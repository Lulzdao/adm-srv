"""Тесты сборщика: журнал по месяцам и одна строка журнала на звонок.

Запуск из каталога SMDR:  python -m unittest test_collector

Только стандартная библиотека — как и сам Collector.Py. Сборщик запускается в
отдельной временной папке (база и журналы — там же), с поддельной АТС на
локальном порту. Номера и звонки выдуманы.
"""

import logging
import os
import socket
import tempfile
import threading
import time
import unittest
from datetime import datetime
from importlib.machinery import SourceFileLoader
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Три звонка в формате АТС; второй АТС отдаёт дважды — как при повторной выдаче буфера.
CALLS = [
    "06/08/26 08:54  3011 06 <D>358623<I>900000000001  0'03 00:01'21",
    "06/08/26 08:54  2042 30 89000000002                    00:00'34",
    "06/08/26 08:55  1016     EXT4041",
]


def fake_pbx(listener, lines):
    """Поддельная АТС: приглашения к входу, затем строки SMDR — и обрыв связи."""
    conn, _ = listener.accept()
    with conn:
        conn.sendall(b"Login:")
        conn.recv(1024)
        conn.sendall(b"Password:")
        conn.recv(1024)
        # Ответ на пароль — отдельно от звонков: иначе первый звонок попал бы ещё и в
        # диагностическую строку «после пароля», и счёт строк журнала сбился бы.
        conn.sendall(b"OK\r\n")
        time.sleep(0.3)
        for line in lines:
            conn.sendall(line.encode() + b"\r\n")
            time.sleep(0.05)
        time.sleep(0.3)


class CollectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.listener = socket.create_server(("127.0.0.1", 0))
        cls.old_cwd = os.getcwd()
        cls.old_env = dict(os.environ)
        os.environ.update({
            "SMDR_HOST": "127.0.0.1",
            "SMDR_PORT": str(cls.listener.getsockname()[1]),
            "SMDR_LOGIN": "SMDR",
            "SMDR_PASSWORD": "выдуманный-пароль",
        })
        os.chdir(cls.tmp.name)
        # Модуль настраивает журнал при загрузке — грузим его уже во временной папке.
        cls.c = SourceFileLoader("collector_under_test", str(HERE / "Collector.Py")).load_module()

    @classmethod
    def tearDownClass(cls):
        logging.shutdown()
        for h in list(logging.getLogger().handlers):
            logging.getLogger().removeHandler(h)
        os.chdir(cls.old_cwd)
        os.environ.clear()
        os.environ.update(cls.old_env)
        cls.listener.close()
        cls.tmp.cleanup()

    def log_text(self, month):
        self.c._log_handler.flush()
        path = Path(self.tmp.name) / f"collector-{month}.log"
        return path.read_text(encoding=self.c._log_handler.encoding or None) if path.exists() else ""

    def emit_at(self, when, message):
        record = logging.LogRecord("root", logging.INFO, __file__, 0, message, None, None)
        record.created = when.timestamp()
        self.c._log_handler.handle(record)

    def test_месяц_в_своём_файле_новый_создаётся_сам(self):
        self.emit_at(datetime(2026, 9, 30, 23, 59, 59), "последняя запись сентября")
        self.emit_at(datetime(2026, 10, 1, 0, 0, 0), "первая запись октября")
        self.assertIn("последняя запись сентября", self.log_text("2026-09"))
        self.assertNotIn("первая запись октября", self.log_text("2026-09"))
        self.assertIn("первая запись октября", self.log_text("2026-10"))

    def test_запись_уходит_в_месяц_своего_времени(self):
        # Строка сентября, дошедшая до журнала уже в октябре, остаётся в сентябре.
        self.emit_at(datetime(2026, 10, 2, 12, 0, 0), "октябрьская")
        self.emit_at(datetime(2026, 9, 30, 23, 59, 58), "запоздавшая сентябрьская")
        self.assertIn("запоздавшая сентябрьская", self.log_text("2026-09"))
        self.assertNotIn("запоздавшая сентябрьская", self.log_text("2026-10"))

    def test_каждый_звонок_в_журнале_один_раз(self):
        lines = [CALLS[0], CALLS[1], CALLS[1], CALLS[2]]
        pbx = threading.Thread(target=fake_pbx, args=(self.listener, lines), daemon=True)
        pbx.start()
        conn = self.c.init_db()
        self.addCleanup(conn.close)  # иначе Windows не даст удалить временную папку с базой
        try:
            self.c.connect_and_listen(conn)
        except Exception:
            pass  # АТС закрыла соединение — так поддельная и заканчивает сеанс
        pbx.join(5)

        log = self.log_text(datetime.now().strftime("%Y-%m"))
        for call in CALLS:
            with self.subTest(call=call):
                calls_logged = [l for l in log.splitlines() if call in l and "ПОВТОР" not in l]
                self.assertEqual(len(calls_logged), 1, f"звонок в журнале не один раз:\n{log}")
        повтор = [l for l in log.splitlines() if "ПОВТОР" in l]
        self.assertEqual(len(повтор), 1)
        self.assertIn(CALLS[1], повтор[0], "по строке ПОВТОР должно быть видно, что именно пропущено")
        # «OK» поддельной АТС сборщик сохраняет как нераспознанную строку — так и задумано.
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM calls WHERE direction != 'unknown'").fetchone()[0], 3)
        self.assertNotIn("выдуманный-пароль", log)


if __name__ == "__main__":
    unittest.main()
