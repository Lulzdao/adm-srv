// Окно «chat.html»: скрипт (вынесен из страницы, текст без правок).
const params = new URLSearchParams(location.search);
const type = params.get('type');       // 'room' | 'dm'
const id = type === 'dm' ? Number(params.get('id')) : params.get('id');
const label = params.get('label');
const token = params.get('token');
const serverUrl = params.get('serverUrl');
const me = JSON.parse(localStorage.getItem('me') || 'null');
installErrorReporting(serverUrl, token, 'chat'); // см. ui-kit.js

document.getElementById('label').textContent = label;
if (type !== 'dm') document.getElementById('statusDot').style.display = 'none';

// Настройка "Скрывать имя в сообщениях" — только в личных чатах (в общей комнате имя нужно, чтобы
// различать реплики). Применяется сразу во всех открытых окнах при переключении слайдера (см.
// onSettingsChanged), не только при следующем открытии чата.
function applyHideNames(settings) {
  document.body.classList.toggle('hide-names', type === 'dm' && !!settings.hideNameInMessages);
}
desktop.getSettings().then(applyHideNames);
desktop.onSettingsChanged(applyHideNames);

// Текст статуса собеседника: для "отошёл" — сколько времени он уже отошёл, а не просто "AFK"
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
// Плюс строка "с какого момента" (since — от сервера, formatStatusSince из ui-kit.js), как в тултипах ростера.
function statusTitle(state, idleSince, since) {
  const sinceLine = formatStatusSince(state, since);
  return sinceLine ? `${statusLabel(state, idleSince)}\n${sinceLine}` : statusLabel(state, idleSince);
}
document.getElementById('statusDot').title = statusTitle('offline');

// Вторая строка шапки (под именем): «печатает…», пока собеседник набирает, иначе его статус.
// В комнате и группе статуса нет — там строка появляется только на время «печатает».
let headerState = 'offline', headerIdleSince = null, headerTyping = '';
function paintHeaderSub() {
  const el = document.getElementById('labelSub');
  if (headerTyping) { el.textContent = headerTyping; el.className = 'hsub typing'; return; }
  el.className = 'hsub';
  if (type !== 'dm') { el.textContent = ''; return; }
  if (headerState === 'active') el.textContent = 'В сети';
  else if (headerState === 'idle') el.textContent = headerIdleSince ? `Отошёл · ${formatIdleDuration(headerIdleSince).replace(' назад', '')}` : 'Отошёл';
  else el.textContent = 'Не в сети';
}
paintHeaderSub();

// Всплывающая карточка по клику на имя — то же самое, что тултип у точки статуса (см. statusTitle
// выше), плюс имена ПК: если у собеседника несколько одновременных подключений под одним аккаунтом
// (сидит с двух компов), сервер уже присылает их все в presence.hosts (см. presenceSnapshot в
// server.js) — просто не показывали эту часть нигде в интерфейсе.
let lastPresence = null; // последний presence этого собеседника — чтобы перерисовать карточку, если она открыта, когда придёт обновление
const presencePanel = document.getElementById('presencePanel');
function presencePopupHtml(p) {
  const state = p ? p.state : 'offline';
  let html = `<div class="pp-state"><span class="dot2 ${state}"></span>${escapeHtml(statusLabel(state, p?.idleSince))}</div>`;
  const sinceLine = formatStatusSince(state, p?.since);
  if (sinceLine) html += `<div class="pp-since">${escapeHtml(sinceLine)}</div>`;
  const hosts = p?.hosts || [];
  if (hosts.length) {
    html += `<div class="pp-hosts-title">${hosts.length > 1 ? 'Подключён с устройств' : 'Подключён с устройства'}</div>`;
    html += hosts.map((h) => `<div class="pp-host">${uiIcon('monitor')}${escapeHtml(h)}</div>`).join('');
  }
  return html;
}
function renderPresencePanel() {
  presencePanel.innerHTML = presencePopupHtml(lastPresence);
}
function closePresencePanel() {
  presencePanel.classList.remove('open');
}
function togglePresencePanel() {
  const opening = !presencePanel.classList.contains('open');
  if (opening) renderPresencePanel();
  presencePanel.classList.toggle('open', opening);
}
if (type === 'dm') {
  const labelEl = document.getElementById('label');
  labelEl.classList.add('clickable'); // .clickable также снимает -webkit-app-region:drag с имени — иначе клик внутри drag-области шапки не всегда доходит
  labelEl.addEventListener('click', togglePresencePanel);
  document.addEventListener('click', (e) => {
    if (presencePanel.classList.contains('open') && !e.target.closest('#presencePanel') && !e.target.closest('#label')) closePresencePanel();
  });
}

// Собеседник, подключённый ТОЛЬКО через веб-панель администратора (без единого реального хоста),
// не может получить ни сообщение, ни файл — у веб-панели нет интерфейса чата. Композер и вложения
// блокируются, пока у него не появится ещё один хост (запущен десктоп-клиент на реальном ПК).
// canReceiveMessages — общая функция из ui-kit.js (используется и в ростере).
let chatReachable = true;
function updateComposerReachability(hosts) {
  if (type !== 'dm') return;
  chatReachable = canReceiveMessages(hosts);
  document.getElementById('text').disabled = !chatReachable;
  document.getElementById('send').disabled = !chatReachable;
  document.getElementById('attach').disabled = !chatReachable;
  document.getElementById('emojiBtn').disabled = !chatReachable;
  if (!chatReachable) closeEmojiPanel();
  document.getElementById('text').placeholder = chatReachable
    ? 'Написать сообщение...'
    : 'Собеседник недоступен — подключён только через веб-панель администратора';
}

document.getElementById('historyBtn').querySelector('span').innerHTML = uiIcon('history');
document.getElementById('historyBtn').title = 'Открыть историю переписки';
document.getElementById('attach').innerHTML = uiIcon('attach');
document.getElementById('send').innerHTML = uiIcon('send');
document.querySelector('#dropOverlay span').innerHTML = uiIcon('attach');

async function api(path) {
  const res = await fetch(serverUrl + path, { headers: { Authorization: 'Bearer ' + token } });
  return res.json();
}

// Кавычки экранируем наравне с угловыми скобками: значение нередко подставляется в атрибут, где
// собственная кавычка закрыла бы его и всё дальнейшее читалось бы уже как разметка. String() —
// на случай, если вместо строки придёт число или null (у них нет .replace).
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Подсветка совпадений при поиске по истории (см. runSearch) — экранируем текст точно так же, как
// в обычном escapeHtml, и уже В ЭКРАНИРОВАННОЙ строке оборачиваем совпадения запроса в <mark>.
// Запрос экранируем тем же escapeHtml (чтобы сравнивать "как есть" с уже экранированным текстом),
// а затем ещё и как regex-спецсимволы, раз он идёт в new RegExp().
function highlightHtml(text, query) {
  let html = escapeHtml(text);
  const q = (query || '').trim();
  if (q) {
    const pattern = escapeRegex(escapeHtml(q));
    if (pattern) html = html.replace(new RegExp(pattern, 'gi'), (m) => `<mark class="hl">${m}</mark>`);
  }
  return emojiHtml(html); // emoji-символы в тексте — картинками (см. ui-kit.js), не системным шрифтом
}

// Вид файла по расширению — вторая половина подписи в карточке: «284 КБ · Excel».
const FILE_KINDS = {
  Excel: ['xls', 'xlsx', 'xlsm', 'csv'], Word: ['doc', 'docx', 'rtf', 'odt'], PDF: ['pdf'], PowerPoint: ['ppt', 'pptx'],
  'Изображение': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'], 'Архив': ['zip', 'rar', '7z', 'gz', 'tar'],
  'Текст': ['txt', 'log', 'md'], 'Видео': ['mp4', 'avi', 'mkv', 'mov'], 'Звук': ['mp3', 'wav', 'ogg'], 'Сертификат': ['cer', 'crt', 'pfx', 'p12', 'sig'],
};
function fileKind(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (!ext || ext === String(name || '').toLowerCase()) return '';
  for (const [kind, exts] of Object.entries(FILE_KINDS)) if (exts.includes(ext)) return kind;
  return ext.length <= 5 ? ext.toUpperCase() : '';
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

// Галочка прочтения рисуется только у СВОИХ сообщений в личной переписке (в общей комнате читателей
// много, "прочитано/не прочитано" одним битом не выразить) — синяя, если read_at уже проставлен
// сервером (см. markDmRead в server.js), иначе серая.
function readTickHtml(m) {
  if (type !== 'dm' || m.from_id !== me.id) return '';
  // Как в Telegram — одна галочка "отправлено", две галочки "прочитано" (а не одна и та же
  // галочка, просто перекрашенная).
  return `<span class="read-tick${m.read_at ? ' read' : ''}" title="${m.read_at ? 'Прочитано' : 'Отправлено'}">${uiIcon(m.read_at ? 'checkDouble' : 'check')}</span>`;
}

// card: true — вид для панели истории: карточка во всю ширину с шапкой «кто — когда» вместо
// пузыря слева/справа (в истории важнее быстро пробежать глазами, чем видеть, чья реплика с какой стороны).
// «Петров Игорь Николаевич» → «Петров И. Н.» — в карточках истории, как в макете; полное ФИО — в
// подсказке. Имя не из трёх слов (логин, «Центр», «admin») остаётся как есть.
function shortFio(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length !== 3) return String(name || '');
  return `${parts[0]} ${parts[1].charAt(0)}. ${parts[2].charAt(0)}.`;
}

function bubbleHtml(m, { withDate, query, card } = {}) {
  const own = m.from_id === me.id;
  const d = new Date(m.created_at);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const stamp = withDate
    ? (card ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '') + ', ' + time : d.toLocaleDateString('ru-RU') + ' ' + time)
    : time;
  const files = m.files || [];
  const tick = readTickHtml(m);

  // Время сообщения — один и тот же узел, который живёт либо рядом с текстом/файлами, либо в
  // строке реакций, если она есть (см. placeTime и ".msg .reactions-bar .time" в стилях).
  const timeEl = card ? '' : `<span class="time">${stamp}${tick}</span>`;
  const reactions = m.reactions || [];
  const inlineTime = reactions.length ? '' : timeEl;
  const head = card
    ? `<div class="hhead"><span class="hwho${own ? ' me' : ''}" title="${own ? '' : escapeHtml(m.from_user)}">${own ? 'Вы' : escapeHtml(shortFio(m.from_user))}</span><span class="hwhen">${stamp}</span></div>`
    : `<div class="who">${escapeHtml(m.from_user)}</div>`;

  let body = '';
  if (m.text) body += `<div class="txt selectable" data-raw-text="${escapeAttr(m.text)}">${highlightHtml(m.text, query)}${files.length ? '' : inlineTime}</div>`;
  if (files.length) {
    // Все карточки файлов — одинаковой ширины (друг под другом, а не в одну строку с временем
    // у последней — раньше время отнимало место только у последней карточки, и та казалась
    // урезанной по сравнению с остальными). Время сообщения — отдельной строкой под всеми файлами.
    const cards = files.map((f) => {
      // Админ мог удалить файл с диска через веб-панель, не трогая саму переписку (см. normalizeRow
      // в server.js) — вместо карточки, которая всё равно не скачается, показываем это прямо.
      if (f.exists === false) {
        return `<div class="file file-deleted"><span class="fi">${uiIcon('warn')}</span><span class="fmeta"><span class="fn">${escapeHtml(f.name || 'файл')}</span><span class="fs">Файл удалён с сервера</span></span></div>`;
      }
      // Без токена в href — короткоживущий токен на скачивание запрашивается прямо перед кликом
      // (см. wireFileClicks/wireMessageContextMenu), а не подставляется здесь заранее: ссылка может
      // провисеть в DOM часами, и токен на момент клика уже истёк бы.
      return `<a class="file" href="#" data-url="${escapeAttr(f.url)}" data-name="${escapeAttr(f.name || 'файл')}"><span class="fi"><span class="fi-file">${uiIcon('file')}</span><span class="fi-download">${uiIcon('download')}</span><span class="fi-progress"><svg viewBox="0 0 24 24"><circle class="ring-bg" cx="12" cy="12" r="10"></circle><circle class="ring-bar" cx="12" cy="12" r="10"></circle></svg><span class="fi-pct"></span></span><span class="fi-check">${uiIcon('check')}</span></span><span class="fmeta"><span class="fn">${escapeHtml(f.name || 'файл')}</span><span class="fs">${[fmtSize(f.size), fileKind(f.name)].filter(Boolean).join(' · ')}</span></span></a>`;
    }).join('');
    body += `<div class="files-block">${cards}</div><div class="files-time">${inlineTime}</div>`;
  }
  const toolbar = `<div class="msg-toolbar"><button type="button" class="mt-btn mt-react" data-mid="${m.id}" title="Реакция">${uiIcon('emoji')}</button><button type="button" class="mt-btn mt-reply" data-mid="${m.id}" title="Ответить">${uiIcon('reply')}</button></div>`;
  // has-files — пузырь с карточками файлов: у него свои поля (карточка почти вплотную к краям).
  const cls = `msg${own ? ' own' : ''}${card ? ' hcard' : ''}${files.length ? ' has-files' : ''}`;
  return `<div class="${cls}" data-ts="${m.created_at}" data-id="${m.id}">${toolbar}${card ? head : ''}${replyQuoteHtml(m)}${card ? '' : head}${body}${reactionsMarkup(m.id, reactions, timeEl)}</div>`;
}

// Цитата сообщения, на которое отвечают — снимок автора/текста сделан на сервере в момент отправки
// (см. миграцию reply_snapshot в server.js), поэтому не ломается, даже если само оригинальное
// сообщение сейчас не загружено в этом окне (старая страница пагинации/другой день).
function replyQuoteHtml(m) {
  if (!m.reply) return '';
  return `<div class="reply-quote" data-reply-id="${m.reply.id}"><div class="rq-bar"></div><div class="rq-body"><span class="rq-name">${escapeHtml(m.reply.from_user || '')}</span><span class="rq-text">${escapeHtml((m.reply.text || '').slice(0, 140))}</span></div></div>`;
}

// Реакции — переиспользуется и при первой отрисовке сообщения (bubbleHtml), и при живом обновлении
// по WS-событию 'reaction' (см. applyReactions). trailing — время сообщения: когда реакции есть,
// оно едет последним элементом их строки, чтобы не остаться висеть на уровне текста.
function reactionsMarkup(mid, reactions, trailing = '') {
  if (!reactions || !reactions.length) return '';
  const pills = reactions.map((r) => {
    const mine = r.userIds.includes(me.id);
    return `<button type="button" class="reaction-pill${mine ? ' mine' : ''}" data-emoji="${escapeAttr(r.emoji)}" data-mid="${mid}">${emojiHtml(r.emoji)}<span class="rcount">${r.userIds.length}</span></button>`;
  }).join('');
  return `<div class="reactions-bar">${pills}${trailing}</div>`;
}

// Куда положить время у уже отрисованного сообщения: строка реакций, если она есть, иначе строка
// под файлами, иначе — конец текста (там оно прижимается float'ом). Порядок именно такой, поэтому
// одна и та же функция годится и когда реакцию поставили, и когда сняли последнюю.
function placeTime(msgEl, timeNode) {
  const home = msgEl.querySelector('.reactions-bar') || msgEl.querySelector('.files-time') || msgEl.querySelector('.txt');
  if (home) home.appendChild(timeNode);
}

// Пересборка реакций уже отрисованного сообщения. Узел времени вынимаем ДО пересборки и потом
// возвращаем тот же самый, а не рисуем заново: он несёт галочку прочтения, которая к этому моменту
// могла уже перекраситься в "прочитано" (см. applyReadReceipt) — перерисовка откатила бы её.
// Плюс он вполне может лежать внутри той самой строки реакций, которую мы сейчас заменим.
function applyReactions(msgEl, mid, reactions) {
  const timeNode = msgEl.querySelector('.time');
  if (timeNode) timeNode.remove();
  const bar = msgEl.querySelector('.reactions-bar');
  const html = reactionsMarkup(mid, reactions);
  if (bar) { if (html) bar.outerHTML = html; else bar.remove(); }
  else if (html) msgEl.insertAdjacentHTML('beforeend', html);
  if (timeNode) placeTime(msgEl, timeNode);
}

// Живое обновление галочек на уже отрисованных своих сообщениях, когда приходит read-receipt —
// без этого пришлось бы перезагружать историю, чтобы увидеть, что собеседник прочитал ответ.
function applyReadReceipt(upTo) {
  document.querySelectorAll('#messages .msg.own[data-ts]').forEach((el) => {
    if (Number(el.dataset.ts) > upTo) return;
    const tick = el.querySelector('.read-tick');
    if (!tick || tick.classList.contains('read')) return;
    tick.classList.add('read');
    tick.title = 'Прочитано';
    tick.innerHTML = uiIcon('checkDouble'); // была одна галочка ("отправлено") — становится две
  });
}

// ---------- "Новые сообщения" — та же логика, что в окне рассылок (см. addLiveBroadcast/loadFeed
// там же по смыслу): полоска перед первым непрочитанным ВХОДЯЩИМ сообщением, прячется по клику или
// прокрутке — но не мгновенно, а с трёхсекундной паузой (см. scheduleUnreadClear), чтобы её успели
// увидеть, даже если клик/скролл случились почти сразу. Метка "последнее увиденное" хранится в
// localStorage персонально на этот диалог (dm:id или room:id) — переживает закрытие окна. ----------
const LAST_SEEN_KEY = `chatLastSeenTs:${type}:${id}`;
function getLastSeenTs() { return Number(localStorage.getItem(LAST_SEEN_KEY)) || 0; }
function setLastSeenTs(ts) { if (ts) localStorage.setItem(LAST_SEEN_KEY, String(ts)); }
// Общая комната и группы: своей отметки о прочтении на сервере нет (читателей много, см.
// readTickHtml), поэтому "что уже новое" определяем по локальной метке "докуда я долистал". Она
// не работает при самом первом открытии диалога — метки в localStorage ещё нет, и полоска
// отметила бы новым вообще всё, что было отправлено сегодня. Разрываем это тем же приёмом, что и
// раньше: при первом открытии сразу проставляем метку на "сейчас" — то, что уже в истории на этот
// момент, считается прочитанным по умолчанию, а всё, что придёт ПОСЛЕ, покажет разделитель как
// обычно. Для личных чатов (см. addMessage ниже) это не нужно вовсе — там есть кое-что понадёжнее.
if (type !== 'dm' && !getLastSeenTs()) setLastSeenTs(Date.now());
let maxKnownTs = getLastSeenTs(); // растёт по мере отрисовки/получения входящих в этой сессии
let hasUnreadDivider = false;
let unreadClearTimer = null;
let programmaticScroll = false; // чтобы автоскролл к новому сообщению не считался "пользователь прокрутил"
function unreadDividerHtml() { return `<div class="unread-divider" id="unreadDivider"><span>Новые сообщения</span></div>`; }

// "Пользователь смотрит конец ленты" — с запасом в пару строк, чтобы это не ломалось от пары
// пикселей округления при дробном масштабе интерфейса (см. uiScale).
function isNearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 60; }

function addMessage(m) {
  const box = document.getElementById('messages');
  const incoming = m.from_id !== me.id;
  // Личный чат: "непрочитано" — то, что говорит СЕРВЕР (read_at ещё не проставлен у входящего
  // сообщения), а не локальная метка "докуда я долистал" в localStorage. Раньше использовалась
  // только метка — и она в принципе не знает о сообщениях, которые пришли ДО самого первого
  // открытия этого диалога на этом компьютере: при первом открытии метка сразу выставлялась на
  // "сейчас", молча объявляя всё уже присланное прочитанным, без единого read-receipt на сервер.
  // Кружок непрочитанного в ростере после этого возвращался при каждом перезапуске клиента — сервер
  // отвечал по своим данным, а по ним сообщения и правда ещё не были прочитаны. read_at свободен от
  // этой проблемы: он не про то, что запомнил этот конкретный компьютер, а про факт на сервере.
  const isUnread = type === 'dm'
    ? incoming && m.read_at == null
    : incoming && getLastSeenTs() && m.created_at > getLastSeenTs();
  if (isUnread && !hasUnreadDivider) {
    box.insertAdjacentHTML('beforeend', unreadDividerHtml());
    hasUnreadDivider = true;
  }
  // В ленте окна — только сегодняшние сообщения (остальное — в «Истории»); плашка сверху говорит об этом прямо.
  if (!box.querySelector('.day-sep')) {
    const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    box.insertAdjacentHTML('afterbegin', `<div class="day-sep">Сегодня, ${today}</div>`);
  }
  const div = document.createElement('div');
  div.innerHTML = bubbleHtml(m);
  box.appendChild(div.firstElementChild);
  // Пузырь "печатает" должен оставаться в самом низу. Обычно его к этому моменту уже сняли (см.
  // ws.onmessage), но в комнате может печатать один, а сообщение прийти от другого.
  const typing = document.getElementById('typingBubble');
  if (typing) box.appendChild(typing);
  if (incoming && m.created_at > maxKnownTs) maxKnownTs = m.created_at;
  programmaticScroll = true;
  box.scrollTop = box.scrollHeight;
}

function clearUnreadDivider() {
  if (!hasUnreadDivider) return;
  clearTimeout(unreadClearTimer);
  unreadClearTimer = null;
  document.getElementById('unreadDivider')?.remove();
  hasUnreadDivider = false;
  setLastSeenTs(maxKnownTs); // "прочитано" — запоминаем, переживёт закрытие окна
  // Тем же сигналом (клик/скролл, спустя те же 3 секунды) сообщаем серверу, что сообщения собеседника
  // до maxKnownTs прочитаны — см. markDmRead в server.js. Только для личных чатов: в общей комнате
  // "прочитано кем-то одним" не имеет смысла, галочек там нет (см. readTickHtml).
  if (type === 'dm') sendPayload({ type: 'read', peer: id, upTo: maxKnownTs });
}
function scheduleUnreadClear() {
  if (!hasUnreadDivider) return;
  clearTimeout(unreadClearTimer);
  unreadClearTimer = setTimeout(clearUnreadDivider, 3000);
}
document.addEventListener('click', scheduleUnreadClear);
document.getElementById('messages').addEventListener('scroll', () => {
  if (programmaticScroll) { programmaticScroll = false; return; } // это мы сами долистали, не пользователь
  scheduleUnreadClear();
});
// Окно уже было открыто (в фоне/свёрнуто) и получило сообщение через свой WS — вернулись к нему
// Alt+Tab'ом или кликом по панели задач, вообще не кликая внутри самого чата. loadHistory() здесь
// не перезапускается (страница не перезагружается), поэтому без отдельного слушателя это тоже
// осталось бы непрочитанным до случайного клика.
window.addEventListener('focus', scheduleUnreadClear);

// Чат "очищается" визуально каждый день — при обычном открытии показываем только сегодняшние
// сообщения; вся остальная переписка никуда не пропадает и доступна через кнопку "История".
function todayRange() {
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { since, until: since + 24 * 3600 * 1000 };
}

async function loadHistory() {
  const { since, until } = todayRange();
  const q = `since=${since}&until=${until}`;
  const items = type === 'room' ? await api(`/api/history/room/${id}?${q}`) : await api(`/api/history/dm/${id}?${q}`);
  items.forEach(addMessage);
  // Окно открыли — значит уже увидели непрочитанное (addMessage выше и так доскроллил до конца).
  // Раньше отметка "прочитано" уходила на сервер только по клику/скроллу внутри чата — а просто
  // открыть диалог и сразу закрыть клиент, ничего не кликнув, этого не считалось. Кружок непрочи-
  // танного и разделитель "Новые сообщения" в такой ситуации возвращались после перезапуска: сервер
  // корректно отвечал по своим данным — read_at так и не был проставлен, значит по его данным
  // сообщения и правда ещё не прочитаны. scheduleUnreadClear() — тот же путь, что у клика/скролла,
  // с той же трёхсекундной паузой (разделитель успевает мелькнуть, а не исчезает мгновенно).
  scheduleUnreadClear();
}

let ws, wsReadyQueue = [];
let wsLostTimer = null; // см. showConnectionLostModal в ui-kit.js
let wsReconnectDelay = 2000; // экспоненциальный бэкофф между попытками (см. onclose ниже)
function connectWs() {
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  ws = new WebSocket(`${wsUrl}?token=${token}&host=${encodeURIComponent(desktop.hostname)}`
    // Версия и сборка — чтобы администратор в веб-панели видел, у кого что установлено, и
    // мог понять, до кого обновление ещё не доехало (см. /api/admin/clients в server.js).
    + `&ver=${encodeURIComponent(desktop.appVersion)}&track=${encodeURIComponent(desktop.buildTrack)}`);
  // У этого окна своё отдельное подключение к серверу — если оно не будет сообщать свой статус,
  // сервер посчитает его вечно "активным" и это перекроет настоящий статус AFK от окна ростера
  // (баг, который был: "Отошёл" не появлялся, пока открыто хоть одно окно чата). Статус на момент
  // подключения берём реальный, а не всегда "в сети" — иначе на пару секунд перебивало настоящий
  // AFK, пока не придёт ближайший 15-секундный тик с исправлением.
  ws.onopen = async () => {
    clearTimeout(wsLostTimer);
    wsLostTimer = null;
    wsReconnectDelay = 2000;
    hideConnectionLostModal();
    const { state } = await desktop.getIdleState();
    ws.send(JSON.stringify({ type: 'status', state }));
    wsReadyQueue.forEach(fn => fn());
    wsReadyQueue = [];
  };
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'presence' && type === 'dm') {
      const p = data.users[id];
      const state = p ? p.state : 'offline';
      document.getElementById('statusDot').className = 'dot ' + state;
      document.getElementById('statusDot').title = statusTitle(state, p?.idleSince, p?.since);
      headerState = state; headerIdleSince = p?.idleSince || null; paintHeaderSub();
      updateComposerReachability(p?.hosts);
      lastPresence = p;
      if (presencePanel.classList.contains('open')) renderPresencePanel(); // если карточка уже открыта — обновляем вживую
    }
    // Собеседник (в этом окне — data.peer) прочитал мои сообщения по data.upTo включительно —
    // перекрашиваем галочки уже отрисованных своих сообщений из серых в синие, без перезагрузки.
    if (data.type === 'read-receipt' && type === 'dm' && data.peer === id) applyReadReceipt(data.upTo);
    if (data.type === 'typing') {
      const belongsTyping = type === 'room' ? data.room === id : data.from_id === id;
      if (belongsTyping) showTypingIndicator(data.from_user);
      return;
    }
    // Реакция добавлена/снята/заменена — сообщение может быть отрисовано и в основной ленте, и
    // в панели истории одновременно, поэтому обновляем везде, где сейчас есть карточка с этим id.
    if (data.type === 'reaction') {
      document.querySelectorAll(`[data-id="${data.messageId}"]`).forEach((el) => {
        applyReactions(el, data.messageId, data.reactions);
      });
      return;
    }
    if (data.type !== 'message') return;
    const belongs = type === 'room' ? data.room === id : (data.from_id === id || data.to_id === id);
    if (belongs) { hideTypingIndicator(); addMessage(data); } // раз сообщение пришло — печатать закончил
  };
  ws.onclose = () => {
    if (window.appShuttingDown) return; // выключается ПК — не переподключаемся и не мигаем модалкой
    if (!wsLostTimer) wsLostTimer = setTimeout(() => { wsLostTimer = null; showConnectionLostModal(connectWs); }, 5000);
    // Бэкофф: 2с → ×1.5 после каждой неудачи, потолок 30с — при обрыве сети на несколько часов
    // это фоновые редкие попытки, а не спам раз в 2 секунды. Успешное onopen сбрасывает задержку.
    setTimeout(connectWs, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
  };
}

desktop.onIdleState(({ state }) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'status', state }));
});

// ---------- "Печатает..." — ничего не хранится на сервере, чистая ретрансляция (см. server.js).
// Отправляем не чаще раза в TYPING_THROTTLE_MS (иначе WS-событие на каждую нажатую клавишу), а у
// получателя индикатор гаснет сам через TYPING_TIMEOUT_MS без нового события — эквивалент явного
// "закончил печатать", которого сервер не шлёт.
const TYPING_THROTTLE_MS = 2500;
const TYPING_TIMEOUT_MS = 4000;
let lastTypingSentAt = 0;
function sendTyping() {
  if (!textEl.value.trim()) return; // стёр всё — не поддерживаем индикатор пустым полем
  const now = Date.now();
  if (now - lastTypingSentAt < TYPING_THROTTLE_MS) return;
  lastTypingSentAt = now;
  sendPayload(type === 'room' ? { type: 'typing', room: id } : { type: 'typing', to: id });
}
let typingHideTimer = null;
function showTypingIndicator(name) {
  const box = document.getElementById('messages');
  // Доскроллить вниз можно только если пользователь и так внизу: если он ушёл читать старую
  // переписку, дёргать его ленту из-за того, что кто-то начал печатать, нельзя.
  const follow = isNearBottom(box);
  let el = document.getElementById('typingBubble');
  if (!el) {
    el = document.createElement('div');
    el.id = 'typingBubble';
    el.className = 'msg typing-bubble';
    el.innerHTML = '<div class="who"></div><div class="tdots"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>';
    box.appendChild(el);
  } else if (el !== box.lastElementChild) {
    box.appendChild(el); // держим пузырь последним — после него могли добавиться сообщения
  }
  // Имя — только в комнате/группе, где печатать может кто угодно. В личном чате оно очевидно и
  // лишняя строка только растит пузырь.
  const who = el.querySelector('.who');
  who.textContent = type === 'room' ? name : '';
  who.style.display = type === 'room' ? '' : 'none';
  if (follow) { programmaticScroll = true; box.scrollTop = box.scrollHeight; }
  headerTyping = type === 'room' ? `${name} печатает…` : 'печатает…'; paintHeaderSub();
  clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(hideTypingIndicator, TYPING_TIMEOUT_MS);
}
function hideTypingIndicator() {
  clearTimeout(typingHideTimer);
  typingHideTimer = null;
  headerTyping = ''; paintHeaderSub();
  const el = document.getElementById('typingBubble');
  if (el) el.remove();
}

// ---------- Ответ на сообщение (reply) ----------
let replyingTo = null; // { id, from_user, text } | null
function paintReplyBanner() {
  const el = document.getElementById('replyBanner');
  if (!replyingTo) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.querySelector('.rb-name').textContent = replyingTo.from_user;
  el.querySelector('.rb-text').textContent = replyingTo.text;
}
function clearReplyingTo() { replyingTo = null; paintReplyBanner(); }
function startReplyTo(mid) {
  const el = document.querySelector(`#messages [data-id="${mid}"], #hpMessages [data-id="${mid}"]`);
  if (!el) return;
  const from_user = el.querySelector('.who')?.textContent || label;
  const text = el.querySelector('.txt')?.dataset.rawText || (el.querySelector('.fn') ? '📎 ' + el.querySelector('.fn').textContent : '');
  replyingTo = { id: mid, from_user, text };
  paintReplyBanner();
  textEl.focus();
}
document.getElementById('rbClose').addEventListener('click', clearReplyingTo);

// ---------- Реакции ----------
function toggleReaction(mid, emoji) {
  sendPayload({ type: 'react', messageId: mid, emoji });
}
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🙏', '✅'];
let quickReactPopup = null;
function closeQuickReact() { quickReactPopup?.remove(); quickReactPopup = null; }
function openQuickReact(btn) {
  closeQuickReact();
  const mid = Number(btn.dataset.mid);
  const pop = document.createElement('div');
  pop.className = 'quick-react-popup';
  pop.innerHTML = QUICK_REACTIONS.map((e) => `<button type="button" data-emoji="${escapeAttr(e)}">${emojiHtml(e)}</button>`).join('');
  document.body.appendChild(pop); // сначала в DOM — иначе offsetWidth/offsetHeight ниже ещё не посчитаны
  const rect = btn.getBoundingClientRect();
  pop.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 4)) + 'px';
  pop.style.top = Math.max(4, rect.top - pop.offsetHeight - 4) + 'px';
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-emoji]');
    if (!b) return;
    toggleReaction(mid, b.dataset.emoji);
    closeQuickReact();
  });
  quickReactPopup = pop;
}
document.addEventListener('click', (e) => {
  if (quickReactPopup && !e.target.closest('.quick-react-popup') && !e.target.closest('.mt-react')) closeQuickReact();
});

// Клик по цитате (reply-quote) прокручивает к оригиналу, если он сейчас загружен в этом окне —
// текст цитаты в самой карточке (reply_snapshot с сервера) не зависит от того, найдётся ли оригинал.
function scrollToMessage(mid) {
  const el = document.querySelector(`#messages [data-id="${mid}"]`) || document.querySelector(`#hpMessages [data-id="${mid}"]`);
  if (!el) { chatToast('Исходное сообщение не загружено в этом окне'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 900);
}

function wireMessageToolbar(container) {
  container.addEventListener('click', (e) => {
    const reactBtn = e.target.closest('.mt-react');
    if (reactBtn) { e.stopPropagation(); openQuickReact(reactBtn); return; }
    const replyBtn = e.target.closest('.mt-reply');
    if (replyBtn) { e.stopPropagation(); startReplyTo(Number(replyBtn.dataset.mid)); return; }
    const pill = e.target.closest('.reaction-pill');
    if (pill) { e.stopPropagation(); toggleReaction(Number(pill.dataset.mid), pill.dataset.emoji); return; }
    const quote = e.target.closest('.reply-quote');
    if (quote) { e.stopPropagation(); scrollToMessage(Number(quote.dataset.replyId)); return; }
  });
}

function sendPayload(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  else wsReadyQueue.push(() => ws.send(JSON.stringify(payload)));
}

// Тост должен появляться НАД строкой ввода, а не поверх неё — а высота composer не фиксирована
// (растёт с многострочным текстом), поэтому отступ считаем от его реальной высоты каждый раз.
function chatToast(message, opts = {}) {
  const composerHeight = document.getElementById('composer').offsetHeight;
  uiToast(message, { ...opts, bottomOffset: composerHeight + 12 });
}

function send() {
  if (!chatReachable) return;
  const input = document.getElementById('text');
  const text = input.value.trim();
  if (!text) return;
  const payload = type === 'room' ? { type: 'send', room: id, text } : { type: 'send', to: id, text };
  if (replyingTo) payload.replyTo = replyingTo.id;
  sendPayload(payload);
  clearReplyingTo();
  input.value = '';
  input.style.height = 'auto'; // сброс авто-роста после отправки — снова однострочное поле
  lastTypingSentAt = 0; // следующее нажатие клавиши для НОВОГО сообщения не должно ждать throttle
}

// Enter — отправляет сообщение; Shift+Enter — переносит строку (для этого поле ввода и сделано
// textarea, а не обычным input, у которого многострочный текст в принципе невозможен).
const textEl = document.getElementById('text');
textEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape' && replyingTo) { e.preventDefault(); clearReplyingTo(); }
});
textEl.addEventListener('input', () => {
  textEl.style.height = 'auto';
  textEl.style.height = Math.min(textEl.scrollHeight, 120) + 'px';
  sendTyping();
});

// Базовый набор эмодзи (как в разделе "часто используемые" на iPhone) — не полный юникодный
// список, а компактная сетка самых ходовых смайликов/жестов для рабочей переписки.
const EMOJI_LIST = [
  '😀', '😂', '🤣', '😊', '😉', '😍', '😘', '🥰', '😎', '🤩',
  '🙂', '🙃', '😇', '🤔', '😐', '😴', '😪', '😭', '😢', '😡',
  '🤯', '😱', '🥳', '😅', '😬', '🤫', '🤐', '🙄', '😏', '😜',
  '👍', '👎', '👏', '🙏', '👌', '✌️', '🤝', '💪', '🤞', '👋',
  '❤️', '🔥', '🎉', '✅', '❌', '⭐', '💯', '⏰', '☕', '📎',
];
const emojiPanel = document.getElementById('emojiPanel');
const emojiBtn = document.getElementById('emojiBtn');
emojiBtn.innerHTML = uiIcon('emoji');
// data-emoji хранит исходный символ для вставки в textarea (см. клик ниже) — сама кнопка теперь
// содержит картинку (emojiHtml), а не текстовый символ, чтобы выглядеть так же, как в сообщениях.
emojiPanel.innerHTML = EMOJI_LIST.map((e) => `<button type="button" data-emoji="${escapeAttr(e)}">${emojiHtml(e)}</button>`).join('');

function closeEmojiPanel() {
  emojiPanel.classList.remove('open');
  emojiBtn.classList.remove('active');
}
function toggleEmojiPanel() {
  const opening = !emojiPanel.classList.contains('open');
  emojiPanel.classList.toggle('open', opening);
  emojiBtn.classList.toggle('active', opening);
}
emojiBtn.addEventListener('click', toggleEmojiPanel);
emojiPanel.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const emoji = btn.dataset.emoji;
  const start = textEl.selectionStart ?? textEl.value.length;
  const end = textEl.selectionEnd ?? textEl.value.length;
  textEl.value = textEl.value.slice(0, start) + emoji + textEl.value.slice(end);
  const caret = start + emoji.length;
  textEl.focus();
  textEl.setSelectionRange(caret, caret);
  textEl.dispatchEvent(new Event('input')); // пересчитать высоту textarea, если добавили несколько подряд
});
document.addEventListener('click', (e) => {
  if (emojiPanel.classList.contains('open') && !e.target.closest('#emojiBtn') && !e.target.closest('#emojiPanel')) closeEmojiPanel();
});

async function uploadFile(file) {
  const formHeaders = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' };
  let res;
  try {
    res = await fetch(`${serverUrl}/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: formHeaders, body: file });
  } catch {
    throw new Error('Сервер недоступен — проверьте подключение и повторите попытку.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Сервер ответил ошибкой (${res.status})`);
  }
  return res.json(); // { url, name, size }
}

// Несколько файлов + подпись (если есть) уходят ОДНИМ сообщением — сервер хранит произвольное
// число файлов в одной записи, поэтому в ленте это тоже один пузырь, а не россыпь отдельных.
async function sendFilesWithCaption(files, caption) {
  let uploaded;
  try {
    uploaded = await Promise.all(files.map(uploadFile));
  } catch (e) {
    uiAlert(e.message, files.length > 1 ? 'Не удалось отправить файлы' : 'Не удалось отправить файл');
    return;
  }
  const base = type === 'room' ? { type: 'send', room: id, text: caption } : { type: 'send', to: id, text: caption };
  sendPayload({ ...base, files: uploaded });
  chatToast(files.length > 1 ? 'Файлы успешно отправлены' : 'Файл успешно отправлен');
}

// ---------- Модалка выбора способа отправки: быстро или с подписью ----------
function openSendFilesModal(files) {
  const count = files.length;
  const title = count === 1 ? 'Отправить файл' : `Отправить файлы (${count})`;
  const noun = count === 1 ? 'файл' : 'файлы';

  const overlay = document.createElement('div');
  overlay.className = 'ui-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ui-modal-box sfp-box';
  box.innerHTML = `
    <div class="ui-modal-title">${uiIcon('file')} ${title}</div>
    <div class="sfp-list">${files.map(f => `<div class="sfp-item"><span class="sfp-fn">${escapeHtml(f.name)}</span><span class="sfp-fs">${fmtSize(f.size)}</span></div>`).join('')}</div>
    <div class="sfp-split">
      <button class="sfp-half sfp-quick" id="sfpQuick">
        <div class="sfp-half-t">${uiIcon('send')} Быстро</div>
        <div class="sfp-half-d">Отправить ${noun} сразу, без подписи</div>
      </button>
      <div class="sfp-half sfp-caption">
        <div class="sfp-half-t">С подписью</div>
        <input id="sfpCaptionInput" placeholder="Текст к ${noun}у...">
        <button id="sfpCaptionSend">Отправить</button>
      </div>
    </div>
    <div class="sfp-cancel-row"><button id="sfpCancel">Отмена</button></div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('sfpCancel').onclick = close;
  document.getElementById('sfpQuick').onclick = () => { close(); sendFilesWithCaption(files, ''); };
  const captionInput = document.getElementById('sfpCaptionInput');
  const sendWithCaption = () => { const caption = captionInput.value.trim(); close(); sendFilesWithCaption(files, caption); };
  document.getElementById('sfpCaptionSend').onclick = sendWithCaption;
  captionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendWithCaption(); });
  captionInput.focus();
}

document.getElementById('attach').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length && chatReachable) openSendFilesModal(files);
});

// ---------- Drag-and-drop: перетащили файлы прямо из проводника в окно чата ----------
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dragCounter++;
  document.getElementById('dropOverlay').classList.add('active');
});
window.addEventListener('dragover', (e) => e.preventDefault()); // без этого drop не сработает
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) document.getElementById('dropOverlay').classList.remove('active');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('dropOverlay').classList.remove('active');
  if (!chatReachable) return;
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) openSendFilesModal(files);
});

// Файлы, отправленные через правый клик по контакту в ростере (окно чата могло только что открыться) —
// приходят одним пакетом и уходят одним сообщением, как и любая другая множественная отправка.
// (Сам пункт меню в ростере уже не появится для недоступного контакта — здесь просто вторая линия защиты.)
desktop.onFilesToSend((files) => {
  if (!chatReachable) return;
  const base = type === 'room' ? { type: 'send', room: id, text: '' } : { type: 'send', to: id, text: '' };
  sendPayload({ ...base, files });
});
desktop.onShowAlert(({ message, title }) => uiAlert(message, title));

// ---------- История: по дням и полнотекстовый поиск ----------
let daysCache = [];

function dayLabel(dayStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = dayStr.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); // «4 октября», без нуля — как в макете
}
function dayRange(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const since = new Date(y, m - 1, d).getTime();
  return { since, until: since + 24 * 3600 * 1000 };
}
function monthLabel(key) { // key = 'YYYY-MM'
  const [y, m] = key.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  // «октябрь 2026 г.» → «Октябрь 2026»: в узкой колонке «г.» только занимает место.
  return (label.charAt(0).toUpperCase() + label.slice(1)).replace(/\s*г\.$/, '');
}

// Сообщения и строка ввода плавно гаснут и сдвигаются вниз, пока не закончится transition — и только
// тогда по-настоящему убираются из раскладки (display:none), иначе остаются невидимыми, но
// занимающими место (тот же приём, что у списка контактов в ростере при открытой панели профиля).
function hideChatBodySmoothly() {
  const box = document.getElementById('messages');
  // display:none обнуляет scrollHeight/scrollTop элемента (и то и другое читается как 0, пока он
  // скрыт) — если что-то попытается прокрутить его в этот момент (например, addMessage при живом
  // сообщении, пришедшем пока открыта История) или браузер просто не идеально восстановит скролл
  // после возврата в раскладку, список чуть сдвигается от того места, где реально был. Поэтому сами
  // запоминаем позицию явно, а не полагаемся на то, что она переживёт display:none сама по себе.
  box.dataset.wasAtBottom = (box.scrollHeight - box.scrollTop - box.clientHeight < 4) ? '1' : '';
  box.dataset.savedScrollTop = box.scrollTop;
  document.getElementById('replyBanner').style.display = 'none'; // не участвует в fade — просто убираем, пока открыта История
  ['messages', 'composer'].forEach((id) => {
    const el = document.getElementById(id);
    if (el.classList.contains('chat-hidden')) return;
    el.classList.add('chat-hidden');
    setTimeout(() => { if (el.classList.contains('chat-hidden')) el.style.display = 'none'; }, 200);
  });
}
function showChatBodySmoothly() {
  ['messages', 'composer'].forEach((id) => {
    const el = document.getElementById(id);
    el.style.display = 'flex'; // оба flex по базовым стилям — сначала возвращаем в раскладку (ещё прозрачным)...
    void el.offsetHeight; // ...форсируем reflow, чтобы transition не схлопнулся...
    el.classList.remove('chat-hidden'); // ...и только теперь плавно проявляем
  });
  const box = document.getElementById('messages');
  // Если до открытия Истории список был прокручен в самый низ — возвращаем именно в (новый) низ,
  // а не на старую абсолютную позицию: пока История была открыта, могли прийти новые сообщения
  // (см. addMessage), и scrollHeight мог вырасти. Если же пользователь читал более старые сообщения
  // (не внизу) — просто восстанавливаем точную позицию, где он и был.
  programmaticScroll = true;
  box.scrollTop = box.dataset.wasAtBottom ? box.scrollHeight : Number(box.dataset.savedScrollTop || 0);
  paintReplyBanner(); // восстановит видимость, если ответ так и не был отправлен/отменён за время открытой Истории
}

async function openHistoryPanel() {
  hideChatBodySmoothly();
  document.getElementById('historyPanel').classList.add('visible'); // а сама панель проявляется плавно
  document.getElementById('historyBtn').classList.add('active');
  document.getElementById('historyBtn').title = 'Скрыть историю переписки';
  const row = document.getElementById('hpSearchRow');
  row.innerHTML = `<div class="hp-search">${uiIcon('search')}<input id="hpSearch" placeholder="Поиск по всей истории переписки…"><span id="hpCount"></span></div>`;
  document.getElementById('hpSearch').addEventListener('input', debounceSearch);
  await loadDays();
  if (daysCache.length) selectDay(daysCache[0].day);
  else document.getElementById('hpMessages').innerHTML = '<div id="hpEmpty">Переписки пока не было</div>';
}
function closeHistoryPanel() {
  document.getElementById('historyPanel').classList.remove('visible'); // сначала плавно скрываем панель...
  showChatBodySmoothly(); // ...и одновременно проявляем сообщения/строку ввода обратно
  document.getElementById('historyBtn').classList.remove('active');
  document.getElementById('historyBtn').title = 'Открыть историю переписки';
}
document.getElementById('historyBtn').addEventListener('click', () => {
  document.getElementById('historyPanel').classList.contains('visible') ? closeHistoryPanel() : openHistoryPanel();
});

// Список дней группируем по месяцам (свернуто, кроме самого свежего) — плоский список за год
// был бы неюзабельным. Быстрый переход к конкретной дате всё равно проще через поиск сверху.
async function loadDays() {
  // Смещение часового пояса ЭТОГО компьютера — чтобы дни группировались как на часах у
  // сотрудника, а не по часовому поясу сервера (getTimezoneOffset() у JS даёт минуты с обратным
  // знаком, поэтому переворачиваем: для UTC+3 получится +180).
  const offsetMinutes = -new Date().getTimezoneOffset();
  daysCache = type === 'room'
    ? await api(`/api/history/room/${id}/days?offsetMinutes=${offsetMinutes}`)
    : await api(`/api/history/dm/${id}/days?offsetMinutes=${offsetMinutes}`);
  const box = document.getElementById('hpDays');
  box.innerHTML = '';
  if (!daysCache.length) return;

  const months = new Map(); // 'YYYY-MM' -> [{day,count}, ...]
  daysCache.forEach(d => {
    const key = d.day.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(d);
  });

  [...months.entries()].forEach(([key, days], idx) => {
    const collapsed = idx !== 0; // самый свежий месяц раскрыт сразу, остальные свёрнуты
    const total = days.reduce((s, d) => s + d.count, 0);

    const header = document.createElement('div');
    header.className = 'mheader' + (collapsed ? ' collapsed' : '');
    header.innerHTML = `<span class="chev">${uiIcon('chevron')}</span><span class="mtitle">${monthLabel(key)}</span><span class="mcount">${total}</span>`;

    const list = document.createElement('div');
    list.className = 'mdays' + (collapsed ? ' collapsed' : '');
    days.forEach(d => {
      const btn = document.createElement('div');
      btn.className = 'dbtn';
      btn.dataset.day = d.day;
      btn.innerHTML = `<span class="dl">${dayLabel(d.day)}</span><span class="cnt" title="Сообщений за день">${d.count}</span>`;
      btn.onclick = () => selectDay(d.day);
      list.appendChild(btn);
    });

    header.onclick = () => { header.classList.toggle('collapsed'); list.classList.toggle('collapsed'); };
    box.appendChild(header);
    box.appendChild(list);
  });
}

// Подгрузка более старых результатов поиска при прокрутке вверх (см. hpState/scroll ниже). День
// (selectDay) не листается постранично — сервер отдаёт день целиком без ограничения LIMIT, там
// нечего подгружать. А вот поиск (roomHistorySearch/dmHistorySearch в server.js) режется по
// HISTORY_PAGE_SIZE (200) — в старом активном диалоге по частому слову легко упереться в этот
// потолок и не увидеть более ранние совпадения без подгрузки.
let hpState = { query: null, oldestId: null, hasMore: false, loading: false };

async function selectDay(day) {
  document.getElementById('hpSearch').value = '';
  [...document.querySelectorAll('#hpDays .dbtn')].forEach(b => b.classList.toggle('active', b.dataset.day === day));
  hpState = { query: null, oldestId: null, hasMore: false, loading: false };
  const { since, until } = dayRange(day);
  const q = `since=${since}&until=${until}`;
  const items = type === 'room' ? await api(`/api/history/room/${id}?${q}`) : await api(`/api/history/dm/${id}?${q}`);
  paintSearchCount(null);
  renderHistoryMessages(items, false);
}
// «4 совпадения» справа в строке поиска. null — поиск не идёт, надпись убрать.
function paintSearchCount(n, more) {
  const el = document.getElementById('hpCount');
  if (!el) return;
  if (n == null) { el.textContent = ''; return; }
  const mod10 = n % 10, mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'совпадение' : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'совпадения' : 'совпадений');
  el.textContent = n ? `${more ? 'более ' : ''}${n} ${word}` : 'нет совпадений';
}

let searchDebounce;
function debounceSearch(e) {
  clearTimeout(searchDebounce);
  const value = e.target.value.trim();
  if (!value) { if (daysCache.length) selectDay(document.querySelector('#hpDays .dbtn.active')?.dataset.day || daysCache[0].day); return; }
  searchDebounce = setTimeout(() => runSearch(value), 250);
}
async function runSearch(text) {
  [...document.querySelectorAll('#hpDays .dbtn')].forEach(b => b.classList.remove('active'));
  hpState = { query: text, oldestId: null, hasMore: false, loading: false };
  const items = type === 'room'
    ? await api(`/api/history/room/${id}?q=${encodeURIComponent(text)}`)
    : await api(`/api/history/dm/${id}?q=${encodeURIComponent(text)}`);
  applySearchPage(items);
  paintSearchCount(items.length, hpState.hasMore);
  renderHistoryMessages(items, true, text);
}
function applySearchPage(items) {
  hpState.hasMore = items.length === 200; // HISTORY_PAGE_SIZE на сервере — полная страница значит, скорее всего, есть ещё
  if (items.length) hpState.oldestId = items[0].id; // items уже в хронологическом порядке (самое старое — первое)
}

function renderHistoryMessages(items, withDate, query) {
  const box = document.getElementById('hpMessages');
  if (!items.length) { box.innerHTML = '<div id="hpEmpty">Ничего не найдено</div>'; return; }
  box.innerHTML = items.map(m => bubbleHtml(m, { withDate, query, card: true })).join('');
  box.scrollTop = box.scrollHeight; // сразу к самым свежим сообщениям за день, а не к началу
}

// Прокрутка почти до самого верха ленты поиска — подгружаем более старую страницу совпадений и
// вставляем её сверху, сохраняя видимую позицию (иначе вставка сверху дёргала бы ленту вниз).
document.getElementById('hpMessages').addEventListener('scroll', async (e) => {
  const box = e.target;
  if (box.scrollTop > 40 || !hpState.hasMore || hpState.loading || !hpState.query) return;
  const state = hpState; // снимок — если пока грузится страница, пользователь переключится на другой
  state.loading = true;  // день/поиск (selectDay/runSearch создают НОВЫЙ hpState), применяем результат
  const prevHeight = box.scrollHeight; // только к тому состоянию, для которого его реально запросили
  const items = type === 'room'
    ? await api(`/api/history/room/${id}?q=${encodeURIComponent(state.query)}&before=${state.oldestId}`)
    : await api(`/api/history/dm/${id}?q=${encodeURIComponent(state.query)}&before=${state.oldestId}`);
  if (state !== hpState) return; // состояние уже сменилось — эта страница больше не актуальна
  applySearchPage(items);
  if (items.length) {
    const frag = document.createElement('div');
    frag.innerHTML = items.map(m => bubbleHtml(m, { withDate: true, query: state.query, card: true })).join('');
    while (frag.firstChild) box.insertBefore(frag.firstChild, box.firstChild);
    box.scrollTop = box.scrollHeight - prevHeight + box.scrollTop;
  }
  state.loading = false;
});

// Клик по прикреплённому файлу — скачивание через главный процесс (webContents.downloadURL),
// а не обычная навигация по ссылке: раньше здесь стоял target="_blank", из-за чего Electron
// открывал вспомогательное пустое окно, которое не закрывалось после сохранения файла.
// Кольцо прогресса: circumference = 2πr, r=10 (совпадает с радиусом окружности в разметке выше)
const RING_CIRCUMFERENCE = 2 * Math.PI * 10;
const activeDownloads = new Map(); // downloadId -> элемент <a class="file">, который сейчас качается

function startDownloadUi(link) {
  const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  link.classList.remove('done');
  link.classList.add('downloading');
  const bar = link.querySelector('.ring-bar');
  const pct = link.querySelector('.fi-pct');
  if (bar) {
    bar.style.strokeDasharray = RING_CIRCUMFERENCE;
    bar.style.strokeDashoffset = RING_CIRCUMFERENCE; // старт с пустого кольца
    bar.classList.add('indeterminate'); // пока не пришёл первый процент — крутится неопределённо
  }
  if (pct) pct.textContent = '';
  activeDownloads.set(id, link);
  return id;
}

desktop.onDownloadProgress(({ id, state, percent }) => {
  const link = activeDownloads.get(id);
  if (!link) return;
  const bar = link.querySelector('.ring-bar');
  const pct = link.querySelector('.fi-pct');

  if (state === 'progressing') {
    if (percent == null) return; // сервер не прислал размер файла — оставляем неопределённое вращение
    if (bar) {
      bar.classList.remove('indeterminate');
      bar.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - percent / 100);
    }
    if (pct) pct.textContent = percent;
    return;
  }

  // Готово (успешно или с ошибкой) — показываем галочку на пару секунд и возвращаем обычную иконку
  activeDownloads.delete(id);
  link.classList.remove('downloading');
  if (state === 'completed') {
    link.classList.add('done');
    setTimeout(() => link.classList.remove('done'), 2500);
    chatToast('Файл успешно скачан');
  } else if (state === 'failed') {
    uiAlert('Не удалось скачать файл — проверьте подключение и повторите попытку.', 'Ошибка скачивания');
  }
});

desktop.onToast(({ message, error }) => chatToast(message, { error }));

// Короткоживущий (60с) токен на скачивание конкретного файла — запрашивается прямо перед тем, как
// он понадобится (клик/ПКМ), а не подставляется в ссылку заранее: карточка файла может пролежать
// в открытом окне часами, а токен в её href к этому моменту уже истёк бы (см. /api/download-token
// в server.js — там же объяснение, зачем это вообще нужно вместо основного сессионного токена).
async function getDownloadUrl(relUrl, name) {
  const { token: dlToken } = await api(`/api/download-token?path=${encodeURIComponent(relUrl)}`);
  return `${serverUrl}${relUrl}?token=${dlToken}&name=${encodeURIComponent(name || 'файл')}`;
}

function wireFileClicks(container) {
  container.addEventListener('click', async (e) => {
    const link = e.target.closest('a.file');
    if (!link) return;
    e.preventDefault();
    const id = startDownloadUi(link);
    try {
      const url = await getDownloadUrl(link.dataset.url, link.dataset.name);
      desktop.downloadFile(url, id);
    } catch {
      chatToast('Не удалось начать скачивание — проверьте подключение.', { error: true });
    }
  });
}
wireFileClicks(document.getElementById('messages'));
wireFileClicks(document.getElementById('hpMessages'));

// ПКМ по сообщению: на файле — "Сохранить как...", на тексте — "Копировать текст".
// Реализовано нативным меню Electron (через главный процесс), т.к. буфер обмена и системный
// диалог "Сохранить как" всё равно должны идти оттуда.
function wireMessageContextMenu(container) {
  container.addEventListener('contextmenu', async (e) => {
    const fileLink = e.target.closest('a.file');
    if (fileLink) {
      e.preventDefault();
      try {
        const url = await getDownloadUrl(fileLink.dataset.url, fileLink.dataset.name);
        desktop.showMessageMenu({ kind: 'file', url, name: fileLink.dataset.name });
      } catch {
        chatToast('Не удалось подготовить файл — проверьте подключение.', { error: true });
      }
      return;
    }
    const txtEl = e.target.closest('.txt');
    if (txtEl) {
      e.preventDefault();
      desktop.showMessageMenu({ kind: 'text', text: txtEl.dataset.rawText || '' });
    }
  });
}
wireMessageContextMenu(document.getElementById('messages'));
wireMessageContextMenu(document.getElementById('hpMessages'));
wireMessageToolbar(document.getElementById('messages'));
wireMessageToolbar(document.getElementById('hpMessages'));

loadHistory();
connectWs();

// Обработчики, которые раньше стояли прямо в разметке (onclick=/onsubmit=): CSP окна запрещает
// встроенный код целиком, поэтому они назначаются отсюда.
document.getElementById('send').addEventListener('click', () => send());
