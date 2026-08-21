import socket
import sqlite3
import time
import re
import logging
from datetime import datetime

HOST = "10.148.130.207"
PORT = 23000
LOGIN = b"SMDR\r\n"
PASSWORD = b"CCSMDRP\r\n"

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
    conn = sqlite3.connect('smdr.db')
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
    conn.commit()
    return conn


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


def connect_and_listen(conn):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(30)
    sock.connect((HOST, PORT))
    logging.info("Подключились к АТС")

    sock.recv(4096)
    sock.sendall(LOGIN)
    time.sleep(0.3)
    sock.recv(4096)
    sock.sendall(PASSWORD)
    logging.info("Авторизовались")

    buf = b''
    while True:
        try:
            data = sock.recv(4096)
            if not data:
                raise ConnectionError("АТС закрыла соединение")
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
                    conn.execute('''INSERT INTO calls
                        (call_dt, call_date, call_time, ext, co, number, ring, duration, direction, status, did, caller, internal_to, raw_line, received_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                        (None, None, None, None, None, None, None, None,
                         'unknown', None, None, None, None, text,
                         datetime.now().isoformat()))
                    conn.commit()
                    continue

                conn.execute('''INSERT INTO calls
                    (call_dt, call_date, call_time, ext, co, number, ring, duration, direction, status, did, caller, internal_to, raw_line, received_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (parsed['call_dt'], parsed['call_date'], parsed['call_time'],
                     parsed['ext'], parsed['co'], parsed['number'], parsed['ring'],
                     parsed['duration'], parsed['direction'], parsed['status'],
                     parsed['did'], parsed['caller'], parsed['internal_to'], text,
                     datetime.now().isoformat()))
                conn.commit()
                logging.info(f"CALL: {text}")
        except socket.timeout:
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
