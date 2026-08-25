// Главный процесс Electron — окна, трей, уведомления, настройки, отправка и скачивание файлов
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, powerMonitor, dialog, session, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { SERVER_URL } = require('./config');
const { autoUpdater } = require('electron-updater');

// ---------- Доверие к корневому удостоверяющему центру организации ----------
// Внутри клиента два независимых сетевых стека, и это ключевой момент. Окна (чат, ростер,
// объявления) ходят через Chromium — он читает хранилище сертификатов Windows, куда корневой
// сертификат домена уже попал через групповые политики, там делать нечего. А ГЛАВНЫЙ процесс
// (автообновление через electron-updater и отправка файлов правым кликом через httpPostBuffer)
// работает через Node, и вот он хранилище Windows НЕ читает — групповые политики на него не
// действуют вовсе. Без этой правки после перехода сервера на https получилась бы крайне
// запутанная картина: переписка работает, а обновления и отправка файлов молча отваливаются
// с UNABLE_TO_VERIFY_LEAF_SIGNATURE.
//
// В rosstat-root-ca.crt лежит ПУБЛИЧНЫЙ корневой сертификат домена (rosstat-CA-SRV-CA01-CA):
// приватного ключа в нём нет, это просто якорь доверия, который и так роздан на все машины.
// Поэтому его безопасно держать в репозитории и вшивать в сборку.
//
// Важно, что здесь именно ДОБАВЛЯЕТСЯ доверие к одному конкретному УЦ, а не отключается
// проверка: 144 публичных корня остаются на месте, а сертификат с чужим именем по-прежнему
// отвергается. Соблазнительный "быстрый" вариант — обработчик certificate-error с игнорированием
// ошибки — уничтожил бы защиту полностью: соединение осталось бы шифрованным, но подменить
// сервер смог бы любой в сети, и выглядело бы всё исправно.
//
// Используется только публичный API (options.ca + tls.rootCertificates), без внутреннего
// context.context.addCACert: сборка win7 работает на Node 16 внутри Electron 22, win10 — на
// заметно более новом, и полагаться на внутренности там нельзя.
const ORG_CA_PATH = path.join(__dirname, 'rosstat-root-ca.crt');
function trustOrganizationCa() {
  let pem;
  try {
    pem = fs.readFileSync(ORG_CA_PATH, 'utf8');
  } catch {
    return; // файла нет — ничего не меняем (например, сервер ещё работает по http)
  }
  const createSecureContext = tls.createSecureContext;
  tls.createSecureContext = (options = {}) => {
    // Если вызывающий явно передал свой список УЦ — не вмешиваемся, иначе сломаем чужую
    // осознанную настройку.
    if (!options.ca) options = { ...options, ca: [...tls.rootCertificates, pem] };
    return createSecureContext(options);
  };
}
trustOrganizationCa();
// Иконка окна/панели задач — в собранном .exe она и так встроена (см. build.win.icon в
// package.json), но при разработке через `npm start` (без сборки) без этого показывался бы
// стандартный логотип Electron вместо своего.
const APP_ICON_PATH = path.join(__dirname, 'build', 'icon.ico');

// Какой сборкой пользуется человек — под Windows 7/8.1 или под Windows 10+. Метку проставляет
// electron-builder на этапе сборки (extraMetadata в build-config/win7.js и win10.js), поэтому в
// собранном приложении она есть всегда, а при запуске из исходников (npm start) её нет — тогда
// 'dev'. Нужна поддержке: обе сборки внешне одинаковы, и без этой строки узнать, какая именно
// стоит у сотрудника, можно только по версии Electron в диспетчере задач.
const BUILD_TRACK = require('./package.json').buildTrack || 'dev';

// GPU/аппаратное ускорение Chromium на Windows 7 нестабильно (устаревшие/неполные драйверы DirectX,
// не рассчитанные на современный Chromium) и регулярно приводит к падениям с "unknown software
// exception (0x80000003)" — особенно на выключении/перезагрузке ПК, когда драйвер экрана начинает
// завершаться прямо посреди работы GPU-процесса. Более ранняя попытка (перехват WM_QUERYENDSESSION,
// см. createRoster ниже) решала только одну из возможных причин этого краша — сам краш у части
// пользователей остался, так что отключаем GPU-ускорение вовсе, но ТОЛЬКО на Windows 7 (ядро "6.1" —
// см. таблицу версий https://learn.microsoft.com/windows/win32/sysinfo/operating-system-version):
// на более новых Windows графика стабильна, отключать её там смысла нет, только потеряем плавность
// CSS-анимаций. Обязательно ДО app.whenReady()/создания любого окна — иначе не подействует.
if (process.platform === 'win32' && require('os').release().startsWith('6.1')) {
  app.disableHardwareAcceleration();
}

// ---------- Локальный лог клиента ----------
// Ошибки ВНУТРИ окон (JS-исключения, unhandledrejection) рендереры сами отправляют на сервер
// (см. installErrorReporting в ui-kit.js/preload.js) — так их видно централизованно, не выезжая к
// сотруднику. Но если упал сам рендерер целиком ('render-process-gone' ниже) или неперехваченное
// исключение случилось в ГЛАВНОМ процессе — слать уже некому и нечем, единственное, что остаётся —
// записать на диск самого пользователя, чтобы при разборе инцидента можно было попросить этот файл.
const LOG_PATH = path.join(app.getPath('userData'), 'client.log');
function logLocal(event, meta = {}) {
  fs.appendFile(LOG_PATH, `${new Date().toISOString()} [${event}] ${JSON.stringify(meta)}\n`, () => {});
  // ...и заодно на сервер, чтобы это было видно в разделе "Логи" веб-панели. Раньше события
  // главного процесса (сбои обновления, падения окон) оставались только здесь, на машине
  // сотрудника, — добраться до них можно было, лишь придя к человеку за компьютер.
  // Отправляет ростер: токен для обращения к серверу есть только у него. Через try, потому что
  // logLocal вызывается в том числе из обработчика неперехваченных исключений — он может
  // сработать раньше, чем появится само окно ростера.
  try { sendToWindow(rosterWin, 'report-to-server', { kind: event, meta }); } catch { /* окна ещё/уже нет */ }
}
process.on('uncaughtException', (err) => {
  logLocal('main_uncaught_exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logLocal('main_unhandled_rejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
});

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  openChatOnMessage: false, // открывать окно чата при новом сообщении (вместо/вместе с уведомлением)
  rememberWindowSize: false, // запоминать размер окон между запусками
  alwaysOnTop: false,        // держать окна поверх остальных
  hideNameInMessages: true,  // не повторять имя собеседника в каждом сообщении личного чата (по умолчанию включено)
  theme: 'dark',             // 'dark' | 'light'
  downloadPath: null,        // папка для сохранения файлов по умолчанию (null = каждый раз спрашивать)
  idleThresholdMinutes: 30,  // сколько минут без активности мыши/клавиатуры -> статус "Отошёл"
  uiScale: 1,                // масштаб всего интерфейса (1 = 100%, текущий размер как есть) — см. applyUiScale
  rosterSize: null,
  chatSize: null,
  broadcastSize: null,
  serverUrlOverride: null,   // переопределяет SERVER_URL из config.js без пересборки — см. Ctrl+S на экране входа
  autoUpdate: true,          // сама качать вышедшие обновления (ставятся при выходе) — см. setupUpdater
  lastSeenVersion: null,     // версия на предыдущем запуске — чтобы показать "обновлено до X" один раз после установки
};

// Приложение раньше называлось mini-messenger-desktop, и папка с настройками была своя на это имя.
// После переименования в «Искру» Electron стал класть данные в другую папку — переносим настройки
// один раз, чтобы у людей не сбросился, в частности, адрес сервера, заданный вручную по Ctrl+S.
// Токен входа сюда не попадает (он в localStorage окна, а его так просто не перенести) — один раз
// придётся войти заново, это ожидаемо и происходит однократно.
const LEGACY_APP_DIR = 'mini-messenger-desktop';
function migrateLegacySettings() {
  if (fs.existsSync(SETTINGS_PATH)) return;
  const legacy = path.join(app.getPath('appData'), LEGACY_APP_DIR, 'settings.json');
  try {
    if (!fs.existsSync(legacy)) return;
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.copyFileSync(legacy, SETTINGS_PATH);
  } catch { /* не перенеслось — приложение просто запустится с настройками по умолчанию */ }
}

function loadSettings() {
  migrateLegacySettings();
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings)); } catch { /* не критично */ }
}
let settings = loadSettings();

let rosterWin = null;
let tray = null;
let isQuitting = false;
const namedWins = new Map(); // "type:id" -> BrowserWindow (чаты, рассылки)

// ---------- Непрочитанные — только в памяти на время работы приложения ----------
// Источник истины один — главный процесс: у него уже есть вся нужная информация (какое окно сейчас
// открыто/сфокусировано) в notify() ниже, откуда и вызывается markUnread. Ростер получает состояние
// через unread-state (пуш при изменении) и get-unread-state (разовый запрос при своём старте — вдруг
// что-то пришло, пока он ещё не был готов слушать пуши). Считаем именно количество (не просто факт
// непрочитанного) — в ростере это индикатор-счётчик, а не точка.
const unreadDms = new Map(); // userId -> count
let unreadBroadcastCount = 0;

function unreadStatePayload() {
  return { dms: Object.fromEntries(unreadDms), broadcast: unreadBroadcastCount };
}
function broadcastUnreadState() {
  sendToWindow(rosterWin, 'unread-state', unreadStatePayload());
}
function markUnread(openPayload) {
  if (!openPayload) return;
  if (openPayload.file === 'broadcast.html') unreadBroadcastCount += 1;
  else if (openPayload.type === 'dm') unreadDms.set(openPayload.id, (unreadDms.get(openPayload.id) || 0) + 1);
  // 'room' (общий чат) — в ростере нет отдельного пункта для него, бейджить пока негде, пропускаем
  broadcastUnreadState();
}
// Открытие/фокус окна = прочитано. Вызывается и для уже открытого окна (существующая ветка
// createWindow), и для только что созданного, и при возврате фокуса на уже открытое later (см.
// 'focus' в createWindow) — новое сообщение могло прийти, пока окно было открыто, но не в фокусе.
function clearUnreadForWindow(file, payload) {
  let changed = false;
  if (file === 'broadcast.html') { changed = unreadBroadcastCount > 0; unreadBroadcastCount = 0; }
  else if (payload?.type === 'dm') changed = unreadDms.delete(payload.id);
  if (changed) broadcastUnreadState();
}

function allWindows() {
  return [rosterWin, ...namedWins.values()].filter((w) => w && !w.isDestroyed());
}

// Отправка в окно всегда через это, а не через win.webContents.send() напрямую. Окно может быть
// формально живым (win.isDestroyed() === false), но его процесс-рендерер уже мёртвым — например,
// в момент завершения сеанса Windows, когда рендереры гасятся раньше главного процесса. Посылка
// IPC в уже погибший рендерер — как раз один из способов словить CHECK-фейл внутри Chromium,
// который наружу выглядит как "unknown software exception (0x80000003)".
function sendToWindow(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
  try { wc.send(channel, payload); } catch { /* окно умирает прямо сейчас — терять тут нечего */ }
}

function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

// Раньше запоминался только размер, не позиция — окно каждый раз пересоздавалось там, где Electron
// сам решит (обычно по центру экрана), а не там, где его оставил пользователь.
const pendingPersisters = new Set(); // см. beginShutdown — отменяем отложенные записи на диск
function attachSizePersistence(win, key) {
  const persist = debounce(() => {
    if (isQuitting) return; // при завершении сеанса Windows сама двигает/сворачивает окна — не пишем
    if (!settings.rememberWindowSize) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    settings[key] = { width, height, x, y };
    saveSettings();
  }, 600);
  pendingPersisters.add(persist);
  win.on('resize', persist);
  win.on('move', persist);
  win.on('closed', () => pendingPersisters.delete(persist));
}

// Сохранённая позиция могла остаться от монитора, который сейчас отключён (ноутбук унесли от
// докстанции, второй монитор выключен и т.п.) — тогда окно открылось бы за пределами видимой
// области и стало бы недоступно. Восстанавливаем позицию, только если она хотя бы частично
// попадает в рабочую область какого-нибудь из подключённых сейчас мониторов.
function clampToVisibleArea(x, y, width, height) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const fits = screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + height > b.y;
  });
  return fits ? { x, y } : null;
}

// Кнопка "развернуть" в шапке должна показывать актуальную иконку (квадрат / два квадрата),
// в том числе если окно развернули не кнопкой, а системным способом (Win+Стрелка вверх и т.п.)
function attachWindowStateEvents(win) {
  const send = () => sendToWindow(win, 'window-state', { maximized: win.isMaximized() });
  win.on('maximize', send);
  win.on('unmaximize', send);
}

// ---------- Завершение сеанса Windows (выключение/перезагрузка/выход из системы) ----------
// История вопроса: у ростера обработчик 'close' в норме отменяет закрытие (preventDefault) и прячет
// окно в трей. Во время реального выключения ПК такой "отказ закрываться" сбивает штатную
// последовательность завершения Chromium и роняет процесс с 0x80000003 (см. electron#34311).
// Первые версии фикса вешали hookWindowMessage(WM_QUERYENDSESSION/WM_ENDSESSION) и прямо ВНУТРИ
// этого обработчика звали win.destroy() + app.quit(). Краш стал реже, но не ушёл совсем — и вот
// почему:
//
//  1. Колбэк hookWindowMessage выполняется СИНХРОННО внутри оконной процедуры, пока Windows ждёт
//     возврата из неё. Уничтожать окно (и тем более гасить всё приложение) прямо там — значит
//     сносить нативное окно изнутри его же обработчика сообщений. Это ре-энтрантность, на которой
//     Chromium штатно срабатывает своим CHECK(), а CHECK — это int3, то есть ровно 0x80000003.
//     Отсюда и ощущение, что приложение "ждёт, пока какой-то процесс сам себя закроет": очередь
//     сообщений действительно заблокирована внутри WndProc, пока там крутится вся эта уборка.
//  2. Обработчик на окнах чата (в отличие от ростера) не имел защиты от повторного входа, а
//     WM_QUERYENDSESSION/WM_ENDSESSION Windows шлёт КАЖДОМУ окну отдельно. При трёх открытых окнах
//     это до шести перекрывающихся app.quit() вперемешку с destroy().
//  3. app.quit() запускает длинный асинхронный каскад (before-quit → закрытие каждого окна →
//     window-all-closed → will-quit). На слабом железе он просто не укладывается в отведённое
//     Windows время до принудительного завершения — поэтому на медленных ПК краш и заметнее.
//
// Теперь: в самой оконной процедуре делаем ТОЛЬКО одно — синхронно снимаем вето на закрытие
// (isQuitting = true), это дёшево и безопасно. Всё остальное уносим из WndProc через setImmediate,
// то есть в обычный виток цикла событий, когда Windows уже получила возврат из обработчика.
//
// Важно, что теперь корректность НЕ зависит от того, успеет ли отложенная уборка: даже если Windows
// прибьёт процесс раньше, чем сработает setImmediate, вето уже снято — и штатное завершение
// Chromium (то самое, которое ломал preventDefault) отработает само. Отложенный beginShutdown —
// это быстрый предсказуемый путь выхода, а не обязательное условие. Раньше было наоборот: вся
// надежда была на уборку, выполняемую в самом опасном для этого месте.
//
// hookWindowMessage — единственный доступный тут механизм: события app 'session-end' в Electron нет
// (в списке событий app его не существует), а powerMonitor 'shutdown' работает только на Linux/macOS.
let idleTimer = null;
let shutdownStarted = false;

// Оборванный WebSocket каждое окно переподключает по таймеру и через 5с показывает модалку
// "соединение потеряно". При завершении работы это лишнее: сокеты и DOM-узлы создаются ровно
// тогда, когда приложение уже разбирают, а модалка успевает мигнуть поверх экрана выключения.
// Работает это в первую очередь на обычном выходе (before-quit → app.quit()), где у рендереров
// есть время обработать IPC. На пути beginShutdown() сразу за этим идёт синхронный app.exit(0),
// так что сигнал скорее всего не успеет дойти — вызов там оставлен как дешёвая подстраховка на
// случай, если выход по какой-то причине затянется.
function stopRendererReconnects() {
  for (const win of allWindows()) sendToWindow(win, 'app-shutting-down');
}

function beginShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  isQuitting = true;

  // Ничего больше не должно трогать рендереры и диск, пока мы разбираем приложение по частям.
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  for (const persist of pendingPersisters) persist.cancel();
  pendingPersisters.clear();

  stopRendererReconnects(); // здесь — только как подстраховка, см. комментарий у самой функции

  if (tray) { try { tray.destroy(); } catch { /* уже снят системой */ } tray = null; }
  // destroy(), а не close(): не эмитит 'close' (а значит, и вето из обработчика ростера не сработает)
  // и не ждёт beforeunload/unload страницы.
  for (const win of allWindows()) { try { win.destroy(); } catch { /* уже уничтожено */ } }

  // app.exit(), а не app.quit(): нам нужен предсказуемо быстрый выход, а не асинхронный каскад,
  // в который слабый ПК не успевает уложиться (см. п.3 выше). Всё, что нужно было сохранить,
  // сохраняется синхронно в момент изменения настроек.
  app.exit(0);
}

// Единственное, что делаем прямо в оконной процедуре — снимаем вето. Уборку откладываем.
function hookSessionEnd(win) {
  if (process.platform !== 'win32') return;
  const onSessionEnding = () => {
    isQuitting = true; // синхронно и дёшево: с этого момента 'close' больше не отменяется
    setImmediate(beginShutdown);
  };
  win.hookWindowMessage(0x0011, onSessionEnding); // WM_QUERYENDSESSION — приходит первым
  win.hookWindowMessage(0x0016, onSessionEnding); // WM_ENDSESSION — подстраховка
}

// Ключ в settings.json для запоминания размера окна — свой на каждый тип окна (чат, рассылки),
// не только на чат, как было раньше.
function sizeKeyForFile(file) {
  const map = { 'chat.html': 'chatSize', 'broadcast.html': 'broadcastSize' };
  return map[file] || null;
}

function createWindow(key, file, payload, size) {
  const existing = namedWins.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show(); // show() и так фокусирует — на случай, если окно почему-то было скрыто
    clearUnreadForWindow(file, payload);
    return existing;
  }
  const sizeKey = sizeKeyForFile(file);
  const saved = sizeKey && settings.rememberWindowSize ? settings[sizeKey] : null;
  const width = saved?.width || size?.width || 380;
  const height = saved?.height || size?.height || 520;
  const pos = clampToVisibleArea(saved?.x, saved?.y, width, height);
  const win = new BrowserWindow({
    width, height, ...(pos || {}),
    minWidth: size?.minWidth || 300,
    minHeight: size?.minHeight || 360,
    frame: false,
    show: false, // показываем только после ready-to-show — иначе видно, как окно дёргается/дорисовывается
    icon: APP_ICON_PATH,
    backgroundColor: settings.theme === 'light' ? '#f3f4f7' : '#191b20',
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false, // preload использует require('os') для hostname — в песочнице это запрещено
    },
  });
  // setZoomFactor ДО навигации не работает — Chromium сбрасывает зум при переходе на новую страницу,
  // так что окно, открытое ПОСЛЕ смены масштаба в настройках, всё равно появлялось со старым (пока
  // само окно не открывали, set-settings не успевал до него докричаться). Применяем уже после
  // загрузки страницы (did-finish-load), а не сразу после создания BrowserWindow.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings.uiScale || 1));
  const qs = new URLSearchParams(payload).toString();
  win.loadFile(path.join(__dirname, 'renderer', file), { search: qs });
  win.once('ready-to-show', () => win.show());
  // Перехват нужен на КАЖДОМ окне, а не только на ростере: Windows шлёт WM_QUERYENDSESSION/
  // WM_ENDSESSION каждому окну напрямую и независимо. Само окно себя больше не уничтожает —
  // всё делает общий beginShutdown() (см. hookSessionEnd), поэтому N открытых окон дают один
  // проход уборки, а не N перекрывающихся.
  hookSessionEnd(win);
  // Пользователь мог вернуться к уже открытому, но не сфокусированному окну (Alt+Tab, клик по
  // панели задач) без повторного клика по контакту/значку в ростере — это тоже прочтение.
  win.on('focus', () => clearUnreadForWindow(file, payload));
  namedWins.set(key, win);
  win.on('closed', () => namedWins.delete(key));
  attachWindowStateEvents(win);
  if (sizeKey) attachSizePersistence(win, sizeKey);
  clearUnreadForWindow(file, payload);
  return win;
}

function createRoster() {
  const saved = settings.rememberWindowSize ? settings.rosterSize : null;
  const width = saved?.width || 300;
  const height = saved?.height || 620;
  const pos = clampToVisibleArea(saved?.x, saved?.y, width, height);
  rosterWin = new BrowserWindow({
    width, height, ...(pos || {}),
    minWidth: 260,
    minHeight: 420,
    frame: false,
    show: false, // показываем только после ready-to-show — иначе видно, как окно дёргается/дорисовывается
    icon: APP_ICON_PATH,
    backgroundColor: settings.theme === 'light' ? '#f3f4f7' : '#191b20',
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  // См. комментарий в createWindow() — setZoomFactor до навигации не переживает загрузку страницы.
  rosterWin.webContents.on('did-finish-load', () => rosterWin.webContents.setZoomFactor(settings.uiScale || 1));
  rosterWin.loadFile(path.join(__dirname, 'renderer', 'roster.html'));
  rosterWin.once('ready-to-show', () => rosterWin.show());
  attachSizePersistence(rosterWin, 'rosterSize');
  attachWindowStateEvents(rosterWin);

  hookSessionEnd(rosterWin);

  // Не закрываем насовсем — сворачиваем в трей, чтобы приложение продолжало получать сообщения.
  // Именно это вето (preventDefault) и ломало завершение сеанса Windows, пока его не научились
  // вовремя снимать — подробности в комментарии к beginShutdown() выше.
  rosterWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      rosterWin.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // Если видите это в консоли после сборки .exe — значит tray-icon.png не попал в установщик:
    // проверьте, что он указан в поле "files" секции "build" в package.json
    console.warn('Иконка трея не найдена или пуста:', iconPath);
  }
  tray = new Tray(icon);
  tray.setToolTip('Искра');
  const menu = Menu.buildFromTemplate([
    { label: 'Открыть', click: () => { rosterWin.show(); rosterWin.focus(); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (rosterWin.isVisible()) rosterWin.focus(); else rosterWin.show();
  });
}

// Раз в 15 секунд проверяем реальное системное бездействие (мышь/клавиатура в любом приложении).
// Рассылаем ВСЕМ открытым окнам, а не только ростеру — у каждого окна чата своё собственное
// WebSocket-подключение к серверу, и если оно не сообщает свой статус, сервер считает его вечно
// "активным", а это перекрывает настоящий статус AFK от подключения ростера (баг, который был:
// статус "отошёл" не появлялся, пока открыто хотя бы одно окно чата).
// Внимание: в виртуальных машинах (VMware/VirtualBox/Hyper-V) интеграция мыши между хостом и гостем
// иногда сама генерирует события движения курсора даже без реальных действий пользователя — тогда
// Windows считает это "активностью", и AFK может не наступать. Это особенность ВМ, а не баг клиента;
// на физическом ПК определение бездействия использует стандартный Windows API (GetLastInputInfo) и
// работает корректно. Текущее время простоя показывается во всплывающей подсказке над своим статусом.
function currentIdleState() {
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const thresholdSeconds = (Number(settings.idleThresholdMinutes) || 30) * 60;
  return { state: idleSeconds >= thresholdSeconds ? 'idle' : 'active', idleSeconds };
}

// idleTimer объявлен рядом с beginShutdown() — при завершении работы интервал обязательно гасится:
// иначе очередной тик придётся ровно на момент, когда рендереры уже мертвы, а окна ещё нет, и
// попытка достучаться до них — один из путей к тому самому 0x80000003.
function startIdleWatch() {
  idleTimer = setInterval(() => {
    if (isQuitting) return;
    const payload = currentIdleState();
    for (const win of allWindows()) sendToWindow(win, 'idle-state', payload);
  }, 15000);
}

// Небольшой POST без внешних зависимостей — нужен, чтобы отправить файл из главного процесса
// (Electron 22 использует Node 16, где ещё нет глобального fetch)
function httpPostBuffer(urlStr, buffer, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': buffer.length },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          let msg = `Сервер ответил ${res.statusCode}`;
          try { msg = JSON.parse(data).error || msg; } catch { /* тело не JSON — оставляем код ответа */ }
          reject(new Error(msg));
        }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function handleSendFile(payload) {
  const result = await dialog.showOpenDialog(rosterWin, { properties: ['openFile', 'multiSelections'] });
  if (result.canceled || !result.filePaths.length) return;
  const win = createWindow(`${payload.type}:${payload.id}`, 'chat.html', payload);
  const whenReady = () => new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
    else resolve();
  });
  await whenReady();
  const uploadedFiles = [];
  for (const filePath of result.filePaths) {
    try {
      const buffer = fs.readFileSync(filePath);
      const name = path.basename(filePath);
      const uploaded = await httpPostBuffer(
        `${payload.serverUrl}/api/upload?name=${encodeURIComponent(name)}`,
        buffer,
        { Authorization: `Bearer ${payload.token}`, 'Content-Type': 'application/octet-stream' },
      );
      uploadedFiles.push(uploaded);
    } catch (e) {
      // Диалог именно в окне ростера (renderer), а не системный showErrorBox — чтобы выглядел
      // как часть клиента, а не как отдельное окно Windows не в теме приложения.
      sendToWindow(rosterWin, 'show-alert', { message: String(e.message || e), title: 'Не удалось отправить файл' });
    }
  }
  // Все успешно загруженные файлы уходят одним сообщением, а не россыпью — так же, как при
  // выборе через кнопку-скрепку или drag-and-drop прямо в окне чата.
  if (uploadedFiles.length) sendToWindow(win, 'files-to-send', uploadedFiles);
}

// ---------- Обновление приложения ----------
// Механика: electron-builder кладёт рядом с установщиком latest.yml (версия, имя файла, контрольная
// сумма), обе сборки — каждая в свою папку на сервере (см. /updates в server.js). Клиент сверяет
// свою версию с latest.yml и при необходимости качает новый установщик.
//
// Обновление НЕ прерывает работу насильно: скачанное ставится при обычном выходе из приложения
// (autoInstallOnAppQuit), а пользователю просто предлагается перезапуститься сейчас, если он готов.
// Принудительный перезапуск по таймеру, который обсуждался в концепте, отброшен — оборвать человека
// посреди разговора хуже, чем поставить обновление на день позже.
let updateState = { state: 'idle' }; // см. sendUpdateState — состояние для панели настроек

function updateFeedUrl() {
  // Адрес берём тот, к которому клиент реально подключён СЕЙЧАС, а не зашитый при сборке: на
  // конкретной машине его могли поменять по Ctrl+S, да и сам сервер мог переехать. Иначе клиент
  // искал бы обновления там, где сервера уже нет.
  const base = String(settings.serverUrlOverride || SERVER_URL).replace(/\/+$/, '');
  return `${base}/updates/${BUILD_TRACK}`;
}

function sendUpdateState(state) {
  updateState = state;
  sendToWindow(rosterWin, 'update-state', state);
}

// electron-updater кладёт в ошибку весь ответ сервера целиком — со всеми заголовками и куском
// HTML-страницы 404 в придачу. В панели настроек из этого получается простыня на десяток строк,
// по которой всё равно не понять, что делать. Поэтому наружу отдаём короткую фразу по-русски, а
// полный текст пишем в client.log (в папке данных пользователя) — там он и нужен, когда разбираются.
function shortUpdateError(err) {
  const raw = String((err && (err.stack || err.message)) || err);
  // Самый частый случай в работе: сборки на сервер ещё не выложили, значит latest.yml нет и в ответ
  // приходит 404. Это не поломка — так и говорим, без слова "ошибка".
  if (/\b404\b|latest\.yml|Cannot find .*\.yml/i.test(raw)) return 'На сервере пока нет файлов обновления';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|socket hang up/i.test(raw)) return 'Сервер недоступен';
  // Понадобится, когда сервер переедет на https со своим сертификатом — см. CONCEPT-roadmap.md.
  if (/certificate|CERT_|ERR_TLS|self.signed/i.test(raw)) return 'Сертификат сервера не признан доверенным';
  return 'Не удалось проверить обновления';
}

// Обновление, запущенное администратором из веб-панели: качаем и ставим без вопросов. Обычный
// сценарий (см. ниже) ждёт выхода из приложения, но здесь администратор действует осознанно —
// например, когда нужно срочно раскатить исправление.
let forceInstallAfterDownload = false;

function forceUpdateNow() {
  if (!app.isPackaged) return;
  logLocal('update_forced_by_admin', {});
  forceInstallAfterDownload = true;
  autoUpdater.autoDownload = true;
  checkForUpdates();
}

function setupUpdater() {
  // В режиме разработки (npm start) обновляться неоткуда и незачем: app-update.yml появляется
  // только в собранном приложении, и electron-updater без него бросает ошибку.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = !!settings.autoUpdate;
  autoUpdater.autoInstallOnAppQuit = true; // скачанное встанет при следующем выходе, без вопросов
  autoUpdater.logger = { info: () => {}, warn: () => {}, error: (m) => logLocal('updater_error', { message: String(m) }) };

  autoUpdater.on('checking-for-update', () => sendUpdateState({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => sendUpdateState({ state: 'not-available' }));
  autoUpdater.on('update-available', (info) => sendUpdateState({
    state: settings.autoUpdate ? 'downloading' : 'available',
    version: info.version,
  }));
  autoUpdater.on('download-progress', (p) => sendUpdateState({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    logLocal('update_downloaded', { version: info.version });
    sendUpdateState({ state: 'downloaded', version: info.version });
    if (forceInstallAfterDownload) {
      // Обновление запустил администратор. Совсем без предупреждения окна закрывать нельзя —
      // человек может печатать, — но и отменить он это не может: решение принято не им.
      // Небольшой паузы хватает, чтобы дописать фразу и понять, что происходит.
      sendToWindow(rosterWin, 'toast', { message: `Администратор запустил обновление до ${info.version}. Перезапуск через 15 секунд…` });
      // (true, true) = тихая установка + автозапуск после нее. Без первого true NSIS-инсталлятор
      // запускается БЕЗ флага /S — то есть показывает полный мастер установки (приветствие, выбор
      // папки, прогресс, финиш), тот же самый, что при установке с нуля. Именно это и выглядело
      // "как простая переустановка" — раньше здесь стоял quitAndInstall() без аргументов, а у него
      // isSilent по умолчанию false (см. BaseUpdater.js в electron-updater). С флагом NSIS ставит
      // обновление в фоне без единого окна, и после установки сам перезапускает приложение — второй
      // true как раз про это.
      setTimeout(() => { isQuitting = true; autoUpdater.quitAndInstall(true, true); }, 15000);
    }
  });
  autoUpdater.on('error', (err) => {
    // Ошибку показываем в настройках, а не глотаем: молча не обновляющийся клиент — это то, что
    // замечают через полгода. Но показываем коротко — полный текст только в лог (см. shortUpdateError).
    logLocal('updater_error', { message: err && err.message, stack: err && err.stack });
    sendUpdateState({ state: 'error', message: shortUpdateError(err) });
  });

  checkForUpdates(); // разовая проверка на старте; дальше — только по кнопке в настройках
}

// Приветствие после обновления: раньше единственным видимым следом того, что обновление вообще
// произошло, было закрытие и повторное открытие приложения — никакого "готово, вот что изменилось".
// Сверяем версию с тем, что запомнили на предыдущем запуске: если она выросла — значит, только что
// обновились (сами, по кнопке или принудительно администратором, неважно каким путём), и стоит
// сказать об этом прямо. Если lastSeenVersion пуст — это первая установка вообще, а не обновление,
// тогда молчим и просто запоминаем версию.
function announceVersionIfUpdated() {
  const current = app.getVersion();
  const previous = settings.lastSeenVersion;
  if (previous && previous !== current) {
    sendToWindow(rosterWin, 'toast', { message: `Искра обновлена до версии ${current}` });
  }
  if (previous !== current) {
    settings.lastSeenVersion = current;
    saveSettings();
  }
}

function checkForUpdates() {
  if (!app.isPackaged) {
    sendUpdateState({ state: 'dev' });
    return;
  }
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: updateFeedUrl() });
    autoUpdater.autoDownload = !!settings.autoUpdate;
    autoUpdater.checkForUpdates();
  } catch (e) {
    logLocal('updater_error', { message: e && e.message, stack: e && e.stack });
    sendUpdateState({ state: 'error', message: shortUpdateError(e) });
  }
}

// ---------- IPC от окон ----------
ipcMain.handle('get-update-state', () => updateState);
ipcMain.on('check-updates', () => checkForUpdates());
ipcMain.on('force-update', () => forceUpdateNow());
// Администратор запросил журнал этой машины из веб-панели. Отдаём его ростеру — отправить на
// сервер может только он, токен есть лишь у него.
ipcMain.handle('read-local-log', () => {
  try { return fs.readFileSync(LOG_PATH, 'utf8'); }
  catch { return '(локальный журнал пуст или недоступен)'; }
});
ipcMain.on('download-update', () => { if (app.isPackaged) autoUpdater.downloadUpdate(); });
ipcMain.on('install-update', () => {
  // isQuitting обязателен ДО quitAndInstall: иначе обработчик close у окна списка контактов
  // отменит закрытие и спрячет окно в трей (см. createRoster), приложение не выйдет,
  // и установка не начнётся.
  isQuitting = true;
  // (true, true) — см. подробный комментарий у второго вызова quitAndInstall выше: без первого
  // true это была бы полноценная переустановка с мастером Windows, без второго — пришлось бы
  // запускать приложение вручную после того, как установщик тихо закончит работу.
  autoUpdater.quitAndInstall(true, true);
});

ipcMain.on('open-chat', (event, payload) => {
  createWindow(`${payload.type}:${payload.id}`, 'chat.html', payload);
});

ipcMain.on('open-broadcast', (event, payload) => {
  createWindow('broadcast', 'broadcast.html', payload, { width: 420, height: 520, minWidth: 360, minHeight: 400 });
});

// ПКМ по отделу в списке контактов. Окно то же самое, что у объявлений (broadcast.html) — оно уже
// умеет файлы, перетаскивание и поиск по дням; отличается только круг адресатов, см. departmentId.
// Ключ окна свой на каждый отдел, чтобы окна разных отделов и общие объявления не подменяли друг друга.
ipcMain.on('show-department-menu', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const menu = Menu.buildFromTemplate([
    {
      label: `Сообщение всему отделу «${payload.departmentName}»`,
      click: () => createWindow(`broadcast:dept:${payload.departmentId}`, 'broadcast.html', payload, { width: 420, height: 520, minWidth: 360, minHeight: 400 }),
    },
  ]);
  menu.popup({ window: win });
});

ipcMain.on('show-user-menu', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const menu = Menu.buildFromTemplate([
    { label: `Написать: ${payload.label}`, click: () => createWindow(`${payload.type}:${payload.id}`, 'chat.html', payload) },
    { label: 'Отправить файл…', click: () => handleSendFile(payload) },
  ]);
  menu.popup({ window: win });
});

// Одноразовое переопределение пути сохранения — см. will-download в app.whenReady() ниже.
let pendingSaveAsPath = null;
let pendingSaveAsWin = null;
// То же самое для отслеживания прогресса конкретного клика "скачать файл" (см. download-file выше).
let pendingDownloadId = null;
let pendingDownloadWin = null;
async function handleSaveFileAs(url, suggestedName, win) {
  const result = await dialog.showSaveDialog(win, { defaultPath: suggestedName });
  if (result.canceled || !result.filePath) return;
  pendingSaveAsPath = result.filePath;
  pendingSaveAsWin = win;
  win.webContents.downloadURL(url);
}

// ПКМ по сообщению в чате/рассылках: копировать текст или сохранить файл в выбранное место
// (не то же самое, что настройка "папка по умолчанию" — тут именно разовый выбор).
ipcMain.on('show-message-menu', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const items = [];
  if (payload.kind === 'text' && payload.text) {
    items.push({
      label: 'Копировать текст',
      click: () => {
        clipboard.writeText(payload.text);
        sendToWindow(win, 'toast', { message: 'Скопировано в буфер обмена' });
      },
    });
  }
  if (payload.kind === 'file' && payload.url) {
    items.push({ label: `Сохранить «${payload.name}» как…`, click: () => handleSaveFileAs(payload.url, payload.name, win) });
  }
  if (!items.length) return;
  Menu.buildFromTemplate(items).popup({ window: win });
});

ipcMain.on('window-action', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') { win.isMaximized() ? win.unmaximize() : win.maximize(); }
  if (action === 'close') win.close();
  // Настоящий выход из приложения (не сворачивание в трей) — например, кнопка "Выйти" в диалоге
  // о потере соединения с сервером: продолжать сидеть в трее без связи с сервером бессмысленно.
  if (action === 'quit') { isQuitting = true; app.quit(); }
});

// Скачивание прикреплённого файла: через главный процесс, а не обычной навигацией по ссылке —
// иначе (при target="_blank") Electron открывал вспомогательное пустое окно, которое зависало
// после сохранения. Имя файла сервер уже присылает верным через Content-Disposition.
// downloadId — метка от рендерера, чтобы потом вернуть прогресс скачивания именно в тот файл,
// по которому кликнули (см. will-download ниже) — карточка файла в чате превращается в кольцо
// прогресса с процентами, а по завершении — в галочку.
ipcMain.on('download-file', (event, url, downloadId) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  pendingDownloadId = downloadId || null;
  pendingDownloadWin = win;
  win.webContents.downloadURL(url);
});

ipcMain.handle('pick-download-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Адрес сервера обычно зашит в config.js на этапе сборки (см. комментарий там) — но неудобно
// пересобирать .exe ради смены IP. serverUrlOverride (в settings.json, тот же файл, что и остальные
// настройки) даёт возможность переопределить его без пересборки — скрытое поле на экране входа,
// вызываемое Ctrl+S (см. roster.html), сохраняет туда через set-server-url.
ipcMain.handle('get-server-url', () => settings.serverUrlOverride || SERVER_URL);
ipcMain.handle('set-server-url', (event, url) => {
  settings.serverUrlOverride = String(url || '').trim() || null;
  saveSettings();
  return settings.serverUrlOverride || SERVER_URL;
});
// Чем именно окна связаны с сервером — для индикатора шифрования в ростере. Отдельный канал, а не
// расширение get-server-url: тот возвращает голую строку и используется во всех трёх окнах при
// подключении, а это нужно одному ростеру и раз в сеанс.
ipcMain.handle('get-connection-info', () => ({
  url: settings.serverUrlOverride || SERVER_URL,
  builtIn: SERVER_URL,                              // что зашито в config.js при сборке
  fromOverride: Boolean(settings.serverUrlOverride), // адрес переопределён на этой машине
}));

// Перезапуск приложения после смены адреса сервера. Можно было бы переподключать окна на лету, но
// адрес читают все три окна независимо, каждое в своём рендерере и в свой момент — половина
// состояния осталась бы от старого адреса. Смена адреса — операция редкая и служебная, честный
// перезапуск здесь надёжнее любой ловкости.
ipcMain.on('relaunch', () => {
  app.relaunch();
  isQuitting = true; // иначе обработчик close у ростера свернёт окно в трей вместо выхода
  app.quit();
});

// Строка "что именно у меня установлено" для панели настроек — см. BUILD_TRACK выше.
ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  track: BUILD_TRACK,
  electron: process.versions.electron,
}));
ipcMain.handle('get-unread-state', () => unreadStatePayload());
// unreadDms/unreadBroadcastCount выше — только в памяти этого процесса, пополняются исключительно
// живыми WS-событиями (см. markUnread). Если клиент был полностью закрыт (не просто свёрнут в
// трей), при следующем запуске эти счётчики стартуют с нуля — пропущенные, пока клиент был офлайн,
// рассылки/сообщения не показывают значок непрочитанного, пока пользователь не откроет диалог
// вручную. Ростер досчитывает пропущенное по данным сервера при каждом старте (см. seedMissedUnread
// в roster.html) и один раз "заряжает" счётчики через этот IPC — до того, как подключится WS,
// поэтому гонки с живыми событиями нет.
ipcMain.handle('seed-unread', (event, payload) => {
  if (!payload) return;
  if (typeof payload.broadcast === 'number' && payload.broadcast > 0) unreadBroadcastCount = payload.broadcast;
  if (payload.dms) {
    for (const [uid, count] of Object.entries(payload.dms)) {
      if (count > 0) unreadDms.set(Number(uid), count);
    }
  }
  broadcastUnreadState();
});
// Реальный статус простоя ПРЯМО СЕЙЧАС (не дожидаясь ближайшего 15-секундного тика) — нужен в
// момент открытия нового WS-подключения, чтобы оно сразу сообщило правильный статус, а не
// безусловно "в сети", даже если человек на самом деле давно отошёл (см. комментарий у onopen
// в roster.html/chat.html).
ipcMain.handle('get-idle-state', () => currentIdleState());
ipcMain.handle('get-settings', () => settings);
ipcMain.on('set-settings', (event, partial) => {
  settings = { ...settings, ...partial };
  saveSettings();
  if ('alwaysOnTop' in partial) {
    for (const win of allWindows()) win.setAlwaysOnTop(settings.alwaysOnTop);
  }
  if ('uiScale' in partial) {
    for (const win of allWindows()) win.webContents.setZoomFactor(settings.uiScale || 1);
  }
  // Включили автообновление — начинаем качать уже найденное, не дожидаясь следующей проверки.
  if ('autoUpdate' in partial && app.isPackaged) {
    autoUpdater.autoDownload = !!settings.autoUpdate;
    if (settings.autoUpdate && updateState.state === 'available') autoUpdater.downloadUpdate();
  }
  // Тема (и в перспективе другие настройки внешнего вида) должны применяться сразу во всех открытых
  // окнах, не только в том, где их поменяли — иначе пришлось бы перезапускать каждое окно вручную.
  for (const win of allWindows()) sendToWindow(win, 'settings-changed', settings);
});

// Выход из аккаунта: чистим localStorage ростера, закрываем все окна кроме него, возвращаем на экран входа
ipcMain.on('logout', () => {
  for (const win of namedWins.values()) { if (!win.isDestroyed()) win.close(); }
  if (rosterWin && !rosterWin.isDestroyed()) {
    rosterWin.webContents.executeJavaScript('localStorage.clear(); location.reload();');
  }
});

// Показ системного уведомления по входящему сообщению/рассылке (или открытие окна чата, если включена настройка)
ipcMain.on('notify', (event, payload) => {
  const { title, body, openPayload } = payload;
  // Раньше notify умел открывать только окно чата — рассылки просто присылали Windows-уведомление
  // без возможности сразу открыть саму рассылку. Теперь openPayload сам указывает, какой файл
  // открывать (chat.html по умолчанию, либо broadcast.html), так что механизм общий для обоих.
  const file = openPayload?.file || 'chat.html';
  const key = !openPayload ? null : (file === 'broadcast.html' ? 'broadcast' : `${openPayload.type}:${openPayload.id}`);
  const winSize = file === 'broadcast.html' ? { width: 420, height: 520, minWidth: 360, minHeight: 400 } : undefined;

  if (settings.openChatOnMessage && openPayload) {
    createWindow(key, file, openPayload, winSize); // само появление окна уже служит уведомлением и отмечает как прочитанное
    return;
  }

  const targetWin = key ? namedWins.get(key) : null;
  if (targetWin && !targetWin.isDestroyed() && targetWin.isFocused()) return; // уже читает этот чат — не дублируем, и это уже прочитано

  markUnread(openPayload); // не читает прямо сейчас — считается непрочитанным до открытия/фокуса окна
  const n = new Notification({ title, body });
  n.on('click', () => {
    if (openPayload) createWindow(key, file, openPayload, winSize);
    else { rosterWin.show(); rosterWin.focus(); }
  });
  n.show();
});

app.whenReady().then(() => {
  createRoster();
  createTray();
  startIdleWatch();
  setupUpdater();
  // once, а не на каждый did-finish-load: сказать "обновлено" нужно один раз за запуск, а не
  // при каждой перезагрузке страницы (например, после выхода из аккаунта — см. logout).
  rosterWin.webContents.once('did-finish-load', announceVersionIfUpdated);

  // Рендерер вылетел целиком (не просто JS-исключение внутри страницы, а сам процесс окна) —
  // в этот момент он уже не может сам отправить лог на сервер, поэтому только локально.
  app.on('render-process-gone', (event, webContents, details) => {
    logLocal('render_process_gone', { reason: details.reason, exitCode: details.exitCode });
  });

  // Путь для сохранения файлов по умолчанию (настройки клиента). Если задан — сохраняем сразу
  // туда без диалога "Сохранить как"; если нет — Electron сам покажет системный диалог с верно
  // подставленным именем файла (сервер присылает его через Content-Disposition).
  // Если пользователь явно выбрал "Сохранить как..." через ПКМ на файле — pendingSaveAsPath на
  // один раз перебивает и путь по умолчанию, и обычный диалог (см. handleSaveFileAs ниже).
  session.defaultSession.on('will-download', (event, item) => {
    const downloadId = pendingDownloadId;
    const progressWin = pendingDownloadWin;
    pendingDownloadId = null;
    pendingDownloadWin = null;
    const saveAsWin = pendingSaveAsPath ? pendingSaveAsWin : null; // запоминаем ДО очистки ниже

    if (pendingSaveAsPath) {
      item.setSavePath(pendingSaveAsPath);
      pendingSaveAsPath = null;
      pendingSaveAsWin = null;
    } else if (settings.downloadPath) {
      try {
        const dest = path.join(settings.downloadPath, item.getFilename());
        item.setSavePath(dest);
      } catch { /* папка недоступна/удалена — покажется обычный диалог сохранения */ }
    }

    if (downloadId && progressWin && !progressWin.isDestroyed()) {
      const send = (payload) => sendToWindow(progressWin, 'download-progress', { id: downloadId, ...payload });
      item.on('updated', (e, state) => {
        if (state !== 'progressing' || item.isPaused()) return;
        const total = item.getTotalBytes();
        const received = item.getReceivedBytes();
        send({ state: 'progressing', percent: total > 0 ? Math.round((received / total) * 100) : null });
      });
      item.once('done', (e, state) => {
        send({ state: state === 'completed' ? 'completed' : 'failed' });
      });
    } else if (saveAsWin && !saveAsWin.isDestroyed()) {
      // "Сохранить как..." из контекстного меню — своего кольца прогресса на карточке файла тут
      // нет (это разовое сохранение в произвольное место), но об успехе/ошибке всё равно сообщаем.
      item.once('done', (e, state) => {
        sendToWindow(saveAsWin, 'toast', state === 'completed'
          ? { message: 'Файл успешно скачан' }
          : { message: 'Не удалось скачать файл', error: true });
      });
    }
  });
});

app.on('window-all-closed', () => {
  // Приложение живёт в трее — не выходим при закрытии окон
});

app.on('activate', () => {
  if (!rosterWin || rosterWin.isDestroyed()) createRoster();
  else rosterWin.show();
});

// Обычный выход (трей → "Выход", кнопка "Выйти" в диалоге о потере связи) идёт штатным каскадом
// app.quit() — он не спешит, и рендереры живут ещё какое-то время. Тикающий таймер бездействия и
// переподключение WS им на этом отрезке уже ни к чему: окна закрываются.
app.on('before-quit', () => {
  isQuitting = true;
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  stopRendererReconnects();
});
