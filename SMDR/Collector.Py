import os
import socket
import sqlite3
import time
import re
import logging
from datetime import datetime
from pathlib import Path

# Адрес АТС и пароль SMDR раньше лежали прямо в этом файле и уезжали в
# репозиторий вместе с кодом. Теперь берём их из окружения или из соседнего
# файла .env (он в .gitignore). Разбираем .env вручную, без python-dotenv:
# на закрытом контуре ставить пакеты неоткуда, а формат тут простейший.
def read_env_text(env_path):
    """Прочитать .env, не полагаясь на то, в какой кодировке его сохранили.

    Файл правят Блокнотом, а он на Windows по умолчанию пишет в кодировке
    системы (для русской — cp1251). Один русский символ в комментарии — и
    строгое чтение в utf-8 роняло коллектор с UnicodeDecodeError ещё до того,
    как он успевал что-то сказать про настройки. Кодировка комментария к делу
    не относится: значения здесь — адрес, порт и пароль, то есть латиница.

    utf-8-sig, а не utf-8: он заодно снимает BOM, который Блокнот дописывает в
    начало файла. Без этого первый ключ читался бы как "\ufeffSMDR_HOST" и
    молча не находился — а это ошибка куда неприятнее падения, потому что
    выглядит как "переменную не задали".
    """
    data = env_path.read_bytes()
    for encoding in ('utf-8-sig', 'cp1251'):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    # Ни то ни другое — читаем как получится, лишь бы добраться до значений:
    # испорченным окажется только нечитаемый комментарий.
    return data.decode('utf-8', errors='replace')


def load_env():
    env_path = Path(__file__).with_name('.env')
    if not env_path.exists():
        return
    for raw in read_env_text(env_path).splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

HOST = os.environ.get('SMDR_HOST', '')
PORT = int(os.environ.get('SMDR_PORT', '23000'))
LOGIN = (os.environ.get('SMDR_LOGIN', 'SMDR') + '\r\n').encode()
PASSWORD = (os.environ.get('SMDR_PASSWORD', '') + '\r\n').encode()

# Через сколько минут молчания считать соединение мёртвым и переподключиться.
# Записи приходят только по завершении разговора, поэтому ночью тишина в
# несколько часов — норма, и просто так рвать связь незачем. Но обрыв бывает
# «тихим»: АТС ушла в перезагрузку, межсетевой экран выкинул простаивающую
# сессию — TCP при этом не закрывается, recv молча ждёт вечно, и коллектор
# выглядит работающим, ничего не принимая. Пересоединение стоит секунду,
# невыявленный обрыв — рабочий день без журнала.
IDLE_RECONNECT_MIN = int(os.environ.get('SMDR_IDLE_RECONNECT_MIN', '30'))
# Как часто отмечать в журнале, что связь жива, а звонков просто нет. Без этой
# строки по логу не отличить «всё в порядке» от «висим».
IDLE_NOTE_MIN = int(os.environ.get('SMDR_IDLE_NOTE_MIN', '5'))

if not HOST or not os.environ.get('SMDR_PASSWORD'):
    raise SystemExit(
        'Не заданы SMDR_HOST и/или SMDR_PASSWORD.\n'
        'Скопируйте .env.example в .env рядом с этим файлом и укажите адрес АТС '
        'и пароль SMDR (см. SMDR/README.md).'
    )

logging.basicConfig(filename='collector.log', level=logging.INFO,
                     format='%(asctime)s %(message)s')

LINE_RE = re.compile(
    r"^(?P<date>\d{2}/\d{2}/\d{2})\s+"
    r"(?P<time>\d{2}:\d{2})\s+"
    r"(?P<ext>\d{3,5})\s+"
    r"(?:"
    r"(?P<co>\d{1,3})\s+"
    r"(?:"
    r"<D>(?P<did>\d+)<I>(?P<caller>\S+)"
    r"|"
    r"(?P<outnum>\S+)"
    r")\s+"
    r"(?:(?P<ring>\d+'\d{2})\s+)?"
    r"(?P<duration>\d{1,2}:\d{2}'\d{2})"
    r"(?:\s+(?P<status>\S+))?"
    r"|"
    r"EXT(?P<internal_to>\d+)"
    r")\s*$"
)


def init_db():
    # timeout: сколько ждать освобождения базы, прежде чем сдаться. По
    # умолчанию 5 секунд — веб-часть журнала успевала их выбрать длинной
    # выборкой, и вставка звонка получала «database is locked».
    conn = sqlite3.connect('smdr.db', timeout=30)
    # WAL: читатель и писатель перестают мешать друг другу. Без него длинное
    # чтение из веб-части блокирует вставку целиком — а ошибка базы вылетала в
    # главный цикл, рвала TCP-сессию с АТС и уходила на пятисекундное
    # переподключение. Всё, что АТС отдаст за эти пять секунд, теряется
    # навсегда: SMDR не переспрашивают.
    conn.execute('PRAGMA journal_mode=WAL')
    # NORMAL вместо FULL: при WAL это безопасно для целостности базы (потерять
    # можно только последние транзакции при отключении питания), а запись
    # каждой строки перестаёт ждать физической записи на диск.
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('''CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_dt TEXT,
        call_date TEXT,
        call_time TEXT,
        ext TEXT,
        co TEXT,
        number TEXT,
        ring TEXT,
        duration TEXT,
        direction TEXT,
        status TEXT,
        did TEXT,
        caller TEXT,
        internal_to TEXT,
        raw_line TEXT,
        received_at TEXT
    )''')
    # Индексы под запросы веб-части: без них страница журнала на 300 тыс.
    # строк перебирает таблицу целиком. Заводим их здесь, рядом с созданием
    # таблицы, чтобы схема жила в одном месте.
    conn.execute('CREATE INDEX IF NOT EXISTS idx_calls_dt ON calls(call_dt DESC)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_calls_direction ON calls(direction)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_calls_ext ON calls(ext)')
    conn.commit()
    return conn


# Поля вставки перечислены один раз: раньше тот же список стоял в двух местах
# подряд, и добавить колонку, поправив только одно, было делом одной невнимательности.
INSERT_SQL = '''INSERT INTO calls
    (call_dt, call_date, call_time, ext, co, number, ring, duration, direction, status, did, caller, internal_to, raw_line, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'''


def save_call(conn, values, text):
    """Записать строку SMDR. Ошибка базы НЕ должна обрывать связь с АТС.

    Раньше исключение отсюда улетало в главный цикл: тот закрывал сокет и ждал
    пять секунд до переподключения, а всё, что АТС отдавала за это время,
    пропадало без следа. Теперь неудачная запись стоит одной строки в журнале —
    и сама строка SMDR там уже есть (её пишет RAW выше), так что данные можно
    восстановить из лога.
    """
    try:
        conn.execute(INSERT_SQL, values)
        conn.commit()
        return True
    except sqlite3.Error as e:
        logging.error(f"НЕ ЗАПИСАНО В БАЗУ ({e}): {text}")
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        return False


def parse_line(line):
    m = LINE_RE.match(line.strip())
    if not m:
        return None
    d = m.groupdict()

    if d['internal_to']:
        direction = 'internal'
        number = None
        co = ring = duration = did = caller = status = None
        internal_to = d['internal_to']
    elif d['did']:
        direction = 'incoming'
        co = d['co']
        ring = d['ring']
        duration = d['duration']
        did = d['did']
        caller = d['caller']
        status = d['status']
        number = None
        internal_to = None
    else:
        direction = 'outgoing'
        co = d['co']
        ring = d['ring']
        duration = d['duration']
        status = d['status']
        number = d['outnum']
        did = caller = internal_to = None

    dd, mm, yy = d['date'].split('/')
    call_dt = f"20{yy}-{mm}-{dd} {d['time']}:00"

    return {
        'call_dt': call_dt,
        'call_date': d['date'],
        'call_time': d['time'],
        'ext': d['ext'],
        'co': co,
        'number': number,
        'ring': ring,
        'duration': duration,
        'direction': direction,
        'status': status,
        'did': did,
        'caller': caller,
        'internal_to': internal_to,
    }


def enable_keepalive(sock):
    """Попросить систему саму проверять, жива ли АТС.

    Без этого разрыв, о котором нам не сказали (перезагрузка АТС, сброс сессии
    на межсетевом экране), не обнаруживается никогда: данных нет, но и ошибки
    нет. С keepalive ядро само шлёт пробы и рвёт соединение, а мы получаем
    исключение и переподключаемся.
    """
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    except OSError:
        return
    # Интервалы задаются по-разному: на Windows одним вызовом ioctl, на Linux
    # тремя опциями. Ни то ни другое не критично — если не вышло, останутся
    # системные умолчания (на Windows это 2 часа, долго, но лучше, чем ничего).
    try:
        if hasattr(socket, 'SIO_KEEPALIVE_VALS'):        # Windows
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 60_000, 10_000))
        else:                                            # Linux и прочие
            for opt, value in (('TCP_KEEPIDLE', 60), ('TCP_KEEPINTVL', 10), ('TCP_KEEPCNT', 6)):
                if hasattr(socket, opt):
                    sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, opt), value)
    except OSError as e:
        logging.warning(f"Не удалось настроить keepalive: {e}")


def connect_and_listen(conn):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(30)
    enable_keepalive(sock)
    sock.connect((HOST, PORT))
    logging.info("Подключились к АТС")

    # Что ответила АТС на каждом шаге — в лог. Раньше здесь безусловно писалось
    # «Авторизовались», хотя ответ никто не смотрел: при неверном логине или
    # пароле АТС просто не начинает слать записи, а в журнале стояло, что вход
    # выполнен. Отличить «пароль не тот» от «звонков нет» было невозможно.
    # Сам пароль не логируем — только приглашение и ответ АТС.
    def short(data):
        return data.decode(errors='replace').strip().replace('\r', ' ').replace('\n', ' ')[:120]

    prompt = sock.recv(4096)
    sock.sendall(LOGIN)
    time.sleep(0.3)
    after_login = sock.recv(4096)
    sock.sendall(PASSWORD)
    logging.info(
        f"Отправили учётные данные (логин {os.environ.get('SMDR_LOGIN', 'SMDR')!r}). "
        f"АТС до логина: {short(prompt)!r}; после логина: {short(after_login)!r}"
    )

    buf = b''
    last_data = time.monotonic()
    last_note = last_data
    while True:
        try:
            data = sock.recv(4096)
            if not data:
                raise ConnectionError("АТС закрыла соединение")
            last_data = last_note = time.monotonic()
            buf += data
            while b'\r\n' in buf:
                line, buf = buf.split(b'\r\n', 1)
                text = line.decode(errors='ignore').strip()
                if not text:
                    continue

                logging.info(f"RAW: {text}")

                parsed = parse_line(text)
                if parsed is None:
                    logging.warning(f"НЕ РАСПОЗНАНО: {text}")
                    save_call(conn, (None, None, None, None, None, None, None, None,
                                     'unknown', None, None, None, None, text,
                                     datetime.now().isoformat()), text)
                    continue

                save_call(conn, (parsed['call_dt'], parsed['call_date'], parsed['call_time'],
                                 parsed['ext'], parsed['co'], parsed['number'], parsed['ring'],
                                 parsed['duration'], parsed['direction'], parsed['status'],
                                 parsed['did'], parsed['caller'], parsed['internal_to'], text,
                                 datetime.now().isoformat()), text)
                logging.info(f"CALL: {text}")
        except socket.timeout:
            # Записи приходят только по завершении разговора, так что тишина
            # сама по себе не признак поломки. Отмечаем её в журнале и рвём
            # связь, только когда молчание затянулось сверх всякой меры.
            idle = time.monotonic() - last_data
            if time.monotonic() - last_note >= IDLE_NOTE_MIN * 60:
                last_note = time.monotonic()
                logging.info(f"Тишина {int(idle // 60)} мин — соединение с АТС держим, звонков нет")
            if IDLE_RECONNECT_MIN and idle >= IDLE_RECONNECT_MIN * 60:
                raise ConnectionError(
                    f"нет записей {int(idle // 60)} мин — переподключаемся на случай тихого обрыва"
                )
            continue


def main():
    conn = init_db()
    while True:
        try:
            connect_and_listen(conn)
        except Exception as e:
            logging.error(f"Обрыв связи: {e}. Переподключение через 5 сек")
            time.sleep(5)


if __name__ == '__main__':
    main()
