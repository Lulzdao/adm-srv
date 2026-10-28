// ====== Настройки ======
//
// Всё, что на платформе настраивают, — одним разделом, как настройки телефона: слева
// категории с цветными значками, справа открытая категория. Вход — шестерёнка в шапке
// меню, у всех; сотруднику в ней только личное (оформление, боковое меню),
// администратору — всё остальное.
// Наверху списка — кто вошёл, внизу — «Выйти» (раньше кнопка была под меню).
// Раньше это было разбросано: щит «Сертификаты» в шапке, «Администрирование» в заявках,
// группа «Оповещения» внизу меню, «Настройки» в Ассистенте, «Шаблоны» в Бюллетенях,
// «Оформление» под меню.
//
// Адрес: #settings — список (на широком экране сразу с первой категорией),
// #settings:<категория>[:<вкладка>]. Старые адреса переводятся (SETTINGS_MOVED).
// Сами экраны категорий живут рядом со своими разделами (app-admin.js,
// app-notifications.js, app-assistant.js, app-bulletins.js) и рисуются в контейнер.

const SETTINGS_CATS = [
  { id: "look", group: "Личное", label: "Оформление", icon: "palette", tone: "accent", all: true,
    sub: "Тема и цвет — только для вас, в этом браузере", keys: "тема цвет акцент тёмная светлая цветная",
    render: (box) => renderLookSettings(box) },
  { id: "nav", group: "Личное", label: "Боковое меню", icon: "sidebar", tone: "accent", all: true,
    sub: "Порядок разделов и как они раскрываются — только для вас, в этом браузере", keys: "меню сайдбар порядок разделы раскрытие",
    render: (box) => renderNavSettings(box) },

  { id: "health", group: "Платформа", label: "Состояние", icon: "pulse", tone: "teal",
    sub: "Службы, модули, почтовая очередь и место на диске", keys: "службы модули диск очередь мониторинг",
    render: (box) => renderHealth(box) },
  { id: "people", group: "Платформа", label: "Люди и группы", icon: "users", tone: "blue",
    sub: "Администраторы, исполнители по отделам, группы исполнителей", keys: "администраторы исполнители логины домен отделы",
    tabs: [
      { id: "people", label: "Администраторы и исполнители", render: (box) => renderPeopleSettings(box) },
      { id: "groups", label: "Группы исполнителей", render: (box) => renderGroupsSettings(box) },
    ] },
  { id: "access", group: "Платформа", label: "Заявка на доступ", icon: "key", tone: "violet",
    sub: "Кому записка, очередь заявок, отделы, программы и должности", keys: "программы должности анкета служебная записка отделы начальники",
    render: (box) => { box.innerHTML = `<div class="card"></div>`; renderAccessAdmin(box.firstElementChild); } },
  { id: "notif", group: "Платформа", label: "Оповещения", icon: "bell", tone: "orange",
    sub: "Лента событий, шаблоны писем, почтовый сервер и расписание", keys: "лента письма почта почтовый сервер smtp расписание сроки мчд доставка",
    tabs: [
      { id: "feed", label: "Лента", render: (box) => renderNotifications(box, "feed") },
      { id: "templates", label: "Шаблоны", render: (box) => renderNotifications(box, "templates") },
      { id: "smtp", label: "Отправка", render: (box) => renderNotifications(box, "smtp") },
    ] },

  { id: "certs", group: "Безопасность", label: "Сертификаты", icon: "shield", tone: "garnet",
    sub: "Сертификат сервера, доверенные корни, что предъявляют модули", keys: "сертификат pfx https tls корневые доверенные",
    render: (box) => renderCertificates(box) },
  { id: "backup", group: "Безопасность", label: "Резервные копии", icon: "database", tone: "slate",
    sub: "Куда и когда копируются базы", keys: "копии бэкап папка базы",
    render: (box) => renderBackupSettings(box) },
  { id: "audit", group: "Безопасность", label: "Журнал действий", icon: "list", tone: "slate",
    sub: "Кто и когда менял настройки. Только чтение", keys: "журнал история изменения",
    render: (box) => renderAudit(box) },

  { id: "acts", group: "Ассистент", label: "Акты", icon: "receipt", tone: "jade",
    sub: "Организация и нумерация, подписанты, неисправности, шаблоны документов", keys: "подписанты неисправности причины списания бланки организация нумерация",
    tabs: [["general", "Общие"], ["people", "Подписанты"], ["rules", "Неисправности"], ["templates", "Шаблоны документов"]]
      .map(([id, label]) => ({ id, label, render: (box) => renderAsstSettings(box, id) })) },
  { id: "mailings", group: "Ассистент", label: "Рассылки", icon: "mail", tone: "blue",
    sub: "Почтовый сервер рассылок, общие ящики отделов, пауза и подпись", keys: "почта ящики подпись пауза",
    render: (box) => renderAsstSettings(box, "mail") },
  { id: "bulletins", group: "Ассистент", label: "Бюллетени", icon: "doc", tone: "gold",
    sub: "Кто собирает бюллетени и по каким шаблонам", keys: "группы шаблоны формы word разбор таблицы цсод",
    tabs: [
      { id: "groups", label: "Группы", render: (box) => renderBulletinGroupsAdmin(box) },
      { id: "forms", label: "Шаблоны", render: (box) => renderBulletinForms(box) },
    ] },
];

// Прежние адреса — из закладок, писем и старых ссылок.
const SETTINGS_MOVED = {
  admin: "settings:health", certs: "settings:certs",
  "notif:feed": "settings:notif:feed", "notif:templates": "settings:notif:templates", "notif:smtp": "settings:notif:smtp",
  "asst:settings": "settings:acts", "bull:forms": "settings:bulletins:forms",
  // Одной категорией «Ассистент» настройки были недолго — до деления на акты и рассылки.
  "settings:assistant": "settings:acts", "settings:assistant:mail": "settings:mailings",
  ...Object.fromEntries(["general", "people", "rules", "templates"].map((t) => [`settings:assistant:${t}`, `settings:acts:${t}`])),
};

let settingsQuery = ""; // поиск переживает переход между категориями

function settingsCats() {
  const admin = Boolean(state.user && state.user.is_admin);
  return SETTINGS_CATS.filter((c) => c.all || admin);
}

/** «look» / «notif:smtp» → категория и вкладка (если они есть у этого человека). */
function settingsTarget(rest) {
  const [catId, tabId] = String(rest || "").split(":");
  const cat = settingsCats().find((c) => c.id === catId) || null;
  const tab = cat && cat.tabs && tabId !== undefined ? cat.tabs.find((t) => t.id === tabId) || null : null;
  return { cat, tab, catId, tabId };
}

function settingsViewExists(view) {
  const rest = view === "settings" ? "" : view.slice("settings:".length);
  if (!rest) return true;
  const { cat, tab, tabId } = settingsTarget(rest);
  return Boolean(cat) && (tabId === undefined || Boolean(tab));
}

// Подпись под «Оформлением» — что выбрано сейчас, как значение справа в настройках телефона.
function settingsHint(c) {
  if (c.id !== "look") return c.sub;
  const now = CenterTheme.get();
  const mode = CenterTheme.modes.find((m) => m.id === now.mode);
  const accent = CenterTheme.accents.find((a) => a.id === now.accent);
  return [mode && mode.name, accent && accent.name].filter(Boolean).join(" · ");
}

/** Кто вошёл — карточкой наверху списка, как учётная запись в настройках телефона. */
function settingsMeHtml() {
  const u = state.user;
  const initials = String(u.full_name || u.ad_login || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `
    <div class="st-card st-me">
      <span class="st-avatar" aria-hidden="true">${esc(initials)}</span>
      <span class="st-item-text">
        <span class="st-item-label">${esc(u.full_name)}</span>
        <span class="st-item-hint">${esc([u.department, u.ad_login].filter(Boolean).join(" · "))}</span>
        <span class="st-item-hint">${esc(userRoleLabel(u))}</span>
      </span>
    </div>`;
}

function settingsItemHtml(c) {
  const keys = [c.label, c.sub, c.keys, ...(c.tabs || []).map((t) => t.label)].join(" ").toLowerCase();
  return `
    <button type="button" class="st-item" data-cat="${c.id}" data-keys="${esc(keys)}" data-tabs="${esc((c.tabs || []).map((t) => t.label).join("|"))}">
      <span class="st-tile tone-${c.tone}">${icon(c.icon, 17)}</span>
      <span class="st-item-text">
        <span class="st-item-label">${esc(c.label)}</span>
        <span class="st-item-hint" data-hint="${esc(settingsHint(c))}">${esc(settingsHint(c))}</span>
      </span>
      ${c.id === "certs" ? `<span class="st-badge" hidden></span>` : ""}
      <span class="st-chevron">${icon("chevron", 14)}</span>
    </button>`;
}

function renderSettings(main, rest) {
  clearViewPoll();
  const cats = settingsCats();
  const { cat, tabId } = settingsTarget(rest);
  const groups = [...new Set(cats.map((c) => c.group))];
  main.innerHTML = `
    <div class="topbar">
      <div class="topbar-title">Настройки</div>
      <label class="st-search">${icon("search", 15)}
        <input type="search" id="stSearch" placeholder="Найти настройку" aria-label="Найти настройку" autocomplete="off" value="${esc(settingsQuery)}">
      </label>
    </div>
    <div class="page st-page${cat ? " st-open" : ""}">
      <nav class="st-list" aria-label="Разделы настроек">
        ${settingsMeHtml()}
        ${groups.map((g) => `
          <div class="st-group">
            <div class="st-group-label">${esc(g)}</div>
            <div class="st-card">${cats.filter((c) => c.group === g).map(settingsItemHtml).join("")}</div>
          </div>`).join("")}
        <div class="st-none" hidden>Ничего не нашлось. Попробуйте другое слово: «сертификат», «шаблон», «почта».</div>
        <div class="st-card st-exit">
          <button type="button" class="st-row st-logout" id="stLogout">
            <span class="st-row-text">
              <span class="st-row-label">${icon("logout", 16)} Выйти</span>
              <span class="st-row-hint">Из «Центра» и из панели «Искры» в этом браузере</span>
            </span>
          </button>
        </div>
      </nav>
      <section class="st-pane" id="stPane"></section>
    </div>`;

  const page = main.querySelector(".st-page");
  const search = main.querySelector("#stSearch");
  main.querySelector("#stLogout").onclick = () => logout();
  main.querySelectorAll(".st-item").forEach((b) => {
    b.onclick = () => openSettingsCat(main, cats.find((c) => c.id === b.dataset.cat));
  });
  search.oninput = () => { settingsQuery = search.value; filterSettings(main); };
  // Enter — открыть первое найденное.
  search.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const first = [...main.querySelectorAll(".st-item")].find((b) => !b.hidden);
    if (first) first.click();
  };
  filterSettings(main);
  paintSettingsCertBadge();
  showSettingsCat(main, cat || cats[0], tabId);
  if (!cat) page.classList.remove("st-open");
}

/** Переход к категории без перерисовки всего экрана: список и поиск остаются как были. */
function openSettingsCat(main, cat, tabId) {
  state.view = tabId ? `settings:${cat.id}:${tabId}` : `settings:${cat.id}`;
  writeHash(false);
  showSettingsCat(main, cat, tabId);
}

function showSettingsCat(main, cat, tabId) {
  clearViewPoll();
  main.querySelector(".st-page").classList.add("st-open");
  main.querySelectorAll(".st-item").forEach((b) => {
    const on = b.dataset.cat === cat.id;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  const tab = cat.tabs ? cat.tabs.find((t) => t.id === tabId) || cat.tabs[0] : null;
  const pane = main.querySelector("#stPane");
  pane.scrollTop = 0; // колонка листается сама по себе — новая категория открывается с начала
  pane.innerHTML = `
    <div class="st-head">
      <button type="button" class="icon-btn st-back" aria-label="Все настройки" title="Все настройки">${icon("chevron", 18)}</button>
      <span class="st-tile st-tile-lg tone-${cat.tone}">${icon(cat.icon, 22)}</span>
      <div class="st-head-text">
        <h2 class="st-title">${esc(cat.label)}</h2>
        <div class="st-sub">${esc(cat.sub)}</div>
      </div>
    </div>
    ${tab ? `<div class="toggle-group as-tabs st-tabs">${cat.tabs.map((t) =>
      `<button class="toggle-btn${t === tab ? " active" : ""}" data-tab="${t.id}">${esc(t.label)}</button>`).join("")}</div>` : ""}
    <div class="st-body" id="stBody"></div>`;
  // Узкий экран: список и категория по очереди, как в телефоне; «назад» — к списку.
  pane.querySelector(".st-back").onclick = () => {
    main.querySelector(".st-page").classList.remove("st-open");
    state.view = "settings";
    writeHash(false);
  };
  pane.querySelectorAll(".st-tabs .toggle-btn").forEach((b) => {
    b.onclick = () => {
      state.view = `settings:${cat.id}:${b.dataset.tab}`;
      writeHash(true);
      showSettingsCat(main, cat, b.dataset.tab);
    };
  });
  (tab ? tab.render : cat.render)(pane.querySelector("#stBody"));
}

/** Поиск: по названию, подписи, вкладкам и ключевым словам категории. */
function filterSettings(main) {
  const q = settingsQuery.trim().toLowerCase();
  let any = false;
  main.querySelectorAll(".st-item").forEach((b) => {
    const show = !q || b.dataset.keys.includes(q);
    b.hidden = !show;
    any = any || show;
    // Нашлось по вкладке — показываем, по какой: «Почта» → «Ассистент · Найдено: Почта рассылок».
    const hint = b.querySelector(".st-item-hint");
    const label = b.querySelector(".st-item-label").textContent.toLowerCase();
    const viaTab = q && !label.includes(q) ? b.dataset.tabs.split("|").find((t) => t && t.toLowerCase().includes(q)) : null;
    hint.textContent = viaTab ? `Найдено: ${viaTab}` : hint.dataset.hint;
  });
  main.querySelectorAll(".st-group").forEach((g) => { g.hidden = ![...g.querySelectorAll(".st-item")].some((b) => !b.hidden); });
  const none = main.querySelector(".st-none");
  if (none) none.hidden = any;
}

/** Значок у «Сертификатов»: сколько дней осталось сертификату сервера. */
function paintSettingsCertBadge() {
  const badge = document.querySelector('.st-item[data-cat="certs"] .st-badge');
  if (!badge) return;
  const left = certDaysLeft(certBadge.cert);
  const text = !certBadge.secure ? "http" : left === null ? "" : left < 0 ? "истёк" : `${left} дн.`;
  badge.hidden = !text;
  badge.textContent = text;
  badge.className = `st-badge ${!certBadge.secure || (left !== null && left < 0) ? "bad" : left !== null && left <= CERT_WARN_DAYS ? "warn" : "ok"}`;
  badge.title = !certBadge.secure ? "Платформа работает без сертификата" : left === null ? "" : `Сертификат сервера: ${text}`;
}

// ---- Личное → Оформление ----------------------------------------------------
// Тема × акцент (theme.js). Применяется сразу и только для этого сотрудника в этом браузере.

const LOOK_MODE_HINT = {
  color: "Боковая панель — цвета акцента",
  light: "Белая боковая панель",
  dark: "Тёмный фон — вечером и в тёмных кабинетах",
};

function renderLookSettings(box) {
  const now = CenterTheme.get();
  box.innerHTML = `
    <div class="st-section-label">Тема</div>
    <div class="st-card">${CenterTheme.modes.map((m) => `
      <button type="button" class="st-row" data-mode="${m.id}" aria-pressed="${now.mode === m.id}">
        <span class="st-row-text">
          <span class="st-row-label">${esc(m.name)}</span>
          <span class="st-row-hint">${esc(LOOK_MODE_HINT[m.id] || "")}</span>
        </span>
        <span class="st-check${now.mode === m.id ? " on" : ""}">${icon("check", 18)}</span>
      </button>`).join("")}</div>
    <div class="st-section-label">Цвет акцента</div>
    <div class="st-card st-swatches">${CenterTheme.accents.map((a) => `
      <button type="button" class="st-swatch${now.accent === a.id ? " on" : ""}" data-accent="${a.id}" aria-pressed="${now.accent === a.id}">
        <span class="st-swatch-dot" style="--c: ${a.color};"></span>${esc(a.name)}
      </button>`).join("")}</div>
    <div class="st-foot">Выбор хранится в этом браузере и действует только для вас — у коллег оформление своё.</div>`;
  box.onclick = (e) => {
    const m = e.target.closest("[data-mode]");
    const a = e.target.closest("[data-accent]");
    if (m) CenterTheme.setMode(m.dataset.mode);
    else if (a) CenterTheme.setAccent(a.dataset.accent);
    else return;
    renderLookSettings(box);
    const hint = document.querySelector('.st-item[data-cat="look"] .st-item-hint');
    if (hint) { hint.dataset.hint = settingsHint(SETTINGS_CATS[0]); hint.textContent = hint.dataset.hint; }
  };
}

// ---- Личное → Боковое меню ---------------------------------------------------
// Порядок разделов верхнего уровня (перетащить или стрелками) и «по одному разделу».
// Подпункты внутри разделов остаются в своём порядке. Хранится как тема — navPrefs()
// в app.js. Меню слева меняется сразу.

function renderNavSettings(box) {
  const prefs = navPrefs();
  const defaults = navEntries();
  const entries = orderNav(defaults, prefs.order);
  const custom = entries.some((e, i) => e !== defaults[i]);
  box.innerHTML = `
    <div class="st-section-label">Порядок разделов</div>
    <div class="st-card st-order" id="stOrder">${entries.map((e, i) => `
      <div class="st-row st-order-row" draggable="true" data-key="${esc(e.key)}">
        <span class="st-grip" aria-hidden="true">${icon("grip", 16)}</span>
        <span class="st-order-icon">${icon(e.icon, 16)}</span>
        <span class="st-row-text"><span class="st-row-label">${esc(e.label)}</span>
          ${e.items ? `<span class="st-row-hint">${esc(e.items.map((it) => it.label).join(", "))}</span>` : ""}</span>
        <button type="button" class="icon-btn st-move" data-move="-1" aria-label="Выше: ${esc(e.label)}" ${i === 0 ? "disabled" : ""}>${icon("chevron", 15)}</button>
        <button type="button" class="icon-btn st-move down" data-move="1" aria-label="Ниже: ${esc(e.label)}" ${i === entries.length - 1 ? "disabled" : ""}>${icon("chevron", 15)}</button>
      </div>`).join("")}</div>
    <div class="st-foot">Перетащите раздел за значок слева или двигайте стрелками. Подпункты внутри разделов остаются на своих местах.</div>
    ${custom ? `<button type="button" class="btn-text st-reset" id="stOrderReset">Вернуть порядок по умолчанию</button>` : ""}

    <div class="st-section-label">Раскрытие разделов</div>
    <div class="st-card">
      <button type="button" class="st-row" id="stSingle" role="switch" aria-checked="${prefs.single}">
        <span class="st-row-text">
          <span class="st-row-label">Открывать по одному разделу</span>
          <span class="st-row-hint">Раскрыли раздел — остальные сворачиваются</span>
        </span>
        <span class="st-switch${prefs.single ? " on" : ""}" aria-hidden="true"></span>
      </button>
    </div>
    <div class="st-foot">Настройки меню хранятся в этом браузере и действуют только для вас.</div>`;

  const save = (patch) => {
    saveNavPrefs({ ...navPrefs(), ...patch });
    refreshNav();
    renderNavSettings(box);
  };
  const keys = () => [...box.querySelectorAll(".st-order-row")].map((r) => r.dataset.key);

  box.querySelectorAll(".st-move").forEach((b) => {
    b.onclick = () => {
      const k = keys();
      const i = k.indexOf(b.closest(".st-order-row").dataset.key);
      const j = i + Number(b.dataset.move);
      if (j < 0 || j >= k.length) return;
      [k[i], k[j]] = [k[j], k[i]];
      save({ order: k });
      // Фокус — на ту же стрелку того же раздела: так его можно двигать дальше с клавиатуры.
      const again = box.querySelector(`.st-order-row[data-key="${CSS.escape(k[j])}"] .st-move[data-move="${b.dataset.move}"]`);
      if (again && !again.disabled) again.focus();
    };
  });

  // Перетаскивание: строка встаёт перед той, над верхней половиной которой её отпустили, или после неё.
  const list = box.querySelector("#stOrder");
  let dragged = null;
  list.addEventListener("dragstart", (e) => {
    dragged = e.target.closest(".st-order-row");
    if (!dragged) return;
    dragged.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragged.dataset.key);
  });
  list.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    const over = e.target.closest(".st-order-row");
    if (!over || over === dragged) return;
    const r = over.getBoundingClientRect();
    over.parentElement.insertBefore(dragged, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  list.addEventListener("drop", (e) => e.preventDefault());
  list.addEventListener("dragend", () => {
    if (!dragged) return;
    dragged.classList.remove("dragging");
    dragged = null;
    const k = keys();
    if (k.join() !== orderNav(navEntries(), navPrefs().order).map((e) => e.key).join()) save({ order: k });
    else renderNavSettings(box);
  });

  const reset = box.querySelector("#stOrderReset");
  if (reset) reset.onclick = () => save({ order: [] });
  box.querySelector("#stSingle").onclick = () => save({ single: !navPrefs().single });
}
