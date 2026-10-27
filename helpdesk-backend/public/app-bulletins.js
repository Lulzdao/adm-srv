// ====== Бюллетени ======
//
// Таблица из ЦСОД + бюллетень (шаблон Word и разбор таблицы) → готовый документ.
// «Сформировать» — всем участникам групп бюллетеней. «Шаблоны» — группам с правом
// управления: скачать, заменить, сделать новый по образцу. Разбор таблицы (листы,
// столбцы, строки) и новые бюллетени с нуля — администраторам, как и группы во
// вкладке Администрирования. Права проверяет сервер (routes/bulletins.js), меню
// лишь не показывает лишнего.
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

/** Права и бюллетени текущего пользователя — для меню и экранов. */
async function refreshBulletinAccess() {
  try { state.bulletins = await api("/bulletins"); } catch { state.bulletins = null; }
  return state.bulletins;
}

function bulletinNavItems() {
  const b = state.bulletins;
  if (!b || (!b.forms.length && !b.canManage)) return [];
  const items = [{ id: "bull:make", label: "Сформировать", icon: "doc" }];
  if (b.canManage) items.push({ id: "bull:forms", label: "Шаблоны", icon: "sliders" });
  return items;
}

function renderBulletins(main, sub) {
  clearViewPoll();
  if (sub === "make") return renderBulletinMake(main);
  if (sub === "forms") return renderBulletinForms(main);
}

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

const bullSize = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`);
const BULL_LAST_KEY = "adm.bulletinForm";

// ---- Сформировать ----------------------------------------------------------
// Раскладка — как у «Новой заявки»: по центру, бюллетень — плиткой, ниже таблица
// и дата, внизу подсказка и кнопка.

async function renderBulletinMake(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Бюллетени</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  const b = await refreshBulletinAccess();
  const page = main.querySelector(".page");
  if (!b || !b.forms.length) {
    page.innerHTML = `<div class="form-narrow"><div class="empty-state">Вам пока не доступен ни один бюллетень.
      Доступ даёт администратор платформы: Администрирование → Бюллетени.</div></div>`;
    return;
  }
  // Выбранный в прошлый раз бюллетень — снова выбран: чаще всего нужен тот же.
  let chosen = b.forms[0].id;
  try { const last = Number(localStorage.getItem(BULL_LAST_KEY)); if (b.forms.some((f) => f.id === last)) chosen = last; } catch { /* хранилище недоступно */ }
  let file = null;
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  page.innerHTML = `
    <div class="form-narrow">
      <div class="form-card">
        <div class="form-card-title">Какой бюллетень</div>
        <div class="form-card-sub">Выберите бюллетень, который нужно сформировать</div>
        <div class="dept-strip" id="bmStrip">
          <div class="dept-fade left" hidden></div>
          <button type="button" class="dept-nav prev" hidden aria-label="Предыдущие">${icon("chevron-left", 16)}</button>
          <div class="dept-scroll">${b.forms.map((f, i) => `
            <button type="button" class="dept-tile ${f.id === chosen ? "active" : ""}" data-form="${f.id}">
              <span class="dept-icon" style="color:${DEPT_FALLBACK_COLORS[i % DEPT_FALLBACK_COLORS.length]};">${icon("doc", 22)}</span>
              <span class="dept-name">${esc(f.name)}</span>
              <span class="dept-hint">Шаблон обновлён ${esc(fmtDate(f.updated_at))}</span>
              <span class="dept-check">${icon("check", 12)}</span>
            </button>`).join("")}</div>
          <div class="dept-fade right" hidden></div>
          <button type="button" class="dept-nav next" hidden aria-label="Следующие">${icon("chevron", 16)}</button>
        </div>
      </div>

      <div class="form-card">
        <div class="form-card-title" style="margin-bottom:16px;">Таблица из ЦСОД</div>
        <div class="dropzone" id="bmDrop"></div>
        <input type="file" id="bmFile" accept=".xlsx,.xls" hidden>
        <div class="field-label">Дата документа</div>
        <input class="field-input" type="date" id="bmDate" value="${iso}" style="max-width:220px;margin-bottom:0;">
      </div>

      <div class="form-foot">
        <div class="hint" id="bmHint"></div>
        <div class="actions"><button class="btn-send" id="bmGo">Сформировать Word</button></div>
      </div>
    </div>`;

  const scroll = wireTileStrip(page.querySelector("#bmStrip"));
  const drop = page.querySelector("#bmDrop");
  const input = page.querySelector("#bmFile");
  const hint = page.querySelector("#bmHint");
  const go = page.querySelector("#bmGo");
  const nameOf = (id) => (b.forms.find((f) => f.id === id) || {}).name || "";
  const say = (text, bad = false) => { hint.classList.toggle("invalid", bad); hint.textContent = text; };
  const showHint = () => say(`Документ «${nameOf(chosen)}» соберётся по таблице и сразу скачается. Месяц и год возьмутся из таблицы.`);
  const showFile = () => {
    drop.innerHTML = file
      ? `<span class="dropzone-icon">${icon("doc", 18)}</span>${esc(file.name)} · ${bullSize(file.size)} — нажмите, чтобы выбрать другую`
      : `<span class="dropzone-icon">${icon("upload", 18)}</span>Перетащите таблицу сюда или нажмите, чтобы выбрать (.xlsx или .xls)`;
  };
  showFile();
  showHint();

  scroll.querySelectorAll(".dept-tile").forEach((tile) => {
    tile.onclick = () => {
      chosen = Number(tile.dataset.form);
      scroll.querySelectorAll(".dept-tile").forEach((t) => t.classList.toggle("active", t === tile));
      showHint();
    };
  });
  drop.onclick = () => { input.value = ""; input.click(); };
  input.onchange = () => { if (input.files[0]) { file = input.files[0]; showFile(); showHint(); } };
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files[0]) { file = e.dataTransfer.files[0]; showFile(); showHint(); }
  });

  go.onclick = async () => {
    if (!file) { say("Выберите файл таблицы из ЦСОД.", true); drop.classList.add("over"); setTimeout(() => drop.classList.remove("over"), 900); return; }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(page.querySelector("#bmDate").value);
    if (!m) { say("Укажите дату документа.", true); return; }
    const fd = new FormData();
    fd.append("form_id", String(chosen));
    fd.append("date", `${m[3]}.${m[2]}.${m[1]}`);
    fd.append("file", file);
    go.disabled = true; go.textContent = "Собираю…";
    try {
      const res = await fetch("/api/bulletins/make", { method: "POST", body: fd, credentials: "same-origin" });
      if (!res.ok) {
        let error = `Ошибка ${res.status}`;
        try { error = (await res.json()).error || error; } catch { /* не JSON */ }
        throw new Error(error);
      }
      const name = bullFileName(res, "бюллетень.docx");
      bullSave(await res.blob(), name);
      say(`Готово: ${name}`);
      // Запоминаем только удачный выбор: ошибочно нажатая плитка не должна стать выбором по умолчанию.
      try { localStorage.setItem(BULL_LAST_KEY, String(chosen)); } catch { /* хранилище недоступно */ }
    } catch (e) { say(e.message, true); } finally { go.disabled = false; go.textContent = "Сформировать Word"; }
  };
}

// ---- Шаблоны ---------------------------------------------------------------

async function renderBulletinForms(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Шаблоны бюллетеней</div></div>
    <div class="page"><div class="spinner">Загрузка…</div></div>`;
  const b = await refreshBulletinAccess();
  const page = main.querySelector(".page");
  if (!b || !b.canManage) { page.innerHTML = `<div class="form-narrow"><div class="empty-state">Нет прав на шаблоны бюллетеней.</div></div>`; return; }
  const mine = b.forms.filter((f) => f.canEdit);
  page.innerHTML = `
    <div class="form-narrow">
      <div class="as-note" style="margin-bottom:16px">Чтобы поменять оформление или текст бюллетеня: скачайте шаблон, поправьте его в Word
        и загрузите обратно. Слова в фигурных скобках — <code>{год}</code>, <code>{периоду}</code>, <code>{#строки}</code> — не трогайте:
        на их место встанут данные из таблицы. Новый бюллетень по той же таблице — кнопка «По образцу».</div>
      ${mine.length ? mine.map((f) => `
        <div class="as-tpl">
          <div class="as-tpl-main">
            <div class="as-tpl-t">${esc(f.name)}</div>
            <div class="as-note">${esc(f.filename)} · ${esc(f.updated_by || "")} · ${esc(fmtDate(f.updated_at))}</div>
          </div>
          <div class="as-tpl-act">
            <button class="btn btn-ghost as-btn-sm" data-get="${f.id}">${icon("download", 14)} Скачать</button>
            <button class="btn btn-ghost as-btn-sm" data-up="${f.id}">${icon("upload", 14)} Заменить</button>
            <button class="btn btn-ghost as-btn-sm" data-copy="${f.id}">${icon("plus", 14)} По образцу</button>
            ${b.admin ? `<button class="btn btn-ghost as-btn-sm" data-edit="${f.id}">${icon("sliders", 14)} Разбор таблицы</button>
              <button class="btn btn-text as-btn-sm" data-del="${f.id}">Удалить</button>` : ""}
          </div>
        </div>`).join("") : `<div class="empty-state">Бюллетеней пока нет.</div>`}
      ${b.admin ? `<div style="margin-top:14px;display:flex;justify-content:flex-end;">
        <button class="btn btn-wire" id="bfNew">${icon("plus", 14)} Новый бюллетень с нуля</button></div>` : ""}
      <input type="file" id="bfUp" accept=".docx" hidden>
    </div>`;
  const byId = (id) => mine.find((f) => f.id === Number(id));
  const warn = (r, ok) => (r.warnings && r.warnings.length ? toast(`${ok}, но: ${r.warnings.join("; ")}`, true) : toast(ok));
  page.querySelectorAll("[data-get]").forEach((x) => { x.onclick = () => asstDownload(`/bulletins/forms/${x.dataset.get}/template`); });

  const up = page.querySelector("#bfUp");
  let target = null;
  page.querySelectorAll("[data-up]").forEach((x) => { x.onclick = () => { target = x.dataset.up; up.value = ""; up.click(); }; });
  up.onchange = async () => {
    if (!up.files[0]) return;
    const fd = new FormData();
    fd.append("file", up.files[0]);
    try {
      warn(await api(`/bulletins/forms/${target}/template`, { method: "PUT", body: fd }), "Шаблон заменён");
      renderBulletinForms(main);
    } catch (e) { toast(e.message, true); }
  };

  page.querySelectorAll("[data-copy]").forEach((x) => {
    x.onclick = () => {
      const f = byId(x.dataset.copy);
      const m = asstModal("Новый бюллетень по образцу", `
        <div class="as-note" style="margin-bottom:12px">Таблица разбирается так же, как у «${esc(f.name)}»; оформление и текст — из вашего шаблона.
          Проще всего скачать шаблон образца, поправить и загрузить сюда.</div>
        <div class="field-label">Название</div>
        <input class="field-input" id="cpName" maxlength="80" value="${esc(f.name)} (копия)">
        <div class="field-label">Шаблон Word</div>
        <input type="file" class="field-input" id="cpFile" accept=".docx">
        <div id="cpMsg" class="as-note" style="color:var(--red);min-height:18px;margin:6px 0 10px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button class="btn btn-ghost" id="cpCancel">Отмена</button>
          <button class="btn btn-wire" id="cpOk">Создать</button>
        </div>`);
      m.el.querySelector("#cpCancel").onclick = () => m.close();
      m.el.querySelector("#cpOk").onclick = async () => {
        const fd = new FormData();
        fd.append("payload", JSON.stringify({ name: m.el.querySelector("#cpName").value }));
        const tpl = m.el.querySelector("#cpFile").files[0];
        if (tpl) fd.append("file", tpl);
        try {
          warn(await api(`/bulletins/forms/${f.id}/copy`, { method: "POST", body: fd }), "Бюллетень создан");
          m.close();
          await refreshBulletinAccess(); refreshNav();
          renderBulletinForms(main);
        } catch (e) { m.el.querySelector("#cpMsg").textContent = e.message; }
      };
    };
  });

  if (!b.admin) return;
  page.querySelector("#bfNew").onclick = () => bulletinFormEditor(main, null);
  page.querySelectorAll("[data-edit]").forEach((x) => { x.onclick = () => bulletinFormEditor(main, Number(x.dataset.edit)); });
  page.querySelectorAll("[data-del]").forEach((x) => {
    x.onclick = async () => {
      const f = byId(x.dataset.del);
      if (!(await uiConfirm(`Удалить бюллетень «${f.name}»? Документы по нему больше не собрать.`, { ok: "Удалить", danger: true }))) return;
      try { await api(`/bulletins/forms/${f.id}`, { method: "DELETE" }); toast("Бюллетень удалён"); await refreshBulletinAccess(); refreshNav(); renderBulletinForms(main); }
      catch (e) { toast(e.message, true); }
    };
  });
}

// ---- Разбор таблицы — администраторам ----------------------------------------
// Разовая настройка под выгрузку: с каких листов и столбцов брать значения,
// какие строки выводить. Отделы её не видят — им хватает шаблонов.

const BULL_RULE_HINT = "Коды: # — цифра, @ — латинская буква, * — что угодно; несколько — через запятую (10, 11, 12). "
  + "Если столбца кода нет, маска сверяется с наименованием: «Российская Федерация, *федеральный округ». "
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
      name: "", warnings: [],
      settings: { fileName: "{название}_{ММ}_{ГГГГ}", nameCol: "A", codeCol: "B", valueCols: ["C", "D", "E"],
        rules: [{ kind: "раздел", codes: "@", sections: [], sentenceCase: true }, { kind: "вид", codes: "##", sections: [], sentenceCase: false }],
        timesFrom: 200, digits: 1 },
    };
  } catch (e) { page.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const s = f.settings;
  page.innerHTML = `
    <div class="form-narrow">
      <div class="form-card">
        <div class="form-card-title" style="margin-bottom:16px;">${id ? "Разбор таблицы" : "Новый бюллетень"}</div>
        <div class="form-row" style="margin-bottom:12px">
          <div><div class="field-label">Название бюллетеня</div><input class="field-input" id="bfName" maxlength="80" value="${esc(f.name)}" placeholder="350 Индексы производства"></div>
          <div><div class="field-label">Имя файла: {название} {ММ} {ГГГГ} {месяц}</div>
            <input class="field-input mono" id="bfFileName" maxlength="100" value="${esc(s.fileName)}"></div>
        </div>
        <div class="field-label">Шаблон Word ${id ? `(сейчас: ${esc(f.filename)}; приложите новый, чтобы заменить)` : ""}</div>
        <input type="file" class="field-input" id="bfFile" accept=".docx" style="margin-bottom:12px">
        <div class="form-row" style="margin-bottom:12px">
          <div><div class="field-label">Столбец наименования</div><input class="field-input mono" id="bfNameCol" maxlength="2" value="${esc(s.nameCol)}"></div>
          <div><div class="field-label">Столбец кода (пусто — по наименованию)</div><input class="field-input mono" id="bfCodeCol" maxlength="2" value="${esc(s.codeCol)}"></div>
          <div><div class="field-label">Столбцы значений → {1} {2} …</div><input class="field-input mono" id="bfValueCols" value="${esc(s.valueCols.join(", "))}"></div>
        </div>
        <div class="as-note" style="margin:-6px 0 12px">Столбец значения — буква (C) или * — последний заполненный;
          с другого листа — «лист!столбец»: <code>1!*, 3!*, 2!*</code>. Таблица документа идёт по строкам листа первого столбца,
          значения с других листов находятся по коду, а без него — по наименованию.</div>
        <div class="form-row" style="margin-bottom:12px">
          <div><div class="field-label">Строки с (код или наименование; пусто — с начала)</div>
            <input class="field-input" id="bfFrom" maxlength="200" value="${esc(s.rangeFrom || "")}" placeholder="Российская Федерация"></div>
          <div><div class="field-label">до, не включая (пусто — до конца)</div>
            <input class="field-input" id="bfTo" maxlength="200" value="${esc(s.rangeTo || "")}" placeholder="Северо-Западный федеральный округ"></div>
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
      ${!id ? `<div class="as-note" style="margin:-4px 0 14px">Кому виден новый бюллетень — отметьте у групп в Администрировании → Бюллетени.</div>` : ""}
      ${f.warnings && f.warnings.length ? `<div class="as-note" style="color:var(--red);margin-bottom:12px">${f.warnings.map(esc).join("<br>")}</div>` : ""}
      <div class="form-foot"><div class="hint" id="bfMsg"></div><div class="actions">
        <button class="btn-text" id="bfBack" type="button">К шаблонам</button>
        <button class="btn-send" id="bfSave">Сохранить</button></div></div>
    </div>`;
  const $ = (sel) => page.querySelector(sel);
  const wireRules = () => page.querySelectorAll(".bf-rule-del").forEach((x) => { x.onclick = () => x.closest("tr").remove(); });
  wireRules();
  $("#bfAddRule").onclick = () => { $("#bfRules").insertAdjacentHTML("beforeend", bulletinRuleRow({})); wireRules(); };
  $("#bfBack").onclick = () => renderBulletinForms(main);
  const msg = $("#bfMsg");
  $("#bfSave").onclick = async () => {
    const settings = {
      fileName: $("#bfFileName").value,
      nameCol: $("#bfNameCol").value, codeCol: $("#bfCodeCol").value,
      // Только запятая: в имени листа бывает пробел («Лист 1!C»).
      valueCols: $("#bfValueCols").value.split(/[,;]/).map((x) => x.trim()).filter(Boolean),
      rangeFrom: $("#bfFrom").value, rangeTo: $("#bfTo").value,
      timesFrom: Number($("#bfTimes").value), digits: Number($("#bfDigits").value),
      rules: [...page.querySelectorAll(".bf-rule")].map((tr) => ({
        kind: tr.querySelector(".bf-kind").value, codes: tr.querySelector(".bf-codes").value,
        sections: tr.querySelector(".bf-sections").value, sentenceCase: tr.querySelector(".bf-case").checked,
      })).filter((r) => r.kind || r.codes),
    };
    const fd = new FormData();
    fd.append("payload", JSON.stringify({ name: $("#bfName").value, settings }));
    if ($("#bfFile").files[0]) fd.append("file", $("#bfFile").files[0]);
    msg.classList.remove("invalid"); msg.textContent = "Сохраняю…";
    try {
      const r = await api(id ? `/bulletins/forms/${id}` : "/bulletins/forms", { method: id ? "PUT" : "POST", body: fd });
      await refreshBulletinAccess(); refreshNav();
      if (r.warnings && r.warnings.length) {
        toast(`Сохранено, но: ${r.warnings.join("; ")}`, true);
        return bulletinFormEditor(main, id || r.id);
      }
      toast("Сохранено");
      renderBulletinForms(main);
    } catch (e) { msg.classList.add("invalid"); msg.textContent = e.message; }
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
    : `<div class="as-note">Бюллетеней пока нет — их добавляют в разделе «Бюллетени → Шаблоны».</div>`;
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
      <div class="field-label" style="margin-top:10px">Бюллетени группы</div>
      <div>${formChecks(g ? g.forms : [])}</div>
      <label class="grp-check"><input type="checkbox" class="bg-manage" ${g && g.can_manage ? "checked" : ""}> Может менять шаблоны бюллетеней группы и делать новые по образцу (раздел «Бюллетени → Шаблоны»)</label>
      <div class="grp-actions">
        ${g ? `<button class="btn btn-ghost bg-del">Удалить группу</button>` : ""}
        <span class="grp-msg"></span>
        <button class="btn btn-wire bg-save">${g ? "Сохранить" : "Добавить"}</button>
      </div>
    </div>`;
  box.innerHTML = `
    <div class="as-note" style="margin-bottom:14px;max-width:820px">Сотрудник видит раздел «Бюллетени», если состоит в группе: по группе домена
      (как она была при его последнем входе) или по логину в списке. У каждой группы свой набор бюллетеней.
      Администраторы платформы видят и правят все.</div>
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
      if (!(await uiConfirm(`Удалить группу «${name}»? Бюллетени останутся, но её участники их больше не увидят.`, { ok: "Удалить", danger: true }))) return;
      try { await api(`/bulletins/groups/${id}`, { method: "DELETE" }); toast("Группа удалена"); renderBulletinGroupsAdmin(box); }
      catch (e) { say(false, e.message); }
    };
  });
}
