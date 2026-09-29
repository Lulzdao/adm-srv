// ====== Задачи администраторов ======
//
// Список слева, карточка справа — как в концепте: открыть задачу не значит
// потерять список, по которому идёшь. Карточка правится на месте: поменял срок
// или статус — сохранилось сразу, без отдельной кнопки «Сохранить», и каждое
// изменение сервер пишет в историю задачи.
//
// Всё, что пришло из базы (названия, ФИО, комментарии), идёт в разметку только
// через esc(): текст задач пишут люди.

const TASK_STATUSES = [
  { id: "todo", label: "К выполнению" },
  { id: "progress", label: "В работе" },
  { id: "done", label: "Готово" },
];
const TASK_MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const TASK_WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const TASK_AVATAR_COLORS = ["#0A61AE", "#663AB5", "#008F9F", "#C25A18", "#E7004B", "#5A5A5A"];

// Фильтры списка переживают переход в другой раздел и обратно, но не F5 —
// как и у заявок.
const tasksUi = { scope: "all", done: false, quick: null, q: "" };
let tasksPeople = null;      // администраторы — кого можно назначить
let tasksThresholds = [3, 1, 0];
let tasksRemindersOn = true;

function taskDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function taskDueLabel(t) {
  const d = taskDay(t.due_date);
  if (!d) return "без срока";
  return `${d.getDate()} ${TASK_MONTHS[d.getMonth()]}${t.due_time ? `, ${t.due_time}` : ""}`;
}
function taskDueRel(t) {
  if (t.status === "done") return t.done_at ? `выполнено ${fmtDate(t.done_at).slice(0, 5)}` : "выполнено";
  if (t.days === null || t.days === undefined) return "";
  if (t.overdue) return t.days < 0 ? `просрочено ${-t.days} дн.` : "срок прошёл";
  if (t.days === 0) return "сегодня";
  if (t.days === 1) return "завтра";
  const d = taskDay(t.due_date);
  return t.days < 7 && d ? `${TASK_WEEKDAYS[d.getDay()]}, через ${t.days} дн.` : `через ${t.days} дн.`;
}
function taskInitials(name) {
  const p = String(name || "").trim().split(/\s+/);
  return ((p[0] || "")[0] || "").toUpperCase() + ((p[1] || "")[0] || "").toUpperCase();
}
function taskAvatarColor(id) { return TASK_AVATAR_COLORS[Number(id) % TASK_AVATAR_COLORS.length]; }
function taskAvatar(p, size = 26) {
  return `<span class="td-av" style="width:${size}px;height:${size}px;background:${taskAvatarColor(p.id)};font-size:${size < 24 ? 9.5 : 10.5}px" title="${esc(p.full_name)}">${esc(taskInitials(p.full_name))}</span>`;
}
function taskPriority(id) { return PRIORITIES.find((p) => p.id === id) || PRIORITIES[2]; }
function thresholdsText(list) {
  const words = [...list].sort((a, b) => b - a).map((n) => (n === 0 ? "в день срока" : n === 1 ? "за 1 день" : `за ${n} дн.`));
  if (!words.length) return "";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`;
}

async function renderTasks(main) {
  clearViewPoll();
  main.innerHTML = `
    <div class="topbar">
      <div class="topbar-title-row"><div class="topbar-title">Задачи</div></div>
      <div class="td-top-actions">
        <div class="search-wrap"><span class="search-icon">${icon("search", 15)}</span>
          <input id="tdSearch" placeholder="Поиск по задачам" value="${esc(tasksUi.q)}" /></div>
        <button class="btn btn-primary td-new" id="tdNew">${icon("plus", 15)} Новая задача</button>
      </div>
    </div>
    <div class="page">
      <div class="td-filters">
        <div class="toggle-group" id="tdScope">
          ${[["all", "Все"], ["mine", "Мои"], ["created", "Поставленные мной"]].map(([id, l]) =>
            `<button class="toggle-btn${tasksUi.scope === id ? " active" : ""}" data-scope="${id}">${l}</button>`).join("")}
        </div>
        <div class="toggle-group" id="tdState">
          <button class="toggle-btn${tasksUi.done ? "" : " active"}" data-done="0">Открытые</button>
          <button class="toggle-btn${tasksUi.done ? " active" : ""}" data-done="1">Выполненные</button>
        </div>
        <span id="tdChips" class="td-chips"></span>
        <span class="td-remind" id="tdRemind"></span>
      </div>
      <div class="td-grid" id="tdGrid">
        <div id="tdList"><div class="spinner">Загрузка задач…</div></div>
        <aside class="td-drawer" id="tdDrawer" hidden></aside>
      </div>
    </div>`;

  main.querySelectorAll("#tdScope .toggle-btn").forEach((b) => {
    b.onclick = () => { tasksUi.scope = b.dataset.scope; tasksUi.quick = null; renderTasks(main); };
  });
  main.querySelectorAll("#tdState .toggle-btn").forEach((b) => {
    b.onclick = () => { tasksUi.done = b.dataset.done === "1"; tasksUi.quick = null; renderTasks(main); };
  });
  let searchTimer;
  main.querySelector("#tdSearch").oninput = (e) => {
    tasksUi.q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadTaskList(main), 250);
  };
  main.querySelector("#tdNew").onclick = () => openTaskForm(main);

  if (!tasksPeople) {
    try { tasksPeople = (await api("/tasks/people")).people; } catch { tasksPeople = []; }
  }
  await loadTaskList(main);
  if (state.taskOpenId) openTask(main, state.taskOpenId);
}

async function loadTaskList(main) {
  const listEl = main.querySelector("#tdList");
  if (!listEl) return;
  const params = new URLSearchParams({ scope: tasksUi.scope, status: tasksUi.done ? "done" : "open" });
  if (tasksUi.q.trim()) params.set("q", tasksUi.q.trim());
  let data;
  try {
    data = await api("/tasks?" + params.toString());
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">Не удалось загрузить задачи: ${esc(e.message)}</div>`;
    return;
  }
  if (!main.querySelector("#tdList")) return; // пока ждали, ушли в другой раздел
  tasksThresholds = data.thresholds && data.thresholds.length ? data.thresholds : tasksThresholds;
  tasksRemindersOn = data.remindersOn !== false;
  const remind = main.querySelector("#tdRemind");
  remind.innerHTML = tasksRemindersOn && !tasksUi.done
    ? `${icon("bell", 14)} напомню ${esc(thresholdsText(tasksThresholds))}`
    : "";

  const tasks = data.tasks;
  const overdue = tasks.filter((t) => t.overdue).length;
  const today = tasks.filter((t) => !t.overdue && t.days === 0).length;
  const chips = main.querySelector("#tdChips");
  chips.innerHTML = tasksUi.done ? "" : `
    <button class="td-chip red${tasksUi.quick === "overdue" ? " on" : ""}" data-quick="overdue" ${overdue ? "" : "disabled"}><b>${overdue}</b> просрочено</button>
    <button class="td-chip${tasksUi.quick === "today" ? " on" : ""}" data-quick="today" ${today ? "" : "disabled"}><b>${today}</b> на сегодня</button>`;
  chips.querySelectorAll(".td-chip").forEach((c) => {
    c.onclick = () => { tasksUi.quick = tasksUi.quick === c.dataset.quick ? null : c.dataset.quick; loadTaskList(main); };
  });

  let shown = tasks;
  if (tasksUi.quick === "overdue") shown = tasks.filter((t) => t.overdue);
  if (tasksUi.quick === "today") shown = tasks.filter((t) => !t.overdue && t.days === 0);

  if (!shown.length) {
    listEl.innerHTML = `<div class="empty-state">${tasksUi.q.trim() ? "Ничего не найдено." : tasksUi.done ? "Выполненных задач пока нет." : "Открытых задач нет. Новая — кнопкой справа сверху."}</div>`;
    return;
  }

  const groups = tasksUi.done
    ? [["Выполнено", shown, ""]]
    : [
        ["Просрочено", shown.filter((t) => t.overdue), "red"],
        ["Сегодня", shown.filter((t) => !t.overdue && t.days === 0), ""],
        ["На этой неделе", shown.filter((t) => !t.overdue && t.days > 0 && t.days <= 7), ""],
        ["Позже", shown.filter((t) => !t.overdue && t.days > 7), ""],
        ["Без срока", shown.filter((t) => t.days === null), ""],
      ];
  listEl.innerHTML = groups.filter(([, list]) => list.length).map(([title, list, cls]) => `
    <div class="td-group">
      <div class="td-gh ${cls}">${title} <span class="n">${list.length}</span></div>
      ${list.map(taskRowHtml).join("")}
    </div>`).join("");

  listEl.querySelectorAll(".td-row").forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest(".td-cb")) return;
      openTask(main, Number(row.dataset.id));
    };
    const cb = row.querySelector(".td-cb");
    cb.onclick = async (e) => {
      e.stopPropagation();
      const done = !cb.classList.contains("done");
      try {
        await api(`/tasks/${row.dataset.id}`, { method: "PATCH", body: { status: done ? "done" : "todo" } });
        toast(done ? "Задача выполнена" : "Задача возвращена в работу");
        await loadTaskList(main);
        if (state.taskOpenId === Number(row.dataset.id)) openTask(main, state.taskOpenId);
        refreshTaskBadge();
      } catch (err) { toast(err.message, true); }
    };
  });
  markOpenRow(main);
}

function taskRowHtml(t) {
  const p = taskPriority(t.priority);
  const due = t.overdue ? "red" : t.days === 0 && t.status !== "done" ? "today" : "";
  return `
    <div class="td-row${t.unread ? " unread" : ""}" data-id="${t.id}" style="border-left-color:${p.color}">
      <span class="td-cb${t.status === "done" ? " done" : ""}" title="${t.status === "done" ? "Вернуть в работу" : "Отметить выполненной"}">${t.status === "done" ? icon("check", 12) : ""}</span>
      <div style="min-width:0">
        <div class="td-t${t.status === "done" ? " done" : ""}">${esc(t.title)}</div>
        <div class="td-meta">
          ${t.tags.map((g) => `<span class="td-tag">${esc(g)}</span>`).join("")}
          ${t.checklist.total ? `<span>${icon("task", 13)} ${t.checklist.done}/${t.checklist.total}</span>` : ""}
          ${t.ticket ? `<span class="td-lnk">${icon("link", 13)} ${esc(t.ticket.display_id)}</span>` : ""}
          ${t.status === "progress" ? `<span class="td-state">в работе</span>` : ""}
        </div>
      </div>
      <span class="td-avs">${t.assignees.map((a) => taskAvatar(a)).join("")}</span>
      <div class="td-due ${due}">${esc(taskDueLabel(t))}<small>${esc(taskDueRel(t))}</small></div>
    </div>`;
}

function markOpenRow(main) {
  main.querySelectorAll(".td-row").forEach((r) => r.classList.toggle("sel", Number(r.dataset.id) === state.taskOpenId));
}

async function refreshTaskBadge() {
  try { state.taskAttention = (await api("/tasks/summary")).attention; updateBadgeDom(); } catch { /* подождёт опроса */ }
}

function closeTaskDrawer(main) {
  const drawer = main.querySelector("#tdDrawer");
  if (drawer) { drawer.hidden = true; drawer.innerHTML = ""; }
  main.querySelector("#tdGrid")?.classList.remove("with-drawer");
  state.taskOpenId = null;
  writeHash(true);
  markOpenRow(main);
}

function showDrawer(main) {
  const drawer = main.querySelector("#tdDrawer");
  drawer.hidden = false;
  main.querySelector("#tdGrid").classList.add("with-drawer");
  return drawer;
}

// ---- Карточка задачи --------------------------------------------------------

async function openTask(main, id) {
  let task;
  try {
    task = (await api(`/tasks/${id}`)).task;
  } catch (e) {
    toast(e.message, true);
    closeTaskDrawer(main);
    return;
  }
  if (!main.querySelector("#tdDrawer")) return;
  state.taskOpenId = id;
  writeHash(true);
  markOpenRow(main);
  // Открыл — значит видел: счётчик в меню и жирная строка гаснут.
  api(`/tasks/${id}/seen`, { method: "POST" })
    .then(() => { main.querySelector(`.td-row[data-id="${id}"]`)?.classList.remove("unread"); refreshTaskBadge(); })
    .catch(() => {});

  const drawer = showDrawer(main);
  const p = taskPriority(task.priority);
  const done = task.checklist.filter((c) => c.done).length;
  const mineIsAuthor = task.created_by && task.created_by.id === state.user.id;
  const others = (tasksPeople || []).filter((x) => !task.assignees.some((a) => a.id === x.id));

  drawer.innerHTML = `
    <div class="td-dh">
      <h3 class="td-title-edit" id="tdTitle" contenteditable="true" spellcheck="false">${esc(task.title)}</h3>
      <button class="td-x" id="tdClose" title="Закрыть">${icon("x", 18)}</button>
    </div>
    <div class="td-status" id="tdStatus">
      ${TASK_STATUSES.map((s) => `<button class="${s.id === task.status ? "on" : ""}" data-status="${s.id}">${s.label}</button>`).join("")}
    </div>
    <div class="td-f">
      <span class="l">Ответственные</span>
      <span class="v" id="tdAssignees">
        ${task.assignees.map((a) => `<span class="td-pill">${taskAvatar(a, 20)} ${esc(a.full_name)}${task.assignees.length > 1 ? `<button class="td-pill-x" data-remove="${a.id}" title="Снять">${icon("x", 11)}</button>` : ""}</span>`).join("")}
        ${others.length ? `<select class="input td-add-person" id="tdAddPerson"><option value="">+ добавить</option>${others.map((x) => `<option value="${x.id}">${esc(x.full_name)}</option>`).join("")}</select>` : ""}
      </span>
      <span class="l">Срок</span>
      <span class="v">
        <input class="input td-date" type="date" id="tdDate" value="${esc(task.due_date || "")}" />
        <input class="input td-time" type="time" id="tdTime" value="${esc(task.due_time || "")}" ${task.due_date ? "" : "disabled"} />
        ${task.overdue ? `<span class="td-pill red">${icon("clock", 13)} просрочено</span>` : ""}
      </span>
      <span class="l">Важность</span>
      <span class="v" id="tdPrio">
        ${PRIORITIES.map((x) => `<button class="td-prio${x.id === task.priority ? " on" : ""}" data-prio="${x.id}" style="--c:${x.color};--s:${x.soft}">${x.label}</button>`).join("")}
      </span>
      <span class="l">Напомнить</span>
      <span class="v td-muted">${tasksRemindersOn && task.due_date ? esc(thresholdsText(tasksThresholds)) + " — ответственным" : task.due_date ? "напоминания выключены в «Оповещениях»" : "срок не задан — напоминать не о чем"}</span>
      <span class="l">Метки</span>
      <span class="v"><input class="input td-wide" id="tdTags" value="${esc(task.tags.join(", "))}" placeholder="через запятую: Лицензии, Оборудование" /></span>
      <span class="l">Заявка</span>
      <span class="v">
        <input class="input td-ticket" id="tdTicket" value="${esc(task.ticket ? task.ticket.display_id : "")}" placeholder="ИТ-0042" />
        ${task.ticket ? `<a href="#detail/${task.ticket.id}" class="td-lnk">${icon("link", 13)} ${esc(task.ticket.title || task.ticket.display_id)}</a>` : ""}
      </span>
    </div>

    <div class="td-sec">Описание</div>
    <textarea class="input td-desc" id="tdDesc" rows="3" placeholder="Что именно сделать, где, с кем согласовать">${esc(task.description || "")}</textarea>

    <div class="td-sec">Чек-лист${task.checklist.length ? ` · ${done} из ${task.checklist.length}` : ""}</div>
    ${task.checklist.length ? `<div class="td-bar"><i style="width:${Math.round((done / task.checklist.length) * 100)}%"></i></div>` : ""}
    <div id="tdChecklist">
      ${task.checklist.map((c) => `
        <div class="td-ck${c.done ? " done" : ""}" data-item="${c.id}">
          <span class="td-cb small${c.done ? " done" : ""}">${c.done ? icon("check", 10) : ""}</span>
          <span class="td-ck-t">${esc(c.text)}</span>
          <button class="td-ck-x" title="Убрать пункт">${icon("x", 12)}</button>
        </div>`).join("")}
    </div>
    <input class="input td-wide" id="tdCheckAdd" placeholder="+ пункт чек-листа, Enter — добавить" />

    <div class="td-sec">Комментарий</div>
    <textarea class="input td-desc" id="tdComment" rows="2" placeholder="Написать ответственным"></textarea>
    <button class="btn btn-ghost" id="tdCommentSend" style="margin-top:8px;">Отправить</button>

    <div class="td-sec">История</div>
    <div class="td-feed">
      ${task.events.map((e) => `
        <div class="${e.kind === "comment" ? "cmt" : e.user_id ? "" : "sys"}">
          <b>${esc(e.user_name || "Центр")}</b> ${e.kind === "comment" ? `<span class="td-cmt">${esc(e.text)}</span>` : esc(e.text)}
          <small>${esc(fmtDate(e.created_at))}</small>
        </div>`).join("")}
    </div>
    <div class="td-foot">
      <span>Поставил ${esc(task.created_by ? task.created_by.full_name : "?")}, ${esc(fmtDate(task.created_at))}</span>
      ${mineIsAuthor ? `<button class="btn btn-ghost td-del" id="tdDelete">${icon("trash", 14)} Удалить</button>` : ""}
    </div>`;

  enhanceSelects(drawer);
  const save = async (body, okText) => {
    try {
      const r = await api(`/tasks/${id}`, { method: "PATCH", body });
      if (r.changed && okText) toast(okText);
      await loadTaskList(main);
      openTask(main, id);
    } catch (e) {
      toast(e.message, true);
      openTask(main, id);
    }
  };

  drawer.querySelector("#tdClose").onclick = () => closeTaskDrawer(main);
  const title = drawer.querySelector("#tdTitle");
  title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };
  title.onblur = () => { const v = title.textContent.trim(); if (v && v !== task.title) save({ title: v }, "Название изменено"); else title.textContent = task.title; };
  drawer.querySelectorAll("#tdStatus button").forEach((b) => {
    b.onclick = () => { if (b.dataset.status !== task.status) save({ status: b.dataset.status }, b.dataset.status === "done" ? "Задача выполнена" : "Статус изменён").then(refreshTaskBadge); };
  });
  drawer.querySelectorAll("#tdPrio button").forEach((b) => {
    b.onclick = () => { if (b.dataset.prio !== task.priority) save({ priority: b.dataset.prio }); };
  });
  const date = drawer.querySelector("#tdDate");
  const time = drawer.querySelector("#tdTime");
  date.onchange = () => save({ due_date: date.value || null, due_time: date.value ? time.value || null : null }, "Срок изменён").then(refreshTaskBadge);
  time.onchange = () => save({ due_time: time.value || null }, "Срок изменён");
  const tags = drawer.querySelector("#tdTags");
  tags.onblur = () => { if (tags.value.trim() !== task.tags.join(", ")) save({ tags: tags.value }); };
  const ticket = drawer.querySelector("#tdTicket");
  ticket.onblur = () => { const v = ticket.value.trim(); if (v !== (task.ticket ? task.ticket.display_id : "")) save({ ticket: v || null }); };
  const desc = drawer.querySelector("#tdDesc");
  desc.onblur = () => { if (desc.value.trim() !== (task.description || "")) save({ description: desc.value }); };

  const addPerson = drawer.querySelector("#tdAddPerson");
  if (addPerson) addPerson.onchange = () => {
    if (!addPerson.value) return;
    save({ assignees: [...task.assignees.map((a) => a.id), Number(addPerson.value)] }, "Ответственный добавлен");
  };
  drawer.querySelectorAll("[data-remove]").forEach((b) => {
    b.onclick = () => save({ assignees: task.assignees.map((a) => a.id).filter((x) => x !== Number(b.dataset.remove)) }, "Ответственный снят");
  });

  const reload = async () => { await loadTaskList(main); openTask(main, id); };
  drawer.querySelectorAll(".td-ck").forEach((row) => {
    const itemId = row.dataset.item;
    row.querySelector(".td-cb").onclick = async () => {
      try { await api(`/tasks/${id}/checklist/${itemId}`, { method: "PATCH", body: { done: !row.classList.contains("done") } }); reload(); }
      catch (e) { toast(e.message, true); }
    };
    row.querySelector(".td-ck-x").onclick = async () => {
      try { await api(`/tasks/${id}/checklist/${itemId}`, { method: "DELETE" }); reload(); }
      catch (e) { toast(e.message, true); }
    };
  });
  const checkAdd = drawer.querySelector("#tdCheckAdd");
  checkAdd.onkeydown = async (e) => {
    if (e.key !== "Enter" || !checkAdd.value.trim()) return;
    try { await api(`/tasks/${id}/checklist`, { method: "POST", body: { text: checkAdd.value } }); await reload(); drawer.querySelector("#tdCheckAdd")?.focus(); }
    catch (err) { toast(err.message, true); }
  };
  drawer.querySelector("#tdCommentSend").onclick = async () => {
    const box = drawer.querySelector("#tdComment");
    if (!box.value.trim()) { box.focus(); return; }
    try { await api(`/tasks/${id}/comments`, { method: "POST", body: { text: box.value } }); toast("Комментарий добавлен"); reload(); }
    catch (e) { toast(e.message, true); }
  };
  const del = drawer.querySelector("#tdDelete");
  if (del) del.onclick = async () => {
    if (!confirm(`Удалить задачу «${task.title}» вместе с историей? Это не отменить.`)) return;
    try { await api(`/tasks/${id}`, { method: "DELETE" }); toast("Задача удалена"); closeTaskDrawer(main); loadTaskList(main); refreshTaskBadge(); }
    catch (e) { toast(e.message, true); }
  };
}

// ---- Новая задача -------------------------------------------------------------

function openTaskForm(main) {
  state.taskOpenId = null;
  writeHash(true);
  markOpenRow(main);
  const drawer = showDrawer(main);
  const me = state.user.id;
  const people = tasksPeople || [];
  drawer.innerHTML = `
    <div class="td-dh"><h3>Новая задача</h3><button class="td-x" id="tdClose" title="Закрыть">${icon("x", 18)}</button></div>
    <div class="field-label">Задача</div>
    <input class="input td-wide" id="tfTitle" maxlength="120" placeholder="Что сделать — коротко" />
    <div class="field-label" style="margin-top:12px;">Ответственные</div>
    <div class="td-people" id="tfPeople">
      ${people.map((x) => `<button type="button" class="td-person${x.id === me ? " on" : ""}" data-id="${x.id}">${taskAvatar(x, 20)} ${esc(x.full_name)}</button>`).join("")}
    </div>
    <div class="td-row2">
      <div><div class="field-label">Срок</div><input class="input" type="date" id="tfDate" /></div>
      <div><div class="field-label">Время</div><input class="input" type="time" id="tfTime" /></div>
    </div>
    <div class="field-label" style="margin-top:12px;">Важность</div>
    <div class="td-prio-row" id="tfPrio">
      ${PRIORITIES.map((x) => `<button type="button" class="td-prio${x.id === "medium" ? " on" : ""}" data-prio="${x.id}" style="--c:${x.color};--s:${x.soft}">${x.label}</button>`).join("")}
    </div>
    <div class="field-label" style="margin-top:12px;">Описание</div>
    <textarea class="input td-desc" id="tfDesc" rows="3" placeholder="Необязательно"></textarea>
    <div class="field-label" style="margin-top:12px;">Чек-лист — по пункту на строку</div>
    <textarea class="input td-desc" id="tfCheck" rows="3" placeholder="Необязательно"></textarea>
    <div class="td-row2">
      <div><div class="field-label">Метки</div><input class="input" id="tfTags" placeholder="через запятую" /></div>
      <div><div class="field-label">Заявка</div><input class="input" id="tfTicket" placeholder="ИТ-0042" /></div>
    </div>
    <div class="td-form-foot">
      <span class="td-form-err" id="tfErr"></span>
      <button class="btn btn-primary" id="tfCreate">Создать задачу</button>
    </div>`;

  drawer.querySelector("#tdClose").onclick = () => closeTaskDrawer(main);
  drawer.querySelectorAll(".td-person").forEach((b) => { b.onclick = () => b.classList.toggle("on"); });
  drawer.querySelectorAll("#tfPrio .td-prio").forEach((b) => {
    b.onclick = () => { drawer.querySelectorAll("#tfPrio .td-prio").forEach((x) => x.classList.toggle("on", x === b)); };
  });
  const title = drawer.querySelector("#tfTitle");
  title.focus();
  drawer.querySelector("#tfCreate").onclick = async () => {
    const err = drawer.querySelector("#tfErr");
    const assignees = [...drawer.querySelectorAll(".td-person.on")].map((b) => Number(b.dataset.id));
    if (!title.value.trim()) { err.textContent = "Напишите, что сделать"; title.focus(); return; }
    if (!assignees.length) { err.textContent = "Выберите хотя бы одного ответственного"; return; }
    const date = drawer.querySelector("#tfDate").value;
    const body = {
      title: title.value,
      assignees,
      due_date: date || null,
      due_time: date ? drawer.querySelector("#tfTime").value || null : null,
      priority: drawer.querySelector("#tfPrio .td-prio.on").dataset.prio,
      description: drawer.querySelector("#tfDesc").value,
      checklist: drawer.querySelector("#tfCheck").value.split("\n").map((x) => x.trim()).filter(Boolean),
      tags: drawer.querySelector("#tfTags").value,
      ticket: drawer.querySelector("#tfTicket").value.trim() || null,
    };
    try {
      const { id } = await api("/tasks", { method: "POST", body });
      toast("Задача создана");
      tasksUi.done = false; tasksUi.quick = null;
      await loadTaskList(main);
      openTask(main, id);
      refreshTaskBadge();
    } catch (e) {
      err.textContent = e.message;
    }
  };
}
