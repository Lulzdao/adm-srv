import os
import socket
import sqlite3
import time
import re
import logging
from collections import deque
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


# Откуда взято каждое значение и что при этом случилось. Заполняется до
# настройки логирования, поэтому копим в списке и пишем в журнал сразу после
# basicConfig — иначе самое нужное сообщение теряется.
ENV_SOURCE = {}
ENV_NOTES = []


def load_env():
    env_path = Path(__file__).with_name('.env')
    if not env_path.exists():
        # Блокнот на Windows дописывает .txt, если имя файла не взять в кавычки.
        # Рядом оказывается .env.txt: на вид всё настроено, а читать нечего.
        alt = Path(__file__).with_name('.env.txt')
        if alt.exists():
            ENV_NOTES.append(
                f"Файл {env_path.name} не найден, но рядом лежит {alt.name}. "
                "Блокнот дописал расширение — переименуйте файл в .env "
                "(в проводнике включите показ расширений или задайте имя в кавычках)."
            )
        else:
            ENV_NOTES.append(f"Файл {env_path} не найден — значения берутся только из окружения.")
        return

    for raw in read_env_text(env_path).splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        cleaned = value.strip().strip('"').strip("'")

        # ВНИМАНИЕ: значение из окружения побеждает значение из .env.
        # Так задумано (служба вправе задать своё), но молча это опаснее всего:
        # .env выглядит настроенным, а работает совсем другой пароль. Поэтому
        # источник каждого значения пишется в журнал.
        if key in os.environ:
            ENV_SOURCE[key] = 'окружение процесса (значение из .env НЕ применено)'
        else:
            os.environ[key] = cleaned
            ENV_SOURCE[key] = '.env'
            if cleaned != value.strip():
                ENV_NOTES.append(
                    f"{key}: с краёв значения сняты кавычки. Если они часть самого значения, "
                    "экранировать их этот разбор не умеет — уберите кавычки и проверьте."
                )
            if value != value.rstrip() or value.strip() != value.strip(' '):
                ENV_NOTES.append(f"{key}: в строке .env были пробелы по краям, они отброшены.")


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
    # Подсказки из load_env печатаем ЗДЕСЬ же. Логирование к этому моменту ещё
    # не настроено, а именно сейчас они нужнее всего: «файл называется .env.txt»
    # объясняет отказ полностью, а общий текст про .env.example — нет.
    raise SystemExit(
        'Не заданы SMDR_HOST и/или SMDR_PASSWORD.\n'
        + ''.join(f'  {note}\n' for note in ENV_NOTES)
        + 'Скопируйте .env.example в .env рядом с этим файлом и укажите адрес АТС '
        'и пароль SMDR (см. SMDR/README.md).'
    )

logging.basicConfig(filename='collector.log', level=logging.INFO,
                     format='%(asctime)s %(message)s')

for _note in ENV_NOTES:
    logging.warning(_note)


def describe_secret(name):
    """Как выглядит значение, не показывая его самого.

    Пароль в журнал попасть не должен, но отличить «пароль не тот» от «пароля
    нет» по журналу необходимо. Длины и источника для этого достаточно: их
    можно сверить с работающей копией, не называя значения вслух.
    """
    value = os.environ.get(name, '')
    parts = [f"источник {ENV_SOURCE.get(name, 'окружение процесса')}", f"длина {len(value)}"]
    if value != value.strip():
        parts.append("ПО КРАЯМ ЕСТЬ ПРОБЕЛЫ")
    if not value:
        parts.append("ПУСТО")
    return f"{name}: " + ", ".join(parts)


logging.info("Настройки: " + "; ".join(
    describe_secret(n) for n in ('SMDR_HOST', 'SMDR_LOGIN', 'SMDR_PASSWORD')
))

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


# Сколько последних записей помнить, чтобы отсеять повторную выдачу.
# Буфер АТС невелик, двух тысяч строк хватает с большим запасом.
RECENT_MEMORY = 2000


class Недавние:
    """Память о последних записях — против повторной выдачи буфера АТС.

    Panasonic отдаёт содержимое своего буфера КАЖДОМУ новому подключению. А
    подключаемся мы заново при каждом получасе тишины (SMDR_IDLE_RECONNECT_MIN)
    и после любого обрыва — значит хвост буфера приезжает снова и снова, и один
    и тот же звонок ложится в базу столько раз, сколько было переподключений.
    Воспроизведено: три подключения подряд — три одинаковые строки.

    Сравниваем по raw_line: в ней дата, время, номер, добавочный и обе
    длительности разом. Два РАЗНЫХ звонка совпадут по этой строке только если
    в одну минуту с одного добавочного на один номер прошли два разговора
    одинаковой длительности до секунды — на практике этого не бывает, а цена
    ошибки несопоставима: потерять одну запись против сотен копий.

    Память заполняется из базы при старте, иначе перезапуск службы снова
    впустил бы весь буфер.
    """

    def __init__(self, conn, размер=RECENT_MEMORY):
        self.размер = размер
        self.очередь = deque()
        self.множество = set()
        try:
            строки = conn.execute(
                "SELECT raw_line FROM calls ORDER BY id DESC LIMIT ?", (размер,)
            ).fetchall()
        except sqlite3.Error as e:
            logging.warning(f"Не удалось прочитать недавние записи ({e}) — защита от повторов начнёт с нуля")
            строки = []
        for (строка,) in reversed(строки):
            if строка:
                self.добавить(строка)

    def добавить(self, строка):
        if строка in self.множество:
            return
        self.очередь.append(строка)
        self.множество.add(строка)
        while len(self.очередь) > self.размер:
            self.множество.discard(self.очередь.popleft())

    def __contains__(self, строка):
        return строка in self.множество


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


def connect_and_listen(conn, недавние=None):
    # Память переживает переподключения: она для того и нужна, что буфер АТС
    # приезжает заново именно при новом подключении.
    if недавние is None:
        недавние = Недавние(conn)
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
    secret = os.environ.get('SMDR_PASSWORD', '')

    def short(data):
        text = data.decode(errors='replace').strip().replace('\r', ' ').replace('\n', ' ')
        # АТС вполне может отразить пароль обратно. В журнал он попасть не должен.
        if secret:
            text = text.replace(secret, '***')
        return text[:120]

    prompt = sock.recv(4096)
    sock.sendall(LOGIN)
    time.sleep(0.3)
    after_login = sock.recv(4096)
    sock.sendall(PASSWORD)

    # Ответ на ПАРОЛЬ читаем обязательно.
    #
    # Раньше после отправки пароля не читалось ничего, и «АТС пароль не
    # приняла» выглядело в журнале ровно как «звонков нет»: те же строки
    # «Тишина N мин — соединение держим». Отличить одно от другого было нельзя.
    #
    # Ждём коротко: при верном пароле АТС может молчать до первого завершённого
    # разговора, и висеть на этом полминуты незачем. А то, что всё-таки
    # пришло, НЕ выбрасываем — прочитанное уходит в общий разбор ниже. Иначе
    # первая же запись о звонке пропала бы именно здесь.
    sock.settimeout(3)
    try:
        after_password = sock.recv(4096)
    except socket.timeout:
        after_password = b''
    finally:
        sock.settimeout(30)

    logging.info(
        f"Отправили учётные данные (логин {os.environ.get('SMDR_LOGIN', 'SMDR')!r}). "
        f"АТС до логина: {short(prompt)!r}; после логина: {short(after_login)!r}; "
        f"после пароля: {short(after_password)!r}"
    )

    # Повторное приглашение к вводу пароля означает отказ.
    #
    # Ловим его не только сразу: АТС сначала отражает введённое звёздочками, а
    # само приглашение присылает заметно позже — в трёхсекундное окно оно не
    # укладывается. И приходит оно БЕЗ перевода строки в конце, поэтому в
    # разбор строк (drain) не попадает никогда: так и лежит в буфере. Значит
    # смотреть надо на сырые куски, а не на разобранные строки.
    отказ_уже_записан = False
    начало_сессии = time.monotonic()

    def проверить_отказ(данные):
        """Записать в журнал отказ АТС — один раз за подключение."""
        nonlocal отказ_уже_записан
        if отказ_уже_записан:
            return
        # Ограничиваем окно: спустя минуту после входа слово «password» в потоке
        # означало бы что угодно, только не приглашение.
        if time.monotonic() - начало_сессии > 60:
            return
        текст = данные.decode(errors='replace').lower()
        if 'password' not in текст and 'invalid' not in текст:
            return
        отказ_уже_записан = True
        logging.error(
            "АТС НЕ ПРИНЯЛА ПАРОЛЬ: она снова просит его ввести. Записи о звонках "
            "приходить не будут. Сверьте SMDR_PASSWORD (см. строку «Настройки» выше: "
            "источник и длина) с тем, что задано на самой АТС "
            "(Maintenance Console -> SMDR Options)."
        )

    проверить_отказ(after_password)

    # Всё, что уже пришло, кладём в буфер разбора, а не теряем.
    buf = after_password
    last_data = time.monotonic()
    last_note = last_data
    def drain(buf):
        """Разобрать все целые строки, что уже лежат в буфере. Вернуть остаток."""
        while b'\r\n' in buf:
            line, buf = buf.split(b'\r\n', 1)
            text = line.decode(errors='ignore').strip()
            if not text:
                continue

            # Отражённый АТС пароль не должен осесть ни в журнале, ни в базе:
            # raw_line сохраняется как есть, и на нераспознанной строке он ушёл
            # бы в таблицу звонков открытым текстом.
            if secret and secret in text:
                text = text.replace(secret, '***')

            logging.info(f"RAW: {text}")

            # Повторная выдача буфера АТС: та же строка уже в базе — не кладём
            # её второй раз. Именно так один звонок размножался на десятки.
            if text in недавние:
                logging.info("ПОВТОР — уже есть в базе, пропускаем")
                continue

            parsed = parse_line(text)
            if parsed is None:
                logging.warning(f"НЕ РАСПОЗНАНО: {text}")
                if save_call(conn, (None, None, None, None, None, None, None, None,
                                    'unknown', None, None, None, None, text,
                                    datetime.now().isoformat()), text):
                    недавние.добавить(text)
                continue

            # Отмечаем только то, что ДЕЙСТВИТЕЛЬНО легло в базу: если запись не
            # прошла (база занята), она должна приехать снова и записаться.
            if save_call(conn, (parsed['call_dt'], parsed['call_date'], parsed['call_time'],
                                parsed['ext'], parsed['co'], parsed['number'], parsed['ring'],
                                parsed['duration'], parsed['direction'], parsed['status'],
                                parsed['did'], parsed['caller'], parsed['internal_to'], text,
                                datetime.now().isoformat()), text):
                недавние.добавить(text)
                logging.info(f"CALL: {text}")
        return buf

    while True:
        try:
            # Разбираем ДО ожидания, а не после. В буфере уже может лежать
            # запись, пришедшая вместе с ответом на пароль: если разбирать
            # только после recv, она пролежала бы там до следующего звонка —
            # то есть, ночью, до утра.
            buf = drain(buf)

            data = sock.recv(4096)
            if not data:
                raise ConnectionError("АТС закрыла соединение")
            проверить_отказ(data)
            last_data = last_note = time.monotonic()
            buf = drain(buf + data)
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
    недавние = Недавние(conn)
    while True:
        try:
            connect_and_listen(conn, недавние)
        except Exception as e:
            logging.error(f"Обрыв связи: {e}. Переподключение через 5 сек")
            time.sleep(5)


if __name__ == '__main__':
    main()
