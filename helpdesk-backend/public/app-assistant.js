// ====== Ассистент ======
//
// Акты (заполняются вручную) и рассылки респондентам. Раздел видят все;
// «Настройки» — только администраторы (и проверяет это сервер, а не только
// меню).
//
// Здесь же — форма заявки на доступ сотрудника: она живёт на экране «Новая
// заявка» плиткой «Доступ к программам», а её настройки (отделы и начальники,
// отдел ИТ, программы) — в Администрировании заявок. Файлы раздела: этот —
// оболочка, заявка на доступ, настройки; app-acts.js — акты; app-mailings.js —
// рассылки.
//
// Всё, что пришло из базы, — в разметку только через esc().

const ASSISTANT_VIEWS = [
  { id: "asst:acts", label: "Акты", icon: "receipt" },
  { id: "asst:mail", label: "Рассылки", icon: "mail" },
  { id: "asst:settings", label: "Настройки", icon: "sliders" },
];

let asstRefsCache = null;
async function asstRefs(force) {
  if (!asstRefsCache || force) asstRefsCache = await api("/assistant/refs");
  return asstRefsCache;
}

function renderAssistant(main, sub) {
  clearViewPoll();
  if (sub === "acts") return renderAsstActs(main);
  if (sub === "mail") return state.mailOpenId ? renderMailing(main, state.mailOpenId) : renderMailings(main);
  if (sub === "settings") return renderAsstSettings(main);
}

// ---- Общие мелочи -----------------------------------------------------------

const asstPad = (n) => String(n).padStart(2, "0");
function asstToday() {
  const d = new Date();
  return `${d.getFullYear()}-${asstPad(d.getMonth() + 1)}-${asstPad(d.getDate())}`;
}
function asstRuDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || "");
}

/** Скачать файл по адресу API: кука сессии та же, браузер сам сохранит файл. */
function asstDownload(path) {
  const a = document.createElement("a");
  a.href = "/api" + path;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function asstTopbar(title, actions = "") {
  return `<div class="topbar"><div class="topbar-title-row"><div class="topbar-title">${esc(title)}</div></div>
    <div class="as-top-actions">${actions}</div></div>`;
}

/**
 * Окно поверх экрана. Возвращает { el, close }. Закрывается крестиком,
 * клавишей Esc и щелчком мимо окна — но не щелчком внутри.
 */
function asstModal(title, bodyHtml, { wide = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "as-modal-back";
  wrap.innerHTML = `
    <div class="as-modal${wide ? " wide" : ""}" role="dialog" aria-modal="true">
      <div class="as-modal-head"><h3>${esc(title)}</h3><button class="icon-btn as-x" type="button" aria-label="Закрыть">${icon("x", 18)}</button></div>
      <div class="as-modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".as-x").onclick = close;
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
  const first = wrap.querySelector("input:not([type=checkbox]):not([type=file]), textarea");
  if (first) setTimeout(() => first.focus(), 30);
  return { el: wrap.querySelector(".as-modal"), close };
}

// ---- Заявка на доступ (экран «Новая заявка») --------------------------------

/**
 * Форма заявки на доступ сотрудника в контейнере box. Рисует экран «Новая
 * заявка», когда выбрана плитка «Доступ к программам». onCancel — кнопка
 * «Отмена».
 */
async function renderAccessForm(box, { onCancel } = {}) {
  box.innerHTML = `<div class="spinner">Загрузка…</div>`;
  let refs;
  try { refs = await asstRefs(true); } catch (e) { box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  let type = "register";
  const needsAccess = () => ["register", "edit", "restore"].includes(type);

  box.innerHTML = `
    <div class="form-card">
      <div class="form-card-title">Что нужно сделать</div>
      <div class="form-card-sub">Заявка уйдёт в отдел ИТ; её статус и переписка — в «Мои заявки»</div>
      <div class="prio-row" id="acType" style="margin-bottom:0">
        ${refs.accessTypes.map((t) => `<button type="button" class="prio-chip${t.id === type ? " active" : ""}" data-t="${t.id}">${esc(t.short)}</button>`).join("")}
      </div>
    </div>
    <div class="form-card">
      <div class="form-card-title" style="margin-bottom:16px">Сотрудник</div>
      <div class="form-row">
        <div><div class="field-label">Фамилия *</div><input class="field-input" id="acLast" maxlength="60"></div>
        <div><div class="field-label">Имя *</div><input class="field-input" id="acFirst" maxlength="60"></div>
        <div><div class="field-label">Отчество</div><input class="field-input" id="acMiddle" maxlength="60"></div>
      </div>
      <div class="form-row">
        <div><div class="field-label">Должность <span id="acPostStar">*</span></div>
          <input class="field-input" id="acPost" list="acPosts" maxlength="150" placeholder="выберите или впишите">
          <datalist id="acPosts">${refs.posts.map((p) => `<option value="${esc(p)}">`).join("")}</datalist></div>
        <div><div class="field-label">Отдел *</div>
          <input class="field-input" id="acDept" list="acDepts" maxlength="150" value="${esc(refs.myDepartment)}" placeholder="выберите или впишите">
          <datalist id="acDepts">${refs.depts.map((d) => `<option value="${esc(d.name)}">`).join("")}</datalist></div>
      </div>
      <div class="form-row" style="margin-bottom:0">
        <div><div class="field-label">Кабинет</div><input class="field-input" id="acRoom" maxlength="20"></div>
        <div><div class="field-label">Внутренний тел.</div><input class="field-input" id="acInt" maxlength="20"></div>
        <div><div class="field-label">Внешний тел.</div><input class="field-input" id="acExt" maxlength="30"></div>
        <div><div class="field-label">Мобильный</div><input class="field-input" id="acMob" maxlength="30"></div>
      </div>
    </div>
    <div class="form-card" id="acAccessCard">
      <div class="form-card-title">Необходимо предоставить доступ</div>
      <div class="form-card-sub">Отметьте программы, которые нужны сотруднику</div>
      <div class="as-checks" id="acProgs">
        ${refs.programs.map((p) => `<label class="as-check"><input type="checkbox" value="${esc(p)}"><span>${esc(p)}</span></label>`).join("")}
      </div>
      <div class="field-label" style="margin-top:16px">Формы в ЦСОД (через запятую)</div>
      <input class="field-input" id="acCsod" maxlength="1000" placeholder="напр. 1-Т, П-1, П-4" style="margin-bottom:0">
    </div>
    <div class="form-card">
      <div class="field-label">Комментарий</div>
      <textarea class="field-input" id="acComment" rows="3" maxlength="1000" style="resize:vertical;margin-bottom:0" placeholder="С какой даты, чьи права скопировать, до какого числа блокировать…"></textarea>
    </div>
    <div class="form-foot">
      <div class="hint" id="acHint">После отправки скачайте служебную записку: её подписывает начальник отдела сотрудника</div>
      <div class="actions">
        <button class="btn-text" id="acCancel">Отмена</button>
        <button class="btn-send" id="acSend">Отправить заявку</button>
      </div>
    </div>
    <div id="acDone"></div>`;

  const $ = (id) => box.querySelector("#" + id);
  const syncType = () => {
    box.querySelectorAll("#acType .prio-chip").forEach((b) => b.classList.toggle("active", b.dataset.t === type));
    $("acAccessCard").hidden = !needsAccess();
    $("acPostStar").hidden = type !== "register";
  };
  box.querySelectorAll("#acType .prio-chip").forEach((b) => { b.onclick = () => { type = b.dataset.t; syncType(); }; });
  syncType();
  $("acCancel").onclick = () => (onCancel ? onCancel() : setView("inbox"));

  $("acSend").onclick = async () => {
    const body = {
      type, last_name: $("acLast").value, first_name: $("acFirst").value, middle_name: $("acMiddle").value,
      post: $("acPost").value, department: $("acDept").value, room: $("acRoom").value,
      phone_int: $("acInt").value, phone_ext: $("acExt").value, phone_mobile: $("acMob").value,
      programs: needsAccess() ? [...box.querySelectorAll("#acProgs input:checked")].map((c) => c.value) : [],
      csod_forms: needsAccess() ? $("acCsod").value : "", comment: $("acComment").value,
    };
    const required = [["acLast", body.last_name], ["acFirst", body.first_name], ["acDept", body.department]];
    if (type === "register") required.push(["acPost", body.post]);
    let bad = false;
    for (const [id, v] of required) { const miss = !String(v).trim(); $(id).classList.toggle("invalid", miss); bad = bad || miss; }
    $("acHint").classList.toggle("invalid", bad);
    if (bad) { $("acHint").textContent = "Заполните отмеченные поля"; return; }
    $("acHint").textContent = "После отправки скачайте служебную записку: её подписывает начальник отдела сотрудника";
    $("acSend").disabled = true;
    try {
      const { ticket } = await api("/assistant/access", { method: "POST", body });
      toast(`Заявка ${ticket.display_id} отправлена в ИТ`);
      $("acDone").innerHTML = `
        <div class="as-done">
          <span class="as-done-ic">${icon("check", 18)}</span>
          <div><b>Заявка ${esc(ticket.display_id)} отправлена</b><small>Распечатайте служебную записку и подпишите у начальника своего отдела</small></div>
          <button class="btn btn-ghost" id="acDoc">${icon("download", 15)} Служебная записка</button>
          <button class="btn btn-ghost" id="acOpen">Открыть заявку</button>
        </div>`;
      $("acDoc").onclick = () => asstDownload(`/assistant/access/${ticket.id}/doc`);
      $("acOpen").onclick = async () => {
        try { setView("detail", (await api(`/tickets/${ticket.id}`)).ticket); } catch (e) { toast(e.message, true); }
      };
      $("acDone").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      toast(e.message, true);
      $("acSend").disabled = false;
    }
  };
}

/** Анкета в карточке заявки (заявка на доступ). */
function ticketFormCard(ticket) {
  const d = ticket.form.data || {};
  const phones = [d.phone_int && `внутр. ${d.phone_int}`, d.phone_ext && `внеш. ${d.phone_ext}`, d.phone_mobile && `моб. ${d.phone_mobile}`].filter(Boolean).join(", ");
  const rows = [
    ["Тип", d.typeLabel], ["Сотрудник", d.fio], ["Должность", d.post], ["Отдел", d.department],
    ["Кабинет", d.room], ["Телефоны", phones], ["Программы", (d.programs || []).join(", ")],
    ["Формы ЦСОД", d.csod_forms], ["Комментарий", d.comment],
  ].filter(([, v]) => v);
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-label" style="display:flex;justify-content:space-between;align-items:center">Анкета сотрудника
        <a class="btn btn-ghost as-btn-sm" href="/api/assistant/access/${ticket.id}/doc">${icon("download", 14)} Служебная записка</a></div>
      <div class="as-kv">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join("")}</div>
    </div>`;
}

// ---- Заявка на доступ: настройки в Администрировании ------------------------

/**
 * Блок «Заявка на доступ» в Администрировании заявок: отделы и начальники,
 * какой отдел — ИТ (его начальнику адресована служебная записка), в какую
 * очередь идут заявки, списки программ и должностей.
 */
async function renderAccessAdmin(box) {
  let g;
  try { g = await api("/assistant/settings/general"); } catch (e) { box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const itMissing = !g.itDept;
  box.innerHTML = `
    <div class="section-label">Заявка на доступ сотрудника</div>
    <div class="as-note" style="margin-bottom:14px;max-width:820px">Сотрудник заполняет её на экране «Новая заявка» (плитка «Доступ к программам»).
      Служебная записка по ней адресована <b>начальнику отдела ИТ</b> и подписывается начальником отдела сотрудника — поэтому нужны отделы с начальниками и падежами ФИО.</div>
    ${itMissing ? `<div class="warn-box">Не выбран отдел ИТ — в служебной записке будет пустая шапка «кому». Выберите его ниже, после того как добавите в список.</div>` : ""}
    <div class="form-row">
      <div><div class="field-label">Отдел ИТ — кому адресована служебная записка</div>
        <select id="axIt" class="field-select"><option value="">— не выбран —</option>${g.orgDepts.map((d) => `<option ${d === g.itDept ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
      <div><div class="field-label">В какую очередь попадает заявка</div>
        <select id="axQueue" class="field-select">${g.accessDepts.map((d) => `<option ${d === (g.accessDept || g.accessDepts[0]) ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
    </div>
    <div class="form-row">
      <div><div class="field-label">Программы — по одной на строку</div>
        <textarea class="field-input" id="axProgs" rows="7" style="resize:vertical">${esc(g.programs.join("\n"))}</textarea></div>
      <div><div class="field-label">Должности — по одной на строку</div>
        <textarea class="field-input" id="axPosts" rows="7" style="resize:vertical">${esc(g.posts.join("\n"))}</textarea></div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:22px"><button class="btn btn-wire" id="axSave">Сохранить</button></div>
    <div id="axDepts"></div>`;
  const lines = (id) => box.querySelector(id).value.split("\n").map((x) => x.trim()).filter(Boolean);
  box.querySelector("#axSave").onclick = async () => {
    try {
      await api("/assistant/settings/general", { method: "PUT", body: {
        itDept: box.querySelector("#axIt").value, accessDept: box.querySelector("#axQueue").value,
        programs: lines("#axProgs"), posts: lines("#axPosts"),
      } });
      asstRefsCache = null;
      toast("Сохранено");
      renderAccessAdmin(box);
    } catch (e) { toast(e.message, true); }
  };
  // Добавили или переименовали отдел — список «отдел ИТ» надо перечитать.
  await asstDictEditor(box.querySelector("#axDepts"), "depts", g, () => renderAccessAdmin(box));
}

// ---- Настройки (администратор) ----------------------------------------------

const ASST_SETTINGS_TABS = [
  ["general", "Общие"], ["people", "Подписанты актов"], ["rules", "Неисправности"],
  ["templates", "Шаблоны"], ["mail", "Почта рассылок"],
];
let asstSettingsTab = "general";

// Справочники — одна форма на все: поле, подпись, подсказка.
const ASST_DICTS = {
  depts: {
    title: "Отделы и начальники", add: "Добавить отдел",
    sub: "Падежи ФИО нужны служебной записке: «Начальнику отдела … Иванову И.И.». Должность и склонение названия отдела подставляются сами",
    cols: [["name", "Отдел"], ["chief_name", "Начальник"], ["sort", "Порядок"]],
    fields: [
      ["name", "Название отдела *", "Отдел статистики цен"],
      ["chief_name", "Начальник (Фамилия И.О.)", "Иванов И.И."], ["chief_name_gen", "Начальник — кого?", "Иванова И.И."], ["chief_name_dat", "Начальник — кому?", "Иванову И.И."],
      ["sort", "Порядок", "0"],
    ],
  },
  people: {
    title: "Подписанты актов", add: "Добавить",
    sub: "Руководитель — в «УТВЕРЖДАЮ» актов; составители выбираются при составлении акта; комиссия — в акте на списание. Начальник отдела ИТ берётся из справочника отделов (Администрирование заявок)",
    cols: [["role", "Роль"], ["name", "Фамилия И.О."], ["post", "Должность"]],
    fields: [
      ["role", "Роль *", "", "role"], ["name", "Фамилия И.О. *", "Иванов И.И."], ["name_dat", "Фамилия И.О. — кому?", "Иванову И.И."],
      ["post", "Должность", "Руководитель"], ["post_dat", "Должность — кому?", "Руководителю"], ["sort", "Порядок", "0"],
    ],
  },
  rules: {
    title: "Типовые неисправности", add: "Добавить",
    sub: "Готовые тексты для акта на ремонт: выбрали вид неисправности в форме акта — описание, работы и остатки подставились (их можно поправить)",
    cols: [["title", "Вид"], ["defect", "Неисправность"], ["repair_works", "Работы"]],
    fields: [
      ["title", "Вид неисправности *", "Принтер: износ термоузла"],
      ["defect", "Неисправность (по одной на строку)", "", "text"], ["repair_works", "Работы (по одной на строку)", "", "text"],
      ["remains", "Что остаётся после ремонта", ""], ["sort", "Порядок", "0"],
    ],
  },
  reasons: {
    title: "Причины списания", add: "Добавить причину",
    sub: "Готовые тексты «выявлены недостатки» для акта на списание",
    cols: [["title", "Название"], ["reason", "Текст"]],
    fields: [["title", "Название *", "Выгорела матрица"], ["reason", "Текст для акта *", "", "text"]],
  },
};

async function renderAsstSettings(main) {
  main.innerHTML = `
    ${asstTopbar("Настройки Ассистента")}
    <div class="page">
      <div class="toggle-group as-tabs" id="asTabs">
        ${ASST_SETTINGS_TABS.map(([id, l]) => `<button class="toggle-btn${asstSettingsTab === id ? " active" : ""}" data-tab="${id}">${l}</button>`).join("")}
      </div>
      <div id="asTab"><div class="spinner">Загрузка…</div></div>
    </div>`;
  main.querySelectorAll("#asTabs .toggle-btn").forEach((b) => {
    b.onclick = () => { asstSettingsTab = b.dataset.tab; renderAsstSettings(main); };
  });
  const box = main.querySelector("#asTab");
  try {
    const general = ["general", "people"].includes(asstSettingsTab) ? await api("/assistant/settings/general") : null;
    if (asstSettingsTab === "general") return asstSettingsGeneral(box, general);
    if (asstSettingsTab === "people") return asstDictEditor(box, "people", general);
    if (asstSettingsTab === "rules") {
      box.innerHTML = `<div id="asD1"></div><div id="asD2" style="margin-top:28px"></div>`;
      await asstDictEditor(box.querySelector("#asD1"), "rules", general);
      return asstDictEditor(box.querySelector("#asD2"), "reasons", general);
    }
    if (asstSettingsTab === "templates") return asstSettingsTemplates(box);
    if (asstSettingsTab === "mail") return mailSettingsTab(box);
  } catch (e) {
    box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

function asstSettingsGeneral(box, g) {
  box.innerHTML = `
    <div class="form-narrow" style="margin:0;max-width:760px">
      <div class="form-card">
        <div class="form-row" style="margin-bottom:0">
          <div><div class="field-label">Организация — как в документах</div><input class="field-input" id="gOrg" value="${esc(g.orgName)}"></div>
          <div><div class="field-label">Первый номер акта в ${g.year} году</div>
            <input class="field-input" id="gStart" type="number" min="1" value="${g.actStart}" style="max-width:160px;margin-bottom:4px">
            <div class="as-note">Если в этом году акты уже составлялись вне Ассистента, нумерация продолжится с этого номера</div></div>
        </div>
      </div>
      <div class="as-note" style="margin:-4px 0 14px">Заявка на доступ, отделы и начальники — в Администрировании заявок.</div>
      <div class="form-foot"><div class="actions"><button class="btn btn-wire" id="gSave">Сохранить</button></div></div>
    </div>`;
  box.querySelector("#gSave").onclick = async () => {
    try {
      await api("/assistant/settings/general", { method: "PUT", body: {
        orgName: box.querySelector("#gOrg").value, actStart: box.querySelector("#gStart").value,
      } });
      asstRefsCache = null;
      toast("Сохранено");
    } catch (e) { toast(e.message, true); }
  };
}

/** Таблица справочника с добавлением, правкой и удалением. onChange — после любого изменения. */
async function asstDictEditor(box, dictId, general, onChange) {
  const d = ASST_DICTS[dictId];
  const { items } = await api(`/assistant/settings/dict/${dictId}`);
  const roles = (general && general.roles) || {};
  const cell = (it, key) => key === "role" ? esc(roles[it.role] || it.role)
    : esc(it[key] === null || it[key] === undefined || it[key] === "" ? "—" : it[key]);
  box.innerHTML = `
    <div class="as-dict-head"><div><div class="as-h">${esc(d.title)}</div><div class="as-note">${esc(d.sub)}</div></div>
      <button class="btn btn-ghost" data-add>${icon("plus", 15)} ${esc(d.add)}</button></div>
    ${items.length ? `<div class="as-table-wrap"><table class="as-table as-click"><thead><tr>${d.cols.map(([, l]) => `<th>${esc(l)}</th>`).join("")}<th></th></tr></thead><tbody>
      ${items.map((it) => `<tr data-id="${it.id}">${d.cols.map(([k]) => `<td>${cell(it, k)}</td>`).join("")}
        <td class="as-row-act"><button class="as-icon-btn" data-rm="${it.id}" title="Удалить">${icon("trash", 14)}</button></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="as-empty">Пока пусто</div>`}`;
  const reload = onChange || (() => asstDictEditor(box, dictId, general));
  box.querySelector("[data-add]").onclick = () => asstDictForm(dictId, null, general, reload);
  box.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.onclick = (e) => { if (!e.target.closest("[data-rm]")) asstDictForm(dictId, items.find((x) => x.id === Number(tr.dataset.id)), general, reload); };
  });
  box.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Удалить запись?")) return;
      try { await api(`/assistant/settings/dict/${dictId}/${b.dataset.rm}`, { method: "DELETE" }); asstRefsCache = null; reload(); } catch (e) { toast(e.message, true); }
    };
  });
}

function asstDictForm(dictId, item, general, onSaved) {
  const d = ASST_DICTS[dictId];
  const v = (k) => (item && item[k] !== null && item[k] !== undefined ? item[k] : "");
  const field = ([k, label, ph, kind]) => {
    if (kind === "role") {
      return `<div class="as-f"><div class="field-label">${esc(label)}</div><select data-k="${k}" class="field-select">
        ${Object.entries(general.roles).map(([id, l]) => `<option value="${id}" ${v(k) === id ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
    }
    if (kind === "text") {
      return `<div class="as-f wide"><div class="field-label">${esc(label)}</div>
        <textarea class="field-input" data-k="${k}" rows="3" placeholder="${esc(ph)}" style="resize:vertical">${esc(v(k))}</textarea></div>`;
    }
    return `<div class="as-f${k === "sort" ? " small" : ""}"><div class="field-label">${esc(label)}</div>
      <input class="field-input" data-k="${k}" value="${esc(v(k))}" placeholder="${esc(ph)}" ${k === "sort" ? 'type="number"' : ""}></div>`;
  };
  const m = asstModal(item ? "Правка" : d.add, `
    <div class="as-grid">${d.fields.map(field).join("")}</div>
    <div class="td-form-foot"><span class="td-form-err" id="dfErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>Сохранить</button></div>`, { wide: d.fields.length > 5 });
  m.el.querySelector("[data-cancel]").onclick = m.close;
  m.el.querySelector("[data-save]").onclick = async () => {
    const body = {};
    m.el.querySelectorAll("[data-k]").forEach((el) => { body[el.dataset.k] = el.value; });
    try {
      if (item) await api(`/assistant/settings/dict/${dictId}/${item.id}`, { method: "PUT", body });
      else await api(`/assistant/settings/dict/${dictId}`, { method: "POST", body });
      asstRefsCache = null;
      m.close();
      onSaved();
    } catch (e) { m.el.querySelector("#dfErr").textContent = e.message; }
  };
}

async function asstSettingsTemplates(box) {
  const { templates } = await api("/assistant/settings/templates");
  box.innerHTML = `
    <div class="as-note" style="margin-bottom:16px;max-width:820px">Встроенные бланки работают сразу. Свой бланк — обычный документ Word с метками:
      <code>{поле}</code> подставляет значение, <code>{#список}…{/}</code> в строке таблицы повторяет строку для каждой позиции.
      Шаблоны прежнего «Ассистента» подходят как есть. Проще всего скачать встроенный, поправить оформление и загрузить.</div>
    ${templates.map((t) => `
      <div class="as-tpl">
        <div class="as-tpl-main">
          <div class="as-tpl-t">${esc(t.label)} ${t.custom ? `<span class="as-badge blue">свой</span>` : `<span class="as-badge">встроенный</span>`}</div>
          ${t.custom ? `<div class="as-note">${esc(t.custom.filename)} · ${esc(t.custom.uploaded_by || "")} · ${esc(fmtDate(t.custom.uploaded_at))}</div>` : ""}
          <div class="as-tags">Метки: ${esc(t.tags)}</div>
        </div>
        <div class="as-tpl-act">
          <button class="btn btn-ghost as-btn-sm" data-get="${t.kind}">${icon("download", 14)} Скачать</button>
          ${t.custom ? `<button class="btn btn-ghost as-btn-sm" data-def="${t.kind}">Встроенный</button>` : ""}
          <button class="btn btn-ghost as-btn-sm" data-up="${t.kind}">${icon("upload", 14)} Загрузить свой</button>
          ${t.custom ? `<button class="btn btn-text as-btn-sm" data-reset="${t.kind}">Вернуть встроенный</button>` : ""}
        </div>
      </div>`).join("")}
    <input type="file" id="tplFile" accept=".docx" hidden>`;
  let kind = null;
  const file = box.querySelector("#tplFile");
  box.querySelectorAll("[data-get]").forEach((b) => { b.onclick = () => asstDownload(`/assistant/settings/templates/${b.dataset.get}`); });
  box.querySelectorAll("[data-def]").forEach((b) => { b.onclick = () => asstDownload(`/assistant/settings/templates/${b.dataset.def}/default`); });
  box.querySelectorAll("[data-up]").forEach((b) => { b.onclick = () => { kind = b.dataset.up; file.value = ""; file.click(); }; });
  file.onchange = async () => {
    if (!file.files[0]) return;
    const fd = new FormData();
    fd.append("file", file.files[0]);
    try {
      const r = await api(`/assistant/settings/templates/${kind}`, { method: "POST", body: fd });
      toast(`Шаблон загружен. Метки в нём: ${r.tags.join(", ") || "нет"}`);
      asstSettingsTemplates(box);
    } catch (e) { toast(e.message, true); }
  };
  box.querySelectorAll("[data-reset]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Вернуть встроенный шаблон? Загруженный будет удалён.")) return;
      try { await api(`/assistant/settings/templates/${b.dataset.reset}`, { method: "DELETE" }); asstSettingsTemplates(box); } catch (e) { toast(e.message, true); }
    };
  });
}
