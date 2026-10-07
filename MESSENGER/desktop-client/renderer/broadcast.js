// Окно «broadcast.html»: скрипт (вынесен из страницы, текст без правок).
const params = new URLSearchParams(location.search);
const token = params.get('token');
const serverUrl = params.get('serverUrl');
const me = JSON.parse(params.get('me') || 'null');
installErrorReporting(serverUrl, token, 'broadcast'); // см. ui-kit.js

// Это же окно работает в двух режимах. Без параметров — привычные объявления всей организации.
// С departmentId — сообщение одному отделу (ПКМ по отделу в списке контактов): тот же composer, та
// же лента, та же история, отличается только круг адресатов. Отдельного окна для этого нет
// намеренно — вся работа с файлами, перетаскиванием, поиском по дням тут уже сделана.
const departmentId = Number(params.get('departmentId')) || null;
const departmentName = params.get('departmentName') || '';
const deptQuery = departmentId ? `&departmentId=${departmentId}` : '';
// Право на рассылки может быть выдано лично человеку ИЛИ всему его отделу — сервер уже считает
// итоговое (эффективное) значение и отдаёт его прямо в /api/me, отдельно спрашивать не нужно.
let canCompose = false;
async function checkComposeAccess() {
  try {
    const res = await fetch(serverUrl + '/api/me', { headers: { Authorization: 'Bearer ' + token } });
    const fresh = await res.json();
    return !!fresh.can_broadcast;
  } catch { return false; }
}

document.getElementById('ttl').innerHTML = departmentId
  ? `<span class="ttl-icon">${uiIcon('group')}</span><span class="ttl-text">Отдел «${escapeHtml(departmentName)}»</span>`
  : `<span class="ttl-icon">${uiIcon('megaphone')}</span><span class="ttl-text">Объявления</span>`;
if (departmentId) {
  // Право "Рассылки" здесь ни при чём: оно про объявление всей организации. Написать своему отделу
  // может любой — написать каждому из них по одному он и так может, список людей открыт.
  document.querySelector('#composer p').textContent = `Сообщение получат только сотрудники отдела «${departmentName}» — уведомлением на компьютер и в их ленту объявлений.`;
  document.getElementById('text').placeholder = 'Текст сообщения отделу...';
  document.getElementById('sendBtn').textContent = 'Отправить отделу';
  document.querySelector('#dropOverlay .dtext').textContent = 'Отпустите, чтобы прикрепить к сообщению';
}
document.getElementById('historyBtn').querySelector('span').innerHTML = uiIcon('history');
document.getElementById('historyBtn').title = 'Найти рассылку по дате или по тексту';
document.querySelector('#dropOverlay span').innerHTML = uiIcon('attach');

// Выбранные файлы рассылки — каждый начинает грузиться на сервер СРАЗУ при выборе (не дожидаясь
// "Отправить всем"), чтобы к моменту отправки текста файлы уже были готовы, а не ждали своей
// очереди. Элемент: { id, file: File, status: 'uploading'|'done'|'error', percent: number|null,
// uploaded: {url,name,size}|null }.
let pendingFiles = [];
const RING_CIRCUMFERENCE = 2 * Math.PI * 10; // тот же радиус кольца (r=10), что и у кольца скачивания ниже

// Открытие/закрытие самой формы рассылки (без ленты — той управляют отдельно, hideFeedSmoothly/
// showFeedSmoothly) — общая функция, чтобы openHistoryPanel могла закрыть уже открытую форму без
// побочного повторного показа ленты (который раньше вызывал заметное мигание при переключении
// "Написать" -> "История": форма сама возвращала ленту, а openHistoryPanel тут же прятала её снова).
function setComposerOpen(open) {
  const btn = document.getElementById('composeBtn');
  document.getElementById('composer').classList.toggle('open', open);
  btn.classList.toggle('active', open);
  btn.title = open ? 'Скрыть форму рассылки' : 'Написать рассылку';
  // .focus() синхронно считает layout (чтобы прокрутить поле в видимую область), а composer в этот
  // момент только начинает разворачиваться через max-height/flex-grow (дорогой relayout сам по
  // себе) — вызванный СРАЗУ при переключении класса .open, focus() форсирует этот layout прямо в
  // момент старта перехода, из-за чего разворачивание визуально дёргалось/подлагивало. Двойной
  // requestAnimationFrame откладывает фокус до следующего отрисованного кадра, когда браузер уже
  // сам посчитал этот layout по расписанию, а не по требованию focus().
  if (open) requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('text').focus()));
}

(async () => {
  canCompose = departmentId ? true : await checkComposeAccess();
  if (!canCompose) return;
  const btn = document.getElementById('composeBtn');
  btn.style.display = 'flex';
  btn.querySelector('span').innerHTML = uiIcon('plus');
  btn.title = departmentId ? 'Написать отделу' : 'Написать рассылку';
  btn.addEventListener('click', () => {
    if (document.getElementById('historyPanel').classList.contains('visible')) closeHistoryPanel();
    const open = !document.getElementById('composer').classList.contains('open');
    setComposerOpen(open);
    if (open) hideFeedSmoothly(); else showFeedSmoothly();
  });
  document.getElementById('attachBtn').innerHTML = uiIcon('attach');
  document.getElementById('attachBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', (e) => {
    addPendingFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });

  // Окно отдела открывают, чтобы написать, — форма сразу открыта, а не спрятана за кнопкой.
  if (departmentId) { setComposerOpen(true); hideFeedSmoothly(); }

  // ---------- Drag-and-drop: перетащили файлы прямо из проводника в окно рассылки ----------
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
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    addPendingFiles(files);
    // Перетащили файл — сразу открываем композер, чтобы было видно, что файл подхватился
    if (!document.getElementById('composer').classList.contains('open')) document.getElementById('composeBtn').click();
  });
})();

// Плавное скрытие/показ ленты сегодняшних рассылок — сначала гаснет (opacity), а когда переход
// закончится, по-настоящему убирается из раскладки (display:none), иначе остаётся невидимой, но
// занимающей место — из-за этого раньше под открытым композером было пустое пространство.
function hideFeedSmoothly() {
  const feed = document.getElementById('feed');
  if (feed.classList.contains('hidden')) return;
  feed.classList.add('hidden');
  setTimeout(() => { if (feed.classList.contains('hidden')) feed.style.display = 'none'; }, 160);
}
function showFeedSmoothly() {
  const feed = document.getElementById('feed');
  feed.style.display = 'flex'; // сначала возвращаем в раскладку (ещё прозрачным)...
  void feed.offsetHeight; // ...форсируем reflow, чтобы transition не схлопнулся...
  feed.classList.remove('hidden'); // ...и только теперь плавно проявляем
}

function chipHtml(entry) {
  const pct = entry.percent != null ? entry.percent : '';
  const offset = entry.percent != null ? RING_CIRCUMFERENCE * (1 - entry.percent / 100) : RING_CIRCUMFERENCE;
  return `<span class="chip ${entry.status}" data-id="${entry.id}">
    <span class="chip-fi">
      <span class="fi-progress"><svg viewBox="0 0 24 24"><circle class="ring-bg" cx="12" cy="12" r="10"></circle><circle class="ring-bar${entry.percent == null ? ' indeterminate' : ''}" cx="12" cy="12" r="10" style="stroke-dasharray:${RING_CIRCUMFERENCE};stroke-dashoffset:${offset}"></circle></svg><span class="fi-pct">${pct}</span></span>
      <span class="fi-check">${uiIcon('check')}</span>
      <span class="fi-error">${uiIcon('warn')}</span>
    </span>
    <span class="chip-fn">${escapeHtml(entry.file.name)}</span>
    <button data-id="${entry.id}" title="${entry.status === 'error' ? 'Убрать (загрузка не удалась)' : 'Убрать'}">${uiIcon('x')}</button>
  </span>`;
}

function renderComposerFiles() {
  const box = document.getElementById('composerFiles');
  box.innerHTML = pendingFiles.map(chipHtml).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = () => {
    pendingFiles = pendingFiles.filter((e) => e.id !== b.dataset.id);
    renderComposerFiles();
  });
  document.getElementById('sendBtn').disabled = pendingFiles.some((e) => e.status === 'uploading');
}

// Точечно обновляет только кольцо прогресса конкретного чипа — без пересборки всего #composerFiles,
// иначе на каждый onprogress-тик (их много) все чипы мигали бы и терялся бы фокус/hover.
function updateChipProgress(entry) {
  const chip = document.querySelector(`#composerFiles .chip[data-id="${entry.id}"]`);
  if (!chip) return;
  const bar = chip.querySelector('.ring-bar');
  const pct = chip.querySelector('.fi-pct');
  if (bar) {
    bar.classList.remove('indeterminate');
    bar.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - entry.percent / 100);
  }
  if (pct) pct.textContent = entry.percent;
}

// fetch() в Electron/Chromium не даёт прогресс отправки тела запроса — только XMLHttpRequest умеет
// upload.onprogress, поэтому загрузка файлов рассылки сделана на нём, а не через fetch, как везде
// в остальном клиенте.
function startUpload(entry) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${serverUrl}/api/upload?name=${encodeURIComponent(entry.file.name)}`);
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    entry.percent = Math.round((e.loaded / e.total) * 100);
    updateChipProgress(entry);
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try { entry.uploaded = JSON.parse(xhr.responseText); entry.status = 'done'; }
      catch { entry.status = 'error'; }
    } else {
      entry.status = 'error';
    }
    renderComposerFiles();
  };
  xhr.onerror = () => { entry.status = 'error'; renderComposerFiles(); };
  xhr.send(entry.file);
}

function addPendingFiles(files) {
  files.forEach((file) => {
    const entry = { id: `pf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file, status: 'uploading', percent: null, uploaded: null };
    pendingFiles.push(entry);
    startUpload(entry);
  });
  renderComposerFiles();
}

async function api(path, opts) {
  const res = await fetch(serverUrl + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

// Кавычки экранируем наравне с угловыми скобками: значение нередко подставляется в атрибут, где
// собственная кавычка закрыла бы его и всё дальнейшее читалось бы уже как разметка. String() —
// на случай, если вместо строки придёт число или null (у них нет .replace).
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Подсветка совпадений при поиске по истории (см. runSearch) — экранируем текст точно так же, как
// в обычном escapeHtml, и уже В ЭКРАНИРОВАННОЙ строке оборачиваем совпадения запроса в <mark>.
function highlightHtml(text, query) {
  let html = escapeHtml(text);
  const q = (query || '').trim();
  if (q) {
    const pattern = escapeRegex(escapeHtml(q));
    if (pattern) html = html.replace(new RegExp(pattern, 'gi'), (m) => `<mark class="hl">${m}</mark>`);
  }
  return emojiHtml(html); // emoji-символы в тексте — картинками (см. ui-kit.js), не системным шрифтом
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

// Инициалы автора для кружка в карточке: первые буквы первых двух слов имени.
function initialsOf(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
}
// Время в карточке: сегодня — «09:15», вчера — «Вчера», раньше — «2 окт». Полная дата — в подсказке.
function itemWhen(ts) {
  const d = new Date(ts); const now = new Date();
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diff === 0) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).replace('.', '');
}

function itemHtml(b, query) {
  const time = new Date(b.created_at).toLocaleString('ru-RU');
  let filesHtml = '';
  (b.files || []).forEach(f => {
    // Админ мог удалить файл с диска через веб-панель, не трогая саму рассылку (см. normalizeRow
    // в server.js) — вместо карточки, которая всё равно не скачается, показываем это прямо.
    if (f.exists === false) {
      filesHtml += `<div class="file-row"><div class="file file-deleted"><span class="fi">${uiIcon('warn')}</span><span class="fmeta"><span class="fn">${escapeHtml(f.name || 'файл')}</span><span class="fs">Файл удалён с сервера</span></span></div></div>`;
      return;
    }
    // Без токена в href — короткоживущий токен на скачивание запрашивается прямо перед кликом
    // (см. wireFileClicks/wireMessageContextMenu), а не подставляется здесь заранее: карточка может
    // провисеть в ленте часами, и токен на момент клика уже истёк бы.
    filesHtml += `<div class="file-row"><a class="file" href="#" data-url="${escapeAttr(f.url)}" data-name="${escapeAttr(f.name || 'файл')}"><span class="fi"><span class="fi-file">${uiIcon('file')}</span><span class="fi-download">${uiIcon('download')}</span><span class="fi-progress"><svg viewBox="0 0 24 24"><circle class="ring-bg" cx="12" cy="12" r="10"></circle><circle class="ring-bar" cx="12" cy="12" r="10"></circle></svg><span class="fi-pct"></span></span><span class="fi-check">${uiIcon('check')}</span></span><span class="fmeta"><span class="fn">${escapeHtml(f.name || 'файл')}</span><span class="fs">${fmtSize(f.size)}</span></span></a></div>`;
  });
  const txtHtml = b.text ? `<div class="txt selectable" data-raw-text="${escapeAttr(b.text)}">${highlightHtml(b.text, query)}</div>` : '';
  // В общей ленте сообщение отделу помечаем — иначе непонятно, почему коллега его не получил.
  // В окне самого отдела метка не нужна: там всё до одного адресовано этому отделу.
  const to = b.department ? `Отдел «${escapeHtml(b.department)}»` : 'Всем сотрудникам';
  const head = `<div class="ihead"><div class="ini">${escapeHtml(initialsOf(b.from_user))}</div><div class="iwho"><div class="who">${escapeHtml(b.from_user)}</div><div class="to">${to}</div></div><span class="time" title="${time}">${itemWhen(b.created_at)}</span></div>`;
  return `<div class="item">${head}${txtHtml}${filesHtml ? `<div class="ifiles">${filesHtml}</div>` : ''}</div>`;
}

// Лента "сегодняшних" рассылок — обнуляется каждый день, как и в чате. Вся история доступна
// через кнопку "История" (панель с днями/месяцами + поиском), а не листанием этой ленты.
function todayRange() {
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { since, until: since + 24 * 3600 * 1000 };
}

// Разделитель "Новые объявления" раньше появлялся только для живых WS-сообщений, пока окно было
// открыто — если окно закрыть и снова открыть уже ПОСЛЕ того, как объявление пришло, разделителя
// не было вообще (loadFeed() просто отрисовывал всё как есть). ID последнего показанного объявления
// хранится в localStorage (переживает закрытие окна, в отличие от переменных в памяти) — при
// загрузке ленты всё, что новее этой метки, тоже помечается разделителем.
// Своя метка на каждый отдел: одна общая означала бы, что открытое окно отдела гасит разделитель
// "новые" в объявлениях всей организации и наоборот.
const LAST_SEEN_KEY = departmentId ? `broadcastLastSeenId:dept:${departmentId}` : 'broadcastLastSeenId';
function getLastSeenId() { return Number(localStorage.getItem(LAST_SEEN_KEY)) || 0; }
function setLastSeenId(id) { if (id) localStorage.setItem(LAST_SEEN_KEY, String(id)); }
let maxKnownBroadcastId = getLastSeenId(); // растёт по мере отрисовки/получения объявлений в этой сессии
function unreadDividerHtml() { return `<div class="unread-divider" id="unreadDivider"><span>Новые</span></div>`; }

async function loadFeed() {
  const { since, until } = todayRange();
  let items;
  try {
    items = await api(`/api/broadcasts?since=${since}&until=${until}${deptQuery}`);
  } catch (e) {
    // Написать отделу может кто угодно, а вот читать его переписку — только его сотрудники
    // (см. departmentScope в server.js). Для постороннего окно остаётся формой отправки.
    const denied = document.getElementById('feed');
    denied.classList.add('empty-state');
    denied.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    return;
  }
  const feed = document.getElementById('feed');
  feed.classList.toggle('empty-state', !items.length);
  const lastSeenId = getLastSeenId();
  const firstUnreadIndex = lastSeenId ? items.findIndex((b) => b.id > lastSeenId) : -1;
  feed.innerHTML = items.map((b, i) => (i === firstUnreadIndex ? unreadDividerHtml() : '') + itemHtml(b)).join('')
    || '<div class="empty">Сегодня рассылок пока не было</div>';
  hasUnreadDivider = firstUnreadIndex !== -1;
  items.forEach((b) => { if (b.id > maxKnownBroadcastId) maxKnownBroadcastId = b.id; });
  // Тот же замкнутый круг, что был в личных сообщениях (см. chat.html): если метку никто раньше не
  // ставил (lastSeenId с самого начала 0), разделитель никогда бы не появился и для будущих
  // объявлений тоже — сама метка выставляется только внутри clearUnreadDivider(), которая
  // срабатывает только если разделитель уже показан. При самом первом открытии окна сразу
  // проставляем метку на максимальный ID из уже загруженного сейчас (то, что уже видно, по
  // умолчанию считается прочитанным) — а всё, что придёт позже, уже корректно покажет разделитель.
  if (!lastSeenId) setLastSeenId(maxKnownBroadcastId);
  // Без этого флага сработавшее от этой строки событие 'scroll' принималось бы за настоящую
  // прокрутку пользователя и сразу запускало 3-секундный таймер скрытия полоски — именно поэтому
  // разделитель пропадал сам через 3 секунды после открытия окна, без единого клика.
  programmaticScroll = true;
  feed.scrollTop = feed.scrollHeight; // сразу показываем самую свежую рассылку, а не листаем сверху
}

async function send() {
  const el = document.getElementById('text');
  const text = el.value.trim();
  if (!text && !pendingFiles.length) return;
  if (pendingFiles.some((e) => e.status === 'uploading')) return; // кнопка и так задизейблена на этот случай
  if (pendingFiles.some((e) => e.status === 'error')) { uiAlert('Уберите файлы, которые не удалось загрузить (крестик на чипе), или перетащите их заново.'); return; }
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = true;
  try {
    // Файлы уже загружены на сервер (см. addPendingFiles/startUpload) — здесь просто собираем
    // сообщение из готовых { url, name, size }, повторно ничего не грузим.
    const files = pendingFiles.map((e) => e.uploaded);
    await api('/api/broadcast', { method: 'POST', body: JSON.stringify({ text, files, departmentId }) });
    el.value = '';
    pendingFiles = [];
    renderComposerFiles();
    document.getElementById('composer').classList.remove('open');
    document.getElementById('composeBtn').classList.remove('active');
    document.getElementById('composeBtn').title = departmentId ? 'Написать отделу' : 'Написать рассылку';
    showFeedSmoothly();
    uiToast(departmentId ? `Сообщение отправлено отделу «${departmentName}»` : 'Рассылка успешно отправлена');
    // Живое обновление придёт по тому же WS, что и всем остальным (эхо собственного отправленного
    // сообщения) — отдельно перезапрашивать ленту не нужно, иначе будет два одинаковых пузыря.
  } catch (e) { uiAlert(e.message); } finally { sendBtn.disabled = pendingFiles.some((e) => e.status === 'uploading'); }
}

// Кольцо прогресса скачивания на карточке файла: пусто -> проценты -> галочка (как в окне чата)
const activeDownloads = new Map();

function startDownloadUi(link) {
  const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  link.classList.remove('done');
  link.classList.add('downloading');
  const bar = link.querySelector('.ring-bar');
  const pct = link.querySelector('.fi-pct');
  if (bar) {
    bar.style.strokeDasharray = RING_CIRCUMFERENCE;
    bar.style.strokeDashoffset = RING_CIRCUMFERENCE;
    bar.classList.add('indeterminate');
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
    if (percent == null) return;
    if (bar) {
      bar.classList.remove('indeterminate');
      bar.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - percent / 100);
    }
    if (pct) pct.textContent = percent;
    return;
  }

  activeDownloads.delete(id);
  link.classList.remove('downloading');
  if (state === 'completed') {
    link.classList.add('done');
    setTimeout(() => link.classList.remove('done'), 2500);
    uiToast('Файл успешно скачан');
  } else if (state === 'failed') {
    uiAlert('Не удалось скачать файл — проверьте подключение и повторите попытку.', 'Ошибка скачивания');
  }
});

desktop.onToast(({ message, error }) => uiToast(message, { error }));

// Короткоживущий (60с) токен на скачивание конкретного файла — запрашивается прямо перед тем, как
// он понадобится (клик/ПКМ), а не подставляется в ссылку заранее: карточка может провисеть в ленте
// часами, и токен в её href к этому моменту уже истёк бы (см. /api/download-token в server.js).
async function getDownloadUrl(relUrl, name) {
  const { token: dlToken } = await api(`/api/download-token?path=${encodeURIComponent(relUrl)}`);
  return `${serverUrl}${relUrl}?token=${dlToken}&name=${encodeURIComponent(name || 'файл')}`;
}

// Клик по файлу — скачивание через главный процесс; ПКМ — скопировать текст / сохранить файл как
function wireFeedInteractions(container) {
  container.addEventListener('click', async (e) => {
    const link = e.target.closest('a.file');
    if (!link) return;
    e.preventDefault();
    const id = startDownloadUi(link);
    try {
      const url = await getDownloadUrl(link.dataset.url, link.dataset.name);
      desktop.downloadFile(url, id);
    } catch {
      uiToast('Не удалось начать скачивание — проверьте подключение.', { error: true });
    }
  });
  // ПКМ — меню в оформлении клиента (uiContextMenu), как в окне чата.
  container.addEventListener('contextmenu', (e) => {
    const fileLink = e.target.closest('a.file');
    if (fileLink) {
      e.preventDefault();
      const name = fileLink.dataset.name;
      uiContextMenu(e.clientX, e.clientY, [{
        label: `Сохранить «${name}» как…`, icon: 'download',
        onClick: async () => {
          try { desktop.saveFileAs({ url: await getDownloadUrl(fileLink.dataset.url, name), name }); }
          catch { uiToast('Не удалось подготовить файл — проверьте подключение.', { error: true }); }
        },
      }]);
      return;
    }
    const txtEl = e.target.closest('.txt');
    if (txtEl) {
      e.preventDefault();
      uiContextMenu(e.clientX, e.clientY, [{ label: 'Копировать текст', icon: 'copy', onClick: () => desktop.copyText(txtEl.dataset.rawText || '') }]);
    }
  });
}
wireFeedInteractions(document.getElementById('feed'));
wireFeedInteractions(document.getElementById('hpMessages'));

// ---------- Панель истории: по дням/месяцам + полнотекстовый поиск (как в окне чата) ----------
let daysCache = [];

function dayLabel(dayStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = dayStr.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); // «4 октября», без нуля — как в истории чата
}
function dayRange(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const since = new Date(y, m - 1, d).getTime();
  return { since, until: since + 24 * 3600 * 1000 };
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  // «октябрь 2026 г.» → «Октябрь 2026»: в узкой колонке «г.» только занимает место.
  return (label.charAt(0).toUpperCase() + label.slice(1)).replace(/\s*г\.$/, '');
}

async function openHistoryPanel() {
  // Композер и история — взаимоисключающие: не должны накладываться друг на друга. Просто закрываем
  // форму (без showFeedSmoothly, который вызвал бы клик по "Написать") — ленту всё равно прячем ниже.
  if (document.getElementById('composer').classList.contains('open')) setComposerOpen(false);
  hideFeedSmoothly();
  document.getElementById('historyPanel').classList.add('visible'); // а сама панель проявляется плавно
  document.getElementById('historyBtn').classList.add('active');
  document.getElementById('historyBtn').title = 'Скрыть историю';
  const row = document.getElementById('hpSearchRow');
  row.innerHTML = `<div class="hp-search">${uiIcon('search')}<input id="hpSearch" placeholder="Поиск по всей истории рассылок…"></div>`;
  document.getElementById('hpSearch').addEventListener('input', debounceSearch);
  await loadDays();
  if (daysCache.length) selectDay(daysCache[0].day);
  else document.getElementById('hpMessages').innerHTML = '<div id="hpEmpty">Рассылок пока не было</div>';
}
function closeHistoryPanel() {
  document.getElementById('historyPanel').classList.remove('visible'); // сначала плавно скрываем панель...
  showFeedSmoothly(); // ...и одновременно проявляем ленту обратно
  document.getElementById('historyBtn').classList.remove('active');
  document.getElementById('historyBtn').title = 'Найти рассылку по дате или по тексту';
}
document.getElementById('historyBtn').addEventListener('click', () => {
  document.getElementById('historyPanel').classList.contains('visible') ? closeHistoryPanel() : openHistoryPanel();
});

async function loadDays() {
  const offsetMinutes = -new Date().getTimezoneOffset();
  daysCache = await api(`/api/broadcasts/days?offsetMinutes=${offsetMinutes}${deptQuery}`);
  const box = document.getElementById('hpDays');
  box.innerHTML = '';
  if (!daysCache.length) return;

  const months = new Map();
  daysCache.forEach(d => {
    const key = d.day.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(d);
  });

  [...months.entries()].forEach(([key, days], idx) => {
    const collapsed = idx !== 0;
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
      btn.innerHTML = `<span class="dl">${dayLabel(d.day)}</span><span class="cnt" title="Объявлений за день">${d.count}</span>`;
      btn.onclick = () => selectDay(d.day);
      list.appendChild(btn);
    });

    header.onclick = () => { header.classList.toggle('collapsed'); list.classList.toggle('collapsed'); };
    box.appendChild(header);
    box.appendChild(list);
  });
}

async function selectDay(day) {
  document.getElementById('hpSearch').value = '';
  [...document.querySelectorAll('#hpDays .dbtn')].forEach(b => b.classList.toggle('active', b.dataset.day === day));
  const { since, until } = dayRange(day);
  const items = await api(`/api/broadcasts?since=${since}&until=${until}${deptQuery}`);
  renderHistoryItems(items);
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
  const items = await api(`/api/broadcasts?q=${encodeURIComponent(text)}${deptQuery}`);
  renderHistoryItems(items, text);
}

function renderHistoryItems(items, query) {
  const box = document.getElementById('hpMessages');
  if (!items.length) { box.innerHTML = '<div id="hpEmpty">Ничего не найдено</div>'; return; }
  // items.map(itemHtml) напрямую передал бы itemHtml ещё и (index, array) от Array.prototype.map —
  // индекс попал бы вторым аргументом туда, где теперь ожидается query. Оборачиваем явно.
  box.innerHTML = items.map((b) => itemHtml(b, query)).join('');
  box.scrollTop = box.scrollHeight; // сразу к самым свежим рассылкам за день, а не к началу
}

// ---------- Живое обновление: новая рассылка появляется в ленте сразу, без переоткрытия окна ----------
let hasUnreadDivider = false;
let programmaticScroll = false; // чтобы наш собственный автоскролл вниз не считался "пользователь посмотрел"
let unreadClearTimer = null;

function addLiveBroadcast(b) {
  // Сервер шлёт человеку всё, что тот вправе видеть; окно отдела из этого потока берёт только своё.
  if (departmentId && Number(b.department_id) !== departmentId) return;
  const feed = document.getElementById('feed');
  feed.querySelector('.empty')?.remove();
  feed.classList.remove('empty-state');

  // Показываем полоску безусловно, при любой живой рассылке, независимо от фокуса окна.
  if (!hasUnreadDivider) {
    feed.insertAdjacentHTML('beforeend', unreadDividerHtml());
    hasUnreadDivider = true;
  }

  const wrap = document.createElement('div');
  wrap.innerHTML = itemHtml(b);
  feed.appendChild(wrap.firstElementChild);
  if (b.id > maxKnownBroadcastId) maxKnownBroadcastId = b.id;
  if (!document.getElementById('historyPanel').classList.contains('visible')) {
    programmaticScroll = true;
    feed.scrollTop = feed.scrollHeight;
  }
}

function clearUnreadDivider() {
  if (!hasUnreadDivider) return;
  clearTimeout(unreadClearTimer);
  unreadClearTimer = null;
  document.getElementById('unreadDivider')?.remove();
  hasUnreadDivider = false;
  setLastSeenId(maxKnownBroadcastId); // "прочитано" — запоминаем, переживёт закрытие окна
}
// Раньше таймер запускало событие 'focus' окна — но оно срабатывает и синтетически, просто от
// показа окна (см. ready-to-show в main.js), а не только когда пользователь осознанно кликнул в уже
// открытое окно. Из-за этого полоска либо пряталась мгновенно при обычном открытии, либо (если окно
// открывалось без явного фокуса — например, по клику на уведомление при выключенном автооткрытии)
// вообще не запускала таймер и просто никогда не исчезала сама. Теперь таймер стартует только по
// настоящему клику или прокрутке — недвусмысленный сигнал, что пользователь смотрит в окно.
function scheduleUnreadClear() {
  if (!hasUnreadDivider) return;
  clearTimeout(unreadClearTimer);
  unreadClearTimer = setTimeout(clearUnreadDivider, 3000);
}
document.addEventListener('click', scheduleUnreadClear);
document.getElementById('feed').addEventListener('scroll', () => {
  if (programmaticScroll) { programmaticScroll = false; return; } // это мы сами долистали, не пользователь
  scheduleUnreadClear();
});

let ws;
let wsLostTimer = null; // см. showConnectionLostModal в ui-kit.js
let wsReconnectDelay = 2000; // экспоненциальный бэкофф между попытками (см. onclose ниже)
function connectWs() {
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  ws = new WebSocket(`${wsUrl}?token=${token}&host=${encodeURIComponent(desktop.hostname)}`
    // Версия и сборка — чтобы администратор в веб-панели видел, у кого что установлено, и
    // мог понять, до кого обновление ещё не доехало (см. /api/admin/clients в server.js).
    + `&ver=${encodeURIComponent(desktop.appVersion)}&track=${encodeURIComponent(desktop.buildTrack)}`);
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
    if (data.type === 'broadcast') addLiveBroadcast(data);
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

loadFeed();
connectWs();

// Обработчики, которые раньше стояли прямо в разметке (onclick=/onsubmit=): CSP окна запрещает
// встроенный код целиком, поэтому они назначаются отсюда.
document.getElementById('sendBtn').addEventListener('click', () => send());
