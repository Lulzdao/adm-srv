// ====== Иконки (единый набор — обводка, без внешних зависимостей) ======
const ICON_PATHS = {
  inbox: '<path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 5h14l2 7v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7l2-7z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chart: '<line x1="5" y1="20" x2="5" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="19" y1="20" x2="19" y2="14"/>',
  sliders: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="1.8"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="1.8"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="1.8"/>',
  shield: '<path d="M12 3l7 3v6c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6l7-3z"/><path d="M9 12.2l2.1 2.1L15.3 10"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  chevron: '<polyline points="9 6 15 12 9 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  paperclip: '<path d="M21 12.5l-8.5 8.5a4 4 0 1 1-5.66-5.66l9-9a2.5 2.5 0 1 1 3.54 3.54l-9 9a1 1 0 1 1-1.42-1.42l8-8"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  box: '<path d="M21 8L12 3 3 8l9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  // Иконки модулей: печать с лентами — Сертвивер, трубка — журнал звонков,
  // облачко реплики — «Искра». Общий «ящик» остаётся запасным вариантом для
  // модулей, которые подключат позже.
  seal: '<circle cx="12" cy="9" r="5.5"/><path d="M8.6 13.5L7.2 21 12 18.6 16.8 21l-1.4-7.5"/>',
  phone: '<path d="M21.5 16.9v2.6a2 2 0 0 1-2.2 2 19.4 19.4 0 0 1-8.5-3 19.1 19.1 0 0 1-5.9-5.9 19.4 19.4 0 0 1-3-8.6 2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1.9.3 1.7.6 2.5a2 2 0 0 1-.5 2.1L7.5 9.4a15.6 15.6 0 0 0 5.9 5.9l1.3-1.1a2 2 0 0 1 2.1-.5c.8.3 1.6.5 2.5.6a2 2 0 0 1 1.7 2z"/>',
  // Раздел оповещений: колокольчик — лента, конверт — настройки отправки,
  // лист с пером — шаблоны писем.
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7z"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
  pen: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/>',
  // Лист с подписью — вкладка МЧД: доверенность это документ, а не сертификат,
  // и в сайдбаре их надо различать с одного взгляда.
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/><path d="M8.5 16.5c1.2-2.4 2-3.6 2.6-3.6.8 0 .5 2.4 1.4 2.4.6 0 1-.8 1.5-.8.4 0 .8.5 1.5 1.4"/>',
  // Искра — та же четырёхлучевая вспышка, что нарисована на иконке
  // десктоп-клиента (MESSENGER/desktop-client/build/icon.png): длинные лучи по
  // осям, короткие по диагоналям.
  spark: '<line x1="12" y1="1.5" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="22.5" y2="12"/><line x1="7.6" y1="7.6" x2="9.9" y2="9.9"/><line x1="16.4" y1="7.6" x2="14.1" y2="9.9"/><line x1="7.6" y1="16.4" x2="9.9" y2="14.1"/><line x1="16.4" y1="16.4" x2="14.1" y2="14.1"/>',
};
function icon(name, size) {
  size = size || 16;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
}

// Государственный герб — фирменный знак системы вместо прежней плитки с
// буквой.
//
// Основной вариант — ФАЙЛ рядом с фронтендом: public/emblem.svg. Официальное
// изображение лучше положить как есть, чем перерисовывать: в государственном
// символе неточность заметнее, чем в любой другой картинке. Файл нужен с
// прозрачным фоном — на белом квадрате герб будет висеть заплаткой на тёплой
// поверхности панели. Растровый годится тоже: поправьте имя в EMBLEM_FILE, а
// размеры проставляются атрибутами, так что 1024 px ужмётся аккуратно.
//
// Пока файла нет, рисуется запасной герб ниже — упрощённый, но узнаваемый:
// пустое место в шапке хуже стилизации. Щиток на груди у него сделан дыркой в
// тулове (fill-rule="evenodd"), а не светлой заплаткой поверх, — иначе
// заплатку пришлось бы перекрашивать под каждый фон.
const EMBLEM_FILE = "emblem.svg";
const EMBLEM_BODY = "M24 18.9c2.6 0 4.5 1.5 4.5 4.1v6.6c0 3-1.7 5.4-4.5 6.9-2.8-1.5-4.5-3.9-4.5-6.9v-6.6c0-2.6 1.9-4.1 4.5-4.1z";
const EMBLEM_SHIELD_OUTER = "M24 21c1.7 0 3 .5 3.8 1v4.6c0 2.4-1.5 4.2-3.8 5.2-2.3-1-3.8-2.8-3.8-5.2v-4.6c.8-.5 2.1-1 3.8-1z";

function emblem(size) {
  size = size || 28;
  // onerror срабатывает, когда файла нет (сервер отвечает 404) — тогда на его
  // место встаёт нарисованный. Обработчик глобальный, потому что выполняется в
  // области видимости страницы, а не этой функции.
  return `<img class="brand-emblem" src="${EMBLEM_FILE}" width="${size}" height="${size}" alt=""
    onerror="this.outerHTML = emblemFallback(${size})">`;
}

function emblemFallback(size) {
  return `<svg class="brand-emblem" width="${size}" height="${size}" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
    <path d="M19.6 20.8c-4.4-1.4-9.2-1.2-13.9 1.6 3.1-.5 5.6.1 7.6 1.2-3.6.2-6.6 1.8-8.9 4.7 2.9-1.4 5.5-1.8 7.9-1.2-3.3 1-5.8 3-7.4 6.1 2.9-2 5.7-2.8 8.4-2.4 2 .3 4-.5 5.9-2.2z"/>
    <path d="M28.4 20.8c4.4-1.4 9.2-1.2 13.9 1.6-3.1-.5-5.6.1-7.6 1.2 3.6.2 6.6 1.8 8.9 4.7-2.9-1.4-5.5-1.8-7.9-1.2 3.3 1 5.8 3 7.4 6.1-2.9-2-5.7-2.8-8.4-2.4-2 .3-4-.5-5.9-2.2z"/>
    <path d="M15.6 12.4c2.5 0 4.4 1.9 4.4 4.4 0 1.2-.5 2.3-1.2 3.1l1.6 1.9-3.2.5-1.6-1.1c-2.4-.2-4.2-2.1-4.2-4.4 0-2.5 1.7-4.4 4.2-4.4z"/>
    <path d="M11.5 15.9l-3.8.5 3.5 1.6z"/>
    <path d="M32.4 12.4c-2.5 0-4.4 1.9-4.4 4.4 0 1.2.5 2.3 1.2 3.1l-1.6 1.9 3.2.5 1.6-1.1c2.4-.2 4.2-2.1 4.2-4.4 0-2.5-1.7-4.4-4.2-4.4z"/>
    <path d="M36.5 15.9l3.8.5-3.5 1.6z"/>
    <path d="M20.2 9.4h7.6l-.6-3.8-2.1 1.6L24 4.4l-1.1 2.8-2.1-1.6z"/>
    <path d="M23.5 1.2h1v1.2h1.2v1h-1.2v1.3h-1V3.4h-1.2v-1h1.2z"/>
    <path d="M12.4 11.6h6.4l-.5-3.2-1.8 1.3-.9-2.4-.9 2.4-1.8-1.3z"/>
    <path d="M29.2 11.6h6.4l-.5-3.2-1.8 1.3-.9-2.4-.9 2.4-1.8-1.3z"/>
    <path d="M19.9 10.5c-.2 1.2-.7 2.1-1.6 2.8l-.9-1.1c.7-.5 1.1-1.2 1.3-2.1zM28.1 10.5c.2 1.2.7 2.1 1.6 2.8l.9-1.1c-.7-.5-1.1-1.2-1.3-2.1z"/>
    <path fill-rule="evenodd" d="${EMBLEM_BODY} ${EMBLEM_SHIELD_OUTER}"/>
    <path d="M18.1 30.9l-4 1.9.7 1.4 3.9-1.9zM29.9 30.9l4 1.9-.7 1.4-3.9-1.9z"/>
    <path d="M24 35.8c2.1 1.5 3.5 3.9 4 6.8-1.3-.9-2.6-1.3-4-1.3s-2.7.4-4 1.3c.5-2.9 1.9-5.3 4-6.8z"/>
    <path d="M24 22.1c1.3 0 2.3.4 2.9.8v3.7c0 1.9-1.2 3.3-2.9 4.1-1.7-.8-2.9-2.2-2.9-4.1v-3.7c.6-.4 1.6-.8 2.9-.8z"/>
  </svg>`;
}

// ====== Выпадающий список ======
//
// Системный <select> оформить нельзя: стрелку рисует браузер, она прижата к
// краю, а раскрытый перечень берёт вид от системы и в палитру не попадает.
// Поэтому настоящий select остаётся в разметке (скрытый), и весь код, который
// читает и пишет .value, продолжает работать как раньше, — а видимую часть
// рисуем сами и держим в согласии с ним в обе стороны.
//
// Навешивается автоматически на каждый появившийся select (см. observeSelects
// в boot), чтобы про это не нужно было помнить в каждом экране.
function enhanceSelect(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = "1";

  const wrap = document.createElement("div");
  wrap.className = "select-wrap";
  // Поле в форме и фильтр выглядят по-разному: у фильтра «таблетка» под стать
  // переключателю рядом, у поля — прямоугольник под стать соседним полям.
  if (sel.closest(".card") || sel.classList.contains("field-select")) wrap.classList.add("select-field");
  if (sel.style.width) wrap.style.width = sel.style.width;
  else if (sel.classList.contains("select-field")) wrap.style.width = "100%";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "select-btn";
  btn.innerHTML = `<span class="select-value"></span><span class="select-chevron">${icon("chevron", 15)}</span>`;
  wrap.appendChild(btn);

  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.hidden = true;
  wrap.appendChild(menu);

  const label = btn.querySelector(".select-value");
  const syncLabel = () => {
    const opt = sel.options[sel.selectedIndex];
    label.textContent = opt ? opt.textContent : "";
  };
  const close = () => { wrap.classList.remove("open"); menu.hidden = true; };
  const open = () => {
    // Перечень строим при открытии: у списка исполнителей варианты
    // подгружаются позже, и построенный заранее оказался бы пустым.
    menu.innerHTML = "";
    [...sel.options].forEach((opt, i) => {
      const row = document.createElement("div");
      row.className = "select-option" + (i === sel.selectedIndex ? " selected" : "");
      row.textContent = opt.textContent;
      row.onclick = () => {
        sel.selectedIndex = i;
        syncLabel();
        close();
        // Событие обязательно: обработчики висят на самом select (onchange).
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      };
      menu.appendChild(row);
    });
    wrap.classList.add("open");
    menu.hidden = false;
    const sel_ = menu.querySelector(".selected");
    if (sel_) sel_.scrollIntoView({ block: "nearest" });
  };

  btn.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close(); };
  btn.onkeydown = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" && menu.hidden) { e.preventDefault(); open(); }
  };
  // Значение могли поменять из кода (например, сбросом фильтров) — подпись
  // должна следовать за ним, иначе покажет уже не то, что выбрано.
  sel.addEventListener("change", syncLabel);
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });
  syncLabel();
}

function enhanceSelects(root) {
  (root || document).querySelectorAll("select:not([data-enhanced])").forEach(enhanceSelect);
}

// Экраны перерисовываются целиком, и вызывать enhanceSelects из каждого
// значило бы однажды забыть. Наблюдатель делает это сам.
function observeSelects() {
  enhanceSelects(document);
  new MutationObserver(() => enhanceSelects(document))
    .observe(document.body, { childList: true, subtree: true });
}

// ====== Константы ======
// Подпись системы. Здесь же, чтобы поменять её в одном месте, а не искать по
// разметке; заголовок вкладки задан отдельно в index.html. «Служба заявок» уже
// не описывала целое: заявки — только один из разделов, рядом Сертвивер, журнал
// звонков и «Искра». Письма о заявках подписаны по-прежнему службой заявок —
// они и правда про заявки, а не про платформу (см. services/notifications.js).
const APP_NAME = "ИТ-сервисы";
// Ведомство — второй строкой под подписью. На экране входа оно уже стоит в
// строке «Липецкстат · внутренняя система», поэтому там не дублируется.
const APP_ORG = "Липецкстат";
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
  observeSelects();
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
        <div class="login-logo">${emblem(44)}<div class="login-title">${APP_NAME}</div></div>
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

const MODULE_VIEW_ICONS = { log: "inbox", stats: "chart", directory: "folder", certs: "seal", mchd: "doc", root: "box" };
// Иконка пункта меню по идентификатору модуля из config/modules.js. Ключ — тот
// же id, что и на сервере; для незнакомого модуля остаётся общий «ящик», так
// что подключение нового ничего здесь не ломает.
const MODULE_ICONS = { certs: "seal", smdr: "phone", messenger: "spark" };
const moduleIcon = (id) => MODULE_ICONS[id] || "box";

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
    // Раздел оповещений — только у ИТ. Исполнителям ХОЗ и ЕГРПО он не нужен:
    // им хватает «Входящих заявок» с бейджем, который работает как работал.
    navHtml += navGroupHtml("notif", "Оповещения", "bell", 0, [
      { id: "notif:feed", label: "Лента", icon: "bell" },
      { id: "notif:templates", label: "Шаблоны", icon: "pen" },
      { id: "notif:smtp", label: "Отправка", icon: "mail" },
    ]);
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
        const it = { id: `module:${m.id}:${views[0].id}`, label: m.label, icon: moduleIcon(m.id) };
        return navBtnHtml(it, state.view === it.id, false);
      }
      const items = views.map(v => ({ id: `module:${m.id}:${v.id}`, label: v.label, icon: MODULE_VIEW_ICONS[v.id] }));
      return navGroupHtml(`mod-${m.id}`, m.label, moduleIcon(m.id), 0, items);
    }).join("");
  }

  root.innerHTML = `
    <div class="app-shell">
      <div class="sidebar">
        <div class="sidebar-head">${emblem(32)}
          <div class="brand-text">
            <div class="brand-name">${APP_NAME}</div>
            <div class="brand-org">${APP_ORG}</div>
          </div>
          ${isIT ? `<button class="head-action${state.view === "certs" ? " active" : ""}" id="certsBtn"
            title="Сертификаты">${icon("shield", 18)}</button>` : ""}
        </div>
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

  const certsBtn = document.getElementById("certsBtn");
  if (certsBtn) certsBtn.onclick = () => setView("certs");

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
  else if (state.view === "certs") renderCertificates(main);
  else if (state.view.startsWith("notif:")) renderNotifications(main, state.view.slice(6));
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
  // Последней колонки со стрелкой больше нет: строка и так кликается целиком,
  // а стрелка только занимала место и намекала на несуществующее действие.
  const gridCols = isPrivileged
    ? "92px minmax(220px,1fr) 150px 80px 130px 150px 140px"
    : "92px minmax(220px,1fr) 130px 150px 140px";

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
          <div>Статус</div><div>Исполнитель</div><div>Обновлено</div>
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

// ====== Сертификаты ======
// Экран про «сертификаты» — это на самом деле про две разные вещи, которые
// постоянно путают, и разница между ними определяет всю раскладку:
//
//   • СЕРТИФИКАТ СЕРВЕРА — что мы ПРЕДЪЯВЛЯЕМ клиентам. Это вся повседневная
//     работа: продлили — загрузили. Поэтому загрузка здесь же, на видном
//     месте, а не «положите файл вот в эту папку на сервере». Файл ОДИН и
//     общий с «Искрой»: обе службы на одной машине и отвечают на одно имя.
//
//   • ДОВЕРЕННЫЕ КОРНИ — кому верим МЫ, когда сами ходим наружу (LDAPS к
//     контроллерам домена, проксирование в «Искру»). Клиентов это не касается
//     совсем: они берут корни из хранилища Windows, куда те приезжают
//     групповыми политиками. На доменной машине раздел не нужен вообще,
//     поэтому он свёрнут и лежит внизу.
async function renderCertificates(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Сертификаты</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;

  const days = (n) => {
    if (n === null || n === undefined) return "";
    if (n < 0) return `<span class="badge" style="color:var(--red);background:var(--red-soft);">истёк ${-n} дн. назад</span>`;
    if (n < 30) return `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">осталось ${n} дн.</span>`;
    return `<span class="badge" style="color:var(--green);background:var(--green-soft);">осталось ${n} дн.</span>`;
  };
  const row = (label, value) => `
    <div class="field-mini"><div class="field-mini-label">${esc(label)}</div>
    <div class="field-mini-value">${value}</div></div>`;

  try {
    const [server, trusted, mods] = await Promise.all([
      api("/certificates/server"), api("/certificates/trusted"), api("/certificates/modules"),
    ]);

    const c = server.certificate;
    const serverCard = !server.secure
      ? `<div class="warn-box">Платформа работает по HTTP — сертификат не задан. Пароли и переписка идут открытым текстом.</div>`
      : c
        ? `${row("Кому выдан", esc(c.subject || "—"))}
           ${row("Имена в сертификате (SAN)", `<span class="mono" style="font-size:12px;">${esc(c.san || "—")}</span>`)}
           ${row("Кем выдан", esc(c.issuer || "—"))}
           ${row("Действителен до", `${esc(c.validTo || "—")} ${days(c.daysLeft)}`)}
           ${row("Корень цепочки", esc(c.rootSubject || "—"))}
           ${row("Цепочка", c.chainComplete
              ? `<span class="badge" style="color:var(--green);background:var(--green-soft);">полная (${c.certificates} серт.)</span>`
              : `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">неполная — клиент может не достроить доверие</span>`)}
           ${row("Отпечаток", `<span class="mono" style="font-size:11px;word-break:break-all;">${esc(c.fingerprint || "—")}</span>`)}`
        : `<div style="font-size:12.5px;color:var(--ink-soft);">Сертификат применён, подробности ещё читаются…</div>`;

    const rootRow = (r) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line-soft);">
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;">${esc(r.subject || r.file)}</div>
          <div style="font-size:11.5px;color:var(--ink-soft);">
            <span class="mono">${esc(r.file)}</span>${r.error ? ` · <span style="color:var(--red);">${esc(r.error)}</span>` : ""}
            ${r.warning ? ` · <span style="color:var(--amber);">${esc(r.warning)}</span>` : ""}
            ${r.selfSigned === false ? " · промежуточный, не корень" : ""}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          ${r.daysLeft !== undefined && r.daysLeft !== null ? days(r.daysLeft) : ""}
          <button class="btn btn-ghost del-root" data-file="${esc(r.file)}">Удалить</button>
        </div>
      </div>`;

    const modRow = (m) => {
      let status;
      if (!m.secure) status = `<span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">без шифрования</span>`;
      else if (m.error) status = `<span class="badge" style="color:var(--red);background:var(--red-soft);">${esc(m.error)}</span>`;
      else if (!m.authorized) status = `<span class="badge" style="color:var(--red);background:var(--red-soft);">не проходит проверку: ${esc(m.authorizationError || "")}</span>`;
      else status = `<span class="badge" style="color:var(--green);background:var(--green-soft);">проверку проходит</span>`;
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line-soft);">
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:600;">${esc(m.label)}</div>
            <div class="mono" style="font-size:11.5px;color:var(--ink-soft);">${esc(m.target)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
            ${m.certificate && m.certificate.daysLeft !== null ? days(m.certificate.daysLeft) : ""}
            ${status}
          </div>
        </div>`;
    };

    main.querySelector(".page").innerHTML = `
      <div style="max-width:900px;">
        <div>
          <div class="card" style="margin-bottom:20px;">
            <div class="section-label">Сертификат сервера — что мы предъявляем</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
              Сертификат один на обе службы: платформа и «Искра» стоят на одной машине и отвечают
              на одно имя. ${server.managedBy === "store"
                ? `Файл лежит в <span class="mono">${esc(server.sharedStore)}</span>; загрузить новый можно здесь же (форма ниже) или в панели «Искры» — разницы нет, файл тот же. Обе службы перечитывают его сами, без перезапуска.`
                : `Сейчас путь задан переменными окружения: <span class="mono">${esc(server.where || "")}</span>. Тогда сертификат <b>не общий</b> с «Искрой» — она читает своё хранилище и может предъявлять другой файл, — а загрузка из панели отключена.`}
            </div>
            ${server.managedBy === "env" ? `<div class="warn-box" style="margin-bottom:14px;">
              <div>
              Чтобы вернуть общий сертификат и загрузку отсюда: уберите <span class="mono">TLS_PFX</span>
              (или <span class="mono">TLS_CERT</span>/<span class="mono">TLS_KEY</span>) из
              <span class="mono">.env</span> и укажите путь к каталогу <span class="mono">certs</span>
              работающей «Искры»: <span class="mono">SHARED_CERT_DIR=&lt;папка Искры&gt;\\certs</span>.
              Сейчас платформа ищет хранилище в <span class="mono">${esc(server.storeDir || "")}</span> —
              если «Искра» стоит не там, сертификат она не найдёт. После правки нужен перезапуск.
              </div>
            </div>` : ""}
            ${serverCard}

            ${server.managedBy === "store" ? `
            <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line-soft);">
              <div class="section-label" style="margin-bottom:8px;">Заменить сертификат</div>
              <div style="font-size:12px;color:var(--ink-soft);margin-bottom:12px;">
                PFX (.pfx или .p12) — экспортированный из удостоверяющего центра домена вместе с
                закрытым ключом и всеми сертификатами пути. Файл сначала проверяется (пароль, срок,
                цепочка) и только потом заменяет действующий: испортить работающую платформу
                загрузкой не того файла нельзя. Прежний остаётся рядом с суффиксом
                <span class="mono">.bak</span>.
              </div>
              <div class="form-row" style="margin-bottom:12px;">
                <div>
                  <div class="field-label">Файл</div>
                  <input class="field-input" id="certFile" type="file" accept=".pfx,.p12" style="margin-bottom:0;padding:10px 12px;">
                </div>
                <div>
                  <div class="field-label">Пароль к файлу</div>
                  <input class="field-input" id="certPass" type="password" placeholder="если он есть" style="margin-bottom:0;">
                </div>
              </div>
              <button class="btn btn-wire" id="certUpload">Загрузить и применить</button>
              <div id="certMsg" style="margin-top:10px;font-size:12.5px;"></div>
            </div>` : ""}
          </div>

          <div class="card">
            <div class="section-label">Модули — что предъявляют они</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px;">
              Платформа проверяет сертификат модуля по-настоящему, поэтому модуль должен быть
              адресован именем из его сертификата, а не по IP.
            </div>
            ${mods.modules.map(modRow).join("")}
          </div>
        </div>

      </div>

      <details class="card" style="margin-top:20px;">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--ink-soft);">
          Доверенные корни — кому верим мы. Обычно трогать не нужно
        </summary>
        <div style="font-size:12px;color:var(--ink-soft);margin:14px 0 12px;max-width:760px;">
          Это не про клиентов: они берут корни из хранилища Windows, куда те приезжают групповыми
          политиками, и панель на это никак не влияет. Список ниже — про исходящие соединения самой
          платформы: LDAPS к контроллерам доменов и проверка сертификата «Искры» при
          проксировании. Удостоверяющий центр у нас один, и на доменной машине здесь не нужно
          ничего: платформа запускается с <span class="mono">--use-system-ca</span> и доверяет тому
          же хранилищу Windows. Раздел пригождается в двух случаях: машина вне домена и переходный
          период при смене УЦ. Файлы лежат в <span class="mono">${esc(trusted.dir)}</span>,
          подключаются переменной <span class="mono">NODE_EXTRA_CA_CERTS</span> и начинают
          действовать только после перезапуска платформы.
        </div>
        <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:320px;">
            ${trusted.roots.length ? trusted.roots.map(rootRow).join("")
              : `<div style="font-size:12.5px;color:var(--ink-soft);">Пока пусто — и это нормальное состояние.</div>`}
          </div>
          <div style="width:380px;flex-shrink:0;">
            <div class="field-label">Добавить корень</div>
            <input class="field-input" id="rootName" placeholder="например domain-b-root.crt" style="margin-bottom:10px;">
            <textarea class="input" id="rootPem" rows="5" placeholder="-----BEGIN CERTIFICATE-----" style="width:100%;font-family:var(--mono);font-size:11px;margin-bottom:10px;"></textarea>
            <button class="btn btn-wire" id="addRoot" style="width:100%;justify-content:center;">Добавить</button>
            <div id="rootMsg" style="margin-top:8px;font-size:12px;text-align:center;"></div>
          </div>
        </div>
      </details>`;

    const uploadBtn = document.getElementById("certUpload");
    if (uploadBtn) uploadBtn.onclick = async () => {
      const msg = document.getElementById("certMsg");
      const input = document.getElementById("certFile");
      const file = input.files && input.files[0];
      if (!file) { msg.style.color = "var(--red)"; msg.textContent = "Выберите файл"; return; }
      msg.style.color = "var(--ink-soft)"; msg.textContent = "Проверяю файл…";
      try {
        // Читаем в base64 на клиенте: так тело остаётся обычным JSON и не
        // требует отдельной обработки multipart ради одного файла.
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] || "");
          r.onerror = () => reject(new Error("Файл не читается"));
          r.readAsDataURL(file);
        });
        const res = await api("/certificates/server", {
          method: "POST",
          body: { pfx: b64, password: document.getElementById("certPass").value },
        });
        renderCertificates(main);
        toast(res.restartRequired
          ? "Файл сохранён. Нужен перезапуск: включить шифрование на работающем HTTP-сервере нельзя."
          : "Сертификат применён, перезапуск не нужен. «Искра» подхватит его сама.");
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };

    document.getElementById("addRoot").onclick = async () => {
      const msg = document.getElementById("rootMsg");
      msg.style.color = "var(--ink-soft)"; msg.textContent = "Проверяю…";
      try {
        await api("/certificates/trusted", {
          method: "POST",
          body: {
            name: document.getElementById("rootName").value.trim(),
            pem: document.getElementById("rootPem").value,
          },
        });
        renderCertificates(main);
        toast("Корень добавлен. Перезапустите платформу, чтобы он начал действовать.");
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };

    main.querySelectorAll(".del-root").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`Удалить ${btn.dataset.file} из доверенных?`)) return;
        try {
          await api(`/certificates/trusted/${encodeURIComponent(btn.dataset.file)}`, { method: "DELETE" });
          renderCertificates(main);
        } catch (e) { toast(e.message, true); }
      };
    });
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}

// ====== Оповещения ======
//
// Три вкладки одного раздела, и все три — только для ИТ. Данные для «Шаблонов»
// и «Отправки» приходят одним запросом /notifications/kinds: справочник
// категорий живёт на сервере (config/notifications.js), поэтому добавленный
// отдел появляется здесь сам, без правок фронтенда.

const NOTIF_TABS = { feed: "Лента", templates: "Шаблоны", smtp: "Отправка" };
const SEVERITY_BADGE = {
  info: ["var(--ink-soft)", "var(--line-soft)"],
  warn: ["var(--amber)", "var(--amber-soft)"],
  crit: ["var(--red)", "var(--red-soft)"],
};

// Состояние доставки одной строкой. Три исхода намеренно выглядят по-разному:
// «в очереди» — не то же самое, что «не ушло», и путать их нельзя.
function deliveryBadge(e) {
  if (!e.mails) return `<span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">без писем</span>`;
  if (e.failed) return `<span class="badge" style="color:var(--red);background:var(--red-soft);">не ушло: ${e.failed} из ${e.mails}</span>`;
  if (e.pending) return `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">в очереди: ${e.pending}</span>`;
  return `<span class="badge" style="color:var(--green);background:var(--green-soft);">отправлено: ${e.sent}</span>`;
}

async function renderNotifications(main, tab) {
  clearViewPoll();
  if (!NOTIF_TABS[tab]) tab = "feed";
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Оповещения — ${esc(NOTIF_TABS[tab])}</div></div>
    <div class="page"><div class="spinner">Загрузка…</div></div>`;
  const page = main.querySelector(".page");

  try {
    if (tab === "feed") await renderNotifFeed(page);
    else {
      const { kinds } = await api("/notifications/kinds");
      if (tab === "templates") renderNotifTemplates(page, kinds);
      else await renderNotifSmtp(page, kinds);
    }
  } catch (e) {
    page.innerHTML = `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}

// ---- Вкладка «Лента» -------------------------------------------------------
//
// Это журнал, а не входящие: отметок «прочитано» здесь нет. Зато у каждого
// события видно, куда оно уехало и чем закончилось, — раньше узнать это было
// нельзя вообще никак.

async function renderNotifFeed(page, filters = {}) {
  const qs = new URLSearchParams();
  if (filters.kind) qs.set("kind", filters.kind);
  if (filters.severity) qs.set("severity", filters.severity);
  if (filters.q) qs.set("q", filters.q);

  const [{ events }, { kinds }] = await Promise.all([
    api("/notifications/feed?" + qs.toString()),
    api("/notifications/kinds"),
  ]);

  page.innerHTML = `
    <div style="max-width:1000px;">
      <div class="card" style="margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:200px;">
          <div class="field-label">Поиск по теме</div>
          <input class="input" id="nfQ" placeholder="номер заявки, ФИО…" value="${esc(filters.q || "")}" />
        </div>
        <div style="min-width:200px;">
          <div class="field-label">Категория</div>
          <select class="input field-select" id="nfKind">
            <option value="">все категории</option>
            ${kinds.map(k => `<option value="${esc(k.kind)}" ${filters.kind === k.kind ? "selected" : ""}>${esc(k.label)}</option>`).join("")}
          </select>
        </div>
        <div style="min-width:160px;">
          <div class="field-label">Важность</div>
          <select class="input field-select" id="nfSev">
            <option value="">любая</option>
            <option value="info" ${filters.severity === "info" ? "selected" : ""}>обычная</option>
            <option value="warn" ${filters.severity === "warn" ? "selected" : ""}>предупреждение</option>
            <option value="crit" ${filters.severity === "crit" ? "selected" : ""}>критическая</option>
          </select>
        </div>
      </div>

      <div class="card">
        <div class="section-label">Последние события${events.length ? ` — ${events.length}` : ""}</div>
        ${events.length ? events.map(notifRowHtml).join("") : `<div class="empty-state">Пока ничего не происходило.</div>`}
      </div>
    </div>`;

  enhanceSelects(page);

  const reload = () => renderNotifFeed(page, {
    q: page.querySelector("#nfQ").value.trim(),
    kind: page.querySelector("#nfKind").value,
    severity: page.querySelector("#nfSev").value,
  });
  let timer;
  page.querySelector("#nfQ").oninput = () => { clearTimeout(timer); timer = setTimeout(reload, 300); };
  page.querySelector("#nfKind").onchange = reload;
  page.querySelector("#nfSev").onchange = reload;

  // Раскрытие строки: куда именно уехало это событие. Ответ на вопрос
  // «а почему Иванову не пришло» должен находиться нажатием, а не рассуждением.
  page.querySelectorAll(".notif-row").forEach(row => {
    row.onclick = async () => {
      const box = row.querySelector(".notif-deliveries");
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = `<div style="font-size:12px;color:var(--ink-soft);">Загрузка…</div>`;
      try {
        const { deliveries } = await api(`/notifications/feed/${row.dataset.id}/deliveries`);
        box.innerHTML = deliveries.length ? deliveries.map(d => `
          <div style="display:flex;gap:10px;align-items:baseline;font-size:12px;padding:3px 0;">
            <span class="mono" style="color:var(--ink-soft);width:52px;flex-shrink:0;">${d.channel === "email" ? "почта" : "лента"}</span>
            <span style="flex:1;min-width:0;word-break:break-all;">${esc(d.address || d.full_name || "—")}</span>
            <span style="flex-shrink:0;">${notifStatusText(d)}</span>
          </div>
          ${d.error ? `<div style="font-size:11.5px;color:var(--red);padding:0 0 6px 62px;">${esc(d.error)}</div>` : ""}
        `).join("") : `<div style="font-size:12px;color:var(--ink-soft);">Доставок не было.</div>`;
      } catch (e) {
        box.innerHTML = `<div style="font-size:12px;color:var(--red);">${esc(e.message)}</div>`;
      }
    };
  });
}

function notifStatusText(d) {
  if (d.status === "sent") return `<span style="color:var(--green);">доставлено</span>`;
  if (d.status === "failed") return `<span style="color:var(--red);">не ушло</span>`;
  return `<span style="color:var(--amber);">в очереди</span>`;
}

function notifRowHtml(e) {
  const [sc, ss] = SEVERITY_BADGE[e.severity] || SEVERITY_BADGE.info;
  return `
    <div class="notif-row" data-id="${e.id}" style="padding:11px 0;border-top:1px solid var(--line-soft);cursor:pointer;">
      <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;">
        <span class="badge" style="color:${sc};background:${ss};flex-shrink:0;">${esc(e.label)}</span>
        <span style="flex:1;min-width:140px;font-size:13px;">${esc(e.subject || "—")}</span>
        ${deliveryBadge(e)}
        <span class="mono" style="font-size:11.5px;color:var(--ink-soft);flex-shrink:0;">${esc(e.created_at || "")}</span>
      </div>
      <div class="notif-deliveries" hidden style="margin-top:8px;padding-left:2px;"></div>
    </div>`;
}

// ---- Вкладка «Шаблоны» -----------------------------------------------------

function renderNotifTemplates(page, kinds) {
  page.innerHTML = `
    <div style="max-width:900px;">
      <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:16px;">
        Подстановки пишутся в двойных фигурных скобках. Кнопка «Предпросмотр» показывает
        письмо на выдуманном примере — править шаблон вслепую значит однажды разослать
        письмо с опечаткой в самой подстановке.
      </div>
      ${kinds.map(templateCardHtml).join("")}
    </div>`;

  page.querySelectorAll(".tpl-card").forEach(card => {
    const kind = card.dataset.kind;
    const subj = card.querySelector(".tpl-subject");
    const body = card.querySelector(".tpl-body");
    const msg = card.querySelector(".tpl-msg");

    card.querySelectorAll(".tpl-var").forEach(chip => {
      chip.onclick = () => {
        // Вставляем в то поле, где стоял курсор: чаще всего это тело письма.
        const target = card.dataset.lastField === "subject" ? subj : body;
        const pos = target.selectionStart || target.value.length;
        target.value = target.value.slice(0, pos) + chip.dataset.v + target.value.slice(target.selectionEnd || pos);
        target.focus();
        target.selectionStart = target.selectionEnd = pos + chip.dataset.v.length;
      };
    });
    subj.onfocus = () => { card.dataset.lastField = "subject"; };
    body.onfocus = () => { card.dataset.lastField = "body"; };

    card.querySelector(".tpl-preview").onclick = async () => {
      msg.style.color = "var(--ink-soft)";
      msg.textContent = "Готовлю предпросмотр…";
      try {
        const r = await api(`/notifications/kinds/${encodeURIComponent(kind)}/preview`, {
          method: "POST", body: { subjectTpl: subj.value, bodyTpl: body.value },
        });
        const box = card.querySelector(".tpl-preview-box");
        box.hidden = false;
        box.innerHTML = `<div style="font-weight:600;font-size:13px;margin-bottom:6px;">${esc(r.subject)}</div>
          <div style="font-size:12.5px;white-space:pre-wrap;">${esc(r.body)}</div>`;
        msg.textContent = "";
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };

    card.querySelector(".tpl-save").onclick = async () => {
      msg.style.color = "var(--ink-soft)";
      msg.textContent = "Сохраняю…";
      try {
        await api(`/notifications/kinds/${encodeURIComponent(kind)}`, {
          method: "PUT", body: { subjectTpl: subj.value, bodyTpl: body.value },
        });
        msg.style.color = "var(--green)";
        msg.textContent = "Сохранено";
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };
  });
}

function templateCardHtml(k) {
  return `
    <div class="card tpl-card" data-kind="${esc(k.kind)}" style="margin-bottom:16px;">
      <div class="section-label">${esc(k.label)}</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:12px;">${esc(k.hint || "")}</div>

      <div class="field-label">Тема письма</div>
      <input class="input tpl-subject" value="${esc(k.subjectTpl || "")}" style="width:100%;margin-bottom:12px;" />

      <div class="field-label">Текст письма</div>
      <textarea class="input tpl-body" rows="7" style="width:100%;font-family:var(--mono);font-size:12.5px;">${esc(k.bodyTpl || "")}</textarea>

      <div style="margin:10px 0 4px;font-size:11.5px;color:var(--ink-soft);">Доступные подстановки — нажмите, чтобы вставить:</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
        ${(k.vars || []).map(v => `<button type="button" class="badge tpl-var" data-v="{{${esc(v)}}}"
          style="color:var(--ink-soft);background:var(--line-soft);border:none;cursor:pointer;font-family:var(--mono);">{{${esc(v)}}}</button>`).join("")}
      </div>

      <div class="tpl-preview-box" hidden style="background:var(--line-soft);border-radius:8px;padding:12px 14px;margin-bottom:12px;"></div>

      <div style="display:flex;gap:10px;align-items:center;">
        <button class="btn btn-wire tpl-save">Сохранить</button>
        <button class="btn btn-ghost tpl-preview">Предпросмотр</button>
        <span class="tpl-msg" style="font-size:12px;"></span>
      </div>
    </div>`;
}

// ---- Вкладка «Отправка» ----------------------------------------------------

async function renderNotifSmtp(page, kinds) {
  const [{ smtp }, { deliveries }] = await Promise.all([
    api("/notifications/smtp"), api("/notifications/deliveries"),
  ]);

  const withList = kinds.filter(k => k.recipients === "list");
  const derived = kinds.filter(k => k.recipients !== "list");

  page.innerHTML = `
    <div style="max-width:900px;">
      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Почтовый сервер</div>
        ${!smtp.configured ? `<div class="warn-box" style="margin-bottom:14px;"><div>
          Адрес сервера не задан — письма не отправляются вовсе. В интерфейсе оповещения при этом
          появляются, а письма копятся в очереди и уйдут, как только сервер укажут.
        </div></div>` : `<div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
          Настройки взяты ${smtp.source === "панель" ? "отсюда, из панели" : `из файла <span class="mono">.env</span> на сервере`}.
          Сохранение здесь перекрывает файл.
        </div>`}

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
          <div><div class="field-label">Адрес сервера</div>
            <input class="input" id="smHost" value="${esc(smtp.host || "")}" placeholder="smtp.example.ru" style="width:100%;" /></div>
          <div><div class="field-label">Порт</div>
            <input class="input" id="smPort" type="number" value="${esc(String(smtp.port || 465))}" style="width:100%;" /></div>
          <div><div class="field-label">Учётная запись</div>
            <input class="input" id="smUser" value="${esc(smtp.user || "")}" placeholder="можно оставить пустым" style="width:100%;" /></div>
          <div><div class="field-label">Пароль</div>
            <input class="input" id="smPass" type="password" placeholder="${smtp.hasPassword ? "задан — оставьте пустым, чтобы не менять" : "не задан"}" style="width:100%;" /></div>
          <div style="grid-column:1/-1;"><div class="field-label">Адрес отправителя</div>
            <input class="input" id="smFrom" value="${esc(smtp.from || "")}" placeholder="ИТ-сервисы &lt;it@lipetskstat.ru&gt;" style="width:100%;" /></div>
        </div>

        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="smSecure" ${smtp.secure ? "checked" : ""} />
          Шифрование с самого начала соединения (обычно порт 465; для 587 — снять)
        </label>

        <div style="display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap;">
          <button class="btn btn-wire" id="smSave">Сохранить</button>
          <button class="btn btn-ghost" id="smTest">Проверить и отправить себе</button>
          <span id="smMsg" style="font-size:12px;"></span>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Кому уходят письма</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px;">
          Адреса — по одному на строку. Проверяются при сохранении: опечатка иначе будет молчать
          ровно так же, как молчал ненастроенный сервер.
        </div>
        ${withList.map(recipientCardHtml).join("")}
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Адресат определяется сам</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px;">
          У этих категорий своего списка нет — заполнять нечего.
        </div>
        ${derived.map(derivedRowHtml).join("")}
      </div>

      <div class="card">
        <div class="section-label">Последние отправки</div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px;">
          <button class="btn btn-ghost" id="smRetry">Повторить неотправленные</button>
          <span id="smRetryMsg" style="font-size:12px;"></span>
        </div>
        ${deliveries.length ? deliveries.map(d => `
          <div style="padding:9px 0;border-top:1px solid var(--line-soft);font-size:12.5px;">
            <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">
              <span style="flex-shrink:0;">${notifStatusText(d)}</span>
              <span style="flex:1;min-width:140px;word-break:break-all;">${esc(d.address)}</span>
              <span style="color:var(--ink-soft);flex-shrink:0;">${esc(d.label)}</span>
              <span class="mono" style="font-size:11.5px;color:var(--ink-soft);flex-shrink:0;">${esc(d.sent_at || d.created_at || "")}</span>
            </div>
            ${d.error ? `<div style="color:var(--red);font-size:11.5px;margin-top:3px;">${esc(d.error)}</div>` : ""}
          </div>`).join("") : `<div class="empty-state">Писем ещё не отправляли.</div>`}
      </div>
    </div>`;

  const msg = page.querySelector("#smMsg");
  const val = (id) => page.querySelector(id).value.trim();

  page.querySelector("#smSave").onclick = async () => {
    msg.style.color = "var(--ink-soft)"; msg.textContent = "Сохраняю…";
    try {
      await api("/notifications/smtp", { method: "PUT", body: {
        host: val("#smHost"), port: Number(val("#smPort")) || 465,
        secure: page.querySelector("#smSecure").checked,
        user: val("#smUser"), from: val("#smFrom"),
        // Пустое поле пароля значит «не менять»: иначе правка порта каждый раз
        // молча стирала бы пароль.
        password: val("#smPass") || undefined,
      }});
      msg.style.color = "var(--green)"; msg.textContent = "Сохранено";
    } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
  };

  page.querySelector("#smTest").onclick = async () => {
    msg.style.color = "var(--ink-soft)"; msg.textContent = "Проверяю соединение…";
    try {
      const r = await api("/notifications/smtp/test", { method: "POST", body: {} });
      if (r.ok) {
        msg.style.color = r.warning ? "var(--amber)" : "var(--green)";
        msg.textContent = r.warning || r.detail || "Связь есть";
      } else {
        msg.style.color = "var(--red)"; msg.textContent = r.error;
      }
    } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
  };

  const retryMsg = page.querySelector("#smRetryMsg");
  page.querySelector("#smRetry").onclick = async () => {
    retryMsg.style.color = "var(--ink-soft)"; retryMsg.textContent = "Отправляю…";
    try {
      const r = await api("/notifications/deliveries/retry", { method: "POST", body: {} });
      retryMsg.textContent = r.retried ? `Повторено: ${r.retried}` : "Нечего повторять";
      if (r.retried) setTimeout(() => renderNotifications(page.closest("main") || page.parentElement, "smtp"), 900);
    } catch (e) { retryMsg.style.color = "var(--red)"; retryMsg.textContent = e.message; }
  };

  page.querySelectorAll(".rcp-card").forEach(card => {
    const kind = card.dataset.kind;
    const field = card.querySelector(".rcp-emails");
    const note = card.querySelector(".rcp-msg");
    const count = card.querySelector(".rcp-count");
    const recount = () => {
      const n = field.value.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean).length;
      // Счётчик рядом с полем: случайно стёртая строка иначе незаметна.
      count.textContent = n ? `получателей: ${n}` : "получателей нет — письма по этой категории никуда не уйдут";
      count.style.color = n ? "var(--ink-soft)" : "var(--amber)";
    };
    field.oninput = recount;
    recount();

    card.querySelector(".rcp-save").onclick = async () => {
      note.style.color = "var(--ink-soft)"; note.textContent = "Сохраняю…";
      try {
        const r = await api(`/notifications/kinds/${encodeURIComponent(kind)}`, {
          method: "PUT", body: { emails: field.value, enabled: card.querySelector(".rcp-on").checked },
        });
        field.value = r.settings.emails || "";
        recount();
        note.style.color = "var(--green)"; note.textContent = "Сохранено";
      } catch (e) { note.style.color = "var(--red)"; note.textContent = e.message; }
    };
  });
}

function recipientCardHtml(k) {
  return `
    <div class="rcp-card" data-kind="${esc(k.kind)}" style="padding:14px 0;border-top:1px solid var(--line-soft);">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px;">
        <span style="font-size:13.5px;font-weight:600;">${esc(k.label)}</span>
        ${k.scheduled ? `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">рассылка появится с планировщиком</span>` : ""}
        <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;">
          <input type="checkbox" class="rcp-on" ${k.enabled ? "checked" : ""} /> включено
        </label>
      </div>
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">${esc(k.hint || "")}</div>
      <textarea class="input rcp-emails" rows="3" placeholder="ivanov@lipetskstat.ru"
        style="width:100%;font-family:var(--mono);font-size:12.5px;">${esc(k.emails || "")}</textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <button class="btn btn-ghost rcp-save">Сохранить</button>
        <span class="rcp-count" style="font-size:11.5px;"></span>
        <span class="rcp-msg" style="font-size:12px;"></span>
      </div>
    </div>`;
}

function derivedRowHtml(k) {
  const where = k.recipients === "author"
    ? "автору заявки — адрес берётся из домена при его входе"
    : `тем же, кто в списке «${esc(k.borrowedFrom || "")}»`;
  return `
    <div style="padding:11px 0;border-top:1px solid var(--line-soft);display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;">
      <span style="font-size:13px;font-weight:600;min-width:180px;">${esc(k.label)}</span>
      <span style="font-size:12px;color:var(--ink-soft);flex:1;min-width:200px;">${where}</span>
      ${k.scheduled ? `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">ждёт планировщика</span>` : ""}
    </div>`;
}

boot();
