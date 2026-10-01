// Веб-панель «Искры»: скрипт. Подключается из index.html относительным адресом — так панель
// работает и напрямую, и через платформу (/modules/messenger/).
/* --- Выпадающий список ---
   Системный <select> оформить нельзя: стрелку рисует браузер, она прижата к
   краю, а раскрытый перечень берёт вид от системы и в палитру не попадает.
   Настоящий select остаётся в разметке скрытым — весь код, который читает и
   пишет .value, работает как раньше, — а видимую часть рисуем сами.
   Тот же приём, что и в панели платформы; общей сборки у сервисов нет,
   поэтому код продублирован сознательно. */
(function () {
  var CHEVRON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

  function enhance(sel) {
    if (sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';
    var wrap = document.createElement('div');
    wrap.className = 'select-wrap';
    if (sel.style.width) wrap.style.width = sel.style.width;
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'select-btn';
    btn.innerHTML = '<span class="select-value"></span><span class="select-chevron">' + CHEVRON + '</span>';
    wrap.appendChild(btn);

    var menu = document.createElement('div');
    menu.className = 'select-menu';
    menu.hidden = true;
    wrap.appendChild(menu);

    var label = btn.querySelector('.select-value');
    function syncLabel() {
      var opt = sel.options[sel.selectedIndex];
      label.textContent = opt ? opt.textContent : '';
    }
    function close() { wrap.classList.remove('open'); menu.hidden = true; }
    function open() {
      menu.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (opt, i) {
        var row = document.createElement('div');
        row.className = 'select-option' + (i === sel.selectedIndex ? ' selected' : '');
        row.textContent = opt.textContent;
        row.onclick = function () {
          sel.selectedIndex = i;
          syncLabel();
          close();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        };
        menu.appendChild(row);
      });
      wrap.classList.add('open');
      menu.hidden = false;
    }
    btn.onclick = function (e) { e.stopPropagation(); menu.hidden ? open() : close(); };
    sel.addEventListener('change', syncLabel);
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    syncLabel();
  }

  function enhanceAll() {
    document.querySelectorAll('select:not([data-enhanced])').forEach(enhance);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhanceAll);
  else enhanceAll();
  // Экраны перерисовываются, поэтому следим за появлением новых select.
  new MutationObserver(enhanceAll).observe(document.documentElement, { childList: true, subtree: true });
})();

let token = localStorage.getItem('admin_token');
let me = JSON.parse(localStorage.getItem('admin_me') || 'null');
let usersCache = [], deptsCache = [];
// path/oldestId/hasMore — курсор постраничной подгрузки (см. loadMoreHistory): admin/history/*
// в server.js режет ответ по HISTORY_PAGE_SIZE (200) — в старом активном диалоге этого может не
// хватить, дальше 200 сообщений назад без подгрузки было не прокрутить.
let lastHistory = { type: 'room', path: null, items: [], oldestId: null, hasMore: false };

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('authErr');
  errEl.textContent = '';
  try {
    const res = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Ошибка входа'; return; }
    if (!data.user.can_admin) { errEl.textContent = 'Эта панель только для администраторов. Используйте приложение для Windows.'; return; }
    token = data.token; me = data.user;
    localStorage.setItem('admin_token', token);
    localStorage.setItem('admin_me', JSON.stringify(me));
    startDash();
  } catch { errEl.textContent = 'Сервер недоступен'; }
}

function logout() {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_me');
  location.reload();
}

// Открытие раздела. Вынесено из обработчика клика, потому что раздел
// открывается не только кликом: он же активен при первой загрузке панели.
// Пока это жило внутри onclick, опрос присутствия при загрузке не запускался
// вовсе — статусы появлялись, только если уйти на другую вкладку и вернуться.
function activateView(name) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));

  // Список подключённых меняется постоянно — перечитываем при каждом заходе в раздел, а не
  // показываем то, что было на момент входа в панель.
  if (name === 'updates') loadClients();
  if (name === 'tls') loadTls();
  // Статусы в списке пользователей обновляем, только пока раздел открыт:
  // держать опрос постоянно незачем.
  if (name === 'users') startPresencePolling();
  else stopPresencePolling();
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.onclick = () => activateView(item.dataset.view);
});

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `Работает без перезапуска: ${h} ч ${m} мин`;
}

async function loadStats() {
  const s = await api('api/admin/stats');
  document.getElementById('statUsers').textContent = s.usersTotal;
  document.getElementById('statOnline').textContent = s.onlineNow;
  document.getElementById('statDepts').textContent = s.departmentsTotal;
  document.getElementById('statMsgs').textContent = s.messagesTotal;
  document.getElementById('statUptime').textContent = fmtUptime(s.uptimeSeconds);
}

// Присутствие: кто в сети и с каких машин. Берём по HTTP, а не только из
// WebSocket, потому что панель открывают и через прокси платформы, где апгрейд
// до WS не пробрасывается, — статус должен показываться в любом случае.
let presenceCache = {};
let presenceTimer = null;

let presenceConnections = null;   // сколько сокетов видит сервер; null — ещё не спрашивали

async function loadPresence() {
  try {
    const { users, connections } = await api('api/admin/presence');
    presenceCache = users || {};
    presenceConnections = typeof connections === 'number' ? connections : null;
    renderUsers();
  } catch { /* не критично: список пользователей покажется без статусов */ }
}

// Опрос идёт, только пока вкладка открыта: держать его постоянно незачем.
function startPresencePolling() {
  stopPresencePolling();
  loadPresence();
  presenceTimer = setInterval(loadPresence, 15000);
}
function stopPresencePolling() {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
}

const PRESENCE_LABEL = { active: 'в сети', idle: 'отошёл', offline: 'не в сети' };

function sinceText(ts) {
  if (!ts) return '';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

function renderUsers() {
  const list = document.getElementById('usersList');
  if (!list) return;
  const q = (document.getElementById('userSearch')?.value || '').trim().toLowerCase();
  const matches = (u) => {
    if (!q) return true;
    const hosts = (presenceCache[u.id]?.hosts || []).join(' ').toLowerCase();
    return u.username.toLowerCase().includes(q)
      || (u.display_name || '').toLowerCase().includes(q)
      || hosts.includes(q);   // искать по имени ПК — привычнее, когда звонит «человек с PC-209»
  };
  const filtered = usersCache.filter(matches);

  const count = document.getElementById('usersCount');
  if (count) {
    const online = usersCache.filter(u => (presenceCache[u.id]?.state || 'offline') !== 'offline').length;
    let text = `${filtered.length} из ${usersCache.length}, в сети ${online}`;
    // Когда в сети никого, а соединений ноль — это не поломка панели, а
    // отсутствие подключённых клиентов. Разница важная: в первом случае чинят
    // панель, во втором — смотрят, почему клиенты не доходят до сервера.
    if (!online && presenceConnections === 0) text += ' · сервер не видит ни одного подключения';
    count.textContent = text;
  }

  if (!filtered.length) {
    list.innerHTML = '<div style="color:var(--muted); text-align:center; padding:22px;">Никого не найдено</div>';
    return;
  }

  // Порядок блоков — тот же, что у отделов на вкладке выше: его задаёт
  // администратор перетаскиванием, и список пользователей обязан ему следовать,
  // иначе порядок отделов означал бы что-то только в одном месте панели.
  const byName = (a, b) =>
    (a.display_name || a.username).localeCompare(b.display_name || b.username, 'ru');

  const blocks = deptsCache.map(d => ({
    name: d.name,
    users: filtered.filter(u => (u.departments || []).some(x => x.id === d.id)).sort(byName),
  }));
  // «Без отдела» всегда последним: это не отдел, а остаток.
  const orphans = filtered.filter(u => !(u.departments || []).length).sort(byName);
  if (orphans.length) blocks.push({ name: 'Без отдела', users: orphans, orphan: true });

  // Пустые отделы показываем только когда не ищем. При поиске они были бы
  // шумом: человек ищет конкретного сотрудника, а не изучает состав отделов.
  const visible = blocks.filter(b => b.users.length || !q);

  list.innerHTML = visible.map(b => `
    <div class="dept-block">
      <div class="dept-head${b.users.length ? '' : ' empty'}">
        <span class="name">${escapeHtml(b.name)}</span>
        <span class="count">${b.users.length ? `${b.users.length} чел.` : 'никого'}</span>
      </div>
      ${b.users.length
        ? b.users.map(u => userRowHtml(u, b.name)).join('')
        : '<div class="dept-empty">В этом отделе пока никого нет.</div>'}
    </div>`).join('');
}

// Строка одного человека. Вынесена из renderUsers отдельно, потому что теперь
// вызывается из каждого блока отдела, а не один раз по плоскому списку.
//
// blockName — отдел, в блоке которого строка сейчас рисуется. Нужен, чтобы
// подпись «ещё в» перечисляла ОСТАЛЬНЫЕ отделы человека: сотрудник в двух
// отделах встречается в списке дважды, и без этой подписи непонятно, почему.
function userRowHtml(u, blockName) {
  const p = presenceCache[u.id] || { state: 'offline', hosts: [], since: null };
  const other = (u.departments || []).map(d => d.name).filter(n => n && n !== blockName);
  // Машин может быть несколько — человек сидит и за своим ПК, и за чужим;
  // показываем все, иначе непонятно, откуда он на самом деле.
  const hosts = (p.hosts || []).length ? p.hosts.map(escapeHtml).join(', ') : '—';
  const caps = [];
  if (u.can_admin) caps.push('админка');
  if (u.can_broadcast) caps.push('рассылки');
  return `<div class="user-row">
    <div class="user-id">
      <span class="user-dot ${p.state}" title="${PRESENCE_LABEL[p.state]}"></span>
      <div style="min-width:0;">
        <div class="user-login">${escapeHtml(u.username)}</div>
        <div class="user-sub">${escapeHtml(u.display_name || '')}</div>
      </div>
    </div>
    <div class="user-cell">${PRESENCE_LABEL[p.state]}${p.since ? ` · ${sinceText(p.since)}` : ''}</div>
    <div class="user-cell user-hosts" title="${escapeHtml((p.hosts || []).join(', '))}">${hosts}</div>
    <div class="user-cell">
      ${caps.length ? `<div class="user-caps">${caps.map(c => `<span class="cap-chip">${c}</span>`).join('')}</div>` : ''}
      ${other.length ? `<div style="margin-top:${caps.length ? 4 : 0}px;">ещё в: ${escapeHtml(other.join(', '))}</div>` : ''}
    </div>
      <button class="user-menu-btn" title="Действия" onclick="openUserMenu(${u.id}, this)">···</button>
    </div>`;
}

function closeUserMenu() {
  const m = document.getElementById('userMenu');
  if (m) m.remove();
}
document.addEventListener('click', (e) => {
  const m = document.getElementById('userMenu');
  if (m && !m.contains(e.target) && !e.target.classList.contains('user-menu-btn')) closeUserMenu();
});

// Всё, что можно сделать с человеком, — здесь. В строке этих действий больше
// нет: они занимали пять колонок и мешали читать сам список.
function openUserMenu(id, anchor) {
  const existed = document.getElementById('userMenu');
  closeUserMenu();
  if (existed && existed.dataset.forUser === String(id)) return; // повторный клик закрывает
  const u = usersCache.find(x => x.id === id);
  if (!u) return;

  const menu = document.createElement('div');
  menu.id = 'userMenu';
  menu.dataset.forUser = String(id);
  menu.innerHTML = `
    <button data-act="rename">Переименовать</button>
    <button data-act="depts">Отделы<span class="menu-state">${escapeHtml((u.departments || []).map(d => d.name).join(', ') || 'нет')}</span></button>
    <div class="menu-sep"></div>
    <button data-act="broadcast">Рассылки<span class="menu-state">${u.can_broadcast ? 'включены' : 'выключены'}</span></button>
    <button data-act="admin">Админка<span class="menu-state">${u.can_admin ? 'включена' : 'выключена'}</span></button>
    <div class="menu-sep"></div>
    <button data-act="password">Сбросить пароль</button>
    <button data-act="delete" class="danger">Удалить</button>`;
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (r.bottom + menu.offsetHeight + 8 < window.innerHeight
    ? r.bottom + 4
    : Math.max(8, r.top - menu.offsetHeight - 4)) + 'px';

  menu.querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'depts') { pickUserDepartments(id, anchor); closeUserMenu(); return; }
      closeUserMenu();
      if (act === 'rename') return renameUser(id);
      if (act === 'broadcast') return toggleUserCap(id, 'can_broadcast', !u.can_broadcast);
      if (act === 'admin') return toggleUserCap(id, 'can_admin', !u.can_admin);
      if (act === 'password') return resetPassword(id);
      if (act === 'delete') return deleteUser(id);
    };
  });
}

function userVersion(id) { return usersCache.find(u => u.id === id)?.version; }
function applyUserVersion(id, version) { const u = usersCache.find(x => x.id === id); if (u && version !== undefined) u.version = version; }

// Переименование меняет и ФИО, и логин — они здесь одно и то же. Пользователя
// так и заводят: логином служит ФИО целиком. Раньше правилось только
// отображаемое имя, и опечатка в фамилии навсегда оставалась в логине.
async function renameUser(id) {
  const u = usersCache.find(x => x.id === id);
  if (!u) return;
  const фио = (prompt('ФИО (оно же логин для входа):', u.display_name || u.username) || '').trim();
  if (!фио || (фио === u.display_name && фио === u.username)) return;

  try {
    await api(`api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: фио, username: фио, version: userVersion(id) }),
    });
    refreshAll();
  } catch (e) { alert(e.message); refreshAll(); }
}

async function toggleUserCap(id, cap, checked) {
  try {
    const r = await api(`api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ [cap]: checked, version: userVersion(id) }) });
    applyUserVersion(id, r.version);
    // Право видно в строке значком, поэтому список надо перерисовать: раньше
    // состояние держала галочка, и обновлять было нечего.
    const u = usersCache.find(x => x.id === id);
    if (u) u[cap] = checked;
    renderUsers();
  } catch (e) { alert(e.message); refreshAll(); }
}

// Порядок отделов задаётся перетаскиванием строк. Раньше здесь были стрелки
// ↑↓: чтобы поднять отдел на пять позиций, приходилось нажать пять раз и пять
// раз дождаться перезагрузки списка с сервера.
//
// Мышь — не единственный способ: сама «ручка» это кнопка, и со стрелками на
// клавиатуре она двигает строку так же. Перетаскивание с клавиатуры не
// работает нигде, и молча оставить панель без клавиатуры было бы потерей, а не
// упрощением.
function renderDepts() {
  const body = document.getElementById('deptsBody');
  body.innerHTML = '';
  deptsCache.forEach((d, i) => {
    const tr = document.createElement('tr');
    tr.className = 'dept-row';
    tr.draggable = true;
    tr.dataset.index = String(i);
    tr.innerHTML = `<td>
        <button class="drag-handle" title="Перетащите, чтобы изменить порядок (или стрелки ↑↓ с клавиатуры)"
                aria-label="Переместить отдел ${escapeHtml(d.name)}">⠿</button>
      </td>
      <td>${escapeHtml(d.name)}</td>
      <td class="dept-actions">
        <button class="action ghost" onclick="renameDept(${d.id})">Переименовать</button>
        <button class="action danger" onclick="deleteDept(${d.id})">Удалить</button>
      </td>`;
    body.appendChild(tr);
  });
  wireDeptDrag(body);
  renderNewUserDepartments(); // кнопка выбора отделов у формы "новый пользователь" — см. ниже
}

function wireDeptDrag(body) {
  let fromIndex = null;

  const clearMarks = () => body.querySelectorAll('.dept-row')
    .forEach(r => r.classList.remove('drop-before', 'drop-after', 'dragging'));

  body.querySelectorAll('.dept-row').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      fromIndex = Number(row.dataset.index);
      row.classList.add('dragging');
      // Firefox не начинает перетаскивание без данных в буфере; значение
      // неважно, важен сам факт, что они заданы.
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(fromIndex)); } catch { /* не все браузеры дают писать сюда */ }
    });

    row.addEventListener('dragover', (e) => {
      if (fromIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Куда встанет строка — выше или ниже той, над которой курсор. Считаем по
      // середине строки, иначе на границе указатель дрожит между вариантами.
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });

    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (fromIndex === null) return;
      const over = Number(row.dataset.index);
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      let to = after ? over + 1 : over;
      // Удаление исходной строки сдвигает всё, что было ниже, на одну позицию.
      if (fromIndex < to) to -= 1;
      clearMarks();
      const moved = fromIndex;
      fromIndex = null;
      if (to !== moved) applyDeptOrder(moved, to);
    });

    row.addEventListener('dragend', () => { fromIndex = null; clearMarks(); });

    // Клавиатура: та же ручка, стрелки вверх/вниз.
    row.querySelector('.drag-handle').addEventListener('keydown', (e) => {
      const i = Number(row.dataset.index);
      if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); applyDeptOrder(i, i - 1, true); }
      if (e.key === 'ArrowDown' && i < deptsCache.length - 1) { e.preventDefault(); applyDeptOrder(i, i + 1, true); }
    });
  });
}

/**
 * Переставить отдел и сохранить порядок.
 *
 * Список перерисовывается СРАЗУ, не дожидаясь сервера: при перетаскивании
 * строка обязана оказаться там, куда её отпустили, иначе движение выглядит
 * незасчитанным. Если сервер откажет — возвращаем прежний порядок и говорим об
 * этом, а не оставляем расхождение молча.
 */
async function applyDeptOrder(from, to, keepFocus) {
  const previous = deptsCache.slice();
  const [moved] = deptsCache.splice(from, 1);
  deptsCache.splice(to, 0, moved);
  renderDepts();
  renderUsers();   // блоки пользователей идут в том же порядке
  if (keepFocus) {
    const row = document.querySelector(`.dept-row[data-index="${to}"] .drag-handle`);
    if (row) row.focus();
  }

  try {
    await api('api/admin/departments/reorder', {
      method: 'POST',
      body: JSON.stringify({ order: deptsCache.map(d => d.id) }),
    });
  } catch (e) {
    deptsCache = previous;
    renderDepts();
    renderUsers();
    alert('Не удалось сохранить порядок отделов: ' + e.message);
  }
}
// Текущее имя берём из кэша по id, а не подставляем строкой в сам onclick: подстановка ломалась
// на любой кавычке в названии отдела (и открывала бы вставку разметки, если бы имя туда попало).
async function renameDept(id) {
  const currentName = deptsCache.find(d => d.id === id)?.name || '';
  const name = prompt('Новое название отдела:', currentName);
  if (!name || !name.trim() || name.trim() === currentName) return;
  try { await api(`api/admin/departments/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }); refreshAll(); } catch (e) { alert(e.message); }
}
async function loadRegistration() {
  try {
    const { open } = await api('api/admin/registration');
    document.getElementById('regOpen').checked = open;
  } catch { /* не критично: остальная панель работает и без этого переключателя */ }
}
async function saveRegistration(open) {
  const msg = document.getElementById('regMsg');
  try {
    await api('api/admin/registration', { method: 'PATCH', body: JSON.stringify({ open }) });
    msg.textContent = open ? 'Регистрация разрешена' : 'Регистрация выключена';
    setTimeout(() => { msg.textContent = ''; }, 2500);
  } catch (e) { msg.textContent = 'Ошибка: ' + e.message; loadRegistration(); }
}

async function refreshAll() {
  usersCache = await api('api/admin/users');
  deptsCache = await api('api/departments');
  renderUsers();
  renderDepts();
  const opts = usersCache.map(u => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`).join('');
  document.getElementById('histUser1').innerHTML = opts;
  document.getElementById('histUser2').innerHTML = opts;
  loadStats();
  loadRegistration();
}

async function createUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const department_ids = [...newUserDepartments];
  const can_broadcast = document.getElementById('newUserBroadcast').checked;
  const can_admin = document.getElementById('newUserAdmin').checked;
  if (!username || !password) return alert('Укажите логин и пароль');
  try {
    await api('api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, department_ids, can_broadcast, can_admin }) });
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    newUserDepartments = [];
    renderNewUserDepartments();
    document.getElementById('newUserBroadcast').checked = false;
    document.getElementById('newUserAdmin').checked = false;
    refreshAll();
  } catch (e) { alert(e.message); }
}
// ---------- Выбор отделов ----------
// Один всплывающий список на всю страницу, а не свой у каждой строки: строк может быть двести.
let newUserDepartments = []; // отделы, выбранные в форме "новый пользователь", до её отправки

function closeDeptPicker() {
  const el = document.getElementById('deptPicker');
  if (el) el.remove();
}
document.addEventListener('mousedown', (e) => {
  const picker = document.getElementById('deptPicker');
  if (picker && !picker.contains(e.target) && !e.target.classList.contains('dept-btn')) closeDeptPicker();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDeptPicker(); });

function openDeptPicker(anchor, selectedIds, onToggle) {
  closeDeptPicker();
  const picker = document.createElement('div');
  picker.id = 'deptPicker';
  if (!deptsCache.length) {
    picker.innerHTML = '<div class="empty">Отделов пока нет — создайте их выше</div>';
  } else {
    picker.innerHTML = deptsCache.map(d =>
      `<label><input type="checkbox" value="${d.id}" ${selectedIds.includes(d.id) ? 'checked' : ''}>${escapeHtml(d.name)}</label>`
    ).join('');
  }
  document.body.appendChild(picker);
  const rect = anchor.getBoundingClientRect();
  // Ниже кнопки, а если там не помещается (нижние строки длинной таблицы) — выше неё.
  const height = picker.offsetHeight;
  picker.style.left = Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8) + 'px';
  picker.style.top = (rect.bottom + height + 8 < window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)) + 'px';
  picker.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const ids = [...picker.querySelectorAll('input[type=checkbox]')].filter(x => x.checked).map(x => Number(x.value));
      onToggle(ids);
    };
  });
}

function pickUserDepartments(id, anchor) {
  const user = usersCache.find(u => u.id === id);
  if (!user) return;
  openDeptPicker(anchor, (user.departments || []).map(d => d.id), async (ids) => {
    try {
      const r = await api(`api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ department_ids: ids, version: userVersion(id) }) });
      applyUserVersion(id, r.version);
      // Обновляем кэш и кнопку на месте: перерисовка всей таблицы закрыла бы список галочек,
      // а отделов обычно отмечают сразу несколько.
      user.departments = ids.map(i => deptsCache.find(d => d.id === i)).filter(Boolean).map(d => ({ id: d.id, name: d.name }));
      const names = user.departments.map(d => d.name).join(', ');
      anchor.textContent = names || 'Без отдела';
      anchor.title = names || 'Без отдела';
      anchor.classList.toggle('empty', !names);
    } catch (e) { alert(e.message); refreshAll(); }
  });
}

function renderNewUserDepartments() {
  const btn = document.getElementById('newDept');
  if (!btn) return;
  newUserDepartments = newUserDepartments.filter(id => deptsCache.some(d => d.id === id)); // отдел могли удалить
  const names = newUserDepartments.map(id => deptsCache.find(d => d.id === id)?.name).filter(Boolean).join(', ');
  btn.textContent = names || 'Без отдела';
  btn.title = names || 'Без отдела';
  btn.classList.toggle('empty', !names);
}

function pickNewUserDepartments(anchor) {
  openDeptPicker(anchor, newUserDepartments, (ids) => {
    newUserDepartments = ids;
    renderNewUserDepartments();
  });
}
async function resetPassword(id) {
  const u = usersCache.find(x => x.id === id);
  const val = prompt(`Новый пароль для ${u ? u.username : 'пользователя'} (минимум 4 символа):`, '');
  if (!val) return;
  if (val.length < 4) return alert('Пароль короче четырёх символов сервер не примет');
  try { await api(`api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ password: val, version: userVersion(id) }) }); alert('Пароль обновлён'); refreshAll(); } catch (e) { alert(e.message); refreshAll(); }
}
async function deleteUser(id) {
  if (!confirm('Удалить пользователя без возможности восстановления?')) return;
  try { await api(`api/admin/users/${id}`, { method: 'DELETE' }); refreshAll(); } catch (e) { alert(e.message); }
}
async function createDept() {
  const name = document.getElementById('newDeptName').value.trim();
  if (!name) return;
  try { await api('api/admin/departments', { method: 'POST', body: JSON.stringify({ name }) }); document.getElementById('newDeptName').value = ''; refreshAll(); } catch (e) { alert(e.message); }
}
async function deleteDept(id) {
  if (!confirm('Удалить отдел? Сотрудники останутся без отдела.')) return;
  try { await api(`api/admin/departments/${id}`, { method: 'DELETE' }); refreshAll(); } catch (e) { alert(e.message); }
}

document.getElementById('histType').onchange = (e) => {
  const isDm = e.target.value === 'dm';
  document.getElementById('histUser1').style.display = isDm ? 'inline-block' : 'none';
  document.getElementById('histUser2').style.display = isDm ? 'inline-block' : 'none';
};

// Экранируем И кавычки тоже: без них значение, попавшее в атрибут (например value="..." в списке
// сотрудников), закрывало атрибут своей кавычкой и дальше писало уже разметку — то есть обычного
// экранирования "<" и ">" для атрибутов недостаточно. String() — потому что сюда попадают и
// значения из логов, где на месте строки может оказаться число или null, а у них нет .replace.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHistoryBox(items) {
  document.getElementById('histMessages').innerHTML = items.map(m => {
    const time = new Date(m.created_at).toLocaleString('ru-RU');
    const files = (m.files || []).map(f => ` 📎 ${escapeHtml(f.name)}${f.exists === false ? ' (удалён с диска)' : ''}`).join('');
    // from_user — это отображаемое имя, которое сотрудник задаёт себе сам в клиенте. Без
    // экранирования имя вида "<img src=x onerror=...>" выполнялось бы прямо здесь, в открытой
    // сессии администратора, — то есть любой сотрудник мог получить доступ к панели, просто
    // переименовавшись и дождавшись, когда админ откроет переписку.
    return `<div class="m"><b>${escapeHtml(m.from_user)}:</b> ${escapeHtml(m.text)}${files}<span class="t">${time}</span></div>`;
  }).join('') || 'Сообщений пока нет';
}

async function loadHistory() {
  const type = document.getElementById('histType').value;
  const box = document.getElementById('histMessages');
  box.innerHTML = 'Загрузка...';
  document.getElementById('histMoreRow').style.display = 'none';
  try {
    let path;
    if (type === 'room') {
      path = 'api/admin/history/room/general';
    } else {
      const u1 = document.getElementById('histUser1').value, u2 = document.getElementById('histUser2').value;
      if (!u1 || !u2 || u1 === u2) { box.innerHTML = 'Выберите двух разных сотрудников'; return; }
      path = `api/admin/history/dm/${u1}/${u2}`;
    }
    const items = await api(path);
    lastHistory = { type, path, items, oldestId: items.length ? items[0].id : null, hasMore: items.length === 200 };
    renderHistoryBox(items);
    document.getElementById('histMoreRow').style.display = lastHistory.hasMore ? 'flex' : 'none';
  } catch (e) { box.innerHTML = 'Ошибка: ' + e.message; }
}

async function loadMoreHistory() {
  if (!lastHistory.hasMore || !lastHistory.path) return;
  const btn = document.getElementById('histMoreBtn');
  const box = document.getElementById('histMessages');
  btn.disabled = true;
  btn.textContent = 'Загрузка...';
  try {
    const items = await api(`${lastHistory.path}?before=${lastHistory.oldestId}`);
    lastHistory.hasMore = items.length === 200;
    if (items.length) {
      lastHistory.oldestId = items[0].id;
      lastHistory.items = [...items, ...lastHistory.items];
      const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
      renderHistoryBox(lastHistory.items);
      box.scrollTop = box.scrollHeight - prevHeight + prevTop; // не сбрасываем позицию просмотра вставкой сверху
    }
    document.getElementById('histMoreRow').style.display = lastHistory.hasMore ? 'flex' : 'none';
  } catch (e) { alert(e.message); } finally {
    btn.disabled = false;
    btn.textContent = 'Показать более ранние';
  }
}

function exportHistory() {
  if (!lastHistory.items.length) { alert('Сначала откройте переписку'); return; }
  const lines = lastHistory.items.map(m => `[${new Date(m.created_at).toLocaleString('ru-RU')}] ${m.from_user}: ${m.text}`);
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `history-${lastHistory.type}-${Date.now()}.txt`;
  a.click();
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

async function loadUploadSettings() {
  try {
    const s = await api('api/admin/upload-settings');
    document.getElementById('uploadExtMode').value = s.mode;
    document.getElementById('uploadExtList').value = s.extensions.join(', ');
    document.getElementById('uploadMaxMb').value = s.maxMb;
    document.getElementById('uploadMaxMb').max = s.hardCeilingMb;
  } catch (e) { document.getElementById('uploadSettingsMsg').textContent = 'Ошибка: ' + e.message; }
}
async function saveUploadSettings() {
  const msg = document.getElementById('uploadSettingsMsg');
  msg.textContent = 'Сохранение...';
  try {
    await api('api/admin/upload-settings', { method: 'PATCH', body: JSON.stringify({
      mode: document.getElementById('uploadExtMode').value,
      extensions: document.getElementById('uploadExtList').value,
      maxMb: document.getElementById('uploadMaxMb').value,
    }) });
    msg.textContent = 'Сохранено';
    setTimeout(() => { if (msg.textContent === 'Сохранено') msg.textContent = ''; }, 2500);
    loadUploadSettings();
  } catch (e) { msg.textContent = 'Ошибка: ' + e.message; }
}

async function loadFiles() {
  const body = document.getElementById('filesBody');
  body.innerHTML = '<tr><td colspan="6">Загрузка...</td></tr>';
  try {
    const files = await api('api/admin/files');
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const orphaned = files.filter(f => f.orphaned).length;
    document.getElementById('filesSummary').textContent =
      `Всего: ${files.length} · Занято места: ${fmtSize(totalSize)}` + (orphaned ? ` · Без ссылок в переписке: ${orphaned}` : '');
    body.innerHTML = files.map(f => `<tr>
        <td>${escapeHtml(f.originalName)}${f.orphaned ? ' <span style="color:var(--warn)">(без сообщения)</span>' : ''}</td>
        <td>${f.context ? escapeHtml(f.context) : '—'}</td>
        <td>${f.from ? escapeHtml(f.from) : '—'}</td>
        <td>${new Date(f.created_at).toLocaleString('ru-RU')}</td>
        <td>${fmtSize(f.size)}</td>
        <td><button class="action danger" data-disk="${escapeHtml(f.diskName)}" onclick="deleteFile(this.dataset.disk)">Удалить</button></td>
      </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">Файлов пока нет</td></tr>';
  } catch (e) { body.innerHTML = `<tr><td colspan="6">Ошибка: ${escapeHtml(e.message)}</td></tr>`; }
}
async function deleteFile(diskName) {
  if (!confirm('Удалить файл с сервера без возможности восстановления?')) return;
  try { await api(`api/admin/files/${encodeURIComponent(diskName)}`, { method: 'DELETE' }); loadFiles(); } catch (e) { alert(e.message); }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const LEVEL_COLOR = { INFO: 'var(--muted)', WARN: 'var(--warn)', ERROR: 'var(--danger)' };
// ---------- Сертификат сервера ----------
// Раздел нужен не для красоты: сертификат домена выдаётся на два года, корневой — на десять.
// Оба когда-нибудь придётся заменить, и делать это правкой переменных окружения на сервере
// неудобно ровно в тот момент, когда это срочно.
const TLS_SOURCE_LABEL = {
  store: 'загружен через эту панель',
  'env-pfx': 'задан переменной TLS_PFX при запуске сервера',
  'env-pem': 'задан переменными TLS_CERT/TLS_KEY при запуске сервера',
};
// То же самое, но так, чтобы вставало в предложение «сертификат задан ещё и ...».
const TLS_SOURCE_SHORT = {
  store: 'в хранилище панели',
  'env-pfx': 'переменной окружения TLS_PFX',
  'env-pem': 'переменными окружения TLS_CERT/TLS_KEY',
};

function tlsCertRows(cert) {
  if (!cert) return '';
  if (cert.error) return `<div style="color:var(--danger)">Файл не читается: ${escapeHtml(cert.error)}</div>`;
  // Срок показываем цветом, а не только числом: "осталось 20 дней" в общем списке цифр
  // проскакивают мимо глаз, а красная строка — нет.
  const days = cert.daysLeft;
  const dayColor = days === null ? 'var(--muted)' : days <= 0 ? 'var(--danger)' : days <= 30 ? 'var(--warn)' : 'var(--muted)';
  const dayText = days === null ? '' : days <= 0 ? ' — срок истёк' : ` — осталось ${days} дн.`;
  const row = (k, v, color) => `<tr><td style="color:var(--muted); width:190px;">${k}</td><td${color ? ` style="color:${color}"` : ''}>${v}</td></tr>`;
  return `<table style="margin-top:10px;">
    ${row('Кому выдан', escapeHtml(cert.subject || '—'))}
    ${row('Имена (SAN)', escapeHtml(cert.san || '—'))}
    ${row('Кем выдан', escapeHtml(cert.issuer || '—'))}
    ${row('Действует до', escapeHtml(cert.validTo || '—') + dayText, dayColor)}
    ${row('Сертификатов в цепочке', String(cert.certificates))}
    ${row('Отпечаток', `<code style="font-size:11px;">${escapeHtml(cert.fingerprint || '—')}</code>`)}
  </table>`;
}

function tlsWarnBox(text) {
  return `<div style="margin-top:10px; padding:8px 10px; border:1px solid var(--warn); border-radius:8px; color:var(--warn); font-size:12.5px;">${text}</div>`;
}

async function loadTls() {
  const box = document.getElementById('tlsState');
  box.innerHTML = 'Загрузка…';
  try {
    const s = await api('api/admin/tls');
    document.getElementById('tlsInsecureWarn').style.display = s.requestSecure ? 'none' : '';

    let html = s.enabled
      ? `<div style="font-size:15px; color:var(--online)">🔒 Шифрование включено — соединения идут по https</div>`
      : `<div style="font-size:15px; color:var(--danger)">⚠ Шифрования нет — всё идёт открытым текстом</div>`;
    if (s.source) html += `<div style="color:var(--muted); font-size:12px; margin-top:4px;">Сертификат ${escapeHtml(TLS_SOURCE_LABEL[s.source] || s.source)}</div>`;

    html += tlsCertRows(s.certificate);

    // Двойная настройка: файл в хранилище и переменная окружения одновременно. Пока файл есть,
    // действует он, а переменная стоит в тени — и обнаруживается ровно тогда, когда файл удаляют
    // и с удивлением видят, что сервер всё так же на https. Показываем это заранее.
    if (s.envAlsoSet) {
      html += tlsWarnBox('Сертификат задан <b>дважды</b>: файлом в хранилище (действует он) и '
        + escapeHtml(TLS_SOURCE_SHORT[s.envAlsoSet] || s.envAlsoSet)
        + ' в скрипте запуска. Пока обе настройки на месте, кнопка «Удалить из хранилища» шифрование не выключит — '
        + 'сервер просто возьмёт сертификат из переменной. Уберите переменную из скрипта запуска (или из настроек службы), '
        + 'чтобы сертификатом управляла только эта панель.');
    }

    // Файл в хранилище есть, а действует не он — так бывает ровно в одном случае: сертификат
    // загрузили на сервер, работавший по http. Молчать об этом нельзя, иначе администратор
    // уверен, что всё включилось.
    if (s.restartRequired) {
      html += tlsWarnBox('Сертификат загружен, но ещё не действует: включить шифрование на работающем http-сервере нельзя. <b>Перезапустите сервер.</b>')
           + `<div style="margin-top:10px; color:var(--muted); font-size:12px;">Что лежит в хранилище и заработает после перезапуска:</div>`
           + tlsCertRows(s.stored);
    }
    if (s.certificate && s.certificate.chainComplete === false) {
      html += tlsWarnBox('Сервер отдаёт не всю цепочку — в ней нет промежуточных удостоверяющих центров. Браузеры это иногда прощают, а автообновление клиента — нет: обновления будут молча не идти. Экспортируйте сертификат заново, вместе со всеми сертификатами пути.');
    }
    if (s.rootMatchesClient === false) {
      html += tlsWarnBox('Сервер подписан <b>не тем</b> корневым центром, который вшит в сборку клиента. Клиенты перестанут доверять серверу. Замените <code>desktop-client/rosstat-root-ca.crt</code> новым корневым сертификатом и пересоберите установщики.');
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<span style="color:var(--danger)">Ошибка: ${escapeHtml(e.message)}</span>`;
  }
}

async function uploadTls() {
  const input = document.getElementById('tlsFile');
  const result = document.getElementById('tlsUploadResult');
  const file = input.files && input.files[0];
  if (!file) { result.innerHTML = '<span style="color:var(--warn)">Выберите файл</span>'; return; }
  if (file.size > 200 * 1024) { result.innerHTML = '<span style="color:var(--danger)">Это слишком большой файл для сертификата — похоже, выбран не тот</span>'; return; }
  if (!confirm(`Заменить действующий сертификат на «${file.name}»?`)) return;

  result.textContent = 'Проверяем файл…';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const data = await api('api/admin/tls', {
      method: 'POST',
      body: JSON.stringify({ pfx: btoa(bin), password: document.getElementById('tlsPassword').value }),
    });
    document.getElementById('tlsPassword').value = ''; // пароль от закрытого ключа не оставляем в поле
    input.value = '';
    result.innerHTML = data.applied
      ? '<span style="color:var(--online)">Сертификат заменён и уже действует. Перезапуск не нужен: новые соединения идут с новым сертификатом.</span>'
      : '<span style="color:var(--warn)">Файл принят и сохранён, но чтобы шифрование включилось, сервер нужно перезапустить.</span>';
    loadTls();
  } catch (e) {
    result.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.message)}</span>`;
  }
}

async function removeTls() {
  if (!confirm('Удалить сертификат из хранилища сервера?')) return;
  try {
    const r = await api('api/admin/tls', { method: 'DELETE' });
    // Сказать "удалено" мало: если сертификат задан ещё и переменной окружения, после перезапуска
    // сервер поднимется по https с тем же сертификатом — и выглядит это так, будто удаление не
    // сработало. Сервер сразу считает, что реально будет дальше, а мы это показываем.
    if (r.nextSource) {
      alert('Файл из хранилища удалён, но шифрование НЕ отключится: сертификат задан ещё и '
        + (TLS_SOURCE_SHORT[r.nextSource] || r.nextSource)
        + '. После перезапуска сервер возьмёт его оттуда — ' + (r.nextWhere || '')
        + '.\n\nЧтобы сервер работал без шифрования, уберите эту переменную из скрипта запуска (службы) и перезапустите его.');
    } else {
      alert('Сертификат удалён. После перезапуска сервер будет работать без шифрования — трафик пойдёт открытым текстом.');
    }
    loadTls();
  } catch (e) { alert(e.message); }
}

async function loadLogs() {
  const day = document.getElementById('logsDay').value || todayStr();
  document.getElementById('logsDay').value = day;
  const type = document.getElementById('logsType').value;
  const level = document.getElementById('logsLevel').value;
  const body = document.getElementById('logsBody');
  body.innerHTML = '<tr><td colspan="5">Загрузка...</td></tr>';
  try {
    const { entries, truncated, total } = await api(`api/admin/logs?day=${day}&type=${type}&level=${level}`);
    document.getElementById('logsSummary').textContent = `Записей: ${total}` + (truncated ? ' (показаны последние ' + entries.length + ')' : '');
    body.innerHTML = entries.map(e => {
      const time = new Date(e.ts).toLocaleTimeString('ru-RU');
      const color = LEVEL_COLOR[e.level] || 'var(--muted)';
      // meta уже структура, а не строка — просто аккуратно раскладываем в "ключ: значение" построчно
      const details = Object.entries(e.meta || {}).map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`).join(' · ');
      return `<tr>
          <td style="color:var(--muted); font-variant-numeric:tabular-nums;">${time}</td>
          <td style="color:${color}; font-weight:700;">${e.level}</td>
          <td style="color:var(--muted);">${e.source === 'client' ? 'клиент' : 'сервер'}</td>
          <td>${escapeHtml(e.event)}</td>
          <td style="color:var(--muted); font-size:12px;">${details}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="color:var(--muted)">За этот день записей нет</td></tr>';
  } catch (e) { body.innerHTML = `<tr><td colspan="5">Ошибка: ${escapeHtml(e.message)}</td></tr>`; }
}

// ---------- Клиенты и обновления ----------
let publishedCache = {};

async function loadPublishedVersions() {
  const box = document.getElementById('publishedVersions');
  try {
    publishedCache = await api('api/admin/update-published');
    const cell = (track, label) => {
      const p = publishedCache[track];
      return `<div><div style="color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.4px;">${label}</div>`
        + (p ? `<div style="font-size:18px; font-weight:700;">${escapeHtml(p.version)}</div>`
             + `<div style="color:var(--muted); font-size:11px;">${escapeHtml(p.file || '')}</div>`
             : `<div style="font-size:14px; color:var(--warn)">не выложено</div>`)
        + `</div>`;
    };
    box.innerHTML = cell('win7', 'Windows 7 / 8.1') + cell('win10', 'Windows 10+');
  } catch (e) { box.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.message)}</span>`; }
  await loadReleases();
}

// ---------- Версии клиента: список, скачивание, откат, удаление, выкладка (lib/releases.js) ----------
const TRACK_LABEL = { win7: 'Windows 7 / 8.1', win10: 'Windows 10+' };

function renderReleases(data) {
  const rows = [];
  for (const track of ['win10', 'win7']) {
    for (const v of (data[track] && data[track].versions) || []) {
      const badge = v.current
        ? ' <span style="color:var(--online, #2e7d32); font-weight:600;">текущая</span>'
        : '';
      const noMap = v.hasBlockmap ? '' : ' <span style="color:var(--warn)" title="Нет файла .blockmap: с этой версии клиенты скачают следующую целиком">без карты блоков</span>';
      rows.push(`<tr>
        <td style="color:var(--muted)">${TRACK_LABEL[track]}</td>
        <td><b>${escapeHtml(v.version)}</b>${badge}${noMap}</td>
        <td>${fmtSize(v.size)}</td>
        <td style="color:var(--muted)">${new Date(v.modified).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td class="row-flex">
          <button class="action ghost" data-track="${track}" data-file="${escapeHtml(v.file)}" onclick="downloadRelease(this.dataset.track, this.dataset.file)">Скачать</button>
          ${v.current ? '' : `<button class="action ghost" data-track="${track}" data-version="${escapeHtml(v.version)}" onclick="makeReleaseCurrent(this.dataset.track, this.dataset.version)"${v.canMakeCurrent ? '' : ' disabled title="У этой версии нет своего latest.yml — вернуться к ней нельзя"'}>Сделать текущей</button>
          <button class="action danger" data-track="${track}" data-version="${escapeHtml(v.version)}" onclick="deleteRelease(this.dataset.track, this.dataset.version)">Удалить</button>`}
        </td>
      </tr>`);
    }
  }
  document.getElementById('releasesBody').innerHTML = rows.join('')
    || '<tr><td colspan="5" style="color:var(--muted)">Версий на сервере пока нет</td></tr>';
}

// Установщик отдаётся без входа (клиентам при обновлении нечем предъявить токен) — обычная ссылка.
// Путь относительный: панель открывают и напрямую, и через «Центр» (/modules/messenger/).
function downloadRelease(track, file) {
  const a = document.createElement('a');
  a.href = `updates/${track}/${encodeURIComponent(file)}`;
  a.download = file;
  document.body.appendChild(a); a.click(); a.remove();
}

async function loadReleases() {
  try { renderReleases(await api('api/admin/releases')); }
  catch (e) { document.getElementById('releasesBody').innerHTML = `<tr><td colspan="5">Ошибка: ${escapeHtml(e.message)}</td></tr>`; }
}

// Пароль спрашиваем полем, а не prompt(): prompt показывает набранное открытым текстом.
function releasePassword() {
  const el = document.getElementById('releasePassword');
  if (!el.value) { el.focus(); throw new Error('Введите свой пароль в поле «Ваш пароль» ниже — действие подтверждается им'); }
  return el.value;
}

async function makeReleaseCurrent(track, version) {
  try {
    const password = releasePassword();
    if (!confirm(`Сделать ${version} текущей версией для ${TRACK_LABEL[track]}? Клиентам, которые ещё не обновились, будет предлагаться она.`)) return;
    await api(`api/admin/releases/${track}/current`, { method: 'POST', body: JSON.stringify({ version, password }) });
    await loadPublishedVersions();
  } catch (e) { alert(e.message); }
}

async function deleteRelease(track, version) {
  if (!confirm(`Удалить с сервера версию ${version} (${TRACK_LABEL[track]})? Клиенты, у которых стоит она, следующую версию скачают целиком.`)) return;
  try {
    await api(`api/admin/releases/${track}/${encodeURIComponent(version)}`, { method: 'DELETE' });
    await loadReleases();
  } catch (e) { alert(e.message); }
}

// Что выбрано для выкладки: по latest-….yml (сборку и версию берём из его содержимого, а не из
// имени файла) находим среди выбранных установщик и карту блоков.
let releasePlan = [];

async function planRelease() {
  const files = [...document.getElementById('releaseFiles').files];
  const byName = new Map(files.map((f) => [f.name, f]));
  releasePlan = [];
  const notes = [];
  for (const f of files.filter((x) => /\.ya?ml$/i.test(x.name))) {
    const yml = await f.text();
    const p = (/^path:\s*'?([^'\r\n]+)'?\s*$/m.exec(yml) || [])[1];
    const m = /^iskra-setup-(win7|win10)-(\d+\.\d+\.\d+)\.exe$/.exec(p || '');
    if (!m) { notes.push(`<div style="color:var(--danger)">${escapeHtml(f.name)}: это не latest.yml сборки клиента</div>`); continue; }
    const exe = byName.get(p); const map = byName.get(p + '.blockmap');
    const ok = exe && map;
    notes.push(`<div>${TRACK_LABEL[m[1]]}, версия <b>${m[2]}</b>: `
      + `установщик ${exe ? '✓ ' + fmtSize(exe.size) : '<span style="color:var(--danger)">не выбран (' + escapeHtml(p) + ')</span>'}, `
      + `карта блоков ${map ? '✓' : '<span style="color:var(--danger)">не выбрана</span>'}</div>`);
    if (ok) releasePlan.push({ track: m[1], version: m[2], yml, exe, map });
  }
  if (!files.length) notes.length = 0;
  else if (!files.some((x) => /\.ya?ml$/i.test(x.name))) notes.push('<div style="color:var(--danger)">Не выбран latest-….yml — без него сервер не сможет проверить установщик</div>');
  document.getElementById('releasePlan').innerHTML = notes.join('');
  document.getElementById('releasePublishBtn').disabled = !releasePlan.length;
}

// Загрузка с ходом выполнения: у fetch его нет, а установщик — сотни мегабайт.
function uploadReleaseFile(track, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `api/admin/releases/${track}/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || `Ошибка загрузки (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Связь с сервером прервалась во время загрузки'));
    xhr.send(file);
  });
}

async function publishRelease() {
  const btn = document.getElementById('releasePublishBtn');
  const progress = document.getElementById('releaseProgress');
  let password;
  try { password = releasePassword(); } catch (e) { alert(e.message); return; }
  const what = releasePlan.map((r) => `${TRACK_LABEL[r.track]} ${r.version}`).join(', ');
  if (!confirm(`Выложить ${what}? Клиенты начнут обновляться сами: при следующем запуске и по «Проверить сейчас».`)) return;
  btn.disabled = true;
  try {
    // Пароль — до загрузки: опечатка не должна стоить сотен мегабайт трафика.
    progress.textContent = 'Проверка пароля…';
    await api('api/admin/releases/confirm', { method: 'POST', body: JSON.stringify({ password }) });
    for (const r of releasePlan) {
      const label = `${TRACK_LABEL[r.track]} ${r.version}`;
      await uploadReleaseFile(r.track, r.exe, (p) => { progress.textContent = `${label}: загрузка установщика ${Math.round(p * 100)}%`; });
      progress.textContent = `${label}: карта блоков…`;
      await uploadReleaseFile(r.track, r.map, () => {});
      progress.textContent = `${label}: сервер проверяет контрольную сумму…`;
      await api(`api/admin/releases/${r.track}/publish`, { method: 'POST', body: JSON.stringify({ yml: r.yml, password }) });
    }
    progress.textContent = `Выложено: ${what}`;
    document.getElementById('releaseFiles').value = '';
    document.getElementById('releasePassword').value = '';
    releasePlan = [];
    document.getElementById('releasePlan').innerHTML = '';
    await loadClients();
  } catch (e) {
    progress.textContent = '';
    alert(e.message);
    btn.disabled = !releasePlan.length;
    await loadReleases();
  }
}

async function loadClients() {
  const body = document.getElementById('clientsBody');
  body.innerHTML = '<tr><td colspan="5">Загрузка...</td></tr>';
  try {
    await loadPublishedVersions();
    const clients = await api('api/admin/clients');
    document.getElementById('clientsSummary').textContent =
      clients.length ? `Машин на связи: ${clients.length}` : '';
    body.innerHTML = clients.map(c => {
      // Устаревшей считаем только тогда, когда есть с чем сравнивать: и версия клиента известна,
      // и на сервере что-то выложено для его трека.
      const pub = c.track && publishedCache[c.track] ? publishedCache[c.track].version : null;
      const outdated = pub && c.version && pub !== c.version;
      const verCell = c.version
        ? `${escapeHtml(c.version)}${outdated ? ` <span style="color:var(--warn)">→ ${escapeHtml(pub)}</span>` : ''}`
        : '<span style="color:var(--muted)">—</span>';
      const trackLabel = { win7: 'Windows 7 / 8.1', win10: 'Windows 10+', dev: 'из исходников' }[c.track] || '—';
      return `<tr>
        <td>${escapeHtml(c.user)}</td>
        <td>${escapeHtml(c.hostname)}</td>
        <td>${verCell}</td>
        <td style="color:var(--muted)">${escapeHtml(trackLabel)}</td>
        <td class="row-flex">
          <button class="action" data-uid="${c.userId}" data-host="${escapeHtml(c.hostname)}"
            onclick="forceUpdate(this.dataset.uid, this.dataset.host)"${outdated ? '' : ' disabled title="Версия уже актуальна"'}>Обновить</button>
          <button class="action ghost" data-uid="${c.userId}" data-host="${escapeHtml(c.hostname)}"
            onclick="requestClientLog(this.dataset.uid, this.dataset.host)">Журнал</button>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" style="color:var(--muted)">Сейчас никто не подключён</td></tr>';
  } catch (e) { body.innerHTML = `<tr><td colspan="5">Ошибка: ${escapeHtml(e.message)}</td></tr>`; }
}

async function forceUpdate(userId, host) {
  if (!confirm(`Запустить обновление на «${host}»? Приложение у сотрудника перезапустится через 15 секунд после загрузки.`)) return;
  try {
    await api('api/admin/force-update', { method: 'POST', body: JSON.stringify({ userId: Number(userId), host }) });
    alert('Команда отправлена. Обновление займёт некоторое время — список можно обновить позже.');
  } catch (e) { alert(e.message); }
}

async function requestClientLog(userId, host) {
  const panel = document.getElementById('clientLogPanel');
  const text = document.getElementById('clientLogText');
  document.getElementById('clientLogTitle').textContent = `Журнал с машины «${host}»`;
  panel.style.display = '';
  text.textContent = 'Запрашиваем журнал у клиента…';
  try {
    await api('api/admin/request-log', { method: 'POST', body: JSON.stringify({ userId: Number(userId), host }) });
  } catch (e) { text.textContent = 'Ошибка: ' + e.message; return; }
  // Клиент отвечает не мгновенно — журнал приходит на сервер отдельным запросом. Опрашиваем
  // несколько раз, а не ждём один раз наугад.
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 700));
    try {
      const dump = await api(`api/admin/client-log?userId=${encodeURIComponent(userId)}&host=${encodeURIComponent(host)}`);
      if (Date.now() - dump.at < 60000) {
        text.textContent = dump.text || '(журнал пуст)';
        return;
      }
    } catch { /* ещё не пришёл — ждём дальше */ }
  }
  text.textContent = 'Клиент не прислал журнал. Возможно, он только что отключился.';
}

async function loadBroadcastFeed() {
  // all=1 — панель показывает и объявления всей организации, и сообщения отдельным отделам:
  // сотрудник видит только свои, администратор по своей задаче видит всё.
  const items = await api('api/broadcasts?all=1');
  document.getElementById('bcFeed').innerHTML = items.map(b => {
    const time = new Date(b.created_at).toLocaleString('ru-RU');
    const dept = b.department ? `<span class="time">отдел: ${escapeHtml(b.department)}</span>` : '';
    return `<div class="bc-item"><span class="who">${escapeHtml(b.from_user)}</span><span class="time">${time}</span>${dept}<div class="txt">${escapeHtml(b.text)}</div></div>`;
  }).join('') || '<div style="color:var(--muted)">Рассылок пока не было</div>';
}
async function sendBroadcast() {
  const el = document.getElementById('bcText');
  const text = el.value.trim();
  if (!text) return;
  try { await api('api/broadcast', { method: 'POST', body: JSON.stringify({ text }) }); el.value = ''; loadBroadcastFeed(); } catch (e) { alert(e.message); }
}

// Отметка присутствия по HTTP — чтобы администратор, сидящий в панели, числился в сети и у
// сотрудников в клиенте. Одного WebSocket ниже для этого мало: панель открывают через прокси
// платформы, где апгрейд до WS не пробрасывается, и тогда сокет не поднимается вовсе, а панель
// продолжает работать. Отметка живёт на сервере минуту и гаснет сама, если вкладку закрыли.
const PRESENCE_HEARTBEAT_MS = 20000;
async function sendPresenceHeartbeat() {
  try { await api('api/presence/heartbeat', { method: 'POST', body: JSON.stringify({}) }); }
  catch { /* сервер недоступен — следующий тик попробует снова, специально ничего не показываем */ }
}
function startPresenceHeartbeat() {
  sendPresenceHeartbeat();
  setInterval(sendPresenceHeartbeat, PRESENCE_HEARTBEAT_MS);
}

function connectPresenceWs() {
  const wsUrl = location.origin.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsUrl}?token=${token}&host=${encodeURIComponent('Веб-панель администратора')}`);
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'presence') {
      const online = new Set(Object.entries(data.users).filter(([, v]) => v.state !== 'offline').map(([k]) => k));
      document.getElementById('statOnline').textContent = online.size;
    }
  };
  ws.onclose = () => setTimeout(connectPresenceWs, 3000);
}

async function startDash() {
  // Право могло измениться (лично или через отдел) с прошлого захода — перепроверяем перед показом панели
  let fresh;
  try { fresh = await api('api/me'); } catch { logout(); return; }
  if (!fresh.can_admin) { logout(); return; }
  me = fresh;
  localStorage.setItem('admin_me', JSON.stringify(me));

  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('dash').classList.add('active');
  document.getElementById('whoName').textContent = me.display_name || me.username;
  await refreshAll();
  document.getElementById('whoRole').textContent = (me.departments || []).map(d => d.name).join(', ');
  await loadHistory();
  await loadBroadcastFeed();
  await loadFiles();
  await loadUploadSettings();
  document.getElementById('logsDay').value = todayStr();
  await loadLogs();
  await loadClients();
  connectPresenceWs();
  startPresenceHeartbeat();
  // Открываем раздел, отмеченный активным в разметке, через ту же функцию, что
  // и клик. Иначе всё, что раздел включает при открытии (опрос присутствия),
  // при загрузке панели не запускается.
  activateView(document.querySelector('.nav-item.active')?.dataset.view || 'overview');
  setInterval(refreshAll, 30000);
}

if (token && me) startDash();
