// ====== Иконки (единый набор — обводка, без внешних зависимостей) ======
const ICON_PATHS = {
  inbox: '<path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 5h14l2 7v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7l2-7z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chart: '<line x1="5" y1="20" x2="5" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="19" y1="20" x2="19" y2="14"/>',
  sliders: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="1.8"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="1.8"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="1.8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  chevron: '<polyline points="9 6 15 12 9 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  paperclip: '<path d="M21 12.5l-8.5 8.5a4 4 0 1 1-5.66-5.66l9-9a2.5 2.5 0 1 1 3.54 3.54l-9 9a1 1 0 1 1-1.42-1.42l8-8"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  box: '<path d="M21 8L12 3 3 8l9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
};
function icon(name, size) {
  size = size || 16;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
}

// ====== Константы ======
const TITLE_MAX = 50;
const DESCRIPTION_MAX = 140;
// Цвета — тональные пары Material 3 (насыщенный тон для точки/текста,
// светлый «container» для подложки). Держите их в согласии с палитрой
// public/styles.css: значения продублированы здесь, потому что подставляются
// в инлайновые стили при отрисовке.
const PRIORITIES = [
  { id: "critical", label: "Критичный", color: "#8C1D18", soft: "#FFDAD6" },
  { id: "high", label: "Высокий", color: "#8A4600", soft: "#FFDCC2" },
  { id: "medium", label: "Средний", color: "#7D5700", soft: "#FFDEA6" },
  { id: "low", label: "Низкий", color: "#5A5248", soft: "#EFE5DB" },
];
const STATUSES = [
  { id: "new", label: "Новая" },
  { id: "progress", label: "В работе" },
  { id: "waiting", label: "Ожидает ответа" },
  { id: "resolved", label: "Решена" },
  { id: "closed", label: "Закрыта" },
  { id: "cancelled", label: "Отменена" },
];
// [цвет текста, цвет подложки] — тональные пары Material 3.
const STATUS_COLORS = {
  new: ["#101C33", "#DCE3F9"], progress: ["#2E1500", "#FFDCC2"], waiting: ["#21005D", "#EADDFF"],
  resolved: ["#08210F", "#CDEBD5"], closed: ["#302A24", "#EFE5DB"], cancelled: ["#302A24", "#EFE5DB"],
};

// ====== Состояние ======
const state = { user: null, view: "inbox", tickets: [], currentTicket: null, notifications: [], departments: [], modules: [], navGroupOpen: {} };
let viewPollHandle = null;   // интервал автообновления текущего экрана (список/карточка)
let notifPollHandle = null;  // интервал обновления счётчика уведомлений (работает всегда)

// ====== API-обёртка ======
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: opts.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* пусто тело у некоторых ответов */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Ошибка ${res.status}`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

function initials(name) {
  return (name || "").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
}
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T") + "Z");
  if (isNaN(d)) return iso;
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function toast(msg, isError) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ====== Точка входа ======
const root = document.getElementById("root");

async function boot() {
  try {
    const { user } = await api("/auth/me");
    state.user = user;
    await enterApp();
  } catch (e) {
    await renderLogin();
  }
}

// ====== Экран логина ======
async function renderLogin(errorMsg) {
  let detectedMode = null;
  let manualMode = null; // если автоопределение не сработало, пользователь может выбрать сам

  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo"><div class="login-logo-icon">С</div><div class="login-title">Служба заявок</div></div>
        <div class="login-sub">Липецкстат · внутренняя система</div>
        <div id="networkNote" class="note-box">Определяем вашу сеть…</div>
        <div id="manualSwitch" style="display:none;margin-bottom:16px;"></div>
        ${errorMsg ? `<div class="error-box">${esc(errorMsg)}</div>` : ""}
        <div class="field-label">Логин</div>
        <input class="field-input" id="loginInput" placeholder="d.volkov" autocomplete="username">
        <div class="field-label">Пароль</div>
        <input class="field-input" id="passwordInput" type="password" placeholder="••••••••" autocomplete="current-password">
        <button class="btn-primary" id="loginBtn">Войти</button>
        <div style="margin-top:12px;font-size:11px;color:var(--ink-soft);">Для локального аварийного входа начните логин с «!»</div>
      </div>
    </div>`;

  const note = document.getElementById("networkNote");
  const manualSwitch = document.getElementById("manualSwitch");

  function renderManualSwitch() {
    manualSwitch.style.display = "block";
    manualSwitch.innerHTML = `
      <div class="tab-group">
        <button class="tab-btn ${manualMode === "A" ? "active" : ""}" data-mode="A">Домен А</button>
        <button class="tab-btn ${manualMode === "B" ? "active" : ""}" data-mode="B">Домен Б</button>
      </div>`;
    manualSwitch.querySelectorAll(".tab-btn").forEach(btn => {
      btn.onclick = () => { manualMode = btn.dataset.mode; renderManualSwitch(); };
    });
  }

  try {
    const { mode } = await api("/auth/detect");
    detectedMode = mode;
    if (mode) {
      note.textContent = `Определена сеть: Домен ${mode}`;
    } else {
      note.textContent = "Не удалось определить сеть автоматически — выберите домен вручную.";
      manualMode = "A";
      renderManualSwitch();
    }
  } catch (e) {
    note.textContent = "Не удалось определить сеть — выберите домен вручную.";
    manualMode = "A";
    renderManualSwitch();
  }

  async function doLogin() {
    const loginRaw = document.getElementById("loginInput").value.trim();
    const password = document.getElementById("passwordInput").value;
    const btn = document.getElementById("loginBtn");
    if (!loginRaw || !password) return;

    const isLocal = loginRaw.startsWith("!");
    const mode = isLocal ? "local" : (detectedMode || manualMode);
    if (!mode) {
      renderLogin("Не удалось определить домен для входа. Выберите домен вручную.");
      return;
    }

    btn.disabled = true; btn.textContent = "Вход...";
    try {
      const { user } = await api("/auth/login", { method: "POST", body: { mode, login: loginRaw, password } });
      state.user = user;
      await enterApp();
    } catch (e) {
      renderLogin(e.message || "Не удалось войти");
    }
  }
  document.getElementById("loginBtn").onclick = doLogin;
  document.getElementById("passwordInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

// ====== Оболочка приложения ======
async function enterApp() {
  try {
    const { departments } = await api("/departments");
    state.departments = departments;
  } catch (e) { state.departments = []; }
  try {
    const { modules } = await api("/modules");
    state.modules = modules;
  } catch (e) { state.modules = []; }
  await refreshNotifications();
  setView("inbox");
  if (!notifPollHandle) {
    notifPollHandle = setInterval(async () => {
      await refreshNotifications();
      updateBadgeDom();
    }, 20000);
  }
}

function clearViewPoll() {
  if (viewPollHandle) { clearInterval(viewPollHandle); viewPollHandle = null; }
}

function setView(view, arg) {
  clearViewPoll();
  if (view === "detail") {
    state.currentTicket = arg;
    if (state.view !== "detail") state.previousView = state.view; // не затираем при обновлении самой карточки
  }
  state.view = view;
  renderShell();
}

function updateBadgeDom() {
  const total = state.notifications.filter(n => !n.is_read).length;
  setNavBadge('.nav-btn[data-view="inbox"]', total);
  setNavBadge('.nav-group-header[data-group="tickets"]', total); // для админа бейдж висит на заголовке группы "Заявки"
}

function setNavBadge(selector, count) {
  const el = document.querySelector(selector);
  if (!el) return;
  let badge = el.querySelector(".nav-badge");
  if (count > 0) {
    if (!badge) {
      badge = document.createElement("span"); badge.className = "nav-badge";
      // у заголовка группы бейдж должен идти перед шевроном, а не в самый конец
      const chevron = el.querySelector(".nav-chevron");
      if (chevron) el.insertBefore(badge, chevron); else el.appendChild(badge);
    }
    badge.textContent = count;
  } else if (badge) {
    badge.remove();
  }
}

async function refreshNotifications() {
  try {
    const { notifications } = await api("/notifications");
    state.notifications = notifications;
  } catch (e) { /* не критично для остального интерфейса */ }
}

function navBtnHtml(it, active, indented) {
  return `
    <button class="nav-btn ${active ? "active" : ""} ${indented ? "nav-btn-sub" : ""}" data-view="${it.id}">
      <span class="nav-icon">${it.icon ? icon(it.icon) : ""}</span>${esc(it.label)}
      ${it.badge ? `<span class="nav-badge">${it.badge}</span>` : ""}
    </button>`;
}

function navGroupHtml(groupId, label, iconName, badge, items) {
  const open = state.navGroupOpen[groupId] !== false; // по умолчанию раскрыта
  return `
    <button class="nav-group-header" data-group="${groupId}">
      <span class="nav-icon">${icon(iconName)}</span>${esc(label)}
      ${badge ? `<span class="nav-badge">${badge}</span>` : ""}
      <span class="nav-chevron ${open ? "open" : ""}">${icon("chevron", 13)}</span>
    </button>
    ${open ? `<div class="nav-subgroup">${items.map(it => navBtnHtml(it, state.view === it.id, true)).join("")}</div>` : ""}`;
}

const MODULE_VIEW_ICONS = { log: "inbox", stats: "chart", directory: "folder", root: "box" };

function renderShell() {
  const u = state.user;
  const totalUnread = state.notifications.filter(n => !n.is_read).length;
  const isIT = u.role === "it";
  const deptForRole = Object.fromEntries(state.departments.filter(d => d.role !== "user").map(d => [d.role, d.name]));
  const isExecutor = !isIT && !!deptForRole[u.role];
  const roleLabel = u.role === "user" ? "Сотрудник" : (deptForRole[u.role] || u.role);

  let navHtml;
  if (isIT) {
    const subItems = [
      { id: "inbox", label: "Входящие заявки", icon: "inbox", badge: totalUnread },
      { id: "mine", label: "Мои заявки", icon: "folder" },
      { id: "create", label: "Новая заявка", icon: "plus" },
      { id: "dashboard", label: "Статистика", icon: "chart" },
      { id: "admin", label: "Администрирование", icon: "sliders" },
    ];
    navHtml = navGroupHtml("tickets", "Заявки", "folder", totalUnread, subItems);
  } else if (isExecutor) {
    const items = [
      { id: "inbox", label: "Входящие заявки", icon: "inbox", badge: totalUnread },
      { id: "mine", label: "Мои заявки", icon: "folder" },
      { id: "create", label: "Новая заявка", icon: "plus" },
    ];
    navHtml = items.map(it => navBtnHtml(it, state.view === it.id, false)).join("");
  } else {
    const items = [
      { id: "inbox", label: "Заявки", icon: "folder", badge: totalUnread },
      { id: "create", label: "Новая заявка", icon: "plus" },
    ];
    navHtml = items.map(it => navBtnHtml(it, state.view === it.id, false)).join("");
  }

  if (state.modules.length) {
    navHtml += `<div class="nav-divider"></div>` + state.modules.map(m => {
      const views = (m.views && m.views.length) ? m.views : [{ id: "root", label: m.label, sub: "" }];
      if (views.length === 1) {
        const it = { id: `module:${m.id}:${views[0].id}`, label: m.label, icon: "box" };
        return navBtnHtml(it, state.view === it.id, false);
      }
      const items = views.map(v => ({ id: `module:${m.id}:${v.id}`, label: v.label, icon: MODULE_VIEW_ICONS[v.id] }));
      return navGroupHtml(`mod-${m.id}`, m.label, "box", 0, items);
    }).join("");
  }

  root.innerHTML = `
    <div class="app-shell">
      <div class="sidebar">
        <div class="sidebar-head"><div class="login-logo-icon">С</div><div style="font-family:var(--serif);font-weight:600;font-size:14.5px;">Служба заявок</div></div>
        <div class="sidebar-nav">${navHtml}</div>
        <div class="sidebar-foot">
          <div class="user-row">
            <div class="user-avatar">${initials(u.full_name)}</div>
            <div style="min-width:0;">
              <div class="user-name">${esc(u.full_name)}</div>
              <div class="user-dept">${esc(u.department || u.ad_login)}</div>
              <div class="user-role-badge">${esc(roleLabel)}</div>
            </div>
          </div>
          <button class="logout-btn" id="logoutBtn">${icon("logout")} Выйти</button>
        </div>
      </div>
      <div class="main" id="mainArea"></div>
    </div>`;

  root.querySelectorAll(".nav-btn").forEach(btn => btn.onclick = () => setView(btn.dataset.view));
  root.querySelectorAll(".nav-group-header").forEach(btn => btn.onclick = () => {
    const g = btn.dataset.group;
    state.navGroupOpen[g] = state.navGroupOpen[g] === false ? true : false;
    renderShell();
  });

  document.getElementById("logoutBtn").onclick = async () => {
    clearViewPoll();
    if (notifPollHandle) { clearInterval(notifPollHandle); notifPollHandle = null; }
    await api("/auth/logout", { method: "POST" });
    state.user = null;
    renderLogin();
  };

  const main = document.getElementById("mainArea");
  if (state.view === "inbox") renderList(main, { scope: "inbox" });
  else if (state.view === "mine") renderList(main, { scope: "mine" });
  else if (state.view === "create") renderCreate(main);
  else if (state.view === "detail") renderDetail(main, state.currentTicket);
  else if (state.view === "dashboard") renderDashboard(main);
  else if (state.view === "admin") renderAdmin(main);
  else if (state.view.startsWith("module:")) {
    const [, modId, viewId] = state.view.split(":");
    const mod = state.modules.find(m => m.id === modId);
    const views = mod && ((mod.views && mod.views.length) ? mod.views : [{ id: "root", label: mod.label, sub: "" }]);
    const view = views && views.find(v => v.id === viewId);
    if (mod && view) renderModule(main, mod, view);
  }
}

// ====== Список заявок ======
function renderModule(main, mod, view) {
  clearViewPoll();
  const src = `${mod.path}/${view.sub || ""}`;
  const title = (mod.views && mod.views.length > 1) ? `${mod.label} — ${view.label}` : mod.label;
  main.innerHTML = `
    <div class="topbar"><div class="topbar-title">${esc(title)}</div></div>
    <div class="page page-flush">
      <iframe class="module-frame" src="${esc(src)}" title="${esc(title)}"></iframe>
    </div>`;
}

async function renderList(main, opts = {}) {
  clearViewPoll();
  const u = state.user;
  const isIT = u.role === "it";
  const deptForRole = Object.fromEntries(state.departments.filter(d => d.role !== "user").map(d => [d.role, d.name]));
  const isExecutor = !isIT && !!deptForRole[u.role];
  const isPrivileged = isIT || isExecutor; // видит колонки "От кого"/"Кабинет"
  const scope = opts.scope || "inbox";
  const showDeptFilter = isIT && scope === "inbox"; // только у админа есть смысл фильтровать по отделу

  let closed = false; // открытые/закрытые — переключатель внутри страницы, не выпадающий список
  let q = "";

  const titles = {
    inbox: isIT || isExecutor ? "Входящие заявки" : "Заявки",
    mine: "Мои заявки",
  };

  // Тема занимает всё свободное место (1fr), а не упирается в 260px:
  // на широком экране заголовок заявки иначе обрезался посреди слова.
  const gridCols = isPrivileged
    ? "92px minmax(220px,1fr) 150px 80px 130px 150px 140px 24px"
    : "92px minmax(220px,1fr) 130px 150px 140px 24px";

  main.innerHTML = `
    <div class="topbar">
      <div class="topbar-title">${titles[scope]}</div>
      <div class="search-wrap"><span class="search-icon">${icon("search", 15)}</span>
        <input class="input" id="searchInput" placeholder="Поиск по номеру или теме">
      </div>
    </div>
    <div class="page">
      <div class="filters-row">
        <div class="toggle-group">
          <button class="toggle-btn active" data-closed="0">Открытые</button>
          <button class="toggle-btn" data-closed="1">Закрытые</button>
        </div>
        ${showDeptFilter ? `
        <select class="input" id="deptFilter">
          <option value="">Все отделы</option>
          ${state.departments.map(d => `<option>${esc(d.name)}</option>`).join("")}
        </select>` : ""}
        <div class="filters-count" id="countLabel">Загрузка…</div>
      </div>
      <div class="ticket-table">
        <div class="ticket-row-head" style="grid-template-columns:${gridCols};">
          <div>Номер</div><div>Тема</div>
          ${isPrivileged ? `<div>От кого</div><div>Кабинет</div>` : ""}
          <div>Статус</div><div>Исполнитель</div><div>Обновлено</div><div></div>
        </div>
        <div id="ticketRows"><div class="spinner">Загрузка заявок…</div></div>
      </div>
    </div>`;

  const load = async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("status", closed ? "archive" : "");
    if (scope === "mine") params.set("mine", "1");
    if (showDeptFilter) {
      const dept = document.getElementById("deptFilter").value;
      if (dept) params.set("category", dept);
    }
    try {
      const { tickets } = await api("/tickets?" + params.toString());
      state.tickets = tickets;
      const rowsEl = document.getElementById("ticketRows");
      document.getElementById("countLabel").textContent = `${tickets.length} заявок`;
      if (tickets.length === 0) {
        rowsEl.innerHTML = `<div class="empty-state">Ничего не найдено.</div>`;
        return;
      }
      const unreadTicketIds = new Set(state.notifications.filter(n => !n.is_read).map(n => n.ticket_id));
      rowsEl.innerHTML = tickets.map(t => {
        const p = PRIORITIES.find(x => x.id === t.priority) || PRIORITIES[2];
        const [sc, ss] = STATUS_COLORS[t.status] || STATUS_COLORS.new;
        const sLabel = (STATUSES.find(s => s.id === t.status) || {}).label || t.status;
        const isUnread = unreadTicketIds.has(t.id);
        return `
        <div class="ticket-row" data-id="${t.id}" style="grid-template-columns:${gridCols};">
          <div class="ticket-id mono">${esc(t.display_id)}</div>
          <div class="ticket-title-cell">
            <span class="priority-dot" style="background:${p.color}"></span>
            <span class="title" style="${isUnread ? "font-weight:700;" : ""}">${esc(t.title)}</span>
            ${isUnread ? `<span class="unread-dot" title="Есть новые комментарии"></span>` : ""}
          </div>
          ${isPrivileged ? `
            <div class="cell-wrap" style="color:var(--ink-soft);font-size:13px;">${esc(t.created_by || "—")}</div>
            <div class="cell-ellipsis mono" style="color:var(--ink-soft);font-size:13px;">${esc(t.room || "—")}</div>
          ` : ""}
          <div><span class="badge" style="color:${sc};background:${ss};">${sLabel}</span></div>
          <div class="cell-wrap" style="color:var(--ink-soft);font-size:13px;">${esc(t.assigned_to || "—")}</div>
          <div class="cell-ellipsis" style="color:var(--ink-soft);font-size:12px;">${fmtDate(t.updated_at)}</div>
          <div class="row-arrow">${icon("chevron", 15)}</div>
        </div>`;
      }).join("");
      rowsEl.querySelectorAll(".ticket-row").forEach(row => {
        row.onclick = async () => {
          try {
            const { ticket } = await api("/tickets/" + row.dataset.id);
            api(`/notifications/ticket/${row.dataset.id}/read`, { method: "PATCH" })
              .then(refreshNotifications).then(updateBadgeDom).catch(() => {});
            setView("detail", ticket);
          } catch (e) { toast(e.message, true); }
        };
      });
    } catch (e) {
      document.getElementById("ticketRows").innerHTML = `<div class="empty-state">Не удалось загрузить заявки: ${esc(e.message)}</div>`;
    }
  };

  main.querySelectorAll(".toggle-btn").forEach(btn => {
    btn.onclick = () => {
      closed = btn.dataset.closed === "1";
      main.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      load();
    };
  });
  if (showDeptFilter) document.getElementById("deptFilter").onchange = load;
  let searchTimer;
  document.getElementById("searchInput").oninput = () => {
    q = document.getElementById("searchInput").value;
    clearTimeout(searchTimer); searchTimer = setTimeout(load, 300);
  };

  load();
  viewPollHandle = setInterval(load, 20000); // автообновление списка
}

// ====== Создание заявки ======
function renderCreate(main) {
  let files = [];
  main.innerHTML = `
    <div class="topbar"><div class="topbar-title">Новая заявка</div></div>
    <div class="page">
      <div style="max-width:640px;margin:0 auto;">
      <div class="card">
        <div class="field-label">Тема</div>
        <input class="field-input" id="cTitle" maxlength="${TITLE_MAX}" placeholder="Коротко опишите проблему" style="margin-bottom:4px;">
        <div id="titleCount" style="font-size:11px;color:var(--ink-soft);margin-bottom:12px;text-align:right;">0/${TITLE_MAX}</div>
        <div class="form-row">
          <div><div class="field-label">Отдел</div><select class="input" id="cCategory" style="width:100%;">${state.departments.map(d => `<option>${esc(d.name)}</option>`).join("")}</select></div>
          <div><div class="field-label">Приоритет</div><select class="input" id="cPriority" style="width:100%;">${PRIORITIES.map(p => `<option value="${p.id}" ${p.id === "medium" ? "selected" : ""}>${p.label}</option>`).join("")}</select></div>
        </div>
        <div class="form-row">
          <div><div class="field-label">Кабинет</div><input class="field-input" id="cRoom" placeholder="напр. 214" style="margin-bottom:0;"></div>
          <div><div class="field-label">Внутренний номер</div><input class="field-input" id="cExt" placeholder="напр. 214" style="margin-bottom:0;"></div>
        </div>
        <div class="field-label" style="margin-top:16px;">Описание</div>
        <textarea class="input field-input" id="cDesc" maxlength="${DESCRIPTION_MAX}" rows="4" placeholder="Что произошло, когда началось, что уже пробовали" style="width:100%;box-sizing:border-box;word-wrap:break-word;margin-bottom:4px;"></textarea>
        <div id="descCount" style="font-size:11px;color:var(--ink-soft);margin-bottom:12px;text-align:right;">0/${DESCRIPTION_MAX}</div>
        <div class="field-label">Вложения</div>
        <div class="dropzone" id="dropzone"><span class="dropzone-icon">${icon("paperclip", 18)}</span>Перетащите файлы сюда или нажмите, чтобы выбрать</div>
        <input type="file" id="fileInput" multiple style="display:none;">
        <div id="fileList"></div>
        <button class="btn btn-wire" id="submitBtn" style="margin-top:6px;" disabled>Отправить заявку</button>
      </div>
      </div>
    </div>`;

  const titleEl = document.getElementById("cTitle");
  const descEl = document.getElementById("cDesc");
  const submitBtn = document.getElementById("submitBtn");
  const titleCount = document.getElementById("titleCount");
  const descCount = document.getElementById("descCount");

  titleEl.oninput = () => {
    submitBtn.disabled = !titleEl.value.trim();
    titleCount.textContent = `${titleEl.value.length}/${TITLE_MAX}`;
  };
  descEl.oninput = () => { descCount.textContent = `${descEl.value.length}/${DESCRIPTION_MAX}`; };

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const fileList = document.getElementById("fileList");
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = () => { files = [...files, ...fileInput.files]; renderFiles(); };
  function renderFiles() {
    fileList.innerHTML = files.map((f, i) => `
      <div class="file-chip"><span class="file-chip-name">${icon("paperclip", 13)} ${esc(f.name)} <span style="color:var(--ink-soft);">· ${(f.size/1024).toFixed(0)} КБ</span></span><span class="file-chip-remove" data-i="${i}">${icon("x", 13)}</span></div>`).join("");
    fileList.querySelectorAll("[data-i]").forEach(el => el.onclick = () => { files.splice(+el.dataset.i, 1); renderFiles(); });
  }

  submitBtn.onclick = async () => {
    const title = titleEl.value.trim();
    if (!title) return;
    submitBtn.disabled = true; submitBtn.textContent = "Отправка…";
    try {
      const ticket = await api("/tickets", { method: "POST", body: {
        title,
        category: document.getElementById("cCategory").value,
        priority: document.getElementById("cPriority").value,
        room: document.getElementById("cRoom").value || null,
        extension: document.getElementById("cExt").value || null,
        description: document.getElementById("cDesc").value || null,
      }});
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        await api(`/tickets/${ticket.id}/attachments`, { method: "POST", body: fd });
      }
      toast(`Заявка ${ticket.display_id} создана`);
      setView("inbox");
    } catch (e) {
      toast(e.message, true);
      submitBtn.disabled = false; submitBtn.textContent = "Отправить заявку";
    }
  };
}

// ====== Карточка заявки ======
async function reloadTicket(id) {
  const { ticket } = await api("/tickets/" + id);
  state.currentTicket = ticket;
  return ticket;
}

function renderDetail(main, ticket) {
  const u = state.user;
  const isIT = u.role === "it";
  const deptForRole = Object.fromEntries(state.departments.filter(d => d.role !== "user").map(d => [d.role, d.name]));
  const isPrivileged = isIT || !!deptForRole[u.role]; // может оставлять внутренние заметки
  const canManage = isIT || deptForRole[u.role] === ticket.category; // видит блок "Управление"
  const p = PRIORITIES.find(x => x.id === ticket.priority) || PRIORITIES[2];

  main.innerHTML = `
    <div class="topbar"><div class="topbar-title-row"><button class="icon-btn" id="backBtn" title="Назад">${icon("chevron", 18)}</button><div class="topbar-title mono" style="color:var(--wire);">${esc(ticket.display_id)}</div></div></div>
    <div class="page">
      <div class="detail-layout">
        <div class="detail-main">
          <div class="card" style="margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:10px;">
              <div style="font-size:17px;font-weight:700;letter-spacing:-0.2px;word-break:break-word;overflow-wrap:break-word;">${esc(ticket.title)}</div>
              <span class="priority-dot" style="background:${p.color};margin-top:6px;"></span>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:16px;" id="statusRow"></div>
            <div style="font-size:13.5px;line-height:1.55;margin-bottom:16px;word-break:break-word;overflow-wrap:break-word;">${esc(ticket.description || "Без описания")}</div>
            <div id="attachList" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
          </div>
          <div class="card">
            <div class="section-label">Комментарии</div>
            <div id="commentsList" style="margin-bottom:18px;"></div>
            <textarea class="input" id="commentText" rows="3" placeholder="Написать комментарий..." style="width:100%;margin-bottom:10px;"></textarea>
            <div style="display:flex;align-items:center;justify-content:space-between;">
              ${isPrivileged ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-soft);"><input type="checkbox" id="internalCheck"> Внутренняя заметка</label>` : "<span></span>"}
              <button class="btn btn-wire" id="sendCommentBtn">Отправить</button>
            </div>
          </div>
          <div class="history-toggle" id="historyToggle"><span class="chevron-icon">${icon("chevron", 13)}</span>История изменений статуса</div>
          <div id="historyList" style="display:none;margin-top:8px;padding-left:18px;border-left:2px solid var(--line-soft);"></div>
        </div>
        <div class="detail-side">
          <div class="card" style="margin-bottom:14px;">
            <div class="section-label">Детали</div>
            <div class="field-mini"><div class="field-mini-label">Создал</div><div class="field-mini-value">${esc(ticket.created_by_name)}</div></div>
            ${ticket.room ? `<div class="field-mini"><div class="field-mini-label">Кабинет</div><div class="field-mini-value mono">${esc(ticket.room)}</div></div>` : ""}
            ${ticket.extension ? `<div class="field-mini"><div class="field-mini-label">Внутр. номер</div><div class="field-mini-value mono">${esc(ticket.extension)}</div></div>` : ""}
            ${!canManage ? `<div class="field-mini"><div class="field-mini-label">Исполнитель</div><div class="field-mini-value">${esc(ticket.assigned_to_name || "—")}</div></div>` : ""}
            <div class="field-mini"><div class="field-mini-label">Создана</div><div class="field-mini-value mono">${fmtDate(ticket.created_at)}</div></div>
            <div class="field-mini"><div class="field-mini-label">Обновлена</div><div class="field-mini-value mono">${fmtDate(ticket.updated_at)}</div></div>
          </div>
          ${canManage ? `
          <div class="card">
            <div class="section-label">Управление</div>
            <div class="field-label">Статус</div>
            <select class="input" id="statusSelect" style="width:100%;margin-bottom:14px;">${STATUSES.map(s => `<option value="${s.id}" ${s.id === ticket.status ? "selected" : ""}>${s.label}</option>`).join("")}</select>
            <div class="field-label">Исполнитель</div>
            <select class="input" id="assigneeSelect" style="width:100%;"><option value="">Загрузка…</option></select>
          </div>` : ""}
        </div>
      </div>
    </div>`;

  function renderStatusRow() {
    const [sc, ss] = STATUS_COLORS[ticket.status] || STATUS_COLORS.new;
    const sLabel = (STATUSES.find(s => s.id === ticket.status) || {}).label || ticket.status;
    document.getElementById("statusRow").innerHTML = `
      <span class="badge" style="color:${sc};background:${ss};">${sLabel}</span>
      <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${esc(ticket.category || "—")}</span>`;
  }
  function renderAttachments() {
    document.getElementById("attachList").innerHTML = (ticket.attachments || []).map(a => `
      <a class="badge" href="/api/tickets/${ticket.id}/attachments/${a.id}" download="${esc(a.filename)}"
         style="color:var(--ink);background:var(--line-soft);text-decoration:none;">
        ${icon("paperclip", 13)} ${esc(a.filename)} <span style="color:var(--ink-soft);">· ${(a.filesize/1024).toFixed(0)} КБ</span>
      </a>`).join("");
  }
  function renderComments() {
    const list = ticket.comments || [];
    document.getElementById("commentsList").innerHTML = list.length ? list.map(c => `
      <div class="comment-box ${c.is_internal ? "internal" : "public"}">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:700;">${esc(c.author)} ${c.is_internal ? `<span style="color:var(--amber);font-size:10.5px;">ВНУТРЕННЯЯ ЗАМЕТКА</span>` : ""}</span>
          <span style="font-size:11px;color:var(--ink-soft);">${fmtDate(c.created_at)}</span>
        </div>
        <div style="font-size:13px;line-height:1.5;">${esc(c.text)}</div>
      </div>`).join("") : `<div style="font-size:12.5px;color:var(--ink-soft);">Комментариев пока нет.</div>`;
  }
  function renderHistory() {
    const list = ticket.history || [];
    document.getElementById("historyList").innerHTML = list.length ? list.map(h => `
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">
        <span class="mono" style="color:var(--ink);">${fmtDate(h.changed_at)}</span> —
        ${esc((STATUSES.find(s=>s.id===h.old_status)||{}).label || h.old_status || "—")} →
        <b style="color:var(--ink);">${esc((STATUSES.find(s=>s.id===h.new_status)||{}).label || h.new_status)}</b>, ${esc(h.changed_by)}
      </div>`).join("") : `<div style="font-size:12px;color:var(--ink-soft);">Изменений не было.</div>`;
  }
  async function renderAssigneeSelect() {
    const sel = document.getElementById("assigneeSelect");
    if (!sel) return;
    try {
      const { users } = await api(`/tickets/${ticket.id}/assignees`);
      sel.innerHTML = `<option value="">— не назначено —</option>` +
        users.map(usr => `<option value="${usr.id}" ${usr.id === ticket.assigned_to ? "selected" : ""}>${esc(usr.full_name)}</option>`).join("");
    } catch (e) {
      sel.innerHTML = `<option value="">Не удалось загрузить список</option>`;
    }
  }

  renderStatusRow(); renderAttachments(); renderComments(); renderHistory();
  if (canManage) renderAssigneeSelect();

  document.getElementById("historyToggle").onclick = () => {
    const el = document.getElementById("historyList");
    const toggleEl = document.getElementById("historyToggle");
    const open = el.style.display !== "none";
    el.style.display = open ? "none" : "block";
    toggleEl.classList.toggle("open", !open);
  };

  document.getElementById("sendCommentBtn").onclick = async () => {
    const text = document.getElementById("commentText").value.trim();
    if (!text) return;
    const isInternal = isPrivileged && document.getElementById("internalCheck").checked;
    try {
      await api(`/tickets/${ticket.id}/comments`, { method: "POST", body: { text, is_internal: isInternal } });
      const fresh = await reloadTicket(ticket.id);
      renderDetail(main, fresh);
    } catch (e) { toast(e.message, true); }
  };

  if (canManage) {
    document.getElementById("statusSelect").onchange = async (e) => {
      try {
        await api(`/tickets/${ticket.id}`, { method: "PATCH", body: { status: e.target.value } });
        const fresh = await reloadTicket(ticket.id);
        renderDetail(main, fresh);
        toast("Статус обновлён");
      } catch (err) { toast(err.message, true); }
    };
    document.getElementById("assigneeSelect").onchange = async (e) => {
      try {
        await api(`/tickets/${ticket.id}`, { method: "PATCH", body: { assigned_to: e.target.value ? Number(e.target.value) : null } });
        const fresh = await reloadTicket(ticket.id);
        renderDetail(main, fresh);
        toast("Исполнитель обновлён");
      } catch (err) { toast(err.message, true); }
    };
  }

  document.getElementById("backBtn").onclick = () => setView(state.previousView || "inbox");

  // Открыли заявку — гасим счётчик уведомлений по ней.
  api(`/notifications/ticket/${ticket.id}/read`, { method: "PATCH" })
    .then(refreshNotifications).then(updateBadgeDom).catch(() => {});

  // Автообновление карточки — не трогаем, если в поле комментария уже
  // что-то набрано, чтобы не затереть недописанный текст. renderDetail
  // вызывается повторно после каждого действия (комментарий, смена статуса)
  // и самим опросом — поэтому сперва гасим предыдущий интервал.
  clearViewPoll();
  viewPollHandle = setInterval(async () => {
    const box = document.getElementById("commentText");
    if (box && box.value.trim()) return;
    try {
      const fresh = await reloadTicket(ticket.id);
      renderDetail(main, fresh);
    } catch (e) { /* тихо пропускаем сбой одного цикла опроса */ }
  }, 20000);
}

// ====== Дашборд ======
async function renderDashboard(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Статистика</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    const [{ tickets }, stats] = await Promise.all([
      api("/tickets?status=all"),
      api("/admin/stats"),
    ]);
    const open = tickets.filter(t => !["resolved", "closed", "cancelled"].includes(t.status)).length;
    const critical = tickets.filter(t => t.priority === "critical" && !["closed", "cancelled"].includes(t.status)).length;
    const closed = tickets.filter(t => ["closed", "resolved"].includes(t.status)).length;

    const byCategory = state.departments.map(d => ({ name: d.name, count: tickets.filter(t => t.category === d.name).length }));
    const maxCount = Math.max(...byCategory.map(c => c.count), 1);

    const topList = (rows) => rows.length
      ? rows.map((r, i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;${i > 0 ? "border-top:1px solid var(--line-soft);" : ""}">
          <span style="font-size:12.5px;">${i + 1}. ${esc(r.full_name)}</span>
          <span class="mono" style="font-size:12.5px;color:var(--ink-soft);">${r.n} закрыто</span>
        </div>`).join("")
      : `<div style="font-size:12.5px;color:var(--ink-soft);padding:8px 0;">Пока нет закрытых заявок за этот период.</div>`;

    main.querySelector(".page").innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">ОТКРЫТО СЕЙЧАС</div><div class="stat-value mono">${open}</div></div>
        <div class="stat-card"><div class="stat-label">КРИТИЧНЫХ АКТИВНЫХ</div><div class="stat-value mono" style="color:${critical ? "var(--red)" : "var(--ink)"};">${critical}</div></div>
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ЗА 7 ДНЕЙ</div><div class="stat-value mono">${stats.closed7}</div></div>
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ЗА 30 ДНЕЙ</div><div class="stat-value mono">${stats.closed30}</div></div>
      </div>
      <div class="stat-grid" style="grid-template-columns:1fr 1fr;">
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ВСЕГО</div><div class="stat-value mono">${closed}</div></div>
        <div class="stat-card"><div class="stat-label">ВСЕГО ЗАЯВОК</div><div class="stat-value mono">${tickets.length}</div></div>
      </div>
      <div class="card" style="margin-bottom:20px;">
        <div class="section-label" style="margin-bottom:16px;">Заявки по отделам</div>
        ${byCategory.map(c => `
          <div class="bar-row">
            <div style="width:130px;font-size:12.5px;">${esc(c.name)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(c.count/maxCount)*100}%"></div></div>
            <div style="width:20px;font-size:12px;text-align:right;" class="mono">${c.count}</div>
          </div>`).join("")}
      </div>
      <div style="display:flex;gap:14px;">
        <div class="card" style="flex:1;">
          <div class="section-label">Топ по закрытым — неделя</div>
          ${topList(stats.topWeek)}
        </div>
        <div class="card" style="flex:1;">
          <div class="section-label">Топ по закрытым — месяц</div>
          ${topList(stats.topMonth)}
        </div>
      </div>`;
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить статистику: ${esc(e.message)}</div>`;
  }
}

// ====== Администрирование ======
async function renderAdmin(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Администрирование</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    const [{ departments: deptSettings }, { admins }] = await Promise.all([
      api("/admin/settings"), api("/admin/admins"),
    ]);

    const ROLE_LABEL = Object.fromEntries(deptSettings.map(d => [d.role, d.name]));

    const groupRow = (id, label, value, placeholder) => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <span style="width:70px;font-size:12px;color:var(--ink-soft);font-weight:600;">${label}</span>
        <input class="input" id="${id}" style="flex:1;" value="${esc(value)}" placeholder="${esc(placeholder)}">
      </div>`;

    const groupCard = (dept) => `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Группа АД — роль ${esc(dept.name)}</div>
        ${groupRow(`group_${dept.role}_A`, "Домен А", dept.groupA, "имя группы")}
        ${groupRow(`group_${dept.role}_B`, "Домен Б", dept.groupB, "имя группы")}
      </div>`;

    main.querySelector(".page").innerHTML = `
      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Текущие исполнители и администраторы</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:14px;">Список читается из членства в группах на момент последнего входа, не редактируется вручную.</div>
        ${admins.length ? admins.map(a => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line-soft);">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:13px;font-weight:600;">${esc(a.full_name)}</span>
              <span class="mono" style="font-size:12px;color:var(--ink-soft);">${esc(a.ad_login)}</span>
              <span class="badge" style="color:var(--wire);background:var(--wire-soft);">${esc(ROLE_LABEL[a.role] || a.role)}</span>
              <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${a.last_domain === "local" ? "Локальный" : "Домен " + esc(a.last_domain)}</span>
            </div>
            <span style="font-size:11px;color:var(--ink-soft);">вход ${fmtDate(a.last_login_at)}</span>
          </div>`).join("") : `<div style="font-size:12.5px;color:var(--ink-soft);">Пока никто не входил под расширенной ролью.</div>`}
      </div>

      <div style="display:flex;gap:20px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div class="card">
            <div class="section-label">Как добавить ещё одну группу исполнителей</div>
            <div style="font-size:12.5px;line-height:1.7;color:var(--ink);">
              1. На сервере откройте файл <code class="mono" style="background:var(--line-soft);padding:1px 5px;border-radius:3px;">config/departments.js</code><br>
              2. Добавьте одну строку в список, например:<br>
              <code class="mono" style="display:block;background:var(--line-soft);padding:8px 10px;border-radius:5px;margin:6px 0;font-size:11.5px;">{ name: "БУХ", prefix: "БУХ", role: "buh" }</code>
              3. Перезапустите сервер (<code class="mono" style="background:var(--line-soft);padding:1px 5px;border-radius:3px;">npm start</code>)<br>
              4. Новый отдел появится в форме создания заявки, в фильтре списка и справа на этой странице — впишите туда название AD-группы, как для остальных отделов.
            </div>
          </div>
        </div>
        <div style="width:380px;flex-shrink:0;">
          ${deptSettings.map(groupCard).join("")}
          <button class="btn btn-wire" id="saveGroups" style="width:100%;justify-content:center;">Сохранить</button>
          <div id="saveMsg" style="margin-top:8px;font-size:12px;color:var(--green);display:none;text-align:center;">Сохранено</div>
        </div>
      </div>`;

    document.getElementById("saveGroups").onclick = async () => {
      try {
        const payload = deptSettings.map(dept => ({
          role: dept.role,
          groupA: document.getElementById(`group_${dept.role}_A`).value.trim(),
          groupB: document.getElementById(`group_${dept.role}_B`).value.trim(),
        }));
        await api("/admin/settings", { method: "PUT", body: { departments: payload } });
        const msg = document.getElementById("saveMsg");
        msg.style.display = "block"; setTimeout(() => msg.style.display = "none", 2500);
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}

boot();
