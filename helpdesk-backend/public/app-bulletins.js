// ====== Бюллетени ======
//
// Таблица из ЦСОД + форма (шаблон Word и правила) → готовый документ.
// «Сформировать» — всем участникам групп бюллетеней; «Формы» — группам с правом
// управления и администраторам; группы — во вкладке Администрирования. Права
// проверяет сервер (routes/bulletins.js), меню лишь не показывает лишнего.
//
// Всё, что пришло из базы, — в разметку только через esc().

const BULLETIN_TAGS_HELP = `
  <code>{год}</code> <code>{прошлый_год}</code> <code>{ММ}</code> <code>{дата}</code> ·
  <code>{Месяц}</code> <code>{месяц}</code> <code>{МЕСЯЦ}</code> <code>{месяцу}</code> <code>{месяце}</code> <code>{месяцем}</code> ·
  <code>{пред_месяц}</code> <code>{пред_месяцу}</code> <code>{год_пред_месяца}</code> ·
  <code>{Период}</code> <code>{период}</code> <code>{ПЕРИОД}</code> <code>{периоду}</code> ·
  <code>{102.1}</code> — строка с кодом 102, первое значение (точки в коде — подчёркиванием: <code>{07_10.1}</code>) ·
  <code>{#строки}…{/строки}</code> — строки по правилам, у каждой <code>{наименование}</code> <code>{код}</code> <code>{1}</code> <code>{2}</code> …
  и признак своего вида: <code>{#раздел}…{/}</code>`;

/** Права и формы текущего пользователя — для меню и экранов. */
async function refreshBulletinAccess() {
  try { state.bulletins = await api("/bulletins"); } catch { state.bulletins = null; }
  return state.bulletins;
}

function bulletinNavItems() {
  const b = state.bulletins;
  if (!b || (!b.forms.length && !b.canManage)) return [];
  const items = [{ id: "bull:make", label: "Сформировать", icon: "doc" }];
  if (b.canManage) items.push({ id: "bull:forms", label: "Формы", icon: "sliders" });
  return items;
}

function renderBulletins(main, sub) {
  clearViewPoll();
  if (sub === "make") return renderBulletinMake(main);
  if (sub === "forms") return renderBulletinForms(main);
}

const bullToday = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
};

/** Имя файла из Content-Disposition (filename* — в UTF-8). */
function bullFileName(res, fallback) {
  const cd = res.headers.get("Content-Disposition") || "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* испорчено — запасное имя */ } }
  const plain = /filename="([^"]+)"/i.exec(cd);
  return plain ? plain[1] : fallback;
}

function bullSave(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- Сформировать ----------------------------------------------------------

async function renderBulletinMake(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Бюллетени</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  const b = await refreshBulletinAccess();
  const page = main.querySelector(".page");
  if (!b || !b.forms.length) {
    page.innerHTML = `<div class="empty-state">Вам пока не доступна ни одна форма бюллетеня.
      ${b && b.canManage ? "Добавьте форму в разделе «Формы»." : "Доступ даёт администратор платформы: Администрирование → Бюллетени."}</div>`;
    return;
  }
  page.innerHTML = `
    <div class="form-narrow" style="margin:0;max-width:640px">
      <div class="form-card">
        <div class="field-label">Таблица из ЦСОД (.xlsx или .xls)</div>
        <input type="file" class="field-input" id="bmFile" accept=".xlsx,.xls">
        <div class="form-row" style="margin:14px 0 0">
          <div><div class="field-label">Форма бюллетеня</div>
            <select class="field-input" id="bmForm">
              <option value="">Определить по заголовку таблицы</option>
              ${b.forms.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}
            </select></div>
          <div><div class="field-label">Дата документа</div>
            <input class="field-input" id="bmDate" value="${bullToday()}" placeholder="ДД.ММ.ГГГГ" style="max-width:160px"></div>
        </div>
      </div>
      <div class="as-note" style="margin:-4px 0 14px">Месяц и год берутся из заголовка таблицы («…за сентябрь 2026 года»);
        от них зависят заголовок, текст и шапка таблицы документа.</div>
      <div class="form-foot"><div class="actions"><span class="grp-msg" id="bmMsg"></span>
        <button class="btn btn-wire" id="bmGo">${icon("download", 14)} Сформировать Word</button></div></div>
    </div>`;
  const msg = page.querySelector("#bmMsg");
  const say = (ok, text) => { msg.style.color = ok ? "var(--green)" : "var(--red)"; msg.textContent = text; };
  // Форма из списка запоминается: в следующий раз чаще всего нужна та же.
  const formSel = page.querySelector("#bmForm");
  try { const last = localStorage.getItem("adm.bulletinForm"); if (last && b.forms.some((f) => String(f.id) === last)) formSel.value = last; } catch { /* хранилище недоступно */ }

  const go = page.querySelector("#bmGo");
  go.onclick = async () => {
    const file = page.querySelector("#bmFile").files[0];
    if (!file) return say(false, "Выберите файл таблицы");
    const fd = new FormData();
    fd.append("file", file);
    if (formSel.value) fd.append("form_id", formSel.value);
    fd.append("date", page.querySelector("#bmDate").value.trim());
    try { localStorage.setItem("adm.bulletinForm", formSel.value); } catch { /* хранилище недоступно */ }
    go.disabled = true; msg.style.color = "var(--ink-soft)"; msg.textContent = "Собираю документ…";
    try {
      const res = await fetch("/api/bulletins/make", { method: "POST", body: fd, credentials: "same-origin" });
      if (!res.ok) {
        let error = `Ошибка ${res.status}`;
        try { error = (await res.json()).error || error; } catch { /* не JSON */ }
        throw new Error(error);
      }
      const name = bullFileName(res, "бюллетень.docx");
      bullSave(await res.blob(), name);
      say(true, `Готово: ${name}`);
    } catch (e) { say(false, e.message); } finally { go.disabled = false; }
  };
}

// ---- Формы -----------------------------------------------------------------

async function renderBulletinForms(main, editId) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title-row"><div class="topbar-title">Формы бюллетеней</div></div>
    <div class="as-top-actions"><button class="btn btn-wire" id="bfNew">${icon("plus", 14)} Добавить форму</button></div></div>
    <div class="page"><div class="spinner">Загрузка…</div></div>`;
  const b = await refreshBulletinAccess();
  const page = main.querySelector(".page");
  if (!b || !b.canManage) { page.innerHTML = `<div class="empty-state">Нет прав на управление формами.</div>`; return; }
  main.querySelector("#bfNew").onclick = () => bulletinFormEditor(main, null);
  if (editId) return bulletinFormEditor(main, editId);
  const mine = b.forms.filter((f) => f.canEdit);
  page.innerHTML = `
    <div class="as-note" style="margin-bottom:16px;max-width:820px">Форма — шаблон Word и правила: из каких столбцов таблицы ЦСОД брать
      данные и какие строки выводить в документ. Проще всего скачать шаблон готовой формы, поправить и загрузить новой формой.</div>
    ${mine.length ? mine.map((f) => `
      <div class="as-tpl">
        <div class="as-tpl-main">
          <div class="as-tpl-t">${esc(f.name)}</div>
          <div class="as-note">${f.sign ? `узнаётся по «${esc(f.sign)}»` : "форму выбирают вручную"} · ${esc(f.updated_by || "")} · ${esc(fmtDate(f.updated_at))}</div>
        </div>
        <div class="as-tpl-act">
          <button class="btn btn-ghost as-btn-sm" data-get="${f.id}">${icon("download", 14)} Шаблон</button>
          <button class="btn btn-ghost as-btn-sm" data-edit="${f.id}">${icon("edit", 14)} Изменить</button>
          <button class="btn btn-text as-btn-sm" data-del="${f.id}" data-name="${esc(f.name)}">Удалить</button>
        </div>
      </div>`).join("") : `<div class="empty-state">Форм пока нет.</div>`}`;
  page.querySelectorAll("[data-get]").forEach((x) => { x.onclick = () => asstDownload(`/bulletins/forms/${x.dataset.get}/template`); });
  page.querySelectorAll("[data-edit]").forEach((x) => { x.onclick = () => bulletinFormEditor(main, Number(x.dataset.edit)); });
  page.querySelectorAll("[data-del]").forEach((x) => {
    x.onclick = async () => {
      if (!(await uiConfirm(`Удалить форму «${x.dataset.name}»? Документы по ней больше не собрать.`, { ok: "Удалить", danger: true }))) return;
      try { await api(`/bulletins/forms/${x.dataset.del}`, { method: "DELETE" }); toast("Форма удалена"); await refreshBulletinAccess(); refreshNav(); renderBulletinForms(main); }
      catch (e) { toast(e.message, true); }
    };
  });
}

const BULL_RULE_HINT = "Коды: # — цифра, @ — латинская буква, * — что угодно; несколько — через запятую (10, 11, 12). "
  + "Разделы — буквы ОКВЭД через запятую, пусто — во всех.";

function bulletinRuleRow(r) {
  return `<tr class="bf-rule">
    <td><input class="input mono bf-kind" value="${esc(r.kind || "")}" placeholder="вид" style="width:100%"></td>
    <td><input class="input mono bf-codes" value="${esc(r.codes || "")}" placeholder="##" style="width:100%"></td>
    <td><input class="input mono bf-sections" value="${esc((r.sections || []).join(", "))}" placeholder="все" style="width:100%"></td>
    <td style="text-align:center"><input type="checkbox" class="bf-case" ${r.sentenceCase ? "checked" : ""} title="ЗАГЛАВНЫЕ → как в предложении"></td>
    <td><button class="btn btn-text as-btn-sm bf-rule-del" type="button">${icon("trash", 14)}</button></td>
  </tr>`;
}

async function bulletinFormEditor(main, id) {
  const page = main.querySelector(".page");
  page.innerHTML = `<div class="spinner">Загрузка…</div>`;
  let f;
  try {
    f = id ? await api(`/bulletins/forms/${id}`) : {
      name: "", groups: [], warnings: [],
      settings: { sign: "", fileName: "{название}_{ММ}_{ГГГГ}", nameCol: "A", codeCol: "B", valueCols: ["C", "D", "E"],
        rules: [{ kind: "раздел", codes: "@", sections: [], sentenceCase: true }, { kind: "вид", codes: "##", sections: [], sentenceCase: false }],
        timesFrom: 200, digits: 1 },
    };
  } catch (e) { page.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const s = f.settings;
  const groups = (state.bulletins && state.bulletins.manageGroups) || [];
  const isAdmin = state.bulletins && state.bulletins.admin;
  page.innerHTML = `
    <div class="form-narrow" style="margin:0;max-width:880px">
      <div class="form-card">
        <div class="form-row" style="margin-bottom:12px">
          <div><div class="field-label">Название формы</div><input class="field-input" id="bfName" maxlength="80" value="${esc(f.name)}" placeholder="350 Индексы производства"></div>
          ${!id && groups.length ? `<div><div class="field-label">Группа${isAdmin ? " (необязательно)" : ""}</div>
            <select class="field-input" id="bfGroup">${isAdmin ? `<option value="">— без группы —</option>` : ""}
              ${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select></div>` : ""}
        </div>
        <div class="field-label">Шаблон Word ${id ? `(сейчас: ${esc(f.filename)}; приложите новый, чтобы заменить)` : ""}</div>
        <input type="file" class="field-input" id="bfFile" accept=".docx" style="margin-bottom:12px">
        <div class="form-row" style="margin-bottom:12px">
          <div><div class="field-label">Признак таблицы — текст из её заголовка</div>
            <input class="field-input" id="bfSign" maxlength="200" value="${esc(s.sign)}" placeholder="Индексы производства по видам экономической деятельности"></div>
          <div><div class="field-label">Имя файла: {название} {ММ} {ГГГГ} {месяц}</div>
            <input class="field-input mono" id="bfFileName" maxlength="100" value="${esc(s.fileName)}"></div>
        </div>
        <div class="form-row" style="margin-bottom:12px">
          <div><div class="field-label">Столбец наименования</div><input class="field-input mono" id="bfNameCol" maxlength="2" value="${esc(s.nameCol)}"></div>
          <div><div class="field-label">Столбец кода</div><input class="field-input mono" id="bfCodeCol" maxlength="2" value="${esc(s.codeCol)}"></div>
          <div><div class="field-label">Столбцы значений → {1} {2} …</div><input class="field-input mono" id="bfValueCols" value="${esc(s.valueCols.join(", "))}"></div>
        </div>
        <div class="form-row" style="margin-bottom:12px">
          <div><div class="field-label">От скольких % писать «в N р.» (0 — никогда)</div><input class="field-input" id="bfTimes" type="number" min="0" value="${esc(s.timesFrom)}"></div>
          <div><div class="field-label">Знаков после запятой</div><input class="field-input" id="bfDigits" type="number" min="0" max="4" value="${esc(s.digits)}"></div>
        </div>
        <div class="field-label">Строки таблицы документа — в порядке Excel, по первому подходящему правилу</div>
        <table class="as-table" style="margin-bottom:6px">
          <thead><tr><th>Вид ({#вид}…{/})</th><th>Коды</th><th>Разделы</th><th title="ЗАГЛАВНЫЕ → как в предложении">Регистр</th><th></th></tr></thead>
          <tbody id="bfRules">${s.rules.map(bulletinRuleRow).join("")}</tbody>
        </table>
        <button class="btn btn-ghost as-btn-sm" id="bfAddRule" type="button">${icon("plus", 14)} Правило</button>
        <div class="as-note" style="margin-top:8px">${esc(BULL_RULE_HINT)}</div>
      </div>
      <div class="as-note" style="margin:-4px 0 14px">Метки шаблона: ${BULLETIN_TAGS_HELP}</div>
      ${f.warnings && f.warnings.length ? `<div class="as-note" style="color:var(--red);margin-bottom:12px">${f.warnings.map(esc).join("<br>")}</div>` : ""}
      <div class="form-foot"><div class="actions">
        <button class="btn btn-ghost" id="bfBack" type="button">К списку</button>
        <span class="grp-msg" id="bfMsg"></span>
        <button class="btn btn-wire" id="bfSave">Сохранить</button></div></div>
    </div>`;
  const $ = (sel) => page.querySelector(sel);
  const wireRules = () => page.querySelectorAll(".bf-rule-del").forEach((x) => { x.onclick = () => x.closest("tr").remove(); });
  wireRules();
  $("#bfAddRule").onclick = () => { $("#bfRules").insertAdjacentHTML("beforeend", bulletinRuleRow({})); wireRules(); };
  $("#bfBack").onclick = () => renderBulletinForms(main);
  const msg = $("#bfMsg");
  $("#bfSave").onclick = async () => {
    const settings = {
      sign: $("#bfSign").value, fileName: $("#bfFileName").value,
      nameCol: $("#bfNameCol").value, codeCol: $("#bfCodeCol").value,
      valueCols: $("#bfValueCols").value.split(/[\s,;]+/).filter(Boolean),
      timesFrom: Number($("#bfTimes").value), digits: Number($("#bfDigits").value),
      rules: [...page.querySelectorAll(".bf-rule")].map((tr) => ({
        kind: tr.querySelector(".bf-kind").value, codes: tr.querySelector(".bf-codes").value,
        sections: tr.querySelector(".bf-sections").value, sentenceCase: tr.querySelector(".bf-case").checked,
      })).filter((r) => r.kind || r.codes),
    };
    const fd = new FormData();
    const payload = { name: $("#bfName").value, settings };
    if ($("#bfGroup")) payload.group_id = $("#bfGroup").value || null;
    fd.append("payload", JSON.stringify(payload));
    if ($("#bfFile").files[0]) fd.append("file", $("#bfFile").files[0]);
    msg.style.color = "var(--ink-soft)"; msg.textContent = "Сохраняю…";
    try {
      const r = await api(id ? `/bulletins/forms/${id}` : "/bulletins/forms", { method: id ? "PUT" : "POST", body: fd });
      await refreshBulletinAccess(); refreshNav();
      if (r.warnings && r.warnings.length) {
        toast(`Сохранено, но: ${r.warnings.join("; ")}`, true);
        return bulletinFormEditor(main, id || r.id);
      }
      toast("Форма сохранена");
      renderBulletinForms(main);
    } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
  };
}

// ---- Администрирование → Бюллетени: группы ----------------------------------

async function renderBulletinGroupsAdmin(box) {
  box.innerHTML = `<div class="spinner">Загрузка…</div>`;
  let data;
  try { data = await api("/bulletins/groups"); } catch (e) { box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const { groups, forms } = data;
  const formChecks = (sel) => forms.length
    ? forms.map((f) => `<label class="grp-check" style="margin:2px 14px 2px 0;display:inline-flex"><input type="checkbox" class="bg-form" value="${f.id}" ${sel.includes(f.id) ? "checked" : ""}> ${esc(f.name)}</label>`).join("")
    : `<div class="as-note">Форм пока нет — их добавляют в разделе «Бюллетени → Формы».</div>`;
  const card = (g) => `
    <div class="card grp-card" data-id="${g ? g.id : ""}" style="margin-bottom:14px">
      ${g ? "" : `<div class="section-label">Новая группа</div>`}
      <div class="field-label">Название</div>
      <input class="input bg-name" maxlength="80" style="width:100%;margin-bottom:10px" value="${esc(g ? g.name : "")}" placeholder="Отдел статистики предприятий">
      <div class="form-row" style="margin-bottom:0">
        <div><div class="field-label">Группы домена — по одной на строку</div>
          <textarea class="field-input mono bg-ad" rows="3" style="resize:vertical;width:100%" placeholder="Otdel-Statistiki">${esc(g ? g.ad_groups.join("\n") : "")}</textarea></div>
        <div><div class="field-label">Логины — по одному на строку</div>
          <textarea class="field-input mono bg-logins" rows="3" style="resize:vertical;width:100%" placeholder="ivanov">${esc(g ? g.logins.map((l) => l.login).join("\n") : "")}</textarea></div>
      </div>
      ${g && g.logins.length ? `<div class="grp-who">${g.logins.map((l) => `<span><span class="mono">${esc(l.login)}</span> — ${l.name ? esc(l.name) : `<i>ещё не входил</i>`}</span>`).join("")}</div>` : ""}
      <div class="field-label" style="margin-top:10px">Формы группы</div>
      <div>${formChecks(g ? g.forms : [])}</div>
      <label class="grp-check"><input type="checkbox" class="bg-manage" ${g && g.can_manage ? "checked" : ""}> Может править формы группы и добавлять новые (раздел «Бюллетени → Формы»)</label>
      <div class="grp-actions">
        ${g ? `<button class="btn btn-ghost bg-del">Удалить группу</button>` : ""}
        <span class="grp-msg"></span>
        <button class="btn btn-wire bg-save">${g ? "Сохранить" : "Добавить"}</button>
      </div>
    </div>`;
  box.innerHTML = `
    <div class="as-note" style="margin-bottom:14px;max-width:820px">Сотрудник видит раздел «Бюллетени», если состоит в группе: по группе домена
      (как она была при его последнем входе) или по логину в списке. У каждой группы свой набор форм.
      Администраторы платформы видят и правят все формы.</div>
    ${groups.map(card).join("")}
    ${card(null)}`;
  box.querySelectorAll(".grp-card").forEach((c) => {
    const id = c.dataset.id;
    const msg = c.querySelector(".grp-msg");
    const say = (ok, text) => { msg.style.color = ok ? "var(--green)" : "var(--red)"; msg.textContent = text; };
    c.querySelector(".bg-save").onclick = async () => {
      const body = {
        name: c.querySelector(".bg-name").value, ad_groups: c.querySelector(".bg-ad").value,
        logins: c.querySelector(".bg-logins").value, can_manage: c.querySelector(".bg-manage").checked,
        forms: [...c.querySelectorAll(".bg-form:checked")].map((x) => Number(x.value)),
      };
      try {
        await api(id ? `/bulletins/groups/${id}` : "/bulletins/groups", { method: id ? "PUT" : "POST", body });
        toast(id ? "Сохранено" : `Группа «${body.name.trim()}» добавлена`);
        await refreshBulletinAccess(); refreshNav();
        renderBulletinGroupsAdmin(box);
      } catch (e) { say(false, e.message); }
    };
    const del = c.querySelector(".bg-del");
    if (del) del.onclick = async () => {
      const name = c.querySelector(".bg-name").value;
      if (!(await uiConfirm(`Удалить группу «${name}»? Формы останутся, но её участники их больше не увидят.`, { ok: "Удалить", danger: true }))) return;
      try { await api(`/bulletins/groups/${id}`, { method: "DELETE" }); toast("Группа удалена"); renderBulletinGroupsAdmin(box); }
      catch (e) { say(false, e.message); }
    };
  });
}
