// Сможет ли клиент сам поставить обновление — отдельно от main.js, чтобы проверять обычными
// тестами без Electron (см. elevation.test.js).
//
// Установщик «Искры» ставит программу для всех пользователей компьютера и потому требует прав
// администратора. У сотрудника без них обновление скачивается, а установка не проходит — причём
// клиент к этому моменту уже закрыт и сам обратно не запустится. Поэтому прежде чем закрываться
// ради обновления, клиент смотрит, есть ли у пользователя эти права, и сообщает об этом серверу:
// панель не шлёт таким машинам команду «обновись» (см. force-update в server.js).

// Группа «Администраторы» — по номеру (SID), а не по имени: имя зависит от языка Windows.
const ADMINISTRATORS_SID = 'S-1-5-32-544';

// Вывод `whoami /groups`: есть ли среди групп пользователя «Администраторы». Группа числится и у
// администратора, работающего без повышения прав (контроль учётных записей), — Windows повысит
// права установщику сама; у обычного пользователя её нет вовсе.
function hasAdminGroup(whoamiOutput) {
  return new RegExp(`(^|[^0-9-])${ADMINISTRATORS_SID}([^0-9-]|$)`).test(String(whoamiOutput || ''));
}

// true — права есть, false — нет, null — узнать не удалось (не Windows, whoami недоступен).
// run — () => текст вывода `whoami /groups`; бросает, если команда не выполнилась.
function detectCanElevate(platform, run) {
  if (platform !== 'win32') return null;
  try {
    const out = run();
    return out ? hasAdminGroup(out) : null;
  } catch {
    return null;
  }
}

// Каким путём этот клиент ставит обновление по команде (из панели или по своей кнопке):
//   'self'  — сам, установщиком: права администратора есть (или узнать не удалось — как раньше);
//   'task'  — прав нет, но установщик завёл задание планировщика от имени системы (Iskra\Update,
//             см. updater.js): клиент лишь просит Windows выполнить его сейчас, не дожидаясь расписания;
//   'none'  — прав нет и задания нет: не закрываемся, версию поставит сценарий политики при перезагрузке.
function updatePlan(isAdmin, hasSystemUpdater) {
  if (isAdmin !== false) return 'self';
  return hasSystemUpdater ? 'task' : 'none';
}

// Что сообщить серверу (adm=1|0): может ли эта машина обновиться по команде. null — неизвестно.
function canUpdateOnCommand(isAdmin, hasSystemUpdater) {
  if (isAdmin === null) return null;
  return updatePlan(isAdmin, hasSystemUpdater) !== 'none';
}

module.exports = { ADMINISTRATORS_SID, hasAdminGroup, detectCanElevate, updatePlan, canUpdateOnCommand };
