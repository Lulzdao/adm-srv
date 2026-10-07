// Фронтенд платформы: дашборд, администрирование, сертификаты.
// Обычный скрипт без сборщика — функции общие для всех файлов страницы (см. index.html: app.js
// подключается первым, запуск — в нём по DOMContentLoaded, когда загружены все).
// ====== Дашборд ======
async function renderDashboard(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Статистика</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    // Раньше здесь скачивался весь список заявок, чтобы посчитать в браузере
    // шесть чисел и гистограмму: 1,87 МБ ради полутора сотен байт полезного.
    // Теперь всё считает SQL одним проходом.
    const stats = await api("/admin/stats");
    const open = stats.open;
    const critical = stats.critical;
    const closed = stats.closedTotal;

    // Состав и порядок отделов берём из своего справочника, а не из ответа:
    // отдел, по которому заявок ещё не было, должен остаться на гистограмме.
    const byCategory = state.departments.map(d => ({ name: d.name, count: (stats.byCategory || {})[d.name] || 0 }));
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
        <div class="stat-card"><div class="stat-label">ВСЕГО ЗАЯВОК</div><div class="stat-value mono">${stats.total}</div></div>
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
// Разделы — вкладками сверху, как в настройках Ассистента: страница выросла, и
// листать её целиком ради одной настройки стало неудобно.
const ADMIN_TABS = [
  ["health", "Состояние"],
  ["people", "Администраторы и исполнители"], ["groups", "Группы исполнителей"],
  ["access", "Заявка на доступ"], ["backup", "Резервные копии"], ["audit", "Журнал действий"],
];
let adminTab = "health";

// ---- Журнал действий администраторов (GET /admin/audit, services/audit.js) ----
// Кто и когда менял настройки. Только чтение: записи не правятся и не удаляются.
function auditDetails(d) {
  if (!d) return "";
  const show = (v) => (Array.isArray(v) ? v.map(show).join("; ") : v && typeof v === "object"
    ? Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(", ") : String(v));
  return Object.entries(d).map(([k, v]) => `<span style="color:var(--ink-soft);">${esc(k)}:</span> ${esc(show(v))}`).join(" · ");
}

async function renderAudit(box) {
  box.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <div class="section-label">Журнал действий администраторов</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:12px;">
        Кто и когда менял настройки: группы домена, папку копий, сертификат, почту и оповещения, ящики рассылок,
        справочники Ассистента. Пароли в журнал не попадают — только отметка, что пароль изменён.
        Записи нельзя ни исправить, ни удалить.
      </div>
      <div style="display:flex;gap:10px;margin-bottom:12px;">
        <input class="input" id="auditQ" placeholder="Поиск: фамилия, логин, что менялось" style="flex:1;max-width:420px;">
        <button class="btn btn-ghost" id="auditFind">Найти</button>
      </div>
      <div id="auditRows"></div>
      <div style="margin-top:12px;"><button class="btn btn-ghost" id="auditMore" style="display:none;">Показать более ранние</button></div>
    </div>`;
  const rowsBox = box.querySelector("#auditRows");
  const moreBtn = box.querySelector("#auditMore");
  let last = null;
  const row = (r) => `
    <div style="display:flex;gap:14px;align-items:baseline;padding:8px 0;border-top:1px solid var(--line-soft);">
      <span style="width:118px;flex-shrink:0;font-size:11.5px;color:var(--ink-soft);">${esc(fmtDate(r.at))}</span>
      <span style="width:190px;flex-shrink:0;font-size:12.5px;font-weight:600;" title="${esc(r.login || "")}${r.ip ? " · " + esc(r.ip) : ""}">${esc(r.full_name || r.login || "—")}</span>
      <span style="flex:1;min-width:0;font-size:12.5px;">${esc(r.summary)}
        ${r.details ? `<div style="font-size:11.5px;margin-top:2px;word-break:break-word;">${auditDetails(r.details)}</div>` : ""}</span>
    </div>`;
  async function load(reset) {
    if (reset) { last = null; rowsBox.innerHTML = `<div class="spinner">Загрузка…</div>`; }
    try {
      const q = box.querySelector("#auditQ").value.trim();
      const res = await api(`/admin/audit?limit=100${q ? "&q=" + encodeURIComponent(q) : ""}${last ? "&before=" + last : ""}`);
      const html = res.rows.map(row).join("");
      if (reset) rowsBox.innerHTML = html || `<div style="font-size:12.5px;color:var(--ink-soft);">${q ? "Ничего не найдено." : "Записей пока нет — они появятся с первым изменением настроек."}</div>`;
      else rowsBox.insertAdjacentHTML("beforeend", html);
      if (res.rows.length) last = res.rows[res.rows.length - 1].id;
      moreBtn.style.display = res.more ? "" : "none";   // .btn задаёт display — атрибут hidden не сработал бы
    } catch (e) { rowsBox.innerHTML = `<div class="empty-state">Не удалось загрузить журнал: ${esc(e.message)}</div>`; }
  }
  box.querySelector("#auditFind").onclick = () => load(true);
  box.querySelector("#auditQ").onkeydown = (e) => { if (e.key === "Enter") load(true); };
  moreBtn.onclick = () => load(false);
  load(true);
}

// ---- Состояние системы (GET /admin/health, services/health.js) ----
const HEALTH_COLOR = { ok: "var(--green)", warn: "var(--amber)", crit: "var(--red)" };

async function renderHealth(box) {
  box.innerHTML = `<div class="spinner">Проверяю службы…</div>`;
  let h;
  try { h = await api("/admin/health"); }
  catch (e) { box.innerHTML = `<div class="empty-state">Не удалось получить состояние: ${esc(e.message)}</div>`; return; }

  const итог = h.crit
    ? { level: "crit", text: `Требует внимания: ${h.crit}` + (h.warn ? `, предупреждений: ${h.warn}` : "") }
    : h.warn ? { level: "warn", text: `Работает, предупреждений: ${h.warn}` } : { level: "ok", text: "Всё в порядке" };
  const когда = (iso) => (iso ? fmtDate(iso) : "");
  const строка = (i) => `
    <div style="display:flex;gap:10px;align-items:baseline;padding:7px 0;border-top:1px solid var(--line-soft);">
      <span title="${i.level}" style="flex-shrink:0;width:9px;height:9px;border-radius:50%;background:${HEALTH_COLOR[i.level]};transform:translateY(1px);"></span>
      <span style="width:230px;flex-shrink:0;font-size:12.5px;font-weight:600;">${esc(i.label)}</span>
      <span style="flex:1;font-size:12.5px;${i.level === "ok" ? "" : `color:${HEALTH_COLOR[i.level]};`}">${esc(i.text)}${i.target ? ` <span class="mono" style="color:var(--ink-soft);font-size:11.5px;">${esc(i.target)}</span>` : ""}</span>
      <span style="flex-shrink:0;font-size:11px;color:var(--ink-soft);">${esc(когда(i.at || i.since || i.updatedAt || i.modified))}</span>
    </div>`;

  box.innerHTML = `
    <div class="card" style="margin-bottom:14px;display:flex;align-items:center;gap:12px;">
      <span style="width:12px;height:12px;border-radius:50%;background:${HEALTH_COLOR[итог.level]};"></span>
      <span style="font-size:14px;font-weight:600;">${esc(итог.text)}</span>
      <span style="flex:1;font-size:11.5px;color:var(--ink-soft);">проверено ${esc(fmtDate(h.checkedAt))}</span>
      <button class="btn btn-ghost" id="healthRefresh">Проверить снова</button>
    </div>
    ${h.sections.map((s) => `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">${esc(s.title)}</div>
        ${s.items.map(строка).join("")}
      </div>`).join("")}`;
  box.querySelector("#healthRefresh").onclick = () => renderHealth(box);
}

async function renderAdmin(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Администрирование</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    const [{ adminGroups, domainLabels }, { admins, executors }, backupInfo, { groups: deptSettings }] = await Promise.all([
      api("/admin/settings"), api("/admin/admins"), api("/admin/backup"), api("/admin/groups"),
    ]);
    const ИМЯ_ДОМЕНА = domainLabels || { A: "rosstat.local", B: "in.local" };

    const ROLE_LABEL = Object.fromEntries(deptSettings.map(d => [d.role, d.name]));

    const groupRow = (id, label, value, placeholder) => `
      <div class="grp-row">
        <span class="grp-row-l">${label}</span>
        <input class="input" id="${id}" style="flex:1;min-width:0;" value="${esc(value)}" placeholder="${esc(placeholder)}">
      </div>`;

    // Карточка группы: кто исполнитель (группа домена и/или логины), видна ли
    // группа плиткой в «Новой заявке». У заведённой из панели — ещё подпись
    // плитки и удаление (пока в ней нет заявок).
    const groupCard = (dept) => `
      <div class="card grp-card" data-role="${esc(dept.role)}">
        <div class="grp-head">
          <span class="grp-name">${esc(dept.name)}</span>
          <span class="badge mono" style="color:var(--wire);background:var(--wire-soft);">${esc(dept.prefix)}-0001</span>
          <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${dept.custom ? "из панели" : "встроенный"}</span>
          ${dept.hidden ? `<span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">скрыта</span>` : ""}
          <span class="grp-count">заявок: ${dept.tickets}</span>
        </div>
        ${dept.custom ? `<div class="field-label">Подпись плитки</div>
          <input class="input grp-hint" style="width:100%;margin-bottom:10px;" maxlength="120" value="${esc(dept.hint)}" placeholder="например: СЭД, почта, учётные записи">` : ""}
        <div class="field-label">Группа домена</div>
        ${groupRow(`group_${dept.role}_A`, esc(ИМЯ_ДОМЕНА.A), dept.groupA, "имя группы — или пусто")}
        ${groupRow(`group_${dept.role}_B`, esc(ИМЯ_ДОМЕНА.B), dept.groupB, "имя группы — или пусто")}
        <div class="field-label">Логины домена — по одному на строку</div>
        <textarea class="field-input mono grp-logins" rows="${Math.min(6, Math.max(2, dept.logins.length + 1))}" style="resize:vertical;width:100%;" placeholder="ivanov">${esc(dept.logins.map((l) => l.login).join("\n"))}</textarea>
        ${dept.logins.length ? `<div class="grp-who">${dept.logins.map((l) => `<span><span class="mono">${esc(l.login)}</span> — ${l.name ? esc(l.name) : `<i>ещё не входил</i>`}</span>`).join("")}</div>` : ""}
        <label class="grp-check"><input type="checkbox" class="grp-hidden" ${dept.hidden ? "checked" : ""}> Скрыть из «Новой заявки» — заявки приходят только по программам из Заявки на доступ</label>
        <div class="grp-actions">
          ${dept.custom ? `<button class="btn btn-ghost grp-del" ${dept.tickets ? `disabled title="В группе есть заявки — её можно только скрыть"` : ""}>Удалить группу</button>` : ""}
          <span class="grp-msg"></span>
          <button class="btn btn-wire grp-save">Сохранить</button>
        </div>
      </div>`;

    const человек = (a, показатьРоль) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line-soft);">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:13px;font-weight:600;">${esc(a.full_name)}</span>
          <span class="mono" style="font-size:12px;color:var(--ink-soft);">${esc(a.ad_login)}</span>
          ${показатьРоль ? (a.roles || [a.role]).map(r => `<span class="badge" style="color:var(--wire);background:var(--wire-soft);">${esc(ROLE_LABEL[r] || r)}</span>`).join("") : ""}
          <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${a.last_domain === "local" ? "Локальный" : esc(ИМЯ_ДОМЕНА[a.last_domain] || a.last_domain)}</span>
        </div>
        <span style="font-size:11px;color:var(--ink-soft);">вход ${fmtDate(a.last_login_at)}</span>
      </div>`;

    const пусто = (текст) => `<div style="font-size:12.5px;color:var(--ink-soft);">${текст}</div>`;

    main.querySelector(".page").innerHTML = `
      <div class="toggle-group as-tabs" id="admTabs">
        ${ADMIN_TABS.map(([id, l]) => `<button class="toggle-btn${adminTab === id ? " active" : ""}" data-tab="${id}">${l}</button>`).join("")}
      </div>

      <div data-pane="health" id="healthPane"></div>
      <div data-pane="audit" id="auditPane"></div>

      <div data-pane="people">
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Администраторы платформы</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">
          Права даёт членство в группе, указанной в <code class="mono">.env</code> на сервере:
          ${adminGroups.A ? `<span class="mono">${esc(adminGroups.A)}</span>` : "<i>не задана</i>"} (${esc(ИМЯ_ДОМЕНА.A)}),
          ${adminGroups.B ? `<span class="mono">${esc(adminGroups.B)}</span>` : "<i>не задана</i>"} (${esc(ИМЯ_ДОМЕНА.B)}).
          Отсюда список не редактируется и группами отделов ниже не расширяется.
        </div>
        ${admins.length ? admins.map(a => человек(a, false)).join("") : пусто("Ни один администратор ещё не входил.")}
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Исполнители по отделам</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">
          Из групп домена (на момент последнего входа) и списков логинов во вкладке «Группы исполнителей». Прав администратора не даёт.
        </div>
        ${executors.length ? executors.map(a => человек(a, true)).join("") : пусто("Пока никто не входил под ролью исполнителя.")}
      </div>
      </div>

      <div data-pane="access">
      <div class="card" style="margin-bottom:20px;" id="accessAdmin"><div class="spinner">Загрузка…</div></div>
      </div>

      <div data-pane="backup">
      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Резервные копии баз</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
          Раз в месяц каждая база копируется в отдельный файл (<span class="mono">smdr-2026-10.db</span> и т.п.),
          старые копии не удаляются. Лучше класть их в сетевую папку, а не на тот же диск, что и базы.
          Путь — сетевой: <span class="mono">\\\\сервер\\папка\\backups</span>. Диск, подключённый буквой
          (<span class="mono">Z:\\</span>), служба не видит — он есть только в сеансе пользователя.
          Права на запись нужны учётной записи компьютера, под ней служба ходит в сеть.
        </div>
        <div style="font-size:12.5px;margin-bottom:12px;">Сейчас копии кладутся в
          <span class="mono">${esc(backupInfo.dir)}</span>
          <span style="color:var(--ink-soft);">(${{ panel: "задано здесь", env: "задано в .env на сервере (BACKUP_DIR)", default: "папка по умолчанию" }[backupInfo.source] || ""})</span>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px;">
          <div style="flex:1;min-width:260px;">
            <div class="field-label">Папка для копий (пусто — ${backupInfo.envDir ? "из .env" : "папка по умолчанию"})</div>
            <input class="input mono" id="bkDir" value="${esc(backupInfo.panelDir)}" placeholder="${esc(backupInfo.envDir || backupInfo.defaultDir)}" style="width:100%;" />
          </div>
          <button class="btn btn-ghost" id="bkCheck">Проверить</button>
          <button class="btn btn-wire" id="bkSave">Сохранить</button>
          <button class="btn btn-ghost" id="bkRun">Сделать копию сейчас</button>
        </div>
        <div id="bkMsg" style="font-size:12px;margin-bottom:10px;"></div>
        <div class="field-label">Последние копии в этой папке</div>
        ${Array.isArray(backupInfo.copies) && backupInfo.copies.length
          ? `<div style="font-size:12.5px;display:grid;grid-template-columns:auto auto auto;gap:4px 18px;justify-content:start;">
              ${backupInfo.copies.map(c => `<span class="mono">${esc(c.name)}</span>
                <span style="color:var(--ink-soft);">${(c.size / 1048576).toFixed(1)} МБ</span>
                <span style="color:var(--ink-soft);">${fmtDate(c.modified)}</span>`).join("")}
            </div>`
          : `<div style="font-size:12px;color:var(--ink-soft);">${esc((backupInfo.copies && backupInfo.copies.error) || "Копий пока нет — первая появится при ближайшем ежемесячном обходе или по кнопке «Сделать копию сейчас».")}</div>`}
      </div>
      </div>

      <div data-pane="groups">
      <div class="grp-layout">
        <div class="grp-list">
          ${deptSettings.map(groupCard).join("")}
        </div>
        <div class="grp-side">
          <div class="card" id="grpNew">
            <div class="section-label">Добавить группу исполнителей</div>
            <div class="as-note" style="margin-bottom:12px;">Группа сразу появится в заявках, правах и оповещениях — перезапуск не нужен.
              Вписанные логинами получают её заявки в колокольчик и на почту.</div>
            <div class="form-row" style="grid-template-columns:1fr 120px;">
              <div><div class="field-label">Название</div><input class="input" id="gnName" maxlength="30" placeholder="АДМ" style="width:100%;"></div>
              <div><div class="field-label">Префикс номера</div><input class="input mono" id="gnPrefix" maxlength="10" placeholder="АДМ" style="width:100%;"></div>
            </div>
            <div class="field-label">Подпись плитки</div>
            <input class="input" id="gnHint" maxlength="120" placeholder="например: СЭД, почта, учётные записи" style="width:100%;margin-bottom:10px;">
            <div class="field-label">Логины домена — по одному на строку</div>
            <textarea class="field-input mono" id="gnLogins" rows="3" style="resize:vertical;width:100%;" placeholder="ivanov"></textarea>
            <label class="grp-check"><input type="checkbox" id="gnHidden"> Скрыть из «Новой заявки»</label>
            <div class="grp-actions"><span class="grp-msg" id="gnMsg"></span><button class="btn btn-wire" id="gnCreate">Добавить</button></div>
          </div>
          <div class="as-note" style="margin-top:12px;">Встроенные отделы (ИТ, ХОЗ…) задаются в <span class="mono">config/departments.local.js</span> на сервере;
            здесь у них правятся группы домена, логины и видимость. Номера заявок группы: <span class="mono">ПРЕФИКС-0001</span>.</div>
        </div>
      </div>
      </div>`;

    // Вкладки только прячут разделы: всё загружено разом, и введённое, но
    // не сохранённое при переключении не теряется.
    const showTab = () => {
      main.querySelectorAll("#admTabs .toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === adminTab));
      main.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== adminTab; });
    };
    main.querySelectorAll("#admTabs .toggle-btn").forEach((b) => { b.onclick = () => { adminTab = b.dataset.tab; showTab(); }; });
    showTab();

    // ---- Состояние: опрос модулей идёт отдельно и страницу не задерживает ----
    renderHealth(main.querySelector("#healthPane"));
    // Журнал — при первом открытии вкладки и заново при каждом следующем: за это время могли появиться записи.
    main.querySelector('#admTabs [data-tab="audit"]').addEventListener("click", () => renderAudit(main.querySelector("#auditPane")));
    if (adminTab === "audit") renderAudit(main.querySelector("#auditPane"));

    // ---- Заявка на доступ: отделы, начальники, отдел ИТ (app-assistant.js) ----
    renderAccessAdmin(main.querySelector("#accessAdmin"));

    // ---- Резервные копии баз (раньше — «Оповещения → Отправка») ----
    const bkMsg = main.querySelector("#bkMsg");
    const bkShow = (ok, text, hint) => {
      bkMsg.style.color = ok ? "var(--green)" : "var(--red)";
      bkMsg.innerHTML = esc(text) + (hint ? `<div style="color:var(--ink-soft);margin-top:4px;">${esc(hint)}</div>` : "");
    };
    main.querySelector("#bkCheck").onclick = async () => {
      const dir = main.querySelector("#bkDir").value.trim() || backupInfo.envDir || backupInfo.defaultDir;
      bkMsg.style.color = "var(--ink-soft)"; bkMsg.textContent = "Проверяю запись…";
      try {
        const r = await api("/admin/backup/check", { method: "POST", body: { dir } });
        if (r.ok) bkShow(true, `Запись в ${dir} работает — копии туда лягут.`);
        else bkShow(false, `Не получилось: ${r.error}`, r.hint);
      } catch (e) { bkShow(false, e.message); }
    };
    main.querySelector("#bkSave").onclick = async () => {
      bkMsg.style.color = "var(--ink-soft)"; bkMsg.textContent = "Проверяю и сохраняю…";
      try {
        const r = await api("/admin/backup", { method: "PUT", body: { dir: main.querySelector("#bkDir").value } });
        bkShow(true, `Сохранено: копии будут класться в ${r.dir}`);
        setTimeout(() => renderAdmin(main), 1800);
      } catch (e) { bkShow(false, e.message, e.hint); }
    };
    // То же задание планировщика, что и ежемесячный обход: результат виден и в «Оповещения → Отправка».
    main.querySelector("#bkRun").onclick = async () => {
      bkMsg.style.color = "var(--ink-soft)"; bkMsg.textContent = "Копирую базы…";
      try {
        const r = await api("/notifications/schedule/backup/run", { method: "POST", body: {} });
        if (r.ok) { bkShow(true, jobDetailText(r.detail)); setTimeout(() => renderAdmin(main), 2600); }
        else bkShow(false, r.error || r.skipped || "не выполнено");
      } catch (e) { bkShow(false, e.message, e.hint); }
    };

    // ---- Группы исполнителей ----
    // Созданная или удалённая группа меняет плитки «Новой заявки» — справочник
    // в браузере перечитываем, чтобы не ждать перезагрузки страницы.
    const refreshGroups = async () => {
      try { state.departments = (await api("/departments")).departments; } catch { /* останется прежний до перезагрузки */ }
      renderAdmin(main);
    };
    main.querySelectorAll(".grp-card").forEach((card) => {
      const role = card.dataset.role;
      const msg = card.querySelector(".grp-msg");
      const say = (ok, text) => { msg.style.color = ok ? "var(--green)" : "var(--red)"; msg.textContent = text; };
      card.querySelector(".grp-save").onclick = async () => {
        const body = {
          groupA: card.querySelector(`#group_${role}_A`).value.trim(),
          groupB: card.querySelector(`#group_${role}_B`).value.trim(),
          logins: card.querySelector(".grp-logins").value,
          hidden: card.querySelector(".grp-hidden").checked,
        };
        const hint = card.querySelector(".grp-hint");
        if (hint) body.hint = hint.value;
        try {
          await api(`/admin/groups/${encodeURIComponent(role)}`, { method: "PUT", body });
          say(true, "Сохранено");
          setTimeout(refreshGroups, 900);
        } catch (e) { say(false, e.message); }
      };
      const del = card.querySelector(".grp-del");
      if (del) del.onclick = async () => {
        const name = card.querySelector(".grp-name").textContent;
        if (!(await uiConfirm(`Удалить группу «${name}»? Программы, отданные ей в Заявке на доступ, вернутся в общую очередь.`, { ok: "Удалить", danger: true }))) return;
        try { await api(`/admin/groups/${encodeURIComponent(role)}`, { method: "DELETE" }); toast(`Группа «${name}» удалена`); refreshGroups(); }
        catch (e) { say(false, e.message); }
      };
    });
    // Префикс по умолчанию — из названия, пока его не правили руками.
    const gnPrefix = main.querySelector("#gnPrefix");
    main.querySelector("#gnName").addEventListener("input", (e) => {
      if (!gnPrefix.dataset.touched) gnPrefix.value = e.target.value.replace(/[^A-Za-zА-Яа-яЁё0-9]/g, "").toUpperCase().slice(0, 10);
    });
    gnPrefix.addEventListener("input", () => { gnPrefix.dataset.touched = "1"; });
    main.querySelector("#gnCreate").onclick = async () => {
      const v = (id) => main.querySelector(id).value;
      const gnMsg = main.querySelector("#gnMsg");
      try {
        await api("/admin/groups", { method: "POST", body: {
          name: v("#gnName"), prefix: v("#gnPrefix"), hint: v("#gnHint"), logins: v("#gnLogins"),
          hidden: main.querySelector("#gnHidden").checked,
        } });
        toast(`Группа «${v("#gnName").trim()}» добавлена`);
        refreshGroups();
      } catch (e) { gnMsg.style.color = "var(--red)"; gnMsg.textContent = e.message; }
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

// Сертификат загрузили, а платформа работает по http — на https она перейдёт только после
// перезапуска. Спрашиваем: сейчас или позже. «Сейчас» — процесс завершается, служба NSSM поднимает
// его снова (routes/certificates.js, POST /restart); ждём, пока платформа ответит по https, и
// открываем её уже по https. Если платформа запущена не службой, кнопки «сейчас» нет — объясняем.
function askRestart(canRestart) {
  const httpsUrl = `https://${location.host}/#certs`;
  const m = asstModal("Сертификат сохранён", `
    <div style="font-size:13px;line-height:1.55;margin-bottom:14px;">
      Сейчас платформа работает по <b>http</b>. На https она перейдёт после перезапуска — на ходу
      включить шифрование нельзя.
      ${canRestart
        ? "Перезапустить сейчас? Пользователи на несколько секунд потеряют связь, открытые страницы переподключатся сами."
        : "Перезапустить отсюда нельзя: платформа запущена не службой. Перезапустите её вручную."}
      <div style="color:var(--ink-soft);margin-top:8px;">После перехода на https браузер попросит войти ещё раз — один
      раз: вход, сделанный по http, браузер на https не переносит. «Искра» читает тот же сертификат; на https она перейдёт
      после перезапуска своей службы.</div>
    </div>
    <div id="rsMsg" style="font-size:12.5px;margin-bottom:12px;"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn btn-ghost" id="rsLater">${canRestart ? "Позже" : "Понятно"}</button>
      ${canRestart ? `<button class="btn btn-wire" id="rsNow">Перезапустить сейчас</button>` : ""}
    </div>`);
  const msg = m.el.querySelector("#rsMsg");
  m.el.querySelector("#rsLater").onclick = () => {
    m.close();
    toast("Сертификат начнёт действовать после перезапуска службы платформы.");
  };
  const now = m.el.querySelector("#rsNow");
  if (!now) return;
  now.onclick = async () => {
    now.disabled = true; m.el.querySelector("#rsLater").disabled = true;
    msg.style.color = "var(--ink-soft)"; msg.textContent = "Перезапускаю платформу…";
    try {
      await api("/certificates/restart", { method: "POST", body: {} });
    } catch (e) {
      msg.style.color = "var(--red)"; msg.textContent = e.message;
      now.disabled = false; m.el.querySelector("#rsLater").disabled = false;
      return;
    }
    // Ответ по https — значит, поднялась уже с сертификатом. Страница открыта по http, поэтому
    // спрашиваем «вслепую» (no-cors): нам важен сам факт ответа, а не его содержимое.
    const started = Date.now();
    const poll = async () => {
      try {
        await fetch(`https://${location.host}/api/health?ts=${Date.now()}`, { mode: "no-cors", cache: "no-store" });
        msg.style.color = "var(--green)"; msg.textContent = "Готово — открываю платформу по https…";
        setTimeout(() => { location.href = httpsUrl; }, 600);
        return;
      } catch { /* ещё не поднялась или сертификат браузеру не доверен */ }
      const sec = Math.round((Date.now() - started) / 1000);
      if (sec < 12) { msg.textContent = `Ждём, пока служба поднимется… ${sec} с`; setTimeout(poll, 1500); return; }
      // Служба поднимается за 5–10 с. Если проверка всё не проходит — скорее всего, браузер не доверяет
      // сертификату (самоподписанный, корня нет в Windows): тогда он сам покажет предупреждение на https-адресе.
      msg.innerHTML = `Открываю <a href="${esc(httpsUrl)}">${esc(httpsUrl)}</a>… Если браузер предупредит о
        сертификате — значит, он ему не доверяет (корня удостоверяющего центра нет в Windows).`;
      setTimeout(() => { location.href = httpsUrl; }, 1500);
    };
    setTimeout(poll, 3000);
  };
}

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

    // Щит в шапке — по тем же свежим данным: раздел открывают и сразу после загрузки нового
    // сертификата (renderCertificates ниже), и ждать до получаса, пока щит спросит сервер сам, незачем.
    // Сертификат ещё разбирается (только что применён) — щит спросит сам при следующем переходе.
    certBadge = { at: server.secure && !server.certificate ? 0 : Date.now(), cert: server.certificate, secure: server.secure };
    const badgeBtn = document.getElementById("certsBtn");
    if (badgeBtn) applyCertBadge(badgeBtn);

    const c = server.certificate;
    const serverCard = !server.secure
      ? `<div class="warn-box">Платформа работает по HTTP — сертификат не задан. Пароли и переписка идут открытым текстом.</div>`
      : c
        ? `${row("Кому выдан", esc(c.subject || "—"))}
           ${row("Имена в сертификате (SAN)", `<span class="mono" style="font-size:12px;">${esc(c.san || "—")}</span>`)}
           ${row("Кем выдан", esc(c.issuer || "—"))}
           ${row("Действителен до", `${esc(c.validTo || "—")} ${days(certDaysLeft(c))}`)}
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
                : server.managedBy === "env"
                ? `Сейчас общее хранилище пустое, и работает запасной путь — переменная в <span class="mono">.env</span>: <span class="mono">${esc(server.where || "")}</span>. Такой сертификат <b>не общий</b> с «Искрой». Загрузите файл формой ниже — он ляжет в общее хранилище и сразу заменит сертификат из переменной: хранилище важнее.`
                : `Сертификата нет. Загрузите PFX формой ниже — он ляжет в общее хранилище; платформа перейдёт на https после перезапуска службы (с http на https на ходу не переключиться).`}
            </div>
            ${server.managedBy !== "store" ? `<div class="warn-box" style="margin-bottom:14px;">
              <div>
              Хранилище платформа ищет в <span class="mono">${esc(server.storeDir || "")}</span> — это должен быть
              каталог <span class="mono">certs</span> работающей «Искры». Если «Искра» стоит не там, укажите
              <span class="mono">SHARED_CERT_DIR=&lt;папка Искры&gt;\\certs</span> в <span class="mono">.env</span> и
              перезапустите платформу — иначе загруженный здесь файл «Искра» не увидит.
              </div>
            </div>` : ""}
            ${server.shadowedEnv ? `<div class="warn-box" style="margin-bottom:14px;">
              <div>
              В <span class="mono">.env</span> (или в окружении службы) задана переменная
              <span class="mono">${esc(server.shadowedEnv)}</span>, но она не используется: действует сертификат
              из общего хранилища. Уберите её — иначе, если файл из хранилища однажды удалят, платформа молча
              вернётся к старому сертификату из переменной.
              </div>
            </div>` : ""}
            ${serverCard}

            ${server.managedBy ? `
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
                  <div class="dropzone dz-inline" id="certDrop" title="PFX-файл сертификата"><span class="dropzone-icon">${icon("upload", 16)}</span><span id="certDropText">Выберите PFX — нажмите или перетащите сюда</span></div>
                  <input id="certFile" type="file" accept=".pfx,.p12" hidden>
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
            <input class="field-input" id="rootName" placeholder="например in-local-root.crt" style="margin-bottom:10px;">
            <textarea class="input" id="rootPem" rows="5" placeholder="-----BEGIN CERTIFICATE-----" style="width:100%;font-family:var(--mono);font-size:11px;margin-bottom:10px;"></textarea>
            <button class="btn btn-wire" id="addRoot" style="width:100%;justify-content:center;">Добавить</button>
            <div id="rootMsg" style="margin-top:8px;font-size:12px;text-align:center;"></div>
          </div>
        </div>
      </details>
      </div>`;

    // Голый <input type="file"> («Выберите файл / Файл не выбран») выбивался из стиля —
    // вместо него пунктирная рамка, как у вложений заявки и рассылок; имя выбранного файла — в ней.
    const certDrop = document.getElementById("certDrop");
    if (certDrop) {
      const input = document.getElementById("certFile");
      const show = () => {
        const f = input.files && input.files[0];
        certDrop.classList.toggle("has-file", Boolean(f));
        document.getElementById("certDropText").textContent = f ? f.name : "Выберите PFX — нажмите или перетащите сюда";
        certDrop.title = f ? f.name : "PFX-файл сертификата";
      };
      certDrop.onclick = () => input.click();
      input.onchange = show;
      certDrop.ondragover = (e) => { e.preventDefault(); certDrop.classList.add("over"); };
      certDrop.ondragleave = () => certDrop.classList.remove("over");
      certDrop.ondrop = (e) => {
        e.preventDefault(); certDrop.classList.remove("over");
        if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); }
      };
    }

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
        if (res.restartRequired) askRestart(res.canRestart);
        else toast("Сертификат применён — перезапуск не нужен ни платформе, ни «Искре»: обе перечитывают общее хранилище сами.");
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
        if (!(await uiConfirm(`Удалить ${btn.dataset.file} из доверенных?`, { ok: "Удалить", danger: true }))) return;
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
