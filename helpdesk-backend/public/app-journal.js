// ====== Ассистент: журнал техники и акты ======
//
// Журнал — что из расходников и запчастей куда поставлено. Отмеченные
// записи с запчастями превращаются в акты на ремонт, картриджи за месяц — в
// ведомость. Вкладка «Остатки» — выгрузка из 1С минус поставленное после неё.

const journalUi = { tab: "journal", kind: "", from: "", to: "", q: "", free: false };
const JOURNAL_KIND = { cartridge: "Картридж", part: "Запчасть" };

async function renderAsstJournal(main) {
  main.innerHTML = `
    ${asstTopbar("Журнал техники", `
      <div class="toggle-group" id="jTab">
        <button class="toggle-btn${journalUi.tab === "journal" ? " active" : ""}" data-tab="journal">Журнал</button>
        <button class="toggle-btn${journalUi.tab === "stock" ? " active" : ""}" data-tab="stock">Остатки</button>
      </div>`)}
    <div class="page" id="jPage"></div>`;
  main.querySelectorAll("#jTab .toggle-btn").forEach((b) => { b.onclick = () => { journalUi.tab = b.dataset.tab; renderAsstJournal(main); }; });
  if (journalUi.tab === "stock") return renderStock(main.querySelector("#jPage"));
  renderJournalTab(main.querySelector("#jPage"));
}

function renderJournalTab(page) {
  page.innerHTML = `
    <div class="filters-row">
      <div class="toggle-group" id="jKind">
        ${[["", "Всё"], ["cartridge", "Картриджи"], ["part", "Запчасти"]].map(([id, l]) => `<button class="toggle-btn${journalUi.kind === id ? " active" : ""}" data-k="${id}">${l}</button>`).join("")}
      </div>
      <label class="as-inline">с <input type="date" class="as-date" id="jFrom" value="${esc(journalUi.from)}"></label>
      <label class="as-inline">по <input type="date" class="as-date" id="jTo" value="${esc(journalUi.to)}"></label>
      <label class="as-check"><input type="checkbox" id="jFree" ${journalUi.free ? "checked" : ""}><span>без акта</span></label>
      <div class="search-wrap"><span class="search-icon">${icon("search", 15)}</span><input id="jQ" placeholder="Поиск" value="${esc(journalUi.q)}" style="width:220px"></div>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-ghost" id="jExport">${icon("download", 15)} Excel</button>
        <button class="btn btn-wire" id="jAdd">${icon("plus", 15)} Запись</button>
      </span>
    </div>
    <div class="as-selbar" id="jSel" hidden></div>
    <div id="jList"><div class="spinner">Загрузка…</div></div>`;
  const $ = (id) => page.querySelector("#" + id);
  page.querySelectorAll("#jKind .toggle-btn").forEach((b) => { b.onclick = () => { journalUi.kind = b.dataset.k; renderJournalTab(page); }; });
  $("jFrom").onchange = () => { journalUi.from = $("jFrom").value; load(); };
  $("jTo").onchange = () => { journalUi.to = $("jTo").value; load(); };
  $("jFree").onchange = () => { journalUi.free = $("jFree").checked; load(); };
  let t;
  $("jQ").oninput = () => { journalUi.q = $("jQ").value; clearTimeout(t); t = setTimeout(load, 250); };
  const params = () => {
    const p = new URLSearchParams();
    if (journalUi.kind) p.set("kind", journalUi.kind);
    if (journalUi.from) p.set("from", journalUi.from);
    if (journalUi.to) p.set("to", journalUi.to);
    if (journalUi.free) p.set("free", "1");
    if (journalUi.q.trim()) p.set("q", journalUi.q.trim());
    return p.toString();
  };
  $("jExport").onclick = () => asstDownload("/assistant/journal/export?" + params());
  $("jAdd").onclick = () => journalForm(null, load);

  const selected = new Set();
  let entries = [];
  const paintSel = () => {
    const bar = $("jSel");
    const picked = entries.filter((e) => selected.has(e.id));
    if (!picked.length) { bar.hidden = true; return; }
    const parts = picked.filter((e) => e.kind === "part").length;
    bar.hidden = false;
    bar.innerHTML = `<b>Выбрано: ${picked.length}</b>
      ${parts === picked.length ? `<button class="btn btn-wire as-btn-sm" id="jRepair">${icon("receipt", 14)} Составить акты на ремонт</button>`
        : `<span class="as-note">Акты на ремонт — только по запчастям. Картриджи идут в ведомость за месяц (раздел «Акты»).</span>`}
      <button class="btn btn-text as-btn-sm" id="jClear">Снять выбор</button>`;
    const rep = bar.querySelector("#jRepair");
    if (rep) rep.onclick = () => repairActDialog([...selected], () => { selected.clear(); load(); });
    bar.querySelector("#jClear").onclick = () => { selected.clear(); page.querySelectorAll(".j-cb").forEach((c) => { c.checked = false; }); paintSel(); };
  };

  async function load() {
    let data;
    try { data = await api("/assistant/journal?" + params()); } catch (e) { $("jList").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
    if (!page.isConnected) return;
    entries = data.entries;
    for (const id of [...selected]) if (!entries.some((e) => e.id === id && !e.act_id)) selected.delete(id);
    if (!entries.length) {
      $("jList").innerHTML = `<div class="empty-state">${journalUi.q || journalUi.from || journalUi.to || journalUi.kind || journalUi.free ? "Ничего не найдено." : "Записей пока нет. Первая — кнопкой «Запись»."}</div>`;
      paintSel();
      return;
    }
    const me = state.user;
    $("jList").innerHTML = `
      <div class="as-table-wrap"><table class="as-table">
        <thead><tr><th style="width:28px"></th><th>Дата</th><th>Что поставлено</th><th>Кол-во</th><th>Куда</th><th>Отдел / кабинет</th><th>Акт</th><th>Записал</th><th></th></tr></thead>
        <tbody>${entries.map((e) => `
          <tr>
            <td>${e.act_id ? "" : `<input type="checkbox" class="j-cb" data-id="${e.id}" ${selected.has(e.id) ? "checked" : ""}>`}</td>
            <td class="nowrap">${esc(asstRuDate(e.date))}</td>
            <td><span class="as-badge ${e.kind === "cartridge" ? "violet" : "blue"}">${JOURNAL_KIND[e.kind]}</span> ${esc(e.part_name)}
              ${e.nomenclature ? `<div class="as-sub mono">${esc(e.nomenclature)}</div>` : ""}${e.note ? `<div class="as-sub">${esc(e.note)}</div>` : ""}</td>
            <td>${e.count}</td>
            <td>${esc(e.equipment || "—")}${e.inv ? `<div class="as-sub mono">инв. № ${esc(e.inv)}</div>` : ""}</td>
            <td>${esc(e.location || "—")}</td>
            <td class="nowrap">${e.act_id ? `<a href="#asst:acts" class="as-badge green">№ ${e.act_num}/${e.act_year}</a>` : `<span class="as-muted">—</span>`}</td>
            <td class="as-sub">${esc(e.author)}</td>
            <td class="as-row-act">${!e.act_id && (me.is_admin || e.created_by === me.id) ? `
              <button class="as-icon-btn" data-edit="${e.id}" title="Править">${icon("edit", 14)}</button>
              <button class="as-icon-btn" data-rm="${e.id}" title="Удалить">${icon("trash", 14)}</button>` : ""}</td>
          </tr>`).join("")}</tbody>
      </table></div>
      ${data.total > entries.length ? `<div class="as-note" style="margin-top:10px">Показаны ${entries.length} из ${data.total} — уточните период или поиск; в Excel выгружаются все.</div>` : ""}`;
    $("jList").querySelectorAll(".j-cb").forEach((c) => {
      c.onchange = () => { const id = Number(c.dataset.id); if (c.checked) selected.add(id); else selected.delete(id); paintSel(); };
    });
    $("jList").querySelectorAll("[data-edit]").forEach((b) => { b.onclick = () => journalForm(entries.find((x) => x.id === Number(b.dataset.edit)), load); });
    $("jList").querySelectorAll("[data-rm]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Удалить запись журнала?")) return;
        try { await api(`/assistant/journal/${b.dataset.rm}`, { method: "DELETE" }); load(); } catch (e) { toast(e.message, true); }
      };
    });
    paintSel();
  }
  load();
}

async function journalForm(entry, onSaved) {
  let refs = { depts: [] };
  try { refs = await asstRefs(); } catch { /* подсказки отделов — не обязательны */ }
  let kind = entry ? entry.kind : "cartridge";
  const v = (k, d = "") => (entry && entry[k] !== null && entry[k] !== undefined ? entry[k] : d);
  const m = asstModal(entry ? "Правка записи" : "Новая запись журнала", `
    <div class="as-grid">
      <div class="as-f"><div class="field-label">Дата</div><input type="date" class="field-input" id="jfDate" value="${esc(v("date", asstToday()))}"></div>
      <div class="as-f"><div class="field-label">Что поставлено</div>
        <div class="toggle-group" id="jfKind">${Object.entries(JOURNAL_KIND).map(([id, l]) => `<button type="button" class="toggle-btn${id === kind ? " active" : ""}" data-k="${id}">${l}</button>`).join("")}</div></div>
      <div class="as-f wide"><div class="field-label">Наименование * <span class="as-muted">— подсказки из базы запчастей</span></div>
        <input class="field-input" id="jfPart" value="${esc(v("part_name"))}" placeholder="Картридж, фьюзер, ролик…"></div>
      <div class="as-f"><div class="field-label">Номенклатурный номер</div><input class="field-input mono" id="jfNom" value="${esc(v("nomenclature"))}"></div>
      <div class="as-f small"><div class="field-label">Кол-во</div><input type="number" min="1" class="field-input" id="jfCount" value="${esc(v("count", 1))}"></div>
      <div class="as-f wide"><div class="field-label">Куда (техника) <span class="as-muted">— подсказки из базы техники</span></div>
        <input class="field-input" id="jfEq" value="${esc(v("equipment"))}" placeholder="Название или инвентарный номер"></div>
      <div class="as-f"><div class="field-label">Инвентарный номер</div><input class="field-input mono" id="jfInv" value="${esc(v("inv"))}"></div>
      <div class="as-f"><div class="field-label">Отдел / кабинет</div><input class="field-input" id="jfLoc" list="jfDepts" value="${esc(v("location"))}">
        <datalist id="jfDepts">${refs.depts.map((d) => `<option value="${esc(d.name)}">`).join("")}</datalist></div>
      <div class="as-f wide"><div class="field-label">Примечание</div><input class="field-input" id="jfNote" value="${esc(v("note"))}"></div>
    </div>
    <div class="td-form-foot"><span class="td-form-err" id="jfErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>Сохранить</button></div>`, { wide: true });
  const $ = (id) => m.el.querySelector("#" + id);
  m.el.querySelectorAll("#jfKind .toggle-btn").forEach((b) => {
    b.onclick = () => { kind = b.dataset.k; m.el.querySelectorAll("#jfKind .toggle-btn").forEach((x) => x.classList.toggle("active", x === b)); };
  });
  asstAutocomplete($("jfPart"),
    async (q) => (await api(`/assistant/parts?kind=${kind}&q=${encodeURIComponent(q)}`)).items,
    (p) => `<b>${esc(p.name)}</b><small>${esc(p.nomenclature || "без номера")} · остаток по 1С: ${p.count ?? "—"}</small>`,
    (p) => { $("jfPart").value = p.name; $("jfNom").value = p.nomenclature || ""; });
  asstAutocomplete($("jfEq"),
    async (q) => (await api("/assistant/equipment?q=" + encodeURIComponent(q))).items,
    (e) => `<b>${esc(e.name)}</b><small>инв. № ${esc(e.inv || "—")}</small>`,
    (e) => { $("jfEq").value = e.name; $("jfInv").value = e.inv || ""; });
  m.el.querySelector("[data-cancel]").onclick = m.close;
  m.el.querySelector("[data-save]").onclick = async () => {
    const body = {
      date: $("jfDate").value, kind, part_name: $("jfPart").value, nomenclature: $("jfNom").value, count: $("jfCount").value,
      equipment: $("jfEq").value, inv: $("jfInv").value, location: $("jfLoc").value, note: $("jfNote").value,
    };
    try {
      if (entry) await api(`/assistant/journal/${entry.id}`, { method: "PUT", body });
      else await api("/assistant/journal", { method: "POST", body });
      m.close();
      toast("Записано");
      onSaved();
    } catch (e) { $("jfErr").textContent = e.message; }
  };
}

function responsibleSelect(refs, id) {
  if (!refs.responsibles.length) {
    return `<div class="as-note">Составителей актов нет в справочнике — ${state.user.is_admin ? "добавьте их в настройках («Люди в документах»)" : "попросите администратора добавить"}; поле подписи останется пустым.</div>`;
  }
  return `<select id="${id}" class="field-select">${refs.responsibles.map((r) => `<option value="${r.id}">${esc(r.name)}${r.post ? ` — ${esc(r.post)}` : ""}</option>`).join("")}</select>`;
}

async function repairActDialog(ids, onDone) {
  let refs, groups;
  try {
    refs = await asstRefs(true);
    groups = (await api("/assistant/acts/repair/preview", { method: "POST", body: { entry_ids: ids } })).groups;
  } catch (e) { toast(e.message, true); return; }
  const m = asstModal("Акты на ремонт", `
    <div class="as-note" style="margin-bottom:14px">Будут составлены акт о неисправностях и акт о ремонте с одним номером. Тексты подставлены из справочника «Типовые неисправности» — поправьте, если нужно.</div>
    ${groups.map((g, i) => `
      <div class="as-group">
        <div class="as-h">${esc(g.name || "Техника без названия")}${g.inv ? ` <span class="as-muted mono">инв. № ${esc(g.inv)}</span>` : ""}</div>
        <div class="as-note">${g.entries.map((e) => `${esc(e.part_name)} × ${e.count}`).join(", ")}${g.rule ? ` · правило «${esc(g.rule)}»` : " · правило не нашлось"}</div>
        <div class="as-grid" style="margin-top:10px">
          <div class="as-f wide"><div class="field-label">Неисправность *</div><textarea class="field-input" rows="2" data-g="${i}" data-k="defect">${esc(g.defect)}</textarea></div>
          <div class="as-f wide"><div class="field-label">Работы *</div><textarea class="field-input" rows="2" data-g="${i}" data-k="repair_works">${esc(g.repair_works)}</textarea></div>
          <div class="as-f wide"><div class="field-label">Что остаётся после ремонта</div><input class="field-input" data-g="${i}" data-k="remains" value="${esc(g.remains)}"></div>
        </div>
      </div>`).join("")}
    <div class="as-grid">
      <div class="as-f"><div class="field-label">Дата актов</div><input type="date" class="field-input" id="raDate" value="${asstToday()}"></div>
      <div class="as-f"><div class="field-label">Составил</div>${responsibleSelect(refs, "raResp")}</div>
      <div class="as-f wide"><label class="as-check"><input type="checkbox" id="raMemo"><span>Добавить служебную записку на запчасти</span></label></div>
    </div>
    <div class="td-form-foot"><span class="td-form-err" id="raErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>${icon("download", 15)} Составить и скачать</button></div>`, { wide: true });
  m.el.querySelector("[data-cancel]").onclick = m.close;
  m.el.querySelector("[data-save]").onclick = async () => {
    const texts = groups.map((g) => ({ key: g.key }));
    m.el.querySelectorAll("[data-g]").forEach((el) => { texts[Number(el.dataset.g)][el.dataset.k] = el.value; });
    const resp = m.el.querySelector("#raResp");
    try {
      const r = await api("/assistant/acts/repair", { method: "POST", body: {
        entry_ids: ids, groups: texts, date: m.el.querySelector("#raDate").value,
        responsible_id: resp ? Number(resp.value) : null, with_memo: m.el.querySelector("#raMemo").checked,
      } });
      m.close();
      toast(`Акт № ${r.num} составлен`);
      asstDownload(`/assistant/acts/${r.id}/download`);
      onDone();
    } catch (e) { m.el.querySelector("#raErr").textContent = e.message; }
  };
}

async function renderStock(page) {
  const month = asstToday().slice(0, 7);
  page.innerHTML = `
    <div class="filters-row">
      <div class="search-wrap"><span class="search-icon">${icon("search", 15)}</span><input id="sQ" placeholder="Поиск по названию или номеру"></div>
      <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
        <label class="as-inline">Отчёт за <input type="month" class="as-date" id="sMonth" value="${month}"></label>
        <button class="btn btn-ghost" id="sReport">${icon("download", 15)} Отчёт об использовании</button>
      </span>
    </div>
    <div id="sList"><div class="spinner">Загрузка…</div></div>`;
  const $ = (id) => page.querySelector("#" + id);
  $("sReport").onclick = () => asstDownload("/assistant/stock/report?month=" + encodeURIComponent($("sMonth").value));
  let t;
  $("sQ").oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  async function load() {
    let data;
    try { data = await api("/assistant/stock?q=" + encodeURIComponent($("sQ").value.trim())); } catch (e) { $("sList").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
    if (!page.isConnected) return;
    if (!data.items.length) {
      $("sList").innerHTML = `<div class="empty-state">${$("sQ").value ? "Ничего не найдено." : `База запчастей пуста — её загружает администратор выгрузкой rep.txt из 1С.`}</div>`;
      return;
    }
    $("sList").innerHTML = `
      <div class="as-note" style="margin-bottom:10px">Остаток = количество по выгрузке из 1С минус поставленное по журналу начиная с ${esc(asstRuDate(data.since))} (день выгрузки).</div>
      <div class="as-table-wrap"><table class="as-table"><thead><tr><th>Наименование</th><th>Номенклатурный №</th><th class="num">По 1С</th><th class="num">Поставлено</th><th class="num">Остаток</th></tr></thead>
      <tbody>${data.items.map((p) => `<tr>
        <td>${p.cartridge ? `<span class="as-badge violet">картридж</span> ` : ""}${esc(p.name)}${p.location ? `<div class="as-sub">${esc(p.location)}</div>` : ""}</td>
        <td class="mono">${esc(p.nomenclature || "—")}</td><td class="num">${p.count ?? "—"}</td><td class="num">${p.used || ""}</td>
        <td class="num"><b class="${p.left <= 0 ? "as-red" : p.left <= 2 ? "as-warn" : ""}">${p.left}</b></td></tr>`).join("")}</tbody></table></div>
      ${data.total > data.items.length ? `<div class="as-note" style="margin-top:10px">Показаны ${data.items.length} из ${data.total} — уточните поиск.</div>` : ""}`;
  }
  load();
}

// ---- Акты ---------------------------------------------------------------------

let actsYear = null;

async function renderAsstActs(main) {
  main.innerHTML = `
    ${asstTopbar("Акты", `
      <button class="btn btn-ghost" id="aCart">${icon("receipt", 15)} Ведомость по картриджам</button>
      <button class="btn btn-ghost" id="aWo">${icon("trash", 15)} Акт на списание</button>`)}
    <div class="page">
      <div class="filters-row"><span id="aYears"></span><span class="as-note" style="margin-left:8px">Акты на ремонт составляются из журнала техники: отметьте записи с запчастями.</span></div>
      <div class="as-selbar" id="aSel" hidden></div>
      <div id="aList"><div class="spinner">Загрузка…</div></div>
    </div>`;
  const $ = (id) => main.querySelector("#" + id);
  $("aCart").onclick = () => cartridgesDialog(load);
  $("aWo").onclick = () => writeoffDialog(load);
  const selected = new Set();
  const paintSel = () => {
    const bar = $("aSel");
    if (!selected.size) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<b>Выбрано: ${selected.size}</b><button class="btn btn-wire as-btn-sm" id="aZip">${icon("download", 14)} Скачать архивом</button>`;
    bar.querySelector("#aZip").onclick = () => asstDownload("/assistant/acts/zip?ids=" + [...selected].join(","));
  };
  async function load() {
    let data;
    try { data = await api("/assistant/acts" + (actsYear ? `?year=${actsYear}` : "")); } catch (e) { $("aList").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
    if (!main.querySelector("#aList")) return;
    actsYear = data.year;
    const years = [...new Set([new Date().getFullYear(), ...data.years])].sort((a, b) => b - a);
    $("aYears").innerHTML = `<div class="toggle-group">${years.map((y) => `<button class="toggle-btn${y === data.year ? " active" : ""}" data-y="${y}">${y}</button>`).join("")}</div>`;
    $("aYears").querySelectorAll("[data-y]").forEach((b) => { b.onclick = () => { actsYear = Number(b.dataset.y); selected.clear(); paintSel(); load(); }; });
    if (!data.acts.length) { $("aList").innerHTML = `<div class="empty-state">В ${data.year} году актов ещё нет.</div>`; return; }
    $("aList").innerHTML = `
      <div class="as-table-wrap"><table class="as-table"><thead><tr><th style="width:28px"></th><th>№</th><th>Дата</th><th>Вид</th><th>Что</th><th>Составил</th><th></th></tr></thead>
      <tbody>${data.acts.map((a) => `<tr>
        <td><input type="checkbox" class="a-cb" data-id="${a.id}" ${selected.has(a.id) ? "checked" : ""}></td>
        <td><b>${a.num}</b></td><td class="nowrap">${esc(asstRuDate(a.date))}</td>
        <td><span class="as-badge ${a.type === "repair" ? "blue" : a.type === "cartridges" ? "violet" : "orange"}">${esc(a.typeLabel)}</span></td>
        <td>${esc(a.title)}${a.entries ? `<div class="as-sub">записей журнала: ${a.entries}</div>` : ""}</td>
        <td class="as-sub">${esc(a.author)}</td>
        <td class="as-row-act">
          <button class="as-icon-btn" data-dl="${a.id}" title="Скачать">${icon("download", 15)}</button>
          ${state.user.is_admin || a.created_by === state.user.id ? `<button class="as-icon-btn" data-rm="${a.id}" title="Удалить из реестра">${icon("trash", 14)}</button>` : ""}
        </td></tr>`).join("")}</tbody></table></div>`;
    $("aList").querySelectorAll(".a-cb").forEach((c) => {
      c.onchange = () => { const id = Number(c.dataset.id); if (c.checked) selected.add(id); else selected.delete(id); paintSel(); };
    });
    $("aList").querySelectorAll("[data-dl]").forEach((b) => { b.onclick = () => asstDownload(`/assistant/acts/${b.dataset.dl}/download`); });
    $("aList").querySelectorAll("[data-rm]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Удалить акт из реестра? Записи журнала снова станут доступны для актов.")) return;
        try { await api(`/assistant/acts/${b.dataset.rm}`, { method: "DELETE" }); selected.delete(Number(b.dataset.rm)); paintSel(); load(); } catch (e) { toast(e.message, true); }
      };
    });
  }
  load();
}

async function cartridgesDialog(onDone) {
  let refs;
  try { refs = await asstRefs(true); } catch (e) { toast(e.message, true); return; }
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() - (new Date().getDate() < 10 ? 1 : 0));
  const m = asstModal("Ведомость на списание картриджей", `
    <div class="as-note" style="margin-bottom:14px">В ведомость попадут все картриджи из журнала за месяц, по которым ведомости ещё не было. Будут и Word, и Excel.</div>
    <div class="as-grid">
      <div class="as-f"><div class="field-label">Месяц</div><input type="month" class="field-input" id="cmMonth" value="${d.getFullYear()}-${asstPad(d.getMonth() + 1)}"></div>
      <div class="as-f"><div class="field-label">Составил</div>${responsibleSelect(refs, "cmResp")}</div>
    </div>
    <div class="td-form-foot"><span class="td-form-err" id="cmErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>${icon("download", 15)} Составить</button></div>`);
  m.el.querySelector("[data-cancel]").onclick = m.close;
  m.el.querySelector("[data-save]").onclick = async () => {
    const resp = m.el.querySelector("#cmResp");
    try {
      const r = await api("/assistant/acts/cartridges", { method: "POST", body: { month: m.el.querySelector("#cmMonth").value, responsible_id: resp ? Number(resp.value) : null } });
      m.close();
      toast(`Ведомость № ${r.num} составлена`);
      asstDownload(`/assistant/acts/${r.id}/download`);
      onDone();
    } catch (e) { m.el.querySelector("#cmErr").textContent = e.message; }
  };
}

async function writeoffDialog(onDone) {
  let refs;
  try { refs = await asstRefs(true); } catch (e) { toast(e.message, true); return; }
  const m = asstModal("Акт на списание оборудования", `
    <div class="as-grid">
      <div class="as-f wide"><div class="field-label">Оборудование * <span class="as-muted">— подсказки из базы техники</span></div><input class="field-input" id="woName" placeholder="Название или инвентарный номер"></div>
      <div class="as-f"><div class="field-label">Инвентарный номер *</div><input class="field-input mono" id="woInv"></div>
      <div class="as-f"><div class="field-label">Введено в эксплуатацию</div><input class="field-input" id="woDate" placeholder="01.06.2016"></div>
      ${refs.reasons.length ? `<div class="as-f wide"><div class="field-label">Готовая причина</div>
        <div class="as-chips">${refs.reasons.map((r) => `<button type="button" class="as-chip" data-r="${r.id}">${esc(r.title)}</button>`).join("")}</div></div>` : ""}
      <div class="as-f wide"><div class="field-label">Выявленные недостатки *</div><textarea class="field-input" id="woReason" rows="3"></textarea></div>
      <div class="as-f"><div class="field-label">Дата акта</div><input type="date" class="field-input" id="woAct" value="${asstToday()}"></div>
      <div class="as-f"><div class="field-label">Составил</div>${responsibleSelect(refs, "woResp")}</div>
    </div>
    <div class="td-form-foot"><span class="td-form-err" id="woErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>${icon("download", 15)} Составить</button></div>`, { wide: true });
  const $ = (id) => m.el.querySelector("#" + id);
  asstAutocomplete($("woName"),
    async (q) => (await api("/assistant/equipment?q=" + encodeURIComponent(q))).items,
    (e) => `<b>${esc(e.name)}</b><small>инв. № ${esc(e.inv || "—")}${e.commissioned ? ` · с ${esc(e.commissioned)}` : ""}</small>`,
    (e) => { $("woName").value = e.name; $("woInv").value = e.inv || ""; $("woDate").value = e.commissioned || ""; });
  m.el.querySelectorAll("[data-r]").forEach((b) => {
    b.onclick = () => { $("woReason").value = refs.reasons.find((r) => r.id === Number(b.dataset.r)).reason; };
  });
  m.el.querySelector("[data-cancel]").onclick = m.close;
  m.el.querySelector("[data-save]").onclick = async () => {
    const resp = $("woResp");
    try {
      const r = await api("/assistant/acts/writeoff", { method: "POST", body: {
        name: $("woName").value, inv: $("woInv").value, commissioned: $("woDate").value, reason: $("woReason").value,
        date: $("woAct").value, responsible_id: resp ? Number(resp.value) : null,
      } });
      m.close();
      toast(`Акт № ${r.num} составлен`);
      asstDownload(`/assistant/acts/${r.id}/download`);
      onDone();
    } catch (e) { $("woErr").textContent = e.message; }
  };
}
