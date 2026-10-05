// Окно «roster.html»: скрипт (вынесен из страницы, текст без правок).
let token = localStorage.getItem('token');
let me = JSON.parse(localStorage.getItem('me') || 'null');
let serverUrl = ''; // подтягивается из config.js через главный процесс — см. init() внизу файла
let mode = 'login';
let ws, presence = {}, usersCache = [];
let collapsedDepts = new Set(JSON.parse(localStorage.getItem('collapsedDepts') || '[]'));
let searchQuery = '';

function displayNameOf(u) { return u.display_name || u.username; }

// Caps Lock отслеживаем на уровне документа, а не поля пароля: клавишу почти всегда нажимают ДО
// того, как поставить курсор в поле, — слушая только сам input, мы узнали бы об этом лишь после
// первого набранного символа. getModifierState есть и у мыши, поэтому клик по форме тоже обновляет
// подсказку (случай "Caps Lock был включён ещё до запуска клиента").
function refreshCapsHint(e) {
  if (!e || typeof e.getModifierState !== 'function') return;
  document.getElementById('capsHint').classList.toggle('show', e.getModifierState('CapsLock'));
}
document.addEventListener('keydown', refreshCapsHint);
document.addEventListener('keyup', refreshCapsHint);
document.addEventListener('mousedown', refreshCapsHint);

function toggleMode() {
  mode = mode === 'login' ? 'register' : 'login';
  document.querySelector('#auth button.primary').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
  document.getElementById('switchMode').innerHTML = mode === 'login' ? 'Нет аккаунта? <b>Зарегистрироваться</b>' : 'Уже есть аккаунт? <b>Войти</b>';
}

// Расшифровка отказа связи в текст для сотрудника. Приходит из diagnoseServer (main.js):
// само окно причину сбоя fetch не знает — Chromium её не раскрывает, и раньше здесь на любой
// сбой писалось «Сервер недоступен», даже когда сервер работал, а на машине просто не было
// корневого сертификата организации.
//
// Каждый текст устроен одинаково: первая строка — что произошло, вторая — что с этим делать.
// Вторая строка адресована в первую очередь тому, кто придёт разбираться (администратору), но
// написана так, чтобы сотрудник мог просто её процитировать.
function describeAuthFailure(d) {
  const адрес = d && d.url ? `\nАдрес сервера: ${d.url}` : '';
  switch (d && d.code) {
    case 'ca-missing-in-system':
      return 'Сервер работает, но Windows на этом компьютере не доверяет его сертификату.\n'
        + 'Не установлен корневой сертификат организации — администратору нужно добавить его в «Доверенные корневые центры сертификации».' + адрес;
    case 'cert-expired':
      return 'Срок действия сертификата сервера истёк.\nНужно выпустить новый сертификат — это делается на сервере.' + адрес;
    case 'cert-name':
      return 'Сертификат сервера выписан на другое имя.\nК серверу надо обращаться тем именем, которое записано в сертификате, а не по адресу.' + адрес;
    case 'cert-untrusted':
      return 'Сертификат сервера не проходит проверку.\nПокажите администратору этот код: ' + (d.detail || 'без кода') + адрес;
    case 'dns':
      return 'Имя сервера не удаётся определить в сети.\nПроверьте адрес сервера или доступность DNS.' + адрес;
    case 'refused':
      return 'Сервер отказывает в подключении.\nВероятно, служба «Искра» на нём не запущена или занят другой порт.' + адрес;
    case 'timeout':
      return 'Сервер не ответил вовремя.\nОбычно так ведёт себя закрытый порт на межсетевом экране или пропавшая связь с подсетью.' + адрес;
    case 'unreachable':
      return 'До сервера нет сети с этого компьютера.\nПроверьте подключение к сети и маршрут до сервера.' + адрес;
    case 'reset':
      return 'Соединение с сервером обрывается.\nТак бывает, когда на пути стоит фильтрация трафика или перепутаны http и https.' + адрес;
    case 'protocol':
      return 'Сервер отвечает не тем протоколом, которого ждёт клиент.\nСкорее всего, в адресе перепутаны http и https или указан не тот порт.' + адрес;
    case 'not-iskra':
      return 'По этому адресу отвечает не «Искра».\nПроверьте адрес и порт сервера.' + адрес;
    case 'http-status':
      return `Сервер ответил ошибкой ${d.status} на проверку связи.\nРазбираться нужно на самом сервере — в его журнале.` + адрес;
    case 'bad-url':
      return 'Адрес сервера записан неверно.\nИсправить его можно на этом экране: Ctrl+S.' + адрес;
    case 'ok':
      return 'Сервер отвечает, но подключиться из окна не получилось.\n'
        + 'Так бывает, когда запрос перехватывает антивирус или прокси на этом компьютере.' + адрес;
    default:
      return 'Не удалось подключиться к серверу.\nПокажите администратору этот код: ' + ((d && d.detail) || 'неизвестно') + адрес;
  }
}

async function doAuth() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('authErr');
  errEl.className = 'err';
  errEl.textContent = '';

  // Проверка до похода на сервер: пустые поля он всё равно отвергнет, а человеку понятнее
  // увидеть причину сразу, чем после круга по сети.
  if (!username || !password) {
    errEl.textContent = mode === 'login' ? 'Введите логин и пароль' : 'Придумайте логин и пароль';
    return;
  }

  let res;
  try {
    res = await fetch(`${serverUrl}/api/${mode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    // До сервера не дошли. Что именно помешало — знает только главный процесс.
    errEl.className = 'err neutral';
    errEl.textContent = 'Проверяем связь с сервером…';
    let diag = null;
    try { diag = await desktop.diagnoseServer(); } catch { /* и диагностика не ответила — обойдёмся общим текстом */ }
    errEl.className = 'err';
    errEl.textContent = describeAuthFailure(diag);
    return;
  }

  // Сервер ответил — дальше разбираем именно его ответ. Тело может оказаться не JSON:
  // на этом адресе может стоять прокси или совсем другая служба, отдающая HTML.
  const data = await res.json().catch(() => null);
  if (!data) {
    errEl.textContent = `Ответ сервера не распознан (код ${res.status}).\nВозможно, по этому адресу отвечает не «Искра».\nАдрес сервера: ${serverUrl}`;
    return;
  }
  if (!res.ok) {
    // 401 и 429 сервер сопровождает точным текстом (неверный пароль, блокировка на N секунд) —
    // его и показываем. Своё добавляем только там, где ответ сервера сам по себе непонятен.
    if (res.status >= 500) {
      errEl.textContent = `Сервер ответил ошибкой ${res.status}.\nЭто сбой на самой «Искре» — разбираться нужно в её журнале.`;
      return;
    }
    let text = data.error || `Сервер отклонил запрос (код ${res.status})`;
    // Подсказка про Caps Lock уместна ровно здесь: пароль не подошёл, а клавиша нажата.
    if (res.status === 401 && document.getElementById('capsHint').classList.contains('show')) {
      text += '\nОбратите внимание: включён Caps Lock.';
    }
    errEl.textContent = text;
    return;
  }

  token = data.token; me = data.user;
  localStorage.setItem('token', token);
  localStorage.setItem('me', JSON.stringify(me));
  startApp();
}

// Адрес сервера обычно зашит при сборке (см. config.js) — неудобно пересобирать .exe ради смены IP.
// Скрытое поле на экране входа, вызываемое Ctrl+S (специально не на виду — это не то, что должен
// трогать рядовой сотрудник; для него никакой кнопки/подсказки в интерфейсе нет).
document.addEventListener('keydown', async (e) => {
  if (!e.ctrlKey || e.key.toLowerCase() !== 's') return;
  if (document.getElementById('app').classList.contains('active')) return; // уже вошли — не наш экран
  e.preventDefault(); // иначе Chromium попытается открыть системный диалог "Сохранить страницу"
  const value = await uiPrompt('Адрес сервера (например, http://192.168.0.11:3000):', serverUrl, { title: 'Адрес сервера', okText: 'Сохранить' });
  if (value === null) return; // отменили
  const next = value.trim();
  if (!next || next === serverUrl) return;
  serverUrl = await desktop.setServerUrl(next);
  connectionInfo = await desktop.getConnectionInfo();
  refreshConnectionIndicator();
  uiToast('Адрес сервера сохранён: ' + serverUrl);
});

async function api(path, opts) {
  const res = await fetch(serverUrl + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  });
  if (res.status === 401) { desktop.logout(); throw new Error('Сессия недействительна'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let wsLostTimer = null; // см. showConnectionLostModal в ui-kit.js
let wsReconnectDelay = 2000; // экспоненциальный бэкофф между попытками (см. onclose ниже)
function connectWs() {
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  ws = new WebSocket(`${wsUrl}?token=${token}&host=${encodeURIComponent(desktop.hostname)}`
    // Версия и сборка — чтобы администратор в веб-панели видел, у кого что установлено, и
    // мог понять, до кого обновление ещё не доехало (см. /api/admin/clients в server.js).
    + `&ver=${encodeURIComponent(desktop.appVersion)}&track=${encodeURIComponent(desktop.buildTrack)}`);
  // Реальный статус на момент подключения, а не всегда "в сети" — иначе новое WS-подключение
  // (например, при открытии окна чата) на пару секунд перебивало настоящий AFK-статус человека,
  // пока не придёт очередной 15-секундный тик с исправлением.
  ws.onopen = async () => {
    clearTimeout(wsLostTimer);
    wsLostTimer = null;
    wsReconnectDelay = 2000;
    hideConnectionLostModal();
    const { state } = await desktop.getIdleState();
    ws.send(JSON.stringify({ type: 'status', state }));
  };
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'presence') { presence = data.users; updatePresenceOnly(); }
    // Команды администратора из веб-панели. Выполняет их главный процесс — окно только передаёт.
    if (data.type === 'force-update') { desktop.forceUpdate(); return; }
    if (data.type === 'send-log') { sendLocalLogToServer(); return; }
    if (data.type === 'message' && data.from_id !== me.id) {
      const files = data.files || [];
      let body = data.text || '';
      if (files.length === 1) body = body ? `${body} · 📎 ${files[0].name}` : `📎 ${files[0].name}`;
      else if (files.length > 1) body = body ? `${body} · 📎 ${files.length} файла` : `📎 ${files.length} файла`;
      // В группе/общей комнате в заголовке уведомления — название комнаты, а не имя автора (иначе
      // не отличить, из какой именно группы прилетело), а имя автора переносится в текст сообщения.
      let title = data.from_user;
      let label = data.from_user;
      if (data.room) {
        const group = groupsCache.find((g) => `group:${g.id}` === data.room);
        label = group ? group.name : 'Общая комната';
        title = label;
        body = `${data.from_user}: ${body}`;
      }
      desktop.notify({
        title,
        body,
        openPayload: { type: data.room ? 'room' : 'dm', id: data.room || data.from_id, label, token, serverUrl },
      });
    }
    if (data.type === 'broadcast') {
      paintBroadcastPreview({ ...data, created_at: data.created_at || Date.now() });
      desktop.notify({
        title: data.department
          ? `📢 Отдел «${data.department}» — ${data.from_user}`
          : '📢 Рассылка от ' + data.from_user,
        body: data.text || `📎 ${(data.files || []).length} файл(ов)`,
        openPayload: { type: 'broadcast', id: 'broadcast', label: 'Объявления', token, serverUrl, file: 'broadcast.html' },
      });
    }
    // Админ поменял чью-то роль/отдел/список пользователей — подхватываем сразу, без перезахода
    if (data.type === 'users-changed') { refreshUsers(); refreshMe(); }
    // Группу создали/переименовали/поменяли состав/удалили — у нас самих или у кого-то ещё —
    // перечитываем свой список групп (дёшево, групп мало) и перерисовываем сайдбар.
    if (data.type === 'groups-changed') refreshGroups().then(renderList);
  };
  ws.onclose = () => {
    if (window.appShuttingDown) return; // выключается ПК — не переподключаемся и не мигаем модалкой
    // Не сбрасываем таймер на каждой неудачной попытке (реконнект — раз в 2с) — иначе постоянные
    // провалы просто бесконечно откладывали бы показ диалога. Ставим один раз на первый обрыв и
    // ждём (5с), пока какая-нибудь попытка не удастся; удачное onopen выше сам его отменяет.
    if (!wsLostTimer) wsLostTimer = setTimeout(() => { wsLostTimer = null; showConnectionLostModal(connectWs); }, 5000);
    // Бэкофф: 2с → ×1.5 после каждой неудачи, потолок 30с — при обрыве сети на несколько часов
    // это фоновые редкие попытки, а не спам раз в 2 секунды. Успешное onopen сбрасывает задержку.
    setTimeout(connectWs, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
  };
}

// Текст статуса: для "отошёл" — сколько времени человек уже отошёл, а не просто "AFK"
function formatIdleDuration(idleSince) {
  if (!idleSince) return '';
  const mins = Math.max(1, Math.round((Date.now() - idleSince) / 60000));
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  return `${hours} ч назад`;
}
function statusLabel(state, idleSince) {
  if (state === 'active') return 'В сети';
  if (state === 'idle') return `Отошёл (${formatIdleDuration(idleSince)})`;
  return 'Не в сети';
}
// Тултип строки пользователя: "Статус: ..." + с какого момента этот статус действует (since —
// от сервера, формируется в formatStatusSince из ui-kit.js) + по строке "Имя ПК: ..." на каждый
// подключённый компьютер (если несколько сессий на одном аккаунте).
function buildTooltip(state, idleSince, hosts, since) {
  const lines = [`Статус: ${statusLabel(state, idleSince)}`];
  const sinceLine = formatStatusSince(state, since);
  if (sinceLine) lines.push(sinceLine);
  (hosts || []).forEach((h) => lines.push(`Имя ПК: ${h}`));
  return lines.join('\n');
}

desktop.onIdleState(({ state, idleSeconds }) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'status', state }));
  const dot = document.getElementById('meDot');
  if (dot) {
    dot.className = 'dot ' + state;
    const mins = Math.floor((idleSeconds || 0) / 60);
    dot.title = state === 'idle' ? `Отошёл (${mins} мин назад)` : 'В сети';
  }
  paintMeSub(state);
});
// Вторая строка в карточке профиля: свой статус и имя этого компьютера (как его видят коллеги).
function paintMeSub(state) {
  const sub = document.getElementById('meSub');
  if (sub) sub.textContent = `${state === 'idle' ? 'Отошёл' : 'В сети'} · ${desktop.hostname}`;
}

desktop.onShowAlert(({ message, title }) => uiAlert(message, title));
// В отличие от chat.html и broadcast.html, здесь этой подписки раньше не было вовсе — все toast-
// сообщения для ростера (например, предупреждение о запущенном администратором обновлении) уходили
// в никуда: канал слушать было некому.
desktop.onToast(({ message, error }) => uiToast(message, { error }));

document.getElementById('historyRowIcon').innerHTML = uiIcon('megaphone');
document.querySelector('#capsHint span').innerHTML = uiIcon('capsLock');

// Версия и трек сборки внизу панели настроек — см. get-app-info в main.js.
const BUILD_TRACK_LABEL = {
  win7: 'сборка для Windows 7 и 8.1',
  win10: 'сборка для Windows 10 и новее',
  dev: 'запуск из исходников',
};
desktop.getAppInfo().then(({ version, track, electron }) => {
  const label = BUILD_TRACK_LABEL[track] || track;
  document.getElementById('ppAbout').textContent = `Искра ${version} · ${label} · Electron ${electron}`;
}).catch(() => { /* не критично: без этой строки всё остальное работает */ });

// ---------- Журнал этой машины и события главного процесса ----------
// Главный процесс пишет свои события (сбои обновления, падения окон) в локальный файл и присылает
// их сюда — потому что обратиться к серверу может только это окно, токен есть лишь у него.
// Без этого такие события оставались бы на машине сотрудника и до раздела "Логи" не доходили.
desktop.onReportToServer(({ kind, meta, level }) => {
  if (!token || !serverUrl) return; // ещё не вошли — отправлять нечем и некуда
  fetch(`${serverUrl}/api/client-log`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind, level, source: 'main', hostname: desktop.hostname,
      message: (meta && (meta.message || meta.reason)) || kind,
      extra: meta,
    }),
  }).catch(() => { /* сервер недоступен — теряем запись, повторять ради лога не будем */ });
});

// Администратор запросил журнал этой машины из веб-панели (см. /api/admin/request-log).
async function sendLocalLogToServer() {
  if (!token || !serverUrl) return;
  try {
    const text = await desktop.readLocalLog();
    await fetch(`${serverUrl}/api/client-log-file?host=${encodeURIComponent(desktop.hostname)}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain' },
      body: text,
    });
  } catch { /* не смогли — администратор просто увидит, что журнал не пришёл */ }
}

// ---------- Обновление приложения ----------
// Состояние считает главный процесс (см. setupUpdater в main.js), здесь только показ. Кнопка
// "Перезапустить и обновить" появляется, лишь когда обновление реально скачано и готово ставиться.
let lastUpdateState = { state: 'idle' };
function paintUpdateState(s) {
  lastUpdateState = s || { state: 'idle' };
  const text = document.getElementById('ppUpdateStatus');
  const installBtn = document.getElementById('ppInstallUpdateBtn');
  const checkBtn = document.getElementById('ppCheckUpdateBtn');
  // В строке — короткая фраза (строка одна, справа ещё действие), подробность — в подсказке.
  const byState = {
    idle: () => ['Обновления не проверялись', ''],
    dev: () => ['Запуск из исходников', 'Обновления не проверяются'],
    checking: () => ['Проверяем обновления…', ''],
    'not-available': () => ['Последняя версия', 'Установлена последняя версия'],
    available: () => [`Доступна версия ${s.version}`, 'Нажмите «Скачать», чтобы загрузить обновление.'],
    downloading: () => [s.percent != null ? `Загрузка — ${s.percent}%` : 'Загрузка обновления…', ''],
    downloaded: () => [`Версия ${s.version} загружена`, 'Установится при выходе из приложения — или перезапустите сейчас.'],
    // message приходит уже готовой короткой фразой (см. shortUpdateError в main.js), полный текст
    // ошибки лежит в client.log — приписывать сюда что-то ещё незачем.
    error: () => ['Обновление не проверено', s.message || 'Не удалось проверить обновления'],
  };
  const [short, hint] = (byState[s.state] || byState.idle)();
  text.textContent = short;
  document.getElementById('ppUpdateRow').title = hint;
  document.getElementById('ppUpdateRow').classList.toggle('ready', s.state === 'downloaded' || s.state === 'available');
  installBtn.style.display = s.state === 'downloaded' ? '' : 'none';
  checkBtn.style.display = s.state === 'downloaded' ? 'none' : '';
  checkBtn.textContent = s.state === 'available' ? 'Скачать' : 'Проверить';
  checkBtn.disabled = s.state === 'checking' || s.state === 'downloading';
}
desktop.getUpdateState().then(paintUpdateState).catch(() => {});
desktop.onUpdateState(paintUpdateState);
document.getElementById('ppCheckUpdateBtn').onclick = () => {
  // Та же кнопка запускает и загрузку, если обновление уже найдено, но автозагрузка выключена —
  // иначе для скачивания вручную понадобилась бы вторая кнопка ровно с тем же смыслом.
  if (lastUpdateState.state === 'available') desktop.downloadUpdate();
  else desktop.checkUpdates();
};
document.getElementById('ppInstallUpdateBtn').onclick = async () => {
  const ok = await uiConfirm('Приложение закроется и обновится. Несохранённых данных в мессенджере нет, но открытые окна чатов закроются.', {
    title: 'Перезапустить и обновить', okText: 'Перезапустить',
  });
  if (ok) desktop.installUpdate();
};
document.getElementById('historyRow').onclick = () => desktop.openBroadcast({ token, serverUrl, me: JSON.stringify(me) });

// ---------- Профиль и настройки — панель под me-bar (не отдельное окно) ----------
document.querySelector('#ppThemeDark .i').innerHTML = uiIcon('moon');
document.querySelector('#ppThemeLight .i').innerHTML = uiIcon('sun');
document.getElementById('ppClearFolderBtn').innerHTML = uiIcon('x');
document.getElementById('ppBack').innerHTML = uiIcon('chevron'); // повёрнут стилем — «назад»
document.getElementById('ppBack').onclick = () => closeProfilePanel();
document.getElementById('searchIcon').innerHTML = uiIcon('search');
document.getElementById('ppEmblem').innerHTML = uiIcon('emblem');

const PP_CHECKBOX_IDS = [
  ['ppOpenChatOnMessage', 'openChatOnMessage'],
  ['ppRememberWindowSize', 'rememberWindowSize'],
  ['ppAlwaysOnTop', 'alwaysOnTop'],
  ['ppHideNames', 'hideNameInMessages'],
  ['ppAutoUpdate', 'autoUpdate'],
];

function paintProfileTheme(theme) {
  document.getElementById('ppThemeDark').classList.toggle('active', theme !== 'light');
  document.getElementById('ppThemeLight').classList.toggle('active', theme === 'light');
}
function paintProfileAccent(accent) {
  document.querySelectorAll('#ppAccent button').forEach((b) => b.classList.toggle('active', b.dataset.accent === (accent || 'ember')));
}
function paintProfileDownloadPath(p) {
  document.getElementById('ppDownloadPathLabel').textContent = p || 'Каждый раз спрашивать, куда сохранить';
  document.getElementById('ppDownloadPathLabel').title = p || '';
}

async function loadProfilePanel() {
  const settings = await desktop.getSettings();
  PP_CHECKBOX_IDS.forEach(([id, key]) => { document.getElementById(id).checked = !!settings[key]; });
  paintProfileTheme(settings.theme);
  paintProfileAccent(settings.accent);
  paintProfileDownloadPath(settings.downloadPath);
  document.getElementById('ppIdleThresholdMinutes').value = settings.idleThresholdMinutes || 30;
  paintProfileUiScale(settings.uiScale);
  // Карточка «кто я»: полное имя и отделы — как записаны на сервере.
  document.getElementById('ppFullName').textContent = displayNameOf(me);
  const depts = Array.isArray(me.departments) ? me.departments.map((d) => d.name).filter(Boolean) : (me.department ? [me.department] : []);
  document.getElementById('ppDept').textContent = depts.join(', ') || 'Без отдела';
}
function paintProfileUiScale(uiScale) {
  const pct = Math.round((uiScale || 1) * 100);
  const range = document.getElementById('ppUiScale');
  range.value = pct;
  document.getElementById('ppUiScaleLabel').textContent = pct + '%';
  paintRangeFill(range);
}
// Закрашенная часть дорожки ползунка — до бегунка. У input[type=range] в Chromium её нет, рисуем
// фоном: доля считается здесь и передаётся в стиль переменной --fill.
function paintRangeFill(range) {
  const min = Number(range.min), max = Number(range.max);
  range.style.setProperty('--fill', `${((Number(range.value) - min) / (max - min)) * 100}%`);
}

// Список контактов плавно прячется, пока открыта панель профиля — сначала гаснет (opacity), а
// когда переход закончится, по-настоящему убирается из раскладки (display:none), иначе остаётся
// невидимым, но занимающим место (тот же приём, что у ленты рассылок при открытом композере).
function hideListSmoothly() {
  const list = document.getElementById('list');
  if (list.classList.contains('hidden')) return;
  list.classList.add('hidden');
  setTimeout(() => { if (list.classList.contains('hidden')) list.style.display = 'none'; }, 160);
}
function showListSmoothly() {
  const list = document.getElementById('list');
  list.style.display = 'block'; // сначала возвращаем в раскладку (ещё прозрачным)...
  void list.offsetHeight; // ...форсируем reflow, чтобы transition не схлопнулся...
  list.classList.remove('hidden'); // ...и только теперь плавно проявляем
}

// "Объявления" прячутся, уезжая вверх, — что при открытии профиля (вместе со списком), что при
// активном поиске (вместе с me-bar, см. setSearchActive). Высота строки схлопывается через
// max-height в самом CSS-переходе (см. #historyRow.hidden-up) — никакого отдельного display:none
// с задержкой не нужно, поэтому и прыжка в конце анимации, пока список поиска остаётся видимым
// рядом, больше нет.
function hideHistoryRowUp() {
  document.getElementById('historyRow').classList.add('hidden-up');
}
function showHistoryRow() {
  document.getElementById('historyRow').classList.remove('hidden-up');
}

function toggleProfilePanel() {
  document.getElementById('profilePanel').classList.contains('open') ? closeProfilePanel() : openProfilePanel();
}
async function openProfilePanel() {
  if (searchQuery) { searchQuery = ''; setSearchActive(false); renderList(); } // поиск и профиль — взаимоисключающие
  await loadProfilePanel();
  document.getElementById('profilePanel').classList.add('open');
  document.getElementById('me-bar').classList.add('open');
  document.getElementById('me-bar').title = 'Скрыть профиль и настройки';
  document.body.classList.add('settings-open'); // шапка окна: «‹ Настройки» вместо названия
  hideListSmoothly();
  hideHistoryRowUp();
}
function closeProfilePanel() {
  document.body.classList.remove('settings-open');
  document.getElementById('profilePanel').classList.remove('open');
  document.getElementById('me-bar').classList.remove('open');
  document.getElementById('me-bar').title = 'Профиль и настройки';
  showListSmoothly();
  showHistoryRow();
}

PP_CHECKBOX_IDS.forEach(([id, key]) => {
  document.getElementById(id).addEventListener('change', (e) => desktop.setSettings({ [key]: e.target.checked }));
});
document.getElementById('ppThemeDark').onclick = () => { desktop.setSettings({ theme: 'dark' }); paintProfileTheme('dark'); };
document.querySelectorAll('#ppAccent button').forEach((b) => {
  b.onclick = () => { desktop.setSettings({ accent: b.dataset.accent }); paintProfileAccent(b.dataset.accent); };
});
document.getElementById('ppThemeLight').onclick = () => { desktop.setSettings({ theme: 'light' }); paintProfileTheme('light'); };
document.getElementById('ppPickFolderBtn').onclick = async () => {
  const folder = await desktop.pickDownloadFolder();
  if (folder) { desktop.setSettings({ downloadPath: folder }); paintProfileDownloadPath(folder); }
};
document.getElementById('ppClearFolderBtn').onclick = () => { desktop.setSettings({ downloadPath: null }); paintProfileDownloadPath(null); };
document.getElementById('ppIdleThresholdMinutes').addEventListener('change', (e) => {
  const mins = Math.min(240, Math.max(1, Number(e.target.value) || 30));
  e.target.value = mins;
  desktop.setSettings({ idleThresholdMinutes: mins });
});
// Кнопки «−» и «+» у порога: шаг 5 минут (до 5 — по одной), само поле по-прежнему можно править руками.
function stepIdleThreshold(dir) {
  const input = document.getElementById('ppIdleThresholdMinutes');
  const cur = Number(input.value) || 30;
  const step = (dir < 0 ? cur <= 5 : cur < 5) ? 1 : 5;
  input.value = cur + dir * step;
  input.dispatchEvent(new Event('change'));
}
document.getElementById('ppIdleMinus').onclick = () => stepIdleThreshold(-1);
document.getElementById('ppIdlePlus').onclick = () => stepIdleThreshold(1);
// 'input' (не 'change') — применяем сразу, пока тащат ползунок, а не только когда его отпустят.
document.getElementById('ppUiScale').addEventListener('input', (e) => {
  const pct = Number(e.target.value);
  document.getElementById('ppUiScaleLabel').textContent = pct + '%';
  paintRangeFill(e.target);
  desktop.setSettings({ uiScale: pct / 100 });
});
document.getElementById('ppLogoutBtn').onclick = async () => {
  const ok = await uiConfirm('Вы уверены, что хотите выйти из аккаунта на этом компьютере?', {
    title: 'Выход из аккаунта', okText: 'Выйти', danger: true,
  });
  if (ok) desktop.logout();
};

function deptOnlineCount(users) {
  const on = users.filter(u => { const s = (presence[u.id] || {}).state; return s === 'active' || s === 'idle'; }).length;
  return `${on} из ${users.length}`;
}

// Разворачивает/сворачивает отдел на месте (без renderList() — тот сносит и пересоздаёт весь DOM,
// из-за чего анимация была бы не на чём проигрывать). section.nextElementSibling — это .dept-rows,
// они всегда идут парой в этом порядке, см. их создание в renderList() ниже.
function toggleDept(key, section) {
  const willCollapse = !collapsedDepts.has(key);
  if (willCollapse) collapsedDepts.add(key); else collapsedDepts.delete(key);
  localStorage.setItem('collapsedDepts', JSON.stringify([...collapsedDepts]));

  const rows = section.nextElementSibling;
  if (!rows || !rows.classList.contains('dept-rows')) { renderList(); return; } // подстраховка на случай рассинхрона разметки

  section.classList.toggle('collapsed', willCollapse);
  section.title = willCollapse ? 'Показать сотрудников отдела' : 'Скрыть сотрудников отдела';
  animateDeptRows(rows, willCollapse);
}

function animateDeptRows(rows, collapsing) {
  if (collapsing) {
    rows.style.maxHeight = rows.scrollHeight + 'px'; // фиксируем текущую (полную) высоту явным числом...
    void rows.offsetHeight; // ...форсируем reflow, чтобы браузер зафиксировал её ДО следующего шага...
    rows.style.maxHeight = '0px'; // ...и только теперь анимируем к нулю
  } else {
    rows.style.maxHeight = rows.scrollHeight + 'px'; // scrollHeight измеряется верно, даже пока сам элемент схлопнут
    rows.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName !== 'max-height') return;
      rows.removeEventListener('transitionend', onEnd);
      // Снимаем ограничение по завершении — иначе список отдела мог бы обрезаться, если позже
      // в него добавится сотрудник (перевод из другого отдела и т.п.), а высота осталась бы старой.
      rows.style.maxHeight = '';
    });
  }
}

// Пользователь, у которого сейчас нет ни одного "живого" подключения (только веб-панель
// администратора или её сочетание с ничем другим), физически не увидит ни сообщение, ни файл —
// у веб-панели нет интерфейса чата. Писать ему/кидать файл из ростера поэтому запрещено:
// строка приглушается и перестаёт быть кликабельной (см. canReceiveMessages в ui-kit.js).
function applyReachability(row, u, p) {
  const reachable = canReceiveMessages(p.hosts);
  const chatPayload = { type: 'dm', id: u.id, label: displayNameOf(u), token, serverUrl };
  row.classList.toggle('unreachable', !reachable);
  row.title = buildTooltip(p.state, p.idleSince, p.hosts, p.since)
    + (reachable ? '' : '\nСейчас недоступен для сообщений и файлов — подключён только через веб-панель администратора');
  row.onclick = reachable ? () => desktop.openChat(chatPayload) : null;
  row.oncontextmenu = reachable
    ? (e) => { e.preventDefault(); desktop.showUserMenu(chatPayload); }
    : (e) => e.preventDefault();
}

// ---------- Непрочитанные — состояние хранит и считает главный процесс (main.js), здесь только отрисовка ----------
let unreadDmCounts = {}; // { userId: count } — ключи приходят строками (через IPC/JSON), см. main.js
let unreadBroadcastCount = 0;

function setUnreadBadge(row, count) {
  row.classList.toggle('unread', count > 0);
  const badge = row.querySelector('.unread-badge');
  if (badge) badge.textContent = count > 99 ? '99+' : String(count);
}

function applyUnreadState(state) {
  unreadDmCounts = state.dms || {};
  unreadBroadcastCount = state.broadcast || 0;
  document.querySelectorAll('#list .row[data-uid]').forEach((row) => {
    setUnreadBadge(row, unreadDmCounts[row.dataset.uid] || 0);
  });
  setUnreadBadge(document.getElementById('historyRow'), unreadBroadcastCount);
}
desktop.onUnreadState(applyUnreadState);

// Вторая строка под именем — только у тех, кто отошёл: «Отошёл · 12 мин». У остальных её нет
// (пустая строка скрыта стилем), и список не разбухает.
function presenceSub(p) {
  if (p.state !== 'idle') return '';
  if (!p.idleSince) return 'Отошёл';
  const mins = Math.max(1, Math.round((Date.now() - p.idleSince) / 60000));
  return `Отошёл · ${mins < 60 ? `${mins} мин` : `${Math.floor(mins / 60)} ч`}`;
}

function makeUserRow(u) {
  const isMe = u.id === me.id;
  const p = presence[u.id] || { state: 'offline', hosts: [] };
  const name = displayNameOf(u);
  const row = document.createElement('div');
  row.className = 'row' + (isMe ? ' is-me' : '');
  row.dataset.uid = u.id; // нужно для точечного обновления статуса без пересборки всего списка
  row.innerHTML = `<div class="dot ${p.state}"></div><div class="rt"><div class="n">${escapeHtml(name)}${isMe ? ' <span class="me-tag">это вы</span>' : ''}</div><div class="sub">${escapeHtml(presenceSub(p))}</div></div><span class="unread-badge"></span>`;
  if (!isMe) setUnreadBadge(row, unreadDmCounts[u.id] || 0);
  if (isMe) {
    row.title = 'Профиль и настройки';
    row.onclick = toggleProfilePanel;
  } else {
    applyReachability(row, u, p);
  }
  return row;
}

// Точечно обновляет точки статуса/тултипы/счётчики "онлайн" по уже существующим DOM-узлам,
// НЕ пересоздавая их. Раньше presence-сообщение (а оно приходит при изменении статуса ЛЮБОГО
// пользователя, не только того, над кем сейчас курсор) вызывало renderList(), которая полностью
// сносит и заново строит список — если мышь в этот момент была над строкой, наведённый элемент
// уничтожался и на его месте появлялся новый уже без :hover, из-за чего подсветка периодически
// пропадала и снова появлялась (моргание). Теперь при обычном обновлении статуса элементы не
// трогаем вообще, только переставляем классы/текст внутри них.
function updatePresenceOnly() {
  document.querySelectorAll('#list .row[data-uid]').forEach((row) => {
    const u = usersCache.find((x) => String(x.id) === row.dataset.uid);
    if (!u) return;
    const p = presence[u.id] || { state: 'offline', hosts: [] };
    const dot = row.querySelector('.dot');
    if (dot) dot.className = 'dot ' + p.state;
    const sub = row.querySelector('.sub');
    if (sub) sub.textContent = presenceSub(p);
    if (u.id === me.id) row.title = 'Профиль и настройки';
    else applyReachability(row, u, p); // пересчитывает и доступность (появился/пропал реальный хост), и тултип
  });
  document.querySelectorAll('#list .section[data-dept]').forEach((section) => {
    const key = section.dataset.dept;
    const users = usersCache.filter((u) => departmentKeysOf(u).includes(key));
    const countEl = section.querySelector('.scount');
    if (countEl) countEl.textContent = deptOnlineCount(users);
  });
}

function renderGroupsSection(list) {
  const header = document.createElement('div');
  header.className = 'section groups-header';
  header.innerHTML = `<span class="stitle">ГРУППЫ</span><button type="button" class="group-add-btn" title="Создать группу">${uiIcon('plus')}</button>`;
  header.querySelector('.group-add-btn').onclick = (e) => { e.stopPropagation(); openGroupModal({ mode: 'create' }); };
  list.appendChild(header);

  if (!groupsCache.length) return;
  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'dept-rows'; // тот же контейнер-обёртка, что у отделов — просто переиспользуем отступы/раскладку
  groupsCache.forEach((g) => rowsWrap.appendChild(makeGroupRow(g)));
  list.appendChild(rowsWrap);
}

function makeGroupRow(g) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.gid = g.id;
  row.title = g.name;
  row.innerHTML = `<div class="badge-icon">${uiIcon('group')}</div><div class="n">${escapeHtml(g.name)}</div><button type="button" class="group-manage-btn" title="Управление группой">${uiIcon('gear')}</button><span class="gcount" title="Участников">${g.member_count || ''}</span><span class="unread-badge"></span>`;
  row.onclick = () => desktop.openChat({ type: 'room', id: `group:${g.id}`, label: g.name, token, serverUrl });
  row.querySelector('.group-manage-btn').onclick = (e) => { e.stopPropagation(); openGroupModal({ mode: 'manage', group: g }); };
  return row;
}

// ---------- Создание/управление группой — одна модалка на оба случая ----------
// mode: 'create' — название + чек-лист участников из usersCache, создатель добавляется сам.
// mode: 'manage' — если canManageGroup(group): та же форма, предзаполненная текущими участниками,
// плюс "Удалить группу"; иначе — только список участников для чтения и кнопка "Покинуть группу"
// (выйти может любой, без специальных прав).
async function openGroupModal({ mode, group }) {
  const canManage = mode === 'create' || canManageGroup(group);
  let currentMemberIds = new Set([me.id]);
  if (mode === 'manage') {
    try {
      const members = await api(`/api/groups/${group.id}/members`);
      currentMemberIds = new Set(members.map((m) => m.id));
    } catch (e) { uiAlert(e.message, 'Не удалось загрузить участников'); return; }
  }

  const overlay = document.createElement('div');
  overlay.className = 'ui-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ui-modal-box group-modal-box';

  const candidates = usersCache.filter((u) => u.id !== me.id); // себя в чек-лист не добавляем — участие и так гарантировано
  const memberListHtml = candidates.map((u) => {
    const checked = currentMemberIds.has(u.id) ? 'checked' : '';
    return canManage
      ? `<label class="gm-member"><input type="checkbox" data-uid="${u.id}" ${checked}><span class="n">${escapeHtml(displayNameOf(u))}</span></label>`
      : (currentMemberIds.has(u.id) ? `<div class="gm-member-name">${escapeHtml(displayNameOf(u))}</div>` : '');
  }).join('');

  box.innerHTML = `
    <div class="ui-modal-title">${uiIcon('group')} ${mode === 'create' ? 'Новая группа' : escapeHtml(group.name)}</div>
    ${canManage ? `
      <div class="gm-field"><label>Название</label><input type="text" id="gmName" maxlength="80" value="${mode === 'manage' ? escapeHtml(group.name) : ''}" placeholder="Например, Отдел статистики"></div>
      <div class="gm-field"><label>Участники</label><div class="gm-members">${memberListHtml || '<div class="gm-member-name" style="color:var(--muted)">Пока больше некого добавить</div>'}</div></div>
    ` : `
      <div class="gm-field"><label>Участники</label><div class="gm-readonly-members">${memberListHtml}</div></div>
    `}
    <div class="ui-modal-actions" style="margin-top:6px; flex-wrap:wrap;">
      ${mode === 'manage' ? '<button class="ui-btn-ghost" id="gmLeave">Покинуть группу</button>' : ''}
      ${mode === 'manage' && canManage ? '<button class="ui-btn-danger" id="gmDelete">Удалить</button>' : ''}
      <button class="ui-btn-ghost" id="gmCancel">Отмена</button>
      ${canManage ? '<button class="ui-btn-primary" id="gmSave">Сохранить</button>' : ''}
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  box.querySelector('#gmCancel').onclick = close;

  if (canManage) {
    box.querySelector('#gmSave').onclick = async () => {
      const name = box.querySelector('#gmName').value.trim();
      if (!name) return uiAlert('Введите название группы', 'Пустое название');
      const checked = [...box.querySelectorAll('.gm-member input[type=checkbox]:checked')].map((el) => Number(el.dataset.uid));
      try {
        if (mode === 'create') {
          await api('/api/groups', { method: 'POST', body: JSON.stringify({ name, memberIds: checked }) });
        } else {
          if (name !== group.name) await api(`/api/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
          const toAdd = checked.filter((id) => !currentMemberIds.has(id));
          const toRemove = [...currentMemberIds].filter((id) => id !== me.id && !checked.includes(id));
          if (toAdd.length) await api(`/api/groups/${group.id}/members`, { method: 'POST', body: JSON.stringify({ userIds: toAdd }) });
          for (const uid of toRemove) await api(`/api/groups/${group.id}/members/${uid}`, { method: 'DELETE' });
        }
        close();
        await refreshGroups();
        renderList();
      } catch (e) { uiAlert(e.message, 'Не удалось сохранить'); }
    };
  }
  if (mode === 'manage') {
    box.querySelector('#gmLeave').onclick = async () => {
      const ok = await uiConfirm(`Покинуть группу «${group.name}»? Вернуться обратно можно будет, только если вас снова добавят.`, { title: 'Покинуть группу', okText: 'Покинуть', danger: true });
      if (!ok) return;
      try {
        await api(`/api/groups/${group.id}/members/${me.id}`, { method: 'DELETE' });
        close();
        await refreshGroups();
        renderList();
      } catch (e) { uiAlert(e.message, 'Не удалось выйти из группы'); }
    };
    if (canManage) {
      box.querySelector('#gmDelete').onclick = async () => {
        const ok = await uiConfirm(`Удалить группу «${group.name}» без возможности восстановления? Переписка останется в базе, но открыть её будет уже нельзя.`, { title: 'Удалить группу', okText: 'Удалить', danger: true });
        if (!ok) return;
        try {
          await api(`/api/groups/${group.id}`, { method: 'DELETE' });
          close();
          await refreshGroups();
          renderList();
        } catch (e) { uiAlert(e.message, 'Не удалось удалить группу'); }
      };
    }
  }
}
function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = '';

  const allUsers = usersCache;

  // Группы — своя секция над отделами, без учёта поискового запроса (во время поиска ищем только
  // среди людей — секция скрывается вместе с обычной группировкой по отделам, см. ниже).
  if (!searchQuery) renderGroupsSection(list);

  // Поиск — плоский список без группировки по отделам, без учёта свёрнутости
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const found = allUsers.filter(u => displayNameOf(u).toLowerCase().includes(q));
    if (!found.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'Никого не найдено';
      list.appendChild(hint);
    } else {
      found.forEach(u => list.appendChild(makeUserRow(u)));
    }
    return;
  }

  // Сотрудник может состоять в нескольких отделах — тогда он показывается в каждом из них.
  // Это осознанное дублирование строки, а не ошибка: человек, который работает и на бухгалтерию,
  // и на статистику, должен находиться там, где его ищут.
  const groups = new Map();
  allUsers.forEach(u => {
    for (const key of departmentKeysOf(u)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    }
  });

  // Порядок — как задан на сервере (веб-панель, стрелки ↑↓), "Без отдела" всегда в самом низу;
  // если отдела почему-то нет в списке с сервера (рассинхрон) — в конец, по алфавиту между собой.
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === 'Без отдела') return 1;
    if (b === 'Без отдела') return -1;
    const ia = deptOrderCache.indexOf(a);
    const ib = deptOrderCache.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b, 'ru');
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  for (const key of orderedKeys) {
    const users = groups.get(key);
    const collapsed = collapsedDepts.has(key);
    const section = document.createElement('div');
    section.className = 'section' + (collapsed ? ' collapsed' : '');
    section.dataset.dept = key;
    section.title = collapsed ? 'Показать сотрудников отдела' : 'Скрыть сотрудников отдела';
    section.innerHTML = `<span class="chev">${uiIcon('chevron')}</span><span class="stitle">${escapeHtml(key)}</span><span class="scount">${deptOnlineCount(users)}</span>`;
    section.onclick = () => toggleDept(key, section);
    // ПКМ по отделу — «Сообщение всему отделу». У псевдо-отдела "Без отдела" адресатов нет как
    // группы, поэтому меню там не появляется вовсе, а не появляется неработающим.
    const dept = deptsCache.find((d) => d.name === key);
    if (dept) {
      section.oncontextmenu = (e) => {
        e.preventDefault();
        desktop.showDepartmentMenu({ departmentId: dept.id, departmentName: dept.name, token, serverUrl, me: JSON.stringify(me) });
      };
      section.title += ' · ПКМ — написать всему отделу';
    }
    list.appendChild(section);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'dept-rows';
    if (collapsed) rowsWrap.style.maxHeight = '0px'; // сразу схлопнуто, без анимации при первой отрисовке
    users.forEach(u => rowsWrap.appendChild(makeUserRow(u)));
    list.appendChild(rowsWrap);
  }
}

let deptOrderCache = []; // имена отделов в порядке, заданном на сервере (стрелками ↑↓ в веб-панели)
let deptsCache = [];     // они же целиком — id нужен для "Сообщение всему отделу" (ПКМ по отделу)

// Отделы сотрудника: массив имён, пусто — "Без отдела". Сервер отдаёт departments массивом; поле
// department (первый отдел строкой) он присылает для совместимости, и если клиент окажется новее
// сервера, работать будем по нему.
function departmentKeysOf(u) {
  const names = Array.isArray(u.departments) ? u.departments.map((d) => d.name).filter(Boolean) : [];
  if (names.length) return names;
  return [u.department || 'Без отдела'];
}

// Раз в 20 секунд (см. setInterval ниже) плюс по каждому 'users-changed' от WS — при росте штата
// гонять список целиком на каждый пустой тик расточительно. Сервер отдаёт ETag на основе версии
// списка (см. usersVersion в server.js); пока никто ничего не менял, ответ — пустой 304, без сборки
// и передачи JSON, и без повторного рендера списка на клиенте.
let usersEtag = null;
let deptsEtag = null;
async function refreshUsers() {
  let changed = false;
  const uHeaders = { Authorization: 'Bearer ' + token };
  if (usersEtag) uHeaders['If-None-Match'] = usersEtag;
  const ures = await fetch(serverUrl + '/api/users', { headers: uHeaders });
  if (ures.status === 401) { desktop.logout(); throw new Error('Сессия недействительна'); }
  if (!ures.ok && ures.status !== 304) throw new Error('request failed');
  if (ures.status !== 304) {
    usersEtag = ures.headers.get('ETag');
    usersCache = await ures.json();
    changed = true;
  }
  try {
    const dHeaders = { Authorization: 'Bearer ' + token };
    if (deptsEtag) dHeaders['If-None-Match'] = deptsEtag;
    const dres = await fetch(serverUrl + '/api/departments', { headers: dHeaders });
    if (dres.ok && dres.status !== 304) {
      deptsEtag = dres.headers.get('ETag');
      deptsCache = await dres.json();
      deptOrderCache = deptsCache.map((d) => d.name);
      changed = true;
    }
  } catch { /* не критично — останется прошлый порядок или алфавитный */ }
  if (changed) renderList();
}

// Список именованных групп, в которых состоит текущий пользователь (см. /api/groups в server.js) —
// без ETag: групп мало (в отличие от списка сотрудников), гонять его целиком не накладно, а меняется
// он реже, чем список пользователей, зато сразу по свежему WS-событию 'groups-changed' (см. выше).
let groupsCache = [];
async function refreshGroups() {
  try { groupsCache = await api('/api/groups'); } catch { /* сервер недоступен — останется прошлый список */ }
}
function canManageGroup(g) { return g.created_by === me.id || !!me.can_admin; }

// Роль/имя могли поменять на сервере (через веб-панель) — подтягиваем свежие данные без перезахода
async function refreshMe() {
  try {
    const fresh = await api('/api/me');
    me = { ...me, ...fresh };
    localStorage.setItem('me', JSON.stringify(me));
    document.getElementById('meName').textContent = displayNameOf(me);
  } catch { /* сеть могла моргнуть — не критично, попробуем при следующем событии */ }
}

// ---------- Скрытый поиск: начал печатать — появилась строка поиска вместо "себя" ----------
// Строка поиска теперь видна всегда (под карточкой профиля), но привычка «просто начать печатать»
// сохранена: обработчик keydown ниже сам переносит набранное в поле.
function setSearchActive(active) {
  if (active && document.getElementById('profilePanel').classList.contains('open')) closeProfilePanel(); // поиск и настройки — взаимоисключающие
  if (active) hideHistoryRowUp(); else showHistoryRow();
  const bar = document.getElementById('searchBar');
  const input = document.getElementById('searchInput');
  bar.classList.toggle('active', active);
  input.value = searchQuery;
  if (active) input.focus(); else input.blur();
}
document.getElementById('searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  setSearchActive(!!searchQuery);
  renderList();
});

// ---------- Строка «Объявления»: время и начало последнего объявления ----------
function paintBroadcastPreview(b) {
  const time = document.getElementById('historyRowTime');
  const preview = document.getElementById('historyRowPreview');
  if (!b) { time.textContent = ''; preview.textContent = ''; return; }
  const d = new Date(b.created_at);
  const today = new Date().toDateString() === d.toDateString();
  time.textContent = today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const files = b.files || [];
  preview.textContent = (b.text || '').replace(/\s+/g, ' ').trim() || (files.length ? `📎 ${files.length === 1 ? files[0].name : files.length + ' файла'}` : '');
}
async function refreshBroadcastPreview() {
  try { const list = await api('/api/broadcasts'); paintBroadcastPreview(list[list.length - 1]); } catch { /* сервер недоступен — строка останется без подписи */ }
}

document.addEventListener('keydown', (e) => {
  if (!document.getElementById('app').classList.contains('active')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const active = document.activeElement;
  const typingElsewhere = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.id !== 'searchInput';
  if (typingElsewhere) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (document.getElementById('profilePanel').classList.contains('open')) { closeProfilePanel(); return; }
    searchQuery = ''; setSearchActive(false); renderList();
    return;
  }
  if (e.key === 'Backspace') {
    e.preventDefault(); // иначе на пустом searchQuery Electron может воспринять Backspace как "назад"
    if (!searchQuery) return;
    searchQuery = searchQuery.slice(0, -1);
    if (!searchQuery) { setSearchActive(false); renderList(); return; }
    setSearchActive(true);
    renderList();
    return;
  }
  if (e.key.length === 1) { // печатный символ
    // Без этого браузер, увидев, что мы только что сфокусировали #searchInput (внутри
    // setSearchActive), сам ЕЩЁ РАЗ вставлял тот же символ в уже сфокусированное поле —
    // и на экране появлялось "аа" вместо "а".
    e.preventDefault();
    searchQuery += e.key;
    setSearchActive(true);
    renderList();
  }
});

// Главный процесс считает непрочитанное только по живым WS-событиям (см. markUnread в main.js) —
// если клиент был полностью закрыт (не свёрнут в трей), при следующем запуске эти счётчики стартуют
// с нуля, и пропущенные, пока клиент был офлайн, рассылки/сообщения не показывают значок
// непрочитанного, пока диалог не откроют вручную. Досчитываем пропущенное по данным сервера при
// каждом старте: для рассылок — своя же метка "последнее увиденное" из localStorage (её читает и
// broadcast.html — тот же file://-источник, общий localStorage) плюс сегодняшняя лента; для личных
// сообщений — read_at на сервере (авторитетнее localStorage: не зависит от того, открывали ли этот
// диалог раньше вообще). ВАЖНО вызывать ДО connectWs() — тогда никакой гонки с живыми событиями:
// сначала фиксируем базовый пропущенный "хвост", а всё, что придёт по WS позже, просто добавится
// поверх через обычный markUnread.
async function seedMissedUnread() {
  try {
    const now = Date.now();
    const todayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
    const lastSeenId = Number(localStorage.getItem('broadcastLastSeenId')) || 0;
    const [todayBroadcasts, dms] = await Promise.all([
      api(`/api/broadcasts?since=${todayStart}&until=${now}`),
      api('/api/unread-dms'),
    ]);
    const broadcast = todayBroadcasts.filter((b) => b.id > lastSeenId).length;
    if (broadcast || Object.keys(dms).length) await desktop.seedUnread({ broadcast, dms });
  } catch { /* сеть недоступна на самом старте — не критично, догонит живыми WS-событиями дальше */ }
}

async function startApp() {
  installErrorReporting(serverUrl, token, 'roster'); // см. ui-kit.js — токен/сервер уже точно известны
  document.getElementById('auth').style.display = 'none';
  document.getElementById('app').classList.add('active');
  // Герб вместо инициалов — insertAdjacentHTML, а не innerHTML: внутри уже лежит
  // значок статуса (#meDot), и перезаписывать содержимое целиком нельзя.
  const meAvatar = document.getElementById('meAvatar');
  meAvatar.classList.add('emblem');
  meAvatar.insertAdjacentHTML('afterbegin', uiIcon('emblem'));
  document.getElementById('meName').textContent = displayNameOf(me);
  document.querySelector('#me-bar .gear').innerHTML = uiIcon('settings');
  paintMeSub('active');
  document.getElementById('me-bar').onclick = toggleProfilePanel;
  document.getElementById('me-bar').title = 'Профиль и настройки';
  // connectWs() — до всего остального и безусловно: если сервер лежал уже на момент запуска
  // приложения (а не просто отвалился во время работы), раньше это было багом — await refreshUsers()
  // ниже падал (fetch по недоступному серверу) без try/catch, и connectWs() просто никогда не
  // вызывался — некому было даже начать WS-реконнект и показать диалог о потере соединения.
  connectWs();
  try {
    await refreshUsers();
    await refreshGroups();
    renderList();
    applyUnreadState(await desktop.getUnreadState()); // на случай, если что-то пришло, пока ростер ещё не слушал unread-state
    await seedMissedUnread();
    refreshBroadcastPreview();
  } catch { /* сервер недоступен уже при запуске — connectWs() выше сам занимается переподключением и покажет диалог */ }
  setInterval(refreshUsers, 20000);
}

// ---------- Индикатор шифрования канала ----------
// Понять, шифруется ли связь, по внешнему виду приложения невозможно — а разница принципиальная:
// по http пароль и вся переписка идут открытым текстом. Показываем в трёх местах: на экране входа
// (там уходит пароль), в строке профиля (видно всегда) и в настройках (там подробности).
let connectionInfo = { url: '', builtIn: '', fromOverride: false };

function refreshConnectionIndicator() {
  const address = connectionInfo.url || serverUrl || '';
  const secure = /^https:/i.test(address);

  const hint = document.getElementById('connHint');
  if (hint) {
    hint.className = 'conn-hint' + (secure ? '' : ' insecure');
    hint.innerHTML = secure
      ? `${uiIcon('lock')}<span>Соединение защищено</span>`
      : `${uiIcon('warn')}<span>Соединение без шифрования</span>`;
  }

  const badge = document.getElementById('insecureBadge');
  if (badge) badge.classList.toggle('show', !secure);

  const state = document.getElementById('ppConnState');
  const detail = document.getElementById('ppConnDetail');
  if (state && detail) {
    state.textContent = secure ? 'Подключено · https' : 'Без шифрования · http';
    state.style.color = secure ? '' : 'var(--danger)';
    let text = secure
      ? `${address} — пароль, переписка и файлы шифруются по дороге до сервера.`
      : `${address} — пароль, переписка и файлы идут по сети открытым текстом. Сообщите администратору.`;
    if (connectionInfo.fromOverride) text += ` Адрес задан вручную на этом компьютере (в сборке — ${connectionInfo.builtIn}).`;
    // В строке — только имя сервера, пояснение целиком — в подсказке (строка одна).
    let host = address;
    try { host = new URL(address).host; } catch { /* адрес записан не по форме — покажем как есть */ }
    detail.textContent = host;
    const row = document.getElementById('ppConnRow');
    row.title = text;
    row.classList.toggle('insecure', !secure);
  }
}

// Служебное окно смены адреса сервера — Ctrl+Shift+S при открытой панели настроек.
// Такое же скрытое, как Ctrl+S на экране входа, и по той же причине: рядовому сотруднику здесь
// делать нечего. Комбинация другая не из вредности — Ctrl+A в Windows везде означает "выделить
// всё", и перехватывать его значило бы сломать привычное поведение в полях ввода. Ctrl+Shift+S
// рифмуется с Ctrl+S на экране входа: то же самое, тот же смысл.
//
// Отдельного переключателя "http/https" тут нет намеренно: протокол — часть адреса, и менять его
// в отрыве от порта бессмысленно (3000 и 443 — разные вещи). Кнопки протокола просто правят начало
// строки, а сохраняется всегда адрес целиком.
function openConnectionDialog() {
  if (document.getElementById('connDialogOverlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'ui-modal-overlay';
  overlay.id = 'connDialogOverlay';
  const box = document.createElement('div');
  box.className = 'ui-modal-box';
  box.innerHTML = `
    <div class="ui-modal-title">Адрес сервера</div>
    <div class="ui-modal-msg">Служебная настройка. Адрес должен совпадать с именем в сертификате сервера, иначе защищённое соединение не установится. После сохранения приложение перезапустится.</div>
    <div style="display:flex; gap:6px; margin-bottom:10px;">
      <button class="ui-btn-ghost" id="connHttp" style="flex:1;">http</button>
      <button class="ui-btn-ghost" id="connHttps" style="flex:1;">https</button>
    </div>
    <input id="connUrlInput" spellcheck="false" style="width:100%; padding:9px 11px; margin-bottom:6px; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px;">
    <div id="connDialogNote" style="font-size:11px; color:var(--muted); margin-bottom:10px; min-height:15px;"></div>
    <div class="ui-modal-actions">
      <button class="ui-btn-ghost" id="connCheck">Проверить</button>
      <button class="ui-btn-ghost" id="connCancel">Отмена</button>
      <button class="ui-btn-primary" id="connSave">Сохранить</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const input = box.querySelector('#connUrlInput');
  const note = box.querySelector('#connDialogNote');
  input.value = connectionInfo.url || serverUrl || '';
  input.focus();
  input.select();

  const refreshNote = () => {
    const value = input.value.trim();
    const secure = /^https:/i.test(value);
    box.querySelector('#connHttp').className = secure ? 'ui-btn-ghost' : 'ui-btn-primary';
    box.querySelector('#connHttps').className = secure ? 'ui-btn-primary' : 'ui-btn-ghost';
    note.textContent = secure ? '' : 'Без шифрования: пароль и переписка пойдут открытым текстом.';
    note.style.color = secure ? 'var(--muted)' : 'var(--danger)';
  };
  const setScheme = (scheme) => {
    input.value = input.value.trim().replace(/^\s*[a-z]+:\/\//i, '') || '';
    input.value = `${scheme}://${input.value}`;
    refreshNote();
    input.focus();
  };
  box.querySelector('#connHttp').onclick = () => setScheme('http');
  box.querySelector('#connHttps').onclick = () => setScheme('https');
  input.addEventListener('input', refreshNote);
  refreshNote();

  // Проверка ДО сохранения. Без неё смена адреса — прыжок вслепую: приложение перезапускается и
  // только там выясняется, что сервер по этому адресу не отвечает (а чинить это приходится уже
  // с экрана входа по Ctrl+S). Заодно это единственное, ради чего кнопки http/https вообще нужны:
  // переключил протокол, нажал "Проверить" и увидел, отвечает ли сервер именно так.
  const checkAddress = async () => {
    const value = input.value.trim();
    if (!/^https?:\/\/.+/i.test(value)) {
      note.textContent = 'Адрес должен начинаться с http:// или https://';
      note.style.color = 'var(--danger)';
      return;
    }
    const btn = box.querySelector('#connCheck');
    btn.disabled = true;
    note.textContent = 'Проверяем…';
    note.style.color = 'var(--muted)';
    // AbortController, а не просто await: на недоступном адресе fetch может висеть десятки секунд,
    // и человек за это время решит, что окно зависло.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 4000);
    try {
      const res = await fetch(value.replace(/\/+$/, '') + '/api/ping', { signal: stop.signal });
      const data = await res.json();
      if (!data || data.app !== 'iskra') throw new Error('это не сервер Искры');
      note.textContent = data.secure
        ? 'Сервер отвечает, соединение шифруется.'
        : 'Сервер отвечает, но БЕЗ шифрования — пароль и переписка пойдут открытым текстом.';
      note.style.color = data.secure ? 'var(--online)' : 'var(--danger)';
    } catch (e) {
      // Различать эти два случая важно: "не отвечает" чинят адресом, а "сертификат не признан" —
      // сертификатом на сервере, и путать их значит искать не там.
      note.textContent = e.name === 'AbortError'
        ? 'Сервер не ответил за 4 секунды — проверьте адрес и сеть.'
        : 'Связаться не удалось: неверный адрес, сервер выключен либо его сертификат не признан.';
      note.style.color = 'var(--danger)';
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
    }
  };

  const close = () => overlay.remove();
  box.querySelector('#connCheck').onclick = checkAddress;
  box.querySelector('#connCancel').onclick = close;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') box.querySelector('#connSave').click();
  });
  box.querySelector('#connSave').onclick = async () => {
    const next = input.value.trim();
    if (!next) return;
    if (!/^https?:\/\/.+/i.test(next)) { note.textContent = 'Адрес должен начинаться с http:// или https://'; note.style.color = 'var(--danger)'; return; }
    if (next === (connectionInfo.url || serverUrl)) { close(); return; }
    await desktop.setServerUrl(next);
    close();
    uiToast('Адрес сохранён, приложение перезапускается');
    setTimeout(() => desktop.relaunch(), 600);
  };
}

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || String(e.key).toLowerCase() !== 's') return;
  if (!document.getElementById('profilePanel').classList.contains('open')) return; // только из настроек
  e.preventDefault();
  openConnectionDialog();
});

(async function init() {
  serverUrl = await desktop.getServerUrl();
  connectionInfo = await desktop.getConnectionInfo();
  refreshConnectionIndicator();
  if (token && me) startApp();
})();

// Обработчики, которые раньше стояли прямо в разметке (onclick=/onsubmit=): CSP окна запрещает
// встроенный код целиком, поэтому они назначаются отсюда.
document.getElementById('authForm').addEventListener('submit', (e) => { e.preventDefault(); doAuth(); });
document.getElementById('switchMode').addEventListener('click', () => toggleMode());
