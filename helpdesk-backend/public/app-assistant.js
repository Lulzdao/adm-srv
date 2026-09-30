// ====== Ассистент ======
//
// Замена прежним «Ассистенту» и «Почтальону»: системы отдела, заявки на доступ
// сотрудника, передача оборудования, журнал техники и акты, рассылки
// респондентам. Раздел видят все; «Настройки» — только администраторы (и
// проверяет это сервер, а не только меню).
//
// Файлы раздела: этот — оболочка, системы, заявка на доступ, передача и
// настройки; app-journal.js — журнал техники и акты; app-mailings.js — рассылки.
//
// Всё, что пришло из базы, — в разметку только через esc().

const ASSISTANT_VIEWS = [
  { id: "asst:home", label: "Системы отдела", icon: "link" },
  { id: "asst:access", label: "Заявка на доступ", icon: "key" },
  { id: "asst:transfer", label: "Передача техники", icon: "box" },
  { id: "asst:journal", label: "Журнал техники", icon: "monitor" },
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
  if (sub === "home") return renderAsstHome(main);
  if (sub === "access") return renderAsstAccess(main);
  if (sub === "transfer") return renderAsstTransfer(main);
  if (sub === "journal") return renderAsstJournal(main);
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

/**
 * Поле с подсказками из базы (техника, запчасти): печатаешь — под полем
 * список, щелчок по строке вызывает onPick. Своё значение ввести тоже можно.
 */
function asstAutocomplete(input, fetchItems, renderItem, onPick) {
  const box = document.createElement("div");
  box.className = "as-ac";
  box.hidden = true;
  input.parentNode.style.position = "relative";
  input.parentNode.appendChild(box);
  let timer, items = [], active = -1;
  const hide = () => { box.hidden = true; active = -1; };
  const paint = () => {
    box.innerHTML = items.length
      ? items.map((it, i) => `<div class="as-ac-row${i === active ? " on" : ""}" data-i="${i}">${renderItem(it)}</div>`).join("")
      : `<div class="as-ac-empty">В базе не найдено — можно вписать вручную</div>`;
    box.hidden = false;
    box.querySelectorAll(".as-ac-row").forEach((r) => {
      r.onmousedown = (e) => { e.preventDefault(); onPick(items[Number(r.dataset.i)]); hide(); };
    });
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      try { items = await fetchItems(q); } catch { items = []; }
      active = -1;
      if (document.activeElement === input) paint();
    }, 200);
  });
  input.addEventListener("keydown", (e) => {
    if (box.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); onPick(items[active]); hide(); }
    else if (e.key === "Escape") hide();
  });
  input.addEventListener("blur", () => setTimeout(hide, 120));
}

// ---- Системы отдела ----------------------------------------------------------

async function renderAsstHome(main) {
  const isAdmin = state.user.is_admin;
  main.innerHTML = `
    ${asstTopbar("Ассистент", isAdmin ? `<button class="btn btn-ghost" id="asHomeAll">Показать все плитки</button>` : "")}
    <div class="page">
      <div class="as-sec">Системы вашего отдела</div>
      <div class="as-tiles" id="asTiles"><div class="spinner">Загрузка…</div></div>
      <div class="as-sec" style="margin-top:28px">Что сделать</div>
      <div class="as-quick">
        ${[
          ["asst:access", "key", "Заявка на доступ", "Регистрация, блокировка, восстановление учётной записи сотрудника"],
          ["asst:transfer", "box", "Передача техники", "Заявка на передачу оборудования между отделами"],
          ["asst:journal", "monitor", "Журнал техники", "Картриджи и запчасти: что куда поставлено, остатки"],
          ["asst:acts", "receipt", "Акты", "Ремонт, списание оборудования, ведомость по картриджам"],
          ["asst:mail", "mail", "Рассылка", "Письма респондентам по списку — с отчётом о доставке"],
        ].map(([id, ic, t, h]) => `
          <button class="as-q" data-go="${id}"><span class="as-q-ic">${icon(ic, 20)}</span>
            <span><b>${t}</b><small>${h}</small></span></button>`).join("")}
      </div>
    </div>`;
  main.querySelectorAll("[data-go]").forEach((b) => { b.onclick = () => setView(b.dataset.go); });
  let all = false;
  const load = async () => {
    const tiles = main.querySelector("#asTiles");
    let links;
    try { links = (await api("/assistant/links" + (all ? "?all=1" : ""))).links; } catch (e) {
      tiles.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return;
    }
    if (!links.length) {
      tiles.innerHTML = `<div class="as-empty">${isAdmin
        ? `Плиток пока нет. Добавьте ссылки на системы в <a href="#asst:settings">настройках</a> — каждому отделу свой набор.`
        : "Администратор ещё не добавил ссылки на системы для вашего отдела."}</div>`;
      return;
    }
    tiles.innerHTML = links.map((l, i) => `
      <a class="as-tile" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
        <span class="as-tile-ic" style="background:${DEPT_FALLBACK_COLORS[i % DEPT_FALLBACK_COLORS.length]}">${esc(l.title.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase())}</span>
        <span class="as-tile-t">${esc(l.title)}</span>
        <span class="as-tile-h">${esc(l.hint || l.url.replace(/^https?:\/\//, ""))}</span>
        ${l.shared ? "" : `<span class="as-tile-tag">отдел</span>`}
      </a>`).join("");
  };
  const allBtn = main.querySelector("#asHomeAll");
  if (allBtn) allBtn.onclick = () => { all = !all; allBtn.textContent = all ? "Только мои" : "Показать все плитки"; load(); };
  load();
}

// ---- Заявка на доступ -------------------------------------------------------

async function renderAsstAccess(main) {
  main.innerHTML = `${asstTopbar("Заявка на доступ")}<div class="page"><div class="spinner">Загрузка…</div></div>`;
  let refs;
  try { refs = await asstRefs(true); } catch (e) { main.querySelector(".page").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  let type = "register";
  const needsAccess = () => ["register", "edit", "restore"].includes(type);

  main.querySelector(".page").innerHTML = `
    <div class="form-narrow">
      <div class="form-card">
        <div class="form-card-title">Что нужно сделать</div>
        <div class="form-card-sub">Заявка уйдёт в отдел ИТ обычной заявкой: её статус и переписка — в «Мои заявки»</div>
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
            <input class="field-input" id="acDept" list="acDepts" maxlength="150" value="${esc(refs.myDepartment)}">
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
        <input class="field-input" id="acCsod" maxlength="1000" placeholder="напр. 1-Т, П-1, П-4">
      </div>
      <div class="form-card">
        <div class="field-label">Комментарий</div>
        <textarea class="field-input" id="acComment" rows="3" maxlength="1000" style="resize:vertical;margin-bottom:0" placeholder="С какой даты, чьи права скопировать, до какого числа блокировать…"></textarea>
      </div>
      <div class="form-foot">
        <div class="hint" id="acHint">После отправки можно скачать служебную записку для подписи начальника отдела</div>
        <div class="actions"><button class="btn btn-wire" id="acSend">Отправить в ИТ</button></div>
      </div>
      <div id="acDone"></div>
    </div>`;

  const $ = (id) => main.querySelector("#" + id);
  const syncType = () => {
    main.querySelectorAll("#acType .prio-chip").forEach((b) => b.classList.toggle("active", b.dataset.t === type));
    $("acAccessCard").hidden = !needsAccess();
    $("acPostStar").hidden = type !== "register";
  };
  main.querySelectorAll("#acType .prio-chip").forEach((b) => { b.onclick = () => { type = b.dataset.t; syncType(); }; });
  syncType();

  $("acSend").onclick = async () => {
    const body = {
      type, last_name: $("acLast").value, first_name: $("acFirst").value, middle_name: $("acMiddle").value,
      post: $("acPost").value, department: $("acDept").value, room: $("acRoom").value,
      phone_int: $("acInt").value, phone_ext: $("acExt").value, phone_mobile: $("acMob").value,
      programs: needsAccess() ? [...main.querySelectorAll("#acProgs input:checked")].map((c) => c.value) : [],
      csod_forms: needsAccess() ? $("acCsod").value : "", comment: $("acComment").value,
    };
    const required = [["acLast", body.last_name], ["acFirst", body.first_name], ["acDept", body.department]];
    if (type === "register") required.push(["acPost", body.post]);
    let bad = false;
    for (const [id, v] of required) { const miss = !String(v).trim(); $(id).classList.toggle("invalid", miss); bad = bad || miss; }
    $("acHint").classList.toggle("invalid", bad);
    if (bad) { $("acHint").textContent = "Заполните отмеченные поля"; return; }
    $("acHint").textContent = "После отправки можно скачать служебную записку для подписи начальника отдела";
    $("acSend").disabled = true;
    try {
      const { ticket } = await api("/assistant/access", { method: "POST", body });
      toast(`Заявка ${ticket.display_id} отправлена в ИТ`);
      $("acDone").innerHTML = `
        <div class="as-done">
          <span class="as-done-ic">${icon("check", 18)}</span>
          <div><b>Заявка ${esc(ticket.display_id)} отправлена</b><small>Служебную записку распечатайте и подпишите у начальника отдела</small></div>
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
    } finally {
      $("acSend").disabled = false;
    }
  };
}

/** Анкета в карточке заявки (заявка на доступ из Ассистента). */
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

// ---- Передача техники ---------------------------------------------------------

async function renderAsstTransfer(main) {
  main.innerHTML = `${asstTopbar("Передача техники")}<div class="page"><div class="spinner">Загрузка…</div></div>`;
  let refs;
  try { refs = await asstRefs(true); } catch (e) { main.querySelector(".page").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const items = [];
  const deptOptions = (sel) => `<option value="">— выберите отдел —</option>` + refs.depts.map((d) => `<option ${d.name === sel ? "selected" : ""}>${esc(d.name)}</option>`).join("");
  const mine = refs.depts.some((d) => d.name === refs.myDepartment) ? refs.myDepartment : "";

  main.querySelector(".page").innerHTML = `
    <div class="as-cols">
      <div>
        ${refs.depts.length ? "" : `<div class="warn-box">Справочник отделов пуст — ${state.user.is_admin ? `заполните его в <a href="#asst:settings">настройках</a>` : "попросите администратора заполнить его"}: без начальников отделов заявку не собрать.</div>`}
        <div class="form-card">
          <div class="form-row" style="margin-bottom:0">
            <div><div class="field-label">От кого (отдел)</div><select id="trFrom" class="field-select">${deptOptions(mine)}</select></div>
            <div><div class="field-label">Кому (отдел)</div><select id="trTo" class="field-select">${deptOptions("")}</select></div>
          </div>
        </div>
        <div class="form-card">
          <div class="form-card-title">Оборудование на передачу</div>
          <div class="form-card-sub">Начните вводить название или инвентарный номер — подскажу из базы техники</div>
          <div class="as-add-row">
            <div style="flex:1"><input class="field-input" id="trName" placeholder="Название или инвентарный номер" style="margin-bottom:0"></div>
            <input class="field-input" id="trInv" placeholder="Инв. №" style="width:150px;margin-bottom:0">
            <input class="field-input" id="trCount" type="number" min="1" value="1" style="width:80px;margin-bottom:0" title="Количество">
            <button class="btn btn-ghost" id="trAdd">${icon("plus", 15)} Добавить</button>
          </div>
          <div id="trItems" style="margin-top:14px"></div>
        </div>
        <div class="form-foot">
          <div class="hint" id="trHint">Заявку распечатайте: её подписывают оба начальника и согласует заместитель руководителя</div>
          <div class="actions"><button class="btn btn-wire" id="trSave">${icon("download", 15)} Сформировать</button></div>
        </div>
      </div>
      <div>
        <div class="as-sec">Последние заявки</div>
        <div id="trList"><div class="spinner">Загрузка…</div></div>
      </div>
    </div>`;

  const $ = (id) => main.querySelector("#" + id);
  const paint = () => {
    $("trItems").innerHTML = items.length ? `
      <div class="as-table-wrap"><table class="as-table"><thead><tr><th>№</th><th>Наименование</th><th>Инв. №</th><th>Кол-во</th><th></th></tr></thead><tbody>
      ${items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.name)}</td><td class="mono">${esc(it.inv || "—")}</td><td>${it.count}</td>
        <td><button class="as-icon-btn" data-del="${i}" title="Убрать">${icon("x", 14)}</button></td></tr>`).join("")}
      </tbody></table></div></div>` : `<div class="as-empty">Список пуст</div>`;
    $("trItems").querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => { items.splice(Number(b.dataset.del), 1); paint(); }; });
  };
  paint();
  const add = (it) => {
    if (it.inv && items.some((x) => x.inv === it.inv)) { toast("Позиция уже внесена в список", true); return; }
    items.push(it);
    $("trName").value = ""; $("trInv").value = ""; $("trCount").value = 1;
    paint();
  };
  asstAutocomplete($("trName"),
    async (q) => (await api("/assistant/equipment?q=" + encodeURIComponent(q))).items,
    (it) => `<b>${esc(it.name)}</b><small>инв. № ${esc(it.inv || "—")}${it.commissioned ? ` · с ${esc(it.commissioned)}` : ""}</small>`,
    (it) => add({ name: it.name, inv: it.inv || "", count: it.count || 1 }));
  $("trAdd").onclick = () => {
    const name = $("trName").value.trim();
    if (!name) { $("trName").classList.add("invalid"); return; }
    $("trName").classList.remove("invalid");
    add({ name, inv: $("trInv").value.trim(), count: Math.max(1, Number($("trCount").value) || 1) });
  };

  $("trSave").onclick = async () => {
    if (!items.length) { toast("Добавьте оборудование на передачу", true); return; }
    $("trSave").disabled = true;
    try {
      const r = await api("/assistant/transfers", { method: "POST", body: { from_dept: $("trFrom").value, to_dept: $("trTo").value, items } });
      toast(`Заявка № ${r.num} сформирована`);
      asstDownload(`/assistant/transfers/${r.id}/doc`);
      items.length = 0; paint(); loadList();
    } catch (e) { toast(e.message, true); } finally { $("trSave").disabled = false; }
  };

  async function loadList() {
    let list;
    try { list = (await api("/assistant/transfers")).transfers; } catch (e) { $("trList").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
    if (!main.querySelector("#trList")) return;
    $("trList").innerHTML = list.length ? list.slice(0, 30).map((t) => `
      <div class="as-li">
        <div class="as-li-main"><b>№ ${t.num} от ${esc(fmtDate(t.created_at).slice(0, 10))}</b>
          <small>${esc(t.from_dept)} → ${esc(t.to_dept)} · ${t.items.length} поз. · ${esc(t.author)}</small></div>
        <button class="as-icon-btn" data-doc="${t.id}" title="Скачать">${icon("download", 15)}</button>
        ${t.created_by === state.user.id || state.user.is_admin ? `<button class="as-icon-btn" data-rm="${t.id}" title="Удалить">${icon("trash", 15)}</button>` : ""}
      </div>`).join("") : `<div class="as-empty">Заявок пока нет</div>`;
    $("trList").querySelectorAll("[data-doc]").forEach((b) => { b.onclick = () => asstDownload(`/assistant/transfers/${b.dataset.doc}/doc`); });
    $("trList").querySelectorAll("[data-rm]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Удалить заявку на передачу?")) return;
        try { await api(`/assistant/transfers/${b.dataset.rm}`, { method: "DELETE" }); loadList(); } catch (e) { toast(e.message, true); }
      };
    });
  }
  loadList();
}

// ---- Настройки (администратор) ----------------------------------------------

const ASST_SETTINGS_TABS = [
  ["general", "Общие"], ["depts", "Отделы"], ["people", "Люди в документах"], ["links", "Системы"],
  ["rules", "Неисправности"], ["templates", "Шаблоны"], ["imports", "Базы из 1С"], ["mail", "Почта рассылок"],
];
let asstSettingsTab = "general";

// Справочники — одна форма на все: поле, подпись, подсказка.
const ASST_DICTS = {
  depts: {
    title: "Отделы и начальники", add: "Добавить отдел",
    sub: "Падежи ФИО нужны документам: «прошу передать начальнику отдела … Иванову И.И. от начальника отдела … Петрова П.П.». Должность и склонение названия отдела подставляются сами",
    cols: [["name", "Отдел"], ["chief_name", "Начальник"], ["sort", "Порядок"]],
    fields: [
      ["name", "Название отдела *", "Отдел статистики цен"],
      ["chief_name", "Начальник (Фамилия И.О.)", "Иванов И.И."], ["chief_name_gen", "Начальник — кого?", "Иванова И.И."], ["chief_name_dat", "Начальник — кому?", "Иванову И.И."],
      ["sort", "Порядок", "0"],
    ],
  },
  people: {
    title: "Люди в документах", add: "Добавить",
    sub: "Руководитель — в шапке «кому» и в «УТВЕРЖДАЮ»; начальник ОИРиТ подписывает акты; составители выбираются при составлении акта",
    cols: [["role", "Роль"], ["name", "Фамилия И.О."], ["post", "Должность"]],
    fields: [
      ["role", "Роль *", "", "role"], ["name", "Фамилия И.О. *", "Иванов И.И."], ["name_dat", "Фамилия И.О. — кому?", "Иванову И.И."],
      ["post", "Должность", "Руководитель"], ["post_dat", "Должность — кому?", "Руководителю"], ["sort", "Порядок", "0"],
    ],
  },
  links: {
    title: "Системы отдела", add: "Добавить систему",
    sub: "Плитки на первой странице Ассистента. Без отделов плитку видят все; с отделами — только сотрудники этих отделов (название — как в AD)",
    cols: [["title", "Название"], ["url", "Адрес"], ["departments", "Отделы"]],
    fields: [
      ["title", "Название *", "АРМ ГС"], ["url", "Адрес *", "http://…"], ["hint", "Подпись под названием", ""],
      ["departments", "Отделы — по одному на строку", "", "depts"], ["sort", "Порядок", "0"],
    ],
  },
  rules: {
    title: "Типовые неисправности", add: "Добавить",
    sub: "Подсказки для актов на ремонт: если в названии техники есть одно из слов, в акт подставятся эти тексты (их можно поправить)",
    cols: [["title", "Вид техники"], ["keywords", "Слова"], ["defect", "Неисправность"]],
    fields: [
      ["title", "Вид техники *", "Принтер"], ["keywords", "Слова в названии (через запятую)", "принтер, мфу, laserjet"],
      ["defect", "Неисправность", "", "text"], ["repair_works", "Работы", "", "text"], ["remains", "Что остаётся после ремонта", ""], ["sort", "Порядок", "0"],
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
    let general = null;
    if (["general", "people", "links"].includes(asstSettingsTab)) general = await api("/assistant/settings/general");
    if (asstSettingsTab === "general") return asstSettingsGeneral(box, general);
    if (asstSettingsTab === "rules") {
      box.innerHTML = `<div id="asD1"></div><div id="asD2" style="margin-top:28px"></div>`;
      await asstDictEditor(box.querySelector("#asD1"), "rules", general);
      return asstDictEditor(box.querySelector("#asD2"), "reasons", general);
    }
    if (ASST_DICTS[asstSettingsTab]) return asstDictEditor(box, asstSettingsTab, general);
    if (asstSettingsTab === "templates") return asstSettingsTemplates(box);
    if (asstSettingsTab === "imports") return asstSettingsImports(box);
    if (asstSettingsTab === "mail") return mailSettingsTab(box);
  } catch (e) {
    box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

function asstSettingsGeneral(box, g) {
  box.innerHTML = `
    <div class="form-narrow" style="margin:0;max-width:760px">
      <div class="form-card">
        <div class="form-row">
          <div><div class="field-label">Организация — как в документах</div><input class="field-input" id="gOrg" value="${esc(g.orgName)}"></div>
          <div><div class="field-label">Куда идут заявки на доступ</div>
            <select id="gDept" class="field-select">${g.accessDepts.map((d) => `<option ${d === (g.accessDept || g.accessDepts[0]) ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
        </div>
        <div class="form-row">
          <div><div class="field-label">Программы для заявки на доступ — по одной на строку</div>
            <textarea class="field-input" id="gProgs" rows="9" style="resize:vertical">${esc(g.programs.join("\n"))}</textarea></div>
          <div><div class="field-label">Должности — по одной на строку</div>
            <textarea class="field-input" id="gPosts" rows="9" style="resize:vertical">${esc(g.posts.join("\n"))}</textarea></div>
        </div>
        <div class="form-row" style="margin-bottom:0">
          <div><div class="field-label">Первый номер акта в ${g.year} году</div>
            <input class="field-input" id="gStart" type="number" min="1" value="${g.actStart}" style="max-width:160px;margin-bottom:4px">
            <div class="as-note">Если в этом году акты уже составлялись вне Ассистента, нумерация продолжится с этого номера</div></div>
        </div>
      </div>
      <div class="form-foot"><div class="actions"><button class="btn btn-wire" id="gSave">Сохранить</button></div></div>
    </div>`;
  const lines = (id) => box.querySelector(id).value.split("\n").map((x) => x.trim()).filter(Boolean);
  box.querySelector("#gSave").onclick = async () => {
    try {
      await api("/assistant/settings/general", { method: "PUT", body: {
        orgName: box.querySelector("#gOrg").value, accessDept: box.querySelector("#gDept").value,
        programs: lines("#gProgs"), posts: lines("#gPosts"), actStart: box.querySelector("#gStart").value,
      } });
      asstRefsCache = null;
      toast("Сохранено");
    } catch (e) { toast(e.message, true); }
  };
}

async function asstDictEditor(box, dictId, general) {
  const d = ASST_DICTS[dictId];
  const { items } = await api(`/assistant/settings/dict/${dictId}`);
  const roles = (general && general.roles) || {};
  const cell = (it, key) => key === "role" ? esc(roles[it.role] || it.role)
    : key === "departments" ? (it.departments.trim() ? esc(it.departments.split("\n").filter(Boolean).join(", ")) : `<span class="as-muted">все отделы</span>`)
    : esc(it[key] === null || it[key] === undefined || it[key] === "" ? "—" : it[key]);
  box.innerHTML = `
    <div class="as-dict-head"><div><div class="as-h">${esc(d.title)}</div><div class="as-note">${esc(d.sub)}</div></div>
      <button class="btn btn-ghost" data-add>${icon("plus", 15)} ${esc(d.add)}</button></div>
    ${items.length ? `<div class="as-table-wrap"><table class="as-table as-click"><thead><tr>${d.cols.map(([, l]) => `<th>${esc(l)}</th>`).join("")}<th></th></tr></thead><tbody>
      ${items.map((it) => `<tr data-id="${it.id}">${d.cols.map(([k]) => `<td class="${k === "url" ? "mono" : ""}">${cell(it, k)}</td>`).join("")}
        <td class="as-row-act"><button class="as-icon-btn" data-rm="${it.id}" title="Удалить">${icon("trash", 14)}</button></td></tr>`).join("")}
      </tbody></table></div></div>` : `<div class="as-empty">Пока пусто</div>`}`;
  const reload = () => asstDictEditor(box, dictId, general);
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
    if (kind === "text" || kind === "depts") {
      return `<div class="as-f wide"><div class="field-label">${esc(label)}</div>
        <textarea class="field-input" data-k="${k}" rows="${kind === "depts" ? 4 : 3}" placeholder="${esc(ph)}" style="resize:vertical">${esc(v(k))}</textarea>
        ${kind === "depts" && general.adDepartments.length ? `<div class="as-note">Отделы из AD (щелчок — добавить):</div>
          <div class="as-chips">${general.adDepartments.map((x) => `<button type="button" class="as-chip" data-dep="${esc(x)}">${esc(x)}</button>`).join("")}</div>` : ""}</div>`;
    }
    return `<div class="as-f${k === "sort" ? " small" : ""}"><div class="field-label">${esc(label)}</div>
      <input class="field-input" data-k="${k}" value="${esc(v(k))}" placeholder="${esc(ph)}" ${k === "sort" ? 'type="number"' : ""}></div>`;
  };
  const m = asstModal(item ? "Правка" : d.add, `
    <div class="as-grid">${d.fields.map(field).join("")}</div>
    <div class="td-form-foot"><span class="td-form-err" id="dfErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>Сохранить</button></div>`, { wide: d.fields.length > 5 });
  m.el.querySelectorAll("[data-dep]").forEach((b) => {
    b.onclick = () => {
      const ta = m.el.querySelector('[data-k="departments"]');
      const have = ta.value.split("\n").map((x) => x.trim()).filter(Boolean);
      if (!have.includes(b.dataset.dep)) ta.value = [...have, b.dataset.dep].join("\n");
    };
  });
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

async function asstSettingsImports(box) {
  const info = await api("/assistant/settings/imports");
  const card = (key, title, file, sub) => {
    const i = info[key];
    return `
      <div class="as-imp">
        <div class="as-imp-ic">${icon(key === "equipment" ? "monitor" : "box", 22)}</div>
        <div class="as-imp-main">
          <div class="as-h">${title}</div>
          <div class="as-note">${sub}</div>
          <div class="as-imp-stat">${i.count ? `<b>${i.count}</b> записей · загружено ${esc(fmtDate(i.at ? i.at.replace("T", " ").slice(0, 19) : ""))}${i.by ? ` · ${esc(i.by)}` : ""}${i.file ? ` · ${esc(i.file)}` : ""}` : "База пуста"}</div>
        </div>
        <button class="btn btn-wire" data-imp="${key}">${icon("upload", 15)} Загрузить ${file}</button>
      </div>`;
  };
  box.innerHTML = `
    ${card("equipment", "База техники", "tec.txt", "Выгрузка из 1С: наименование, инвентарный номер, дата ввода, количество. Нужна для передачи техники, журнала и актов на списание")}
    ${card("parts", "База запчастей и расходников", "rep.txt", "Выгрузка из 1С: наименование, местонахождение, номенклатурный номер, остаток. Остатки в журнале считаются от неё")}
    <div class="as-note" style="margin-top:8px">Каждая загрузка заменяет базу целиком — источник правды 1С. Записи журнала при этом не меняются.</div>
    <input type="file" id="impFile" accept=".txt,.csv" hidden>`;
  let kind = null;
  const file = box.querySelector("#impFile");
  box.querySelectorAll("[data-imp]").forEach((b) => { b.onclick = () => { kind = b.dataset.imp; file.value = ""; file.click(); }; });
  file.onchange = async () => {
    if (!file.files[0]) return;
    const fd = new FormData();
    fd.append("file", file.files[0]);
    try {
      const r = await api(`/assistant/settings/imports/${kind}`, { method: "POST", body: fd });
      toast(`Загружено записей: ${r.count}`);
      asstSettingsImports(box);
    } catch (e) { toast(e.message, true); }
  };
}
