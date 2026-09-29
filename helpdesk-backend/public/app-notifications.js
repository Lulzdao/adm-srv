// Фронтенд платформы: оповещения — лента, шаблоны, отправка.
// Обычный скрипт без сборщика — функции общие для всех файлов страницы (см. index.html: app.js
// подключается первым, запуск — в нём по DOMContentLoaded, когда загружены все).
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
    <div>
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

// Шаблон правят по одному, а не читают все подряд: категорий десять, каждая с
// темой, текстом и списком подстановок, и простыня из десяти карточек прокручивалась
// экранов на пять. Показываем ту, что выбрали в списке; выбор запоминаем на время
// сессии, чтобы после сохранения и возврата на вкладку не искать её заново.
const TPL_PICK_KEY = "adm.tplPick";
// Тот же приём на вкладке «Отправка»: список получателей правят по одному.
const RCP_PICK_KEY = "adm.rcpPick";

function renderNotifTemplates(page, kinds) {
  let picked = null;
  try { picked = sessionStorage.getItem(TPL_PICK_KEY); } catch { /* приватный режим */ }
  if (!kinds.some(k => k.kind === picked)) picked = kinds.length ? kinds[0].kind : null;

  page.innerHTML = `
    <div>
      <div class="card" style="margin-bottom:18px;">
        <div class="field-label">Шаблон какой категории править</div>
        <select class="input field-select" id="tplPick" style="width:100%;">
          ${kinds.map(k => `<option value="${esc(k.kind)}" ${k.kind === picked ? "selected" : ""}>${esc(k.label)}</option>`).join("")}
        </select>
        <div style="font-size:12.5px;color:var(--ink-soft);margin-top:12px;">
          Подстановки пишутся в двойных фигурных скобках. Кнопка «Предпросмотр» показывает
          письмо на выдуманном примере — править шаблон вслепую значит однажды разослать
          письмо с опечаткой в самой подстановке.
        </div>
      </div>
      <div id="tplHost"></div>
    </div>`;

  enhanceSelects(page);
  const host = page.querySelector("#tplHost");
  const show = (kind) => {
    const k = kinds.find(x => x.kind === kind);
    if (!k) return;
    try { sessionStorage.setItem(TPL_PICK_KEY, kind); } catch { /* приватный режим */ }
    host.innerHTML = templateCardHtml(k);
    wireTemplateCards(host);
  };
  page.querySelector("#tplPick").onchange = (e) => show(e.target.value);
  if (picked) show(picked);
}

function wireTemplateCards(page) {
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
  const [{ smtp }, { deliveries }, schedule] = await Promise.all([
    api("/notifications/smtp"), api("/notifications/deliveries"), api("/notifications/schedule"),
  ]);

  const withList = kinds.filter(k => k.recipients === "list");
  const derived = kinds.filter(k => k.recipients !== "list");

  page.innerHTML = `
    <div>
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
            <input class="input" id="smFrom" value="${esc(smtp.from || "")}" placeholder="Центр &lt;it@lipetskstat.ru&gt;" style="width:100%;" /></div>
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
        <div class="section-label">Проверка по расписанию</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
          Сроки и минуты платформа проверяет сама: обход раз в час, задания выполняются
          не чаще одного раза за своё окно — сутки или месяц. Пропущенные дни не теряются:
          порог считается от даты документа, а не от того, сколько раз мы на него посмотрели.
        </div>

        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;">
          <div style="width:210px;">
            <div class="field-label">Час ежедневной проверки</div>
            <input class="input" id="schHour" type="number" min="0" max="23" value="${esc(String(schedule.hour))}" style="width:100%;" />
          </div>
          <button class="btn btn-ghost" id="schSave">Сохранить час</button>
          <span id="schMsg" style="font-size:12px;"></span>
        </div>

        ${schedule.jobs.map(jobRowHtml).join("")}
        ${schedule.startedOn ? `<div style="font-size:11.5px;color:var(--ink-soft);margin-top:12px;">
          Служба оповещений впервые запущена <span class="mono">${esc(schedule.startedOn)}</span>.
          Документы, просроченные более чем за месяц до этой даты, писем не порождают —
          иначе в первый же день уехала бы пачка «срочно выпустить новый» про архив.
        </div>` : ""}
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Кому уходят письма</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
          Адреса — по одному на строку. Проверяются при сохранении: опечатка иначе будет молчать
          ровно так же, как молчал ненастроенный сервер.
        </div>
        <div class="field-label">Список какой категории править</div>
        <select class="input field-select" id="rcpPick" style="width:100%;">
          ${withList.map(k => `<option value="${esc(k.kind)}">${esc(k.label)}${rcpBadge(k)}</option>`).join("")}
        </select>
        <div id="rcpHost"></div>
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

  const schMsg = page.querySelector("#schMsg");
  page.querySelector("#schSave").onclick = async () => {
    schMsg.style.color = "var(--ink-soft)"; schMsg.textContent = "Сохраняю…";
    try {
      await api("/notifications/schedule", { method: "PUT", body: { hour: Number(page.querySelector("#schHour").value) } });
      schMsg.style.color = "var(--green)"; schMsg.textContent = "Сохранено";
    } catch (e) { schMsg.style.color = "var(--red)"; schMsg.textContent = e.message; }
  };

  // Папка резервных копий: «Проверить» пишет пробный файл от имени службы, «Сохранить»
  // принимает только доступную папку (пусто — вернуться к .env / папке по умолчанию).
  page.querySelectorAll(".job-run").forEach(btn => {
    btn.onclick = async () => {
      const note = btn.parentElement.querySelector(".job-msg");
      note.style.color = "var(--ink-soft)"; note.textContent = "Проверяю…";
      try {
        // Обход не глядя на час и на отметку о сегодняшнем выполнении. Повторов
        // это не создаёт: от них защищает ключ события, а не расписание.
        const r = await api(`/notifications/schedule/${encodeURIComponent(btn.dataset.job)}/run`, { method: "POST", body: {} });
        if (r.ok) {
          note.style.color = "var(--green)";
          note.textContent = jobDetailText(r.detail);
          setTimeout(() => renderNotifications(page.closest("main") || page.parentElement, "smtp"), 2600);
        } else {
          note.style.color = "var(--red)"; note.textContent = r.error || r.skipped || "не выполнено";
        }
      } catch (e) { note.style.color = "var(--red)"; note.textContent = e.message; }
    };
  });

  const retryMsg = page.querySelector("#smRetryMsg");
  page.querySelector("#smRetry").onclick = async () => {
    retryMsg.style.color = "var(--ink-soft)"; retryMsg.textContent = "Отправляю…";
    try {
      const r = await api("/notifications/deliveries/retry", { method: "POST", body: {} });
      retryMsg.textContent = r.retried ? `Повторено: ${r.retried}` : "Нечего повторять";
      if (r.retried) setTimeout(() => renderNotifications(page.closest("main") || page.parentElement, "smtp"), 900);
    } catch (e) { retryMsg.style.color = "var(--red)"; retryMsg.textContent = e.message; }
  };

  // Список категорий вместо пяти карточек подряд — так же, как на вкладке
  // «Шаблоны». Правят их по одной, а прокручивать простыню, чтобы добраться до
  // нужной, приходилось каждый раз.
  //
  // В подписи каждой категории видно, сколько у неё получателей: иначе выбирать
  // пришлось бы вслепую, и незаполненный список нашёлся бы только перебором.
  const rcpHost = page.querySelector("#rcpHost");
  const rcpSelect = page.querySelector("#rcpPick");
  if (rcpSelect && rcpHost) {
    let pickedRcp = null;
    try { pickedRcp = sessionStorage.getItem(RCP_PICK_KEY); } catch { /* приватный режим */ }
    if (!withList.some(k => k.kind === pickedRcp)) pickedRcp = withList.length ? withList[0].kind : null;

    const showRcp = (kind) => {
      const k = withList.find(x => x.kind === kind);
      if (!k) return;
      try { sessionStorage.setItem(RCP_PICK_KEY, kind); } catch { /* приватный режим */ }
      rcpHost.innerHTML = recipientCardHtml(k);
      wireRecipientCards(rcpHost, withList);
    };
    rcpSelect.value = pickedRcp || "";
    rcpSelect.onchange = (e) => showRcp(e.target.value);
    if (pickedRcp) showRcp(pickedRcp);
  }

  enhanceSelects(page);
}

// Обвязка карточки получателей. Отдельно от renderNotifSmtp, потому что теперь
// карточка перерисовывается при каждом выборе категории, а не один раз.
function wireRecipientCards(host, withList) {
  host.querySelectorAll(".rcp-card").forEach(card => {
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

        // Подпись в списке категорий показывает число получателей — после
        // сохранения она обязана сойтись с полем, иначе выбор снова станет
        // гаданием.
        const k = withList.find(x => x.kind === kind);
        if (k) k.emails = field.value;
        refreshRcpOptions(withList);
      } catch (e) { note.style.color = "var(--red)"; note.textContent = e.message; }
    };
  });
}

// Пересобрать подписи в списке категорий, не трогая выбранную.
function refreshRcpOptions(withList) {
  const select = document.getElementById("rcpPick");
  if (!select) return;
  const current = select.value;
  select.innerHTML = withList
    .map(k => `<option value="${esc(k.kind)}">${esc(k.label)}${rcpBadge(k)}</option>`).join("");
  select.value = current;
  // Событие change НЕ поднимаем намеренно: оно перерисовало бы карточку и
  // стёрло надпись «Сохранено» ровно в тот момент, когда её читают. Видимую
  // часть обновляем сами — настоящий select спрятан под нашей обёрткой.
  const wrap = select.closest(".select-wrap");
  const label = wrap && wrap.querySelector(".select-value");
  if (label) label.textContent = select.options[select.selectedIndex]?.textContent || "";
}

// Сколько адресов заведено — приписка к названию категории в списке.
function rcpBadge(k) {
  const n = (k.emails || "").split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean).length;
  return n ? ` — ${n} адр.` : " — не заполнено";
}

// Сводка обхода — то, что вернул адаптер: «документов 42, истекает 3». Показываем
// как есть, парами «ключ: значение»: набор полей у заданий разный, и подгонять
// его под общий шаблон значило бы однажды потерять то, что важно именно здесь.
function jobDetailText(detail) {
  if (!detail || typeof detail !== "object") return "выполнено";
  const value = (v) => (typeof v === "boolean" ? (v ? "да" : "нет") : v);
  return Object.entries(detail).map(([k, v]) => `${k}: ${value(v)}`).join(", ");
}

function jobRowHtml(job) {
  const last = job.last;
  let state;
  if (!last) state = `<span style="color:var(--ink-soft);">ещё не выполнялось</span>`;
  else if (last.ok) state = `<span style="color:var(--green);">${esc(jobDetailText(last.detail))}</span>`;
  else state = `<span style="color:var(--red);">${esc(last.error || "ошибка")}</span>`;

  return `
    <div style="padding:11px 0;border-top:1px solid var(--line-soft);">
      <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;">
        <span style="font-size:13px;font-weight:600;min-width:210px;">${esc(job.label)}</span>
        <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);flex-shrink:0;">
          ${job.period === "monthly" ? "раз в месяц" : "раз в сутки"}</span>
        <span style="flex:1;min-width:180px;font-size:12px;">${state}</span>
        <button class="btn btn-ghost job-run" data-job="${esc(job.id)}" style="flex-shrink:0;">Проверить сейчас</button>
        <span class="job-msg" style="font-size:12px;"></span>
      </div>
      ${last ? `<div class="mono" style="font-size:11px;color:var(--ink-soft);margin-top:3px;">последний обход: ${esc(String(last.at).replace("T", " ").slice(0, 19))}</div>` : ""}
    </div>`;
}

function recipientCardHtml(k) {
  return `
    <div class="rcp-card" data-kind="${esc(k.kind)}" style="padding:14px 0;border-top:1px solid var(--line-soft);">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px;">
        <span style="font-size:13.5px;font-weight:600;">${esc(k.label)}</span>
        ${k.scheduled ? `<span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${k.trigger === "monthly" ? "раз в месяц" : "ежедневная проверка"}</span>` : ""}
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
      ${k.scheduled ? `<span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${k.trigger === "monthly" ? "раз в месяц" : "ежедневная проверка"}</span>` : ""}
    </div>`;
}
