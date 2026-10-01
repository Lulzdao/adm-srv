const { execFileSync } = require("child_process");

/**
 * Перезапуск платформы из панели.
 *
 * Нужен после первой загрузки сертификата: работающий по http сервер на https
 * на ходу не переводится. Сам процесс перезапуститься не может — он
 * завершается, а поднимает его заново служба NSSM (AppExit по умолчанию —
 * Restart, пауза AppRestartDelay; DEPLOY.md, «Создать службы»).
 *
 * Поэтому перезапуск разрешён, только если платформа действительно работает
 * службой: запущенная вручную (npm start, окно cmd) она бы просто выключилась
 * и больше не поднялась. Проверяем по родительскому процессу — у службы это
 * nssm.exe.
 *
 * Функции вызываются через объект модуля (selfRestart.runsUnderService()), а не
 * деструктуризацией — так тест подменяет их, не завершая сам себя.
 */
function parentImageName() {
  if (process.platform !== "win32") return null;
  try {
    // CSV без заголовка: "nssm.exe","1234","Services","0","5 000 K"
    const out = execFileSync("tasklist", ["/FI", `PID eq ${process.ppid}`, "/FO", "CSV", "/NH"], {
      encoding: "latin1", timeout: 5000, windowsHide: true,
    });
    const m = /^"([^"]+)"/.exec(String(out).trim());
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function runsUnderService() {
  return /^nssm(\.exe)?$/i.test(parentImageName() || "");
}

// Ответ панели должен успеть уйти до выхода — поэтому с небольшой паузой.
function scheduleRestart(who) {
  console.log(`Перезапуск платформы по запросу администратора ${who || "?"} (служба поднимет её заново)`);
  setTimeout(() => process.exit(0), 500);
}

module.exports = { runsUnderService, scheduleRestart };
