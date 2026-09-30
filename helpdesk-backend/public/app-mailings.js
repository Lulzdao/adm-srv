// ====== Ассистент: рассылки респондентам ======
//
// Три шага на одном экране: список -> письмо -> с какого ящика. До отправки
// видно, кому уйдёт, у кого адрес с ошибкой и как будет выглядеть письмо
// первому получателю. Дальше — карточка рассылки с ходом отправки, паузой,
// повтором неотправленных и отчётом.
//
// Пароль от своего ящика уходит только на сервер и живёт там в памяти, пока
// идёт отправка; в браузере он тоже нигде не сохраняется.

// Инструкция, как создать пароль приложения в почте: для своего ящика почта
// принимает только его. Файл лежит в public/docs — заменить его можно без
// правки кода, достаточно положить новый под тем же именем.
const APP_PASSWORD_GUIDE = "/docs/app-password.pdf";

const MAIL_STATUS = {
  sending: ["идёт отправка", "blue"], paused: ["на паузе", "orange"], done: ["завершена", "green"], cancelled: ["отменена", ""],
};
const MAIL_ROW_STATUS = { sent: ["отправлено", "green"], failed: ["не отправлено", "red"], pending: ["в очереди", ""] };

function mailProgress(c) {
  const done = (c.sent || 0) + (c.failed || 0);
  const pct = c.total ? Math.round((done / c.total) * 100) : 0;
  return `<div class="as-prog"><i style="width:${pct}%"></i></div>
    <div class="as-sub">${c.sent || 0} из ${c.total} отправлено${c.failed ? ` · <span class="as-red">${c.failed} не отправлено</span>` : ""}</div>`;
}

async function renderMailings(main) {
  clearViewPoll();
  main.innerHTML = `
    ${asstTopbar("Рассылки", `<button class="btn btn-wire" id="mNew">${icon("plus", 15)} Новая рассылка</button>`)}
    <div class="page"><div id="mList"><div class="spinner">Загрузка…</div></div></div>`;
  main.querySelector("#mNew").onclick = () => renderMailingNew(main);
  let data;
  try { data = await api("/mailings"); } catch (e) { main.querySelector("#mList").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const list = main.querySelector("#mList");
  if (!list) return;
  if (!data.campaigns.length) {
    list.innerHTML = `<div class="empty-state">Рассылок пока нет. Загрузите список респондентов (CSV или Excel с колонками ОКПО, наименование, почта) — кнопкой «Новая рассылка».</div>`;
    return;
  }
  list.innerHTML = `
    <div class="as-table-wrap"><table class="as-table as-click"><thead><tr><th>Тема</th><th>Когда</th><th>С адреса</th>${state.user.is_admin ? "<th>Автор</th>" : ""}<th>Статус</th><th style="width:220px">Ход</th></tr></thead>
    <tbody>${data.campaigns.map((c) => {
      const [label, cls] = MAIL_STATUS[c.status];
      return `<tr data-id="${c.id}"><td><b>${esc(c.subject)}</b></td><td class="nowrap">${esc(fmtDate(c.created_at))}</td>
        <td class="as-sub">${esc(c.sender_address)}</td>${state.user.is_admin ? `<td class="as-sub">${esc(c.author)}</td>` : ""}
        <td><span class="as-badge ${cls}">${label}</span></td><td>${mailProgress(c)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  list.querySelectorAll("tr[data-id]").forEach((tr) => { tr.onclick = () => setView("asst:mail", Number(tr.dataset.id)); });
  // Пока что-то отправляется — список обновляется сам.
  if (data.campaigns.some((c) => c.status === "sending")) {
    viewPollHandle = setInterval(() => { if (state.view === "asst:mail" && !state.mailOpenId && main.querySelector("#mList")) renderMailings(main); }, 4000);
  }
}

async function renderMailingNew(main) {
  clearViewPoll();
  let settings;
  try { settings = await api("/mailings/settings"); } catch (e) { toast(e.message, true); return; }
  const st = { recipients: [], columns: [], skipDup: true, files: [], mode: settings.from ? "shared" : "own" };

  main.innerHTML = `
    <div class="topbar"><div class="topbar-title-row"><button class="icon-btn" id="mBack" title="Назад">${icon("chevron", 18)}</button><div class="topbar-title">Новая рассылка</div></div></div>
    <div class="page"><div class="form-narrow">
      ${settings.configured ? "" : `<div class="warn-box">Почтовый сервер для рассылок не настроен — ${state.user.is_admin ? `задайте его в <a href="#asst:settings">настройках</a> («Почта рассылок»)` : "обратитесь к администратору"}.</div>`}
      <div class="form-card">
        <div class="form-card-title">1. Кому</div>
        <div class="form-card-sub">CSV или Excel: колонки «ОКПО», «Наименование», «Почта» (названия — примерно такие; в ячейке с почтой может быть несколько адресов через запятую)</div>
        <div class="dropzone" id="mDrop" style="margin-bottom:0"><span class="dropzone-icon">${icon("upload", 18)}</span>Перетащите файл со списком сюда или нажмите, чтобы выбрать</div>
        <input type="file" id="mFile" accept=".csv,.xlsx,.txt" hidden>
        <div id="mParsed"></div>
      </div>
      <div class="form-card">
        <div class="form-card-title" style="margin-bottom:14px">2. Письмо</div>
        <div class="field-label">Тема *</div>
        <input class="field-input" id="mSubject" maxlength="200">
        <div class="field-label">Текст *</div>
        <textarea class="field-input" id="mBody" rows="7" style="resize:vertical;margin-bottom:6px" placeholder="Напоминаем о сроке сдачи отчёта…"></textarea>
        <div class="as-note" id="mFields"></div>
        <label class="as-check" style="margin:12px 0"><input type="checkbox" id="mTpl" checked><span>Обращение и реквизиты респондента: «Здравствуйте, уважаемый респондент! ОКПО… Наименование…» и подпись «${esc(settings.signature)}»</span></label>
        <div class="dropzone" id="aDrop"><span class="dropzone-icon">${icon("paperclip", 18)}</span>Вложения — не больше 10 МБ вместе</div>
        <input type="file" id="aFile" multiple hidden>
        <div id="aList"></div>
        <div class="field-label" style="margin-top:6px">Так письмо увидит первый получатель</div>
        <pre class="as-preview" id="mPreview">Загрузите список и напишите текст</pre>
      </div>
      <div class="form-card">
        <div class="form-card-title" style="margin-bottom:14px">3. С какого ящика</div>
        <div class="toggle-group" id="mMode" style="margin-bottom:14px">
          ${settings.from ? `<button class="toggle-btn" data-m="shared">Общий ящик — ${esc(settings.from)}</button>` : ""}
          ${settings.allowOwn ? `<button class="toggle-btn" data-m="own">Свой ящик</button>` : ""}
        </div>
        <div id="mOwn">
          <div class="form-row" style="margin-bottom:0">
            <div><div class="field-label">Ваш адрес *</div><input class="field-input" id="mAddr" value="${esc(state.user.email || "")}" autocomplete="off"></div>
            <div><div class="field-label">Пароль приложения *</div><input class="field-input" id="mPass" type="password" autocomplete="new-password"></div>
          </div>
          <div class="as-note-row">
            <a class="btn btn-ghost as-btn-sm" href="${APP_PASSWORD_GUIDE}" target="_blank" rel="noopener">${icon("doc", 14)} Как получить пароль приложения</a>
            <span class="as-note">Почта принимает только пароль приложения, а не обычный пароль от почты. Он нигде не сохраняется: нужен, только пока идёт отправка.</span>
          </div>
        </div>
        <div class="as-note" id="mSharedNote">Ответы респондентов придут вам${state.user.email ? ` на ${esc(state.user.email)}` : ""}, а не в общий ящик. Отчёт о доставке — тоже вам.</div>
      </div>
      <div class="form-foot">
        <div class="hint" id="mHint">Письма уходят по одному с паузой ${Math.round(settings.delayMs / 100) / 10} с — так почтовый сервер не примет рассылку за спам</div>
        <div class="actions"><button class="btn btn-wire" id="mSend" disabled>Отправить</button></div>
      </div>
    </div></div>`;
  const $ = (id) => main.querySelector("#" + id);
  $("mBack").onclick = () => setView("asst:mail");

  const chosen = () => st.recipients.filter((r) => !r.problem && !(st.skipDup && r.duplicateOf));
  const paintMode = () => {
    main.querySelectorAll("#mMode .toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.m === st.mode));
    $("mOwn").hidden = st.mode !== "own";
    $("mSharedNote").hidden = st.mode !== "shared";
  };
  main.querySelectorAll("#mMode .toggle-btn").forEach((b) => { b.onclick = () => { if (!b.disabled) { st.mode = b.dataset.m; paintMode(); } }; });
  paintMode();

  const fill = (text, r) => {
    const map = new Map(Object.entries({ ...(r.fields || {}), ОКПО: r.okpo || "", Наименование: r.name || "" })
      .map(([k, v]) => [k.trim().toLowerCase().replace(/ё/g, "е"), v]));
    return text.replace(/\{([^{}\n]{1,60})\}/g, (all, k) => { const key = k.trim().toLowerCase().replace(/ё/g, "е"); return map.has(key) ? map.get(key) : all; });
  };
  const paintPreview = () => {
    const r = chosen()[0];
    const body = $("mBody").value;
    const n = chosen().length;
    $("mSend").disabled = !n || !settings.configured;
    $("mSend").textContent = n ? `Отправить ${n} ${n % 10 === 1 && n % 100 !== 11 ? "письмо" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "письма" : "писем"}` : "Отправить";
    if (!r || !body.trim()) { $("mPreview").textContent = "Загрузите список и напишите текст"; return; }
    let text = fill(body, r);
    if ($("mTpl").checked) {
      const head = ["Здравствуйте, уважаемый респондент!"];
      if (r.okpo) head.push(`ОКПО: ${r.okpo}`);
      if (r.name) head.push(`Наименование: ${r.name}`);
      text = `${head.join("\n")}\n\n${text}\n\nС уважением,\n${settings.signature}`;
    }
    $("mPreview").textContent = `Кому: ${r.emails.join(", ")}\nТема: ${fill($("mSubject").value, r)}\n\n${text}`;
  };
  ["mBody", "mSubject"].forEach((id) => { $(id).oninput = paintPreview; });
  $("mTpl").onchange = paintPreview;

  const paintParsed = () => {
    const all = st.recipients;
    const bad = all.filter((r) => r.problem);
    const dup = all.filter((r) => !r.problem && r.duplicateOf);
    const ok = chosen();
    $("mParsed").innerHTML = `
      <div class="as-parsed">
        <span class="as-badge green">${ok.length} получат письмо</span>
        ${bad.length ? `<span class="as-badge red">${bad.length} без правильного адреса</span>` : ""}
        ${dup.length ? `<label class="as-check"><input type="checkbox" id="mDup" ${st.skipDup ? "checked" : ""}><span>не слать повторно на те же адреса (${dup.length})</span></label>` : ""}
        <button class="btn btn-text as-btn-sm" id="mReset">Другой файл</button>
      </div>
      ${bad.length ? `<div class="as-bad">${bad.slice(0, 20).map((r) => `<div>строка ${r.row_no}: ${esc(r.name || r.okpo || "")} — ${esc(r.problem)}</div>`).join("")}${bad.length > 20 ? `<div>…и ещё ${bad.length - 20}</div>` : ""}</div>` : ""}
      <div class="as-table-wrap"><table class="as-table" style="margin-top:10px"><thead><tr><th>Строка</th><th>ОКПО</th><th>Наименование</th><th>Почта</th></tr></thead>
      <tbody>${ok.slice(0, 8).map((r) => `<tr><td>${r.row_no}</td><td class="mono">${esc(r.okpo)}</td><td>${esc(r.name)}</td><td>${esc(r.emails.join(", "))}</td></tr>`).join("")}</tbody></table></div>
      ${ok.length > 8 ? `<div class="as-note" style="margin-top:6px">…и ещё ${ok.length - 8}</div>` : ""}`;
    const dupCb = $("mParsed").querySelector("#mDup");
    if (dupCb) dupCb.onchange = () => { st.skipDup = dupCb.checked; paintParsed(); };
    $("mParsed").querySelector("#mReset").onclick = () => { st.recipients = []; $("mParsed").innerHTML = ""; $("mDrop").hidden = false; paintPreview(); };
    $("mDrop").hidden = true;
    $("mFields").innerHTML = st.columns.length ? `Подстановки (щелчок — вставить в текст): ${st.columns.map((c) => `<button type="button" class="as-chip" data-f="${esc(c)}">{${esc(c)}}</button>`).join(" ")}` : "";
    $("mFields").querySelectorAll("[data-f]").forEach((b) => {
      b.onclick = () => {
        const ta = $("mBody"), tag = `{${b.dataset.f}}`;
        const p = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, p) + tag + ta.value.slice(ta.selectionEnd ?? p);
        ta.focus(); ta.selectionStart = ta.selectionEnd = p + tag.length;
        paintPreview();
      };
    });
    paintPreview();
  };

  const parseFile = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api("/mailings/parse", { method: "POST", body: fd });
      st.recipients = r.recipients;
      st.columns = r.columns;
      paintParsed();
    } catch (e) { toast(e.message, true); }
  };
  const dropzone = (zone, input, onFiles) => {
    zone.onclick = () => input.click();
    input.onchange = () => { if (input.files.length) onFiles([...input.files]); input.value = ""; };
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); };
    zone.ondragleave = () => zone.classList.remove("over");
    zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove("over"); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); };
  };
  dropzone($("mDrop"), $("mFile"), (files) => parseFile(files[0]));
  const paintFiles = () => {
    const total = st.files.reduce((n, f) => n + f.size, 0);
    $("aList").innerHTML = st.files.map((f, i) => `<div class="file-chip"><span class="file-chip-name">${icon("paperclip", 14)} ${esc(f.name)} <span class="as-muted">${(f.size / 1024 / 1024).toFixed(2)} МБ</span></span>
      <span class="file-chip-remove" data-i="${i}">${icon("x", 13)}</span></div>`).join("")
      + (total > 10 * 1024 * 1024 ? `<div class="as-red as-sub">Вместе ${(total / 1024 / 1024).toFixed(1)} МБ — больше 10 МБ не пройдёт</div>` : "");
    $("aList").querySelectorAll("[data-i]").forEach((x) => { x.onclick = () => { st.files.splice(Number(x.dataset.i), 1); paintFiles(); }; });
  };
  dropzone($("aDrop"), $("aFile"), (files) => { st.files.push(...files); st.files = st.files.slice(0, 10); paintFiles(); });

  $("mSend").onclick = async () => {
    const list = chosen();
    if (!$("mSubject").value.trim() || !$("mBody").value.trim()) { toast("Заполните тему и текст письма", true); return; }
    if (st.mode === "own" && (!$("mAddr").value.trim() || !$("mPass").value)) { toast("Укажите свой адрес и пароль приложения", true); return; }
    if (!confirm(`Отправить ${list.length} писем с адреса ${st.mode === "own" ? $("mAddr").value.trim() : settings.from}?`)) return;
    const fd = new FormData();
    fd.append("payload", JSON.stringify({
      subject: $("mSubject").value, body: $("mBody").value, use_template: $("mTpl").checked, sender_mode: st.mode,
      own_address: $("mAddr").value, own_password: $("mPass").value,
      recipients: list.map((r) => ({ row_no: r.row_no, okpo: r.okpo, name: r.name, emails: r.emails, fields: r.fields })),
    }));
    for (const f of st.files) fd.append("attachments", f, f.name);
    $("mSend").disabled = true;
    $("mHint").textContent = st.mode === "own" ? "Проверяю вход в ваш ящик…" : "Ставлю в очередь…";
    try {
      const r = await api("/mailings", { method: "POST", body: fd });
      $("mPass").value = "";
      toast("Рассылка запущена");
      setView("asst:mail", r.id);
    } catch (e) {
      toast(e.message, true);
      $("mHint").innerHTML = esc(e.message) + (/пароль приложения/i.test(e.message)
        ? ` <a href="${APP_PASSWORD_GUIDE}" target="_blank" rel="noopener">Инструкция</a>` : "");
      $("mSend").disabled = false;
    }
  };
}

let mailRowFilter = "";

async function renderMailing(main, id) {
  let data;
  try { data = await api(`/mailings/${id}`); } catch (e) {
    toast(e.message, true);
    setView("asst:mail", null, { replace: true });
    return;
  }
  if (state.view !== "asst:mail" || state.mailOpenId !== id) return;
  const c = data.campaign;
  const [label, cls] = MAIL_STATUS[c.status];
  const rows = mailRowFilter ? data.recipients.filter((r) => r.status === mailRowFilter) : data.recipients;
  const needPass = c.sender_mode === "own";
  main.innerHTML = `
    <div class="topbar"><div class="topbar-title-row"><button class="icon-btn" id="mBack" title="К списку">${icon("chevron", 18)}</button>
      <div class="topbar-title">${esc(c.subject)}</div></div>
      <div class="as-top-actions">
        ${c.status === "sending" ? `<button class="btn btn-ghost" data-act="pause">${icon("pause", 15)} Пауза</button>` : ""}
        ${c.status === "paused" ? `<button class="btn btn-wire" data-act="resume">${icon("play", 15)} Продолжить</button>` : ""}
        ${c.failed && c.status !== "sending" ? `<button class="btn btn-ghost" data-act="retry">${icon("refresh", 15)} Повторить неотправленные</button>` : ""}
        <button class="btn btn-ghost" id="mRep">${icon("download", 15)} Отчёт в Excel</button>
        ${c.status === "sending" || c.status === "paused" ? `<button class="btn btn-text" data-act="cancel">Отменить</button>` : `<button class="btn btn-text" id="mDel">Удалить</button>`}
      </div></div>
    <div class="page">
      ${c.status === "paused" && c.paused_reason ? `<div class="warn-box">${esc(c.paused_reason)}</div>` : ""}
      <div class="as-cols">
        <div>
          <div class="as-mhead">
            <span class="as-badge ${cls}">${label}</span>
            <span class="as-sub">с адреса ${esc(c.sender_address)} · ${esc(fmtDate(c.created_at))} · ${esc(c.author || "")}</span>
          </div>
          <div style="max-width:520px;margin:10px 0 18px">${mailProgress(c)}</div>
          <div class="toggle-group" id="mRowF" style="margin-bottom:12px">
            ${[["", `Все ${data.recipients.length}`], ["sent", `Отправлено ${c.sent}`], ["failed", `Не отправлено ${c.failed}`], ["pending", `В очереди ${c.pending}`]]
              .map(([f, l]) => `<button class="toggle-btn${mailRowFilter === f ? " active" : ""}" data-f="${f}">${l}</button>`).join("")}
          </div>
          <div class="as-table-wrap"><table class="as-table"><thead><tr><th>Строка</th><th>ОКПО</th><th>Наименование</th><th>Почта</th><th>Статус</th></tr></thead>
          <tbody>${rows.slice(0, 500).map((r) => {
            const [l, k] = MAIL_ROW_STATUS[r.status];
            return `<tr><td>${r.row_no}</td><td class="mono">${esc(r.okpo || "")}</td><td>${esc(r.name || "")}</td><td>${esc(r.emails)}</td>
              <td><span class="as-badge ${k}">${l}</span>${r.error ? `<div class="as-sub as-red">${esc(r.error)}</div>` : ""}</td></tr>`;
          }).join("")}</tbody></table></div>
        </div>
        <div>
          <div class="as-sec">Письмо</div>
          <pre class="as-preview">${esc(data.preview)}</pre>
          ${data.attachments.length ? `<div class="as-sec" style="margin-top:14px">Вложения</div>${data.attachments.map((a) => `<div class="file-chip"><span class="file-chip-name">${icon("paperclip", 14)} ${esc(a.filename)}</span><span class="as-muted">${(a.size / 1024).toFixed(0)} КБ</span></div>`).join("")}` : ""}
        </div>
      </div>
    </div>`;
  const $ = (x) => main.querySelector("#" + x);
  $("mBack").onclick = () => setView("asst:mail");
  $("mRep").onclick = () => asstDownload(`/mailings/${id}/report`);
  main.querySelectorAll("#mRowF .toggle-btn").forEach((b) => { b.onclick = () => { mailRowFilter = b.dataset.f; renderMailing(main, id); }; });
  const del = $("mDel");
  if (del) del.onclick = async () => {
    if (!confirm("Удалить рассылку вместе с отчётом и вложениями?")) return;
    try { await api(`/mailings/${id}`, { method: "DELETE" }); setView("asst:mail"); } catch (e) { toast(e.message, true); }
  };
  main.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === "cancel" && !confirm("Отменить рассылку? Неотправленные письма не уйдут.")) return;
      const body = {};
      if (needPass && (act === "resume" || act === "retry")) {
        const pass = await askMailPassword(c);
        if (pass === null) return;
        if (pass) body.password = pass;
      }
      try { await api(`/mailings/${id}/${act}`, { method: "POST", body }); renderMailing(main, id); } catch (e) { toast(e.message, true); }
    };
  });
  clearViewPoll();
  if (c.status === "sending") {
    viewPollHandle = setInterval(() => { if (state.view === "asst:mail" && state.mailOpenId === id) renderMailing(main, id); }, 3000);
  }
}

/** Пароль своего ящика для продолжения. Пусто — «попробовать без него» (он ещё в памяти сервера). */
function askMailPassword(c) {
  return new Promise((resolve) => {
    const m = asstModal("Пароль приложения", `
      <div class="as-note" style="margin-bottom:12px">Рассылка идёт с ящика ${esc(c.sender_address)}. Если служба перезапускалась или пароль был неверным, введите его заново; после обычной паузы можно оставить поле пустым.
        Нужен пароль приложения — <a href="${APP_PASSWORD_GUIDE}" target="_blank" rel="noopener">как его получить</a>.</div>
      <input class="field-input" id="mpPass" type="password" autocomplete="new-password">
      <div class="td-form-foot"><button class="btn btn-text" data-cancel>Отмена</button><button class="btn btn-wire" data-ok>Продолжить</button></div>`);
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    m.el.querySelector("[data-cancel]").onclick = () => finish(null);
    m.el.querySelector("[data-ok]").onclick = () => finish(m.el.querySelector("#mpPass").value);
    m.el.querySelector("#mpPass").onkeydown = (e) => { if (e.key === "Enter") finish(e.target.value); };
    // Закрыли крестиком или щелчком мимо — как «Отмена».
    new MutationObserver((_, obs) => { if (!m.el.isConnected) { obs.disconnect(); finish(null); } }).observe(document.body, { childList: true });
  });
}

// ---- Настройки почты рассылок (вкладка в настройках Ассистента) ----------

async function mailSettingsTab(box) {
  const s = await api("/mailings/settings");
  box.innerHTML = `
    <div class="form-narrow" style="margin:0;max-width:760px">
      <div class="form-card">
        <div class="form-card-title" style="margin-bottom:14px">Почтовый сервер</div>
        <div class="form-row">
          <div><div class="field-label">Сервер</div><input class="field-input" id="msHost" value="${s.hostFromPlatform ? "" : esc(s.host)}" placeholder="${s.hostFromPlatform && s.host ? `как у оповещений: ${esc(s.host)}` : "mail.example"}"></div>
          <div style="max-width:120px"><div class="field-label">Порт</div><input class="field-input" id="msPort" type="number" value="${s.port}"></div>
          <div style="max-width:160px"><div class="field-label">Шифрование</div><label class="as-check" style="margin-top:12px"><input type="checkbox" id="msTls" ${s.secure ? "checked" : ""}><span>TLS (порт 465)</span></label></div>
        </div>
        <div class="as-note">Пусто — тот же сервер, что у оповещений платформы.</div>
      </div>
      <div class="form-card">
        <div class="form-card-title" style="margin-bottom:14px">Общий ящик</div>
        <div class="form-row">
          <div><div class="field-label">Адрес отправителя</div><input class="field-input" id="msFrom" value="${esc(s.sharedFrom)}" placeholder="rassylka@…"></div>
          <div><div class="field-label">Логин</div><input class="field-input" id="msUser" value="${esc(s.user)}" autocomplete="off"></div>
          <div><div class="field-label">Пароль</div><input class="field-input" id="msPass" type="password" autocomplete="new-password" placeholder="${s.hasPassword ? "задан — пусто, чтобы не менять" : ""}"></div>
          <div><div class="field-label">Группа домена с доступом</div><input class="field-input" id="msGroup" value="${esc(s.sharedGroup)}" placeholder="пусто — всем" autocomplete="off"></div>
        </div>
        <div class="as-note" style="margin-bottom:12px">Если группа задана, общий ящик видят и могут выбрать только её участники; остальные отправляют со своего ящика.
          Имя группы — как в AD (без учёта регистра). Состав группы платформа узнаёт при входе сотрудника: кого добавили в группу — увидит ящик после повторного входа.</div>
        <label class="as-check"><input type="checkbox" id="msOwn" ${s.allowOwn ? "checked" : ""}><span>Разрешить сотрудникам отправлять со своего ящика</span></label>
      </div>
      <div class="form-card">
        <div class="form-row" style="margin-bottom:0">
          <div style="max-width:220px"><div class="field-label">Пауза между письмами, секунд</div><input class="field-input" id="msDelay" type="number" min="0" max="60" step="0.5" value="${s.delayMs / 1000}"></div>
          <div><div class="field-label">Подпись в шаблоне письма</div><input class="field-input" id="msSign" value="${esc(s.signature)}"></div>
        </div>
        <div class="as-note">300 писем с паузой 3 с уходят примерно за 15 минут. Меньше 1 с — риск, что почтовый сервер сочтёт рассылку спамом.</div>
      </div>
      <div class="form-foot"><div class="hint" id="msHint"></div>
        <div class="actions"><button class="btn btn-ghost" id="msTest">Проверить соединение</button><button class="btn btn-wire" id="msSave">Сохранить</button></div></div>
    </div>`;
  const $ = (id) => box.querySelector("#" + id);
  const save = async () => {
    const body = {
      host: $("msHost").value, port: $("msPort").value, secure: $("msTls").checked, from: $("msFrom").value, user: $("msUser").value, sharedGroup: $("msGroup").value,
      delayMs: Math.round(Number($("msDelay").value || 0) * 1000), signature: $("msSign").value, allowOwn: $("msOwn").checked,
    };
    if ($("msPass").value) body.password = $("msPass").value;
    await api("/mailings/settings", { method: "PUT", body });
  };
  $("msSave").onclick = async () => {
    try { await save(); toast("Сохранено"); mailSettingsTab(box); } catch (e) { toast(e.message, true); }
  };
  $("msTest").onclick = async () => {
    $("msHint").textContent = "Проверяю…";
    try {
      await save();
      const r = await api("/mailings/settings/verify", { method: "POST" });
      $("msHint").textContent = r.ok ? "Соединение и вход в общий ящик — в порядке" : r.error;
      $("msHint").classList.toggle("invalid", !r.ok);
    } catch (e) { $("msHint").textContent = e.message; }
  };
}
