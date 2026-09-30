// ====== Ассистент: акты ======
//
// Все акты заполняются вручную: акты на ремонт (о неисправностях и о ремонте,
// по желанию — служебная записка на запчасти), акт на списание оборудования и
// ведомость на списание картриджей за месяц. Готовые тексты неисправностей и
// причин списания — из справочников в настройках.

let actsYear = null;

async function renderAsstActs(main) {
  main.innerHTML = `
    ${asstTopbar("Акты", `
      <button class="btn btn-wire" id="aRepair">${icon("plus", 15)} Акты на ремонт</button>
      <button class="btn btn-ghost" id="aWo">${icon("trash", 15)} Акт на списание</button>
      <button class="btn btn-ghost" id="aCart">${icon("receipt", 15)} Ведомость по картриджам</button>`)}
    <div class="page">
      <div class="filters-row"><span id="aYears"></span></div>
      <div class="as-selbar" id="aSel" hidden></div>
      <div id="aList"><div class="spinner">Загрузка…</div></div>
    </div>`;
  const $ = (id) => main.querySelector("#" + id);
  $("aRepair").onclick = () => repairActDialog(load);
  $("aWo").onclick = () => writeoffDialog(load);
  $("aCart").onclick = () => cartridgesDialog(load);
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
    if (!data.acts.length) {
      $("aList").innerHTML = `<div class="empty-state">В ${data.year} году актов ещё нет. Новый — кнопками справа сверху.</div>`;
      return;
    }
    $("aList").innerHTML = `
      <div class="as-table-wrap"><table class="as-table"><thead><tr><th style="width:28px"></th><th>№</th><th>Дата</th><th>Вид</th><th>Что</th><th>Составил</th><th></th></tr></thead>
      <tbody>${data.acts.map((a) => `<tr>
        <td><input type="checkbox" class="a-cb" data-id="${a.id}" ${selected.has(a.id) ? "checked" : ""}></td>
        <td><b>${a.num}</b></td><td class="nowrap">${esc(asstRuDate(a.date))}</td>
        <td><span class="as-badge ${a.type === "repair" ? "blue" : a.type === "cartridges" ? "violet" : "orange"}">${esc(a.typeLabel)}</span></td>
        <td>${esc(a.title)}</td>
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
        if (!confirm("Удалить акт из реестра?")) return;
        try { await api(`/assistant/acts/${b.dataset.rm}`, { method: "DELETE" }); selected.delete(Number(b.dataset.rm)); paintSel(); load(); } catch (e) { toast(e.message, true); }
      };
    });
  }
  load();
}

// ---- Строки таблицы в форме ------------------------------------------------

/**
 * Таблица строк, которые заполняют руками: техника, запчасти, картриджи.
 * cols: [{ key, label, width?, type? }]. Возвращает { rows() } — непустые
 * строки как объекты.
 */
function actRowsEditor(box, cols, { addLabel = "Добавить строку", min = 1 } = {}) {
  const data = Array.from({ length: min }, () => ({}));
  const paint = () => {
    box.innerHTML = `
      <div class="as-table-wrap"><table class="as-table as-rows"><thead><tr>${cols.map((c) => `<th style="${c.width ? `width:${c.width}` : ""}">${esc(c.label)}</th>`).join("")}<th style="width:36px"></th></tr></thead>
      <tbody>${data.map((r, i) => `<tr>${cols.map((c) => `<td><input class="field-input" data-i="${i}" data-k="${c.key}" ${c.type === "number" ? 'type="number" min="1"' : ""} value="${esc(r[c.key] ?? (c.type === "number" ? 1 : ""))}"></td>`).join("")}
        <td>${data.length > min ? `<button type="button" class="as-icon-btn" data-del="${i}" title="Убрать">${icon("x", 14)}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <button type="button" class="btn btn-text as-btn-sm" data-add>${icon("plus", 14)} ${esc(addLabel)}</button>`;
    box.querySelectorAll("input[data-k]").forEach((el) => { el.oninput = () => { data[Number(el.dataset.i)][el.dataset.k] = el.value; }; });
    box.querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => { data.splice(Number(b.dataset.del), 1); paint(); }; });
    box.querySelector("[data-add]").onclick = () => { data.push({}); paint(); box.querySelector("tbody tr:last-child input")?.focus(); };
  };
  paint();
  return {
    rows: () => data
      .map((r) => Object.fromEntries(cols.map((c) => [c.key, r[c.key] ?? (c.type === "number" ? 1 : "")])))
      .filter((r) => cols.some((c) => c.type !== "number" && String(r[c.key] || "").trim())),
  };
}

function responsibleSelect(refs, id) {
  if (!refs.responsibles.length) {
    return `<div class="as-note">Составителей актов нет в справочнике — ${state.user.is_admin ? "добавьте их в настройках («Подписанты актов»)" : "попросите администратора добавить"}; поле подписи останется пустым.</div>`;
  }
  return `<select id="${id}" class="field-select">${refs.responsibles.map((r) => `<option value="${r.id}">${esc(r.name)}${r.post ? ` — ${esc(r.post)}` : ""}</option>`).join("")}</select>`;
}

// ---- Акты на ремонт ----------------------------------------------------------

async function repairActDialog(onDone) {
  let refs;
  try { refs = await asstRefs(true); } catch (e) { toast(e.message, true); return; }
  const m = asstModal("Акты на ремонт", `
    <div class="as-note" style="margin-bottom:14px">Будут составлены акт о неисправностях и акт о ремонте с одним номером.</div>
    <div class="as-sec">Техника</div>
    <div id="raEq"></div>
    ${refs.rules.length ? `<div class="as-sec" style="margin-top:14px">Типовая неисправность</div>
      <div class="as-chips" style="margin-bottom:6px">${refs.rules.map((r) => `<button type="button" class="as-chip" data-rule="${r.id}">${esc(r.title)}</button>`).join("")}</div>
      <div class="as-note" style="margin-bottom:6px">Щелчок подставит описание, работы и остатки — их можно поправить.</div>` : ""}
    <div class="as-grid" style="margin-top:10px">
      <div class="as-f wide"><div class="field-label">Неисправности * — по одной на строку</div><textarea class="field-input" id="raDef" rows="3"></textarea></div>
      <div class="as-f wide"><div class="field-label">Работы * — по одной на строку</div><textarea class="field-input" id="raWorks" rows="3"></textarea></div>
    </div>
    <div class="as-sec" style="margin-top:14px">Запасные части</div>
    <div class="as-note" style="margin-bottom:6px">Если запчасти не менялись — оставьте пустым. Работа у запчасти — по умолчанию первая из списка работ.</div>
    <div id="raParts"></div>
    <div class="as-grid" style="margin-top:12px">
      <div class="as-f wide"><div class="field-label">Что остаётся после ремонта</div><input class="field-input" id="raRem" placeholder="не образовались"></div>
      <div class="as-f"><div class="field-label">Дата актов</div><input type="date" class="field-input" id="raDate" value="${asstToday()}"></div>
      <div class="as-f"><div class="field-label">Составил</div>${responsibleSelect(refs, "raResp")}</div>
      <div class="as-f wide"><label class="as-check"><input type="checkbox" id="raMemo"><span>Добавить служебную записку на запчасти</span></label></div>
    </div>
    <div class="td-form-foot"><span class="td-form-err" id="raErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>${icon("download", 15)} Составить и скачать</button></div>`, { wide: true });
  const $ = (id) => m.el.querySelector("#" + id);
  const eq = actRowsEditor($("raEq"), [
    { key: "name", label: "Наименование *" }, { key: "inv", label: "Инв. №", width: "150px" }, { key: "location", label: "Местонахождение", width: "200px" },
  ], { addLabel: "Ещё техника" });
  const parts = actRowsEditor($("raParts"), [
    { key: "name", label: "Запасная часть" }, { key: "nomenclature", label: "Номенкл. №", width: "140px" },
    { key: "count", label: "Кол-во", width: "80px", type: "number" }, { key: "work", label: "Работа", width: "190px" },
  ], { addLabel: "Ещё запчасть", min: 1 });
  m.el.querySelectorAll("[data-rule]").forEach((b) => {
    b.onclick = () => {
      const r = refs.rules.find((x) => x.id === Number(b.dataset.rule));
      $("raDef").value = r.defect || "";
      $("raWorks").value = r.repair_works || "";
      if (r.remains) $("raRem").value = r.remains;
    };
  });
  m.el.querySelector("[data-cancel]").onclick = m.close;
  m.el.querySelector("[data-save]").onclick = async () => {
    const resp = $("raResp");
    try {
      const r = await api("/assistant/acts/repair", { method: "POST", body: {
        equipment: eq.rows(), defects: $("raDef").value, works: $("raWorks").value, parts: parts.rows(),
        remains: $("raRem").value, date: $("raDate").value, responsible_id: resp ? Number(resp.value) : null,
        with_memo: $("raMemo").checked,
      } });
      m.close();
      toast(`Акт № ${r.num} составлен`);
      asstDownload(`/assistant/acts/${r.id}/download`);
      onDone();
    } catch (e) { $("raErr").textContent = e.message; }
  };
}

// ---- Ведомость по картриджам ------------------------------------------------

async function cartridgesDialog(onDone) {
  let refs;
  try { refs = await asstRefs(true); } catch (e) { toast(e.message, true); return; }
  // В начале месяца обычно составляют ведомость за прошлый.
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() - (new Date().getDate() < 10 ? 1 : 0));
  const m = asstModal("Ведомость на списание картриджей", `
    <div class="as-note" style="margin-bottom:14px">Будут и Word, и Excel. Итог по количеству посчитается сам.</div>
    <div class="as-grid">
      <div class="as-f"><div class="field-label">Месяц</div><input type="month" class="field-input" id="cmMonth" value="${d.getFullYear()}-${asstPad(d.getMonth() + 1)}"></div>
      <div class="as-f"><div class="field-label">Составил</div>${responsibleSelect(refs, "cmResp")}</div>
    </div>
    <div class="as-sec" style="margin-top:14px">Картриджи и расходники</div>
    <div id="cmRows"></div>
    <div class="td-form-foot"><span class="td-form-err" id="cmErr"></span>
      <button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-save>${icon("download", 15)} Составить</button></div>`, { wide: true });
  const rows = actRowsEditor(m.el.querySelector("#cmRows"), [
    { key: "name", label: "Наименование *" }, { key: "nomenclature", label: "Номенкл. №", width: "140px" },
    { key: "count", label: "Кол-во", width: "80px", type: "number" }, { key: "location", label: "Где установлен", width: "200px" },
  ], { addLabel: "Ещё картридж" });
  m.el.querySelector("[data-cancel]").onclick = m.close;
  m.el.querySelector("[data-save]").onclick = async () => {
    const resp = m.el.querySelector("#cmResp");
    try {
      const r = await api("/assistant/acts/cartridges", { method: "POST", body: {
        month: m.el.querySelector("#cmMonth").value, rows: rows.rows(), responsible_id: resp ? Number(resp.value) : null,
      } });
      m.close();
      toast(`Ведомость № ${r.num} составлена`);
      asstDownload(`/assistant/acts/${r.id}/download`);
      onDone();
    } catch (e) { m.el.querySelector("#cmErr").textContent = e.message; }
  };
}

// ---- Акт на списание ----------------------------------------------------------

async function writeoffDialog(onDone) {
  let refs;
  try { refs = await asstRefs(true); } catch (e) { toast(e.message, true); return; }
  const m = asstModal("Акт на списание оборудования", `
    <div class="as-grid">
      <div class="as-f wide"><div class="field-label">Оборудование *</div><input class="field-input" id="woName" placeholder="Наименование"></div>
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
