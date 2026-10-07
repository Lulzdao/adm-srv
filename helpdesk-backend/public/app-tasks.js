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
  // Период: «5–11 окт» или «28 сен – 4 окт» — задача на неделю или месяц.
  const f = taskDay(t.due_from);
  if (f) {
    return f.getMonth() === d.getMonth()
      ? `${f.getDate()}–${d.getDate()} ${TASK_MONTHS[d.getMonth()]}`
      : `${f.getDate()} ${TASK_MONTHS[f.getMonth()]} – ${d.getDate()} ${TASK_MONTHS[d.getMonth()]}`;
  }
  return `${d.getDate()} ${TASK_MONTHS[d.getMonth()]}${t.due_time ? `, ${t.due_time}` : ""}`;
}
function taskDueRel(t) {
  if (t.status === "done") return t.done_at ? `выполнено ${fmtDate(t.done_at).slice(0, 5)}` : "выполнено";
  if (t.days === null || t.days === undefined) return "";
  if (t.overdue) return t.days < 0 ? `просрочено ${-t.days} дн.` : "срок прошёл";
  if (t.due_from) {
    const f = taskDay(t.due_from);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (f > today) return `начать с ${f.getDate()} ${TASK_MONTHS[f.getMonth()]}`;
    return t.days === 0 ? "последний день" : `ещё ${t.days + 1} дн. в периоде`;
  }
  if (t.days === 0) return "сегодня";
  if (t.days === 1) return "завтра";
  const d = taskDay(t.due_date);
  return t.days < 7 && d ? `${TASK_WEEKDAYS[d.getDay()]}, через ${t.days} дн.` : `через ${t.days} дн.`;
}
/**
 * Срок задачи: один день (можно со временем) или период «с … по …» — для
 * дел «в течение недели», «до конца месяца». value — { due_from, due_date,
 * due_time }; onChange получает его целиком при каждой правке.
 */
function taskDueControl(box, value, onChange) {
  let v = { due_from: value.due_from || null, due_date: value.due_date || null, due_time: value.due_time || null };
  let period = Boolean(v.due_from);
  const paint = () => {
    box.innerHTML = `
      <div class="td-due-ctl">
        <div class="td-due-mode">
          <button type="button" data-mode="day" class="${period ? "" : "on"}">День</button>
          <button type="button" data-mode="period" class="${period ? "on" : ""}">Период</button>
        </div>
        ${period ? `
          <span class="td-due-dates">
            <span class="td-due-pair"><span class="td-due-l">с</span><input class="input td-date" type="date" data-k="from" value="${esc(v.due_from || "")}"></span>
            <span class="td-due-pair"><span class="td-due-l">по</span><input class="input td-date" type="date" data-k="to" value="${esc(v.due_date || "")}"></span>
          </span>
          <div class="td-due-presets">
            <button type="button" data-p="week">Эта неделя</button>
            <button type="button" data-p="next">Следующая неделя</button>
            <button type="button" data-p="month">Этот месяц</button>
          </div>` : `
          <input class="input td-date" type="date" data-k="to" value="${esc(v.due_date || "")}">
          <input class="input td-time" type="time" data-k="time" value="${esc(v.due_time || "")}" ${v.due_date ? "" : "disabled"} title="Время — необязательно">`}
        <div class="td-due-err" hidden></div>
      </div>`;
    box.querySelectorAll("[data-mode]").forEach((b) => {
      b.onclick = () => {
        const want = b.dataset.mode === "period";
        if (want === period) return;
        period = want;
        if (period) {
          // Был день — он становится концом периода, начало — сегодня (если раньше).
          const today = calIso(new Date());
          v = { due_from: v.due_date && v.due_date > today ? today : null, due_date: v.due_date, due_time: null };
          if (!v.due_from) { paint(); return; }
        } else {
          v = { due_from: null, due_date: v.due_date, due_time: null };
        }
        paint(); emit();
      };
    });
    // Набор даты с клавиатуры шлёт «изменение» на каждой цифре — с
    // промежуточными значениями вроде года 0008. Поэтому ввод только
    // запоминается, а сохраняется, когда человек ушёл из полей срока (или
    // нажал Enter) и срок при этом осмысленный. Поля при этом не
    // перерисовываются — курсор не выпрыгивает посреди набора.
    const get = (k) => box.querySelector(`[data-k="${k}"]`);
    box.querySelectorAll("input").forEach((inp) => {
      inp.oninput = inp.onchange = () => {
        if (period) {
          v = { due_from: get("from").value || null, due_date: get("to").value || null, due_time: null };
        } else {
          v = { due_from: null, due_date: get("to").value || null, due_time: get("to").value ? get("time").value || null : null };
          get("time").disabled = !v.due_date;
        }
        showProblem(null);
      };
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } };
    });
    box.querySelectorAll("[data-p]").forEach((b) => {
      b.onclick = () => {
        const now = new Date();
        const mon = calMonday(now);
        if (b.dataset.p === "week") v = { due_from: calIso(mon), due_date: calIso(calAddDays(mon, 6)), due_time: null };
        if (b.dataset.p === "next") v = { due_from: calIso(calAddDays(mon, 7)), due_date: calIso(calAddDays(mon, 13)), due_time: null };
        if (b.dataset.p === "month") v = { due_from: calIso(new Date(now.getFullYear(), now.getMonth(), 1)), due_date: calIso(new Date(now.getFullYear(), now.getMonth() + 1, 0)), due_time: null };
        paint(); emit();
      };
    });
  };
  const okDate = (d) => !d || (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= "2000-01-01" && d <= "2100-12-31");
  /** Что не так со сроком сейчас; null — всё в порядке (в том числе «без срока»). */
  const problem = () => {
    if (!okDate(v.due_date) || !okDate(v.due_from)) return "Дата набрана не до конца";
    if (!period) return null;
    if (!v.due_from || !v.due_date) return "У периода выберите оба дня: с какого и по какое";
    if (v.due_from > v.due_date) return "Начало периода позже его конца";
    if (v.due_from === v.due_date) return "Период в один день — выберите «День»";
    return null;
  };
  const showProblem = (text) => {
    const el = box.querySelector(".td-due-err");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  };
  let sent = JSON.stringify({ due_from: value.due_from || null, due_date: value.due_date || null, due_time: value.due_time || null });
  const out = () => ({ due_from: period ? v.due_from : null, due_date: v.due_date, due_time: period ? null : v.due_time });
  const emit = () => { sent = JSON.stringify(out()); onChange(out()); };
  // Сохранить введённое: только целый и осмысленный срок и только если он изменился.
  const commit = () => {
    const p = problem();
    if (p) { showProblem(p); return; }
    if (JSON.stringify(out()) !== sent) emit();
  };
  box.addEventListener("focusout", (e) => { if (!box.contains(e.relatedTarget)) commit(); });
  paint();
  return {
    value: () => out(),
    /** Что не так со сроком (для формы новой задачи); null — можно сохранять. */
    problem,
  };
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
        // Галочка прорисовывается, затем строка «втягивается» в «Выполненные» (вернули — в «Открытые»).
        if (done) {
          cb.classList.add("done"); cb.innerHTML = icon("check", 12); checkDraw(cb);
          row.querySelector(".td-t").classList.add("done");
          await motionPause(280);
        }
        const item = snapshotEl(row);
        await loadTaskList(main);
        flyInto(item, main.querySelector(`.toggle-btn[data-done="${done ? 1 : 0}"]`));
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
  main.querySelectorAll(".cal-ev, .ag-item").forEach((el) => el.classList.toggle("open", Number(el.dataset.id) === state.taskOpenId));
}

async function refreshTaskBadge() {
  try { state.taskAttention = (await api("/tasks/summary")).attention; updateBadgeDom(); } catch { /* подождёт опроса */ }
}

/** Обновить тот вид, в котором открыта карточка: список или календарь. */
function reloadTasksView(main) {
  if (main.querySelector("#tdList")) return loadTaskList(main);
  if (main.querySelector("#tdCal")) return loadCalendar(main);
  return Promise.resolve();
}

// В календаре справа всегда колонка: без карточки там сводка дня. Карточка
// встаёт на её место, закрыли — сводка возвращается.
function closeTaskDrawer(main) {
  const drawer = main.querySelector("#tdDrawer");
  if (drawer) { drawer.hidden = true; drawer.innerHTML = ""; }
  const agenda = main.querySelector("#tdAgenda");
  if (agenda) agenda.hidden = false;
  else main.querySelector("#tdGrid")?.classList.remove("with-drawer");
  state.taskOpenId = null;
  writeHash(true);
  markOpenRow(main);
  if (agenda) renderCalAgenda(main);
}

function showDrawer(main) {
  const drawer = main.querySelector("#tdDrawer");
  if (drawer.hidden) slideInRight(drawer); // открылась, а не перерисовалась уже открытая
  drawer.hidden = false;
  const agenda = main.querySelector("#tdAgenda");
  if (agenda) agenda.hidden = true;
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
        <span id="tdDue"></span>
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
      await reloadTasksView(main);
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
  taskDueControl(drawer.querySelector("#tdDue"), task, (due) => save(due, "Срок изменён").then(refreshTaskBadge));
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

  // Ждём и саму карточку: анимации после перерисовки (галочка, комментарий) — уже на новых элементах.
  const reload = async () => { await reloadTasksView(main); await openTask(main, id); };
  drawer.querySelectorAll(".td-ck").forEach((row) => {
    const itemId = row.dataset.item;
    row.querySelector(".td-cb").onclick = async () => {
      const nowDone = !row.classList.contains("done");
      try {
        await api(`/tasks/${id}/checklist/${itemId}`, { method: "PATCH", body: { done: nowDone } });
        await reload();
        if (nowDone) checkDraw(main.querySelector(`#tdDrawer .td-ck[data-item="${itemId}"] .td-cb`));
      } catch (e) { toast(e.message, true); }
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
    try { await api(`/tasks/${id}/comments`, { method: "POST", body: { text: box.value } }); toast("Комментарий добавлен"); await reload(); enterFromBelow(main.querySelector("#tdDrawer .td-feed .cmt")); } // новые события — сверху
    catch (e) { toast(e.message, true); }
  };
  const del = drawer.querySelector("#tdDelete");
  if (del) del.onclick = async () => {
    if (!confirm(`Удалить задачу «${task.title}» вместе с историей? Это не отменить.`)) return;
    try { await api(`/tasks/${id}`, { method: "DELETE" }); toast("Задача удалена"); closeTaskDrawer(main); reloadTasksView(main); refreshTaskBadge(); }
    catch (e) { toast(e.message, true); }
  };
}

// ---- Новая задача -------------------------------------------------------------

function openTaskForm(main, presetDate = "") {
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
    <div class="field-label" style="margin-top:12px;">Срок</div>
    <div id="tfDue"></div>
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
  const dueCtl = taskDueControl(drawer.querySelector("#tfDue"), { due_date: presetDate || null }, () => {});
  const title = drawer.querySelector("#tfTitle");
  title.focus();
  drawer.querySelector("#tfCreate").onclick = async () => {
    const err = drawer.querySelector("#tfErr");
    const assignees = [...drawer.querySelectorAll(".td-person.on")].map((b) => Number(b.dataset.id));
    if (!title.value.trim()) { err.textContent = "Напишите, что сделать"; title.focus(); return; }
    if (!assignees.length) { err.textContent = "Выберите хотя бы одного ответственного"; return; }
    const dueProblem = dueCtl.problem();
    if (dueProblem) { err.textContent = dueProblem; return; }
    const due = dueCtl.value();
    const body = {
      title: title.value,
      assignees,
      ...due,
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
      await reloadTasksView(main);
      openTask(main, id);
      refreshTaskBadge();
    } catch (e) {
      err.textContent = e.message;
    }
  };
}

// ====== Календарь задач ======
//
// Месяц или неделя. Задачу перетаскивают на другой день — срок сдвигается и
// пишется в историю, как любая правка. Задачи без срока лежат справа, и их
// тоже можно бросить на день. Двойной щелчок по дню — новая задача на него.
// Выполненные видны зачёркнутыми и не перетаскиваются: переносить сделанное
// незачем, а случайно сдвинутый срок выполненной задачи только путает историю.

const CAL_MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const CAL_MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const CAL_WEEKDAYS_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const CAL_DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const CAL_MONTH_LIMIT = 3; // сколько задач показывать в клетке месяца, остальное — «+ ещё»

const calUi = { mode: "month", anchor: null, scope: "all", selected: null };
let calData = { byDay: new Map(), undated: [], open: [], today: "" };

const calIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const calAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const calMonday = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return calAddDays(x, -((x.getDay() + 6) % 7)); };

/** Первый и последний день сетки: 5–6 недель месяца или одна неделя. */
function calRange() {
  const a = calUi.anchor;
  if (calUi.mode === "week") { const s = calMonday(a); return [s, calAddDays(s, 6)]; }
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
  const start = calMonday(first);
  const end = calAddDays(calMonday(last), 6);
  return [start, end];
}

function calTitle() {
  const a = calUi.anchor;
  if (calUi.mode === "month") return `${CAL_MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  const [s, e] = calRange();
  return s.getMonth() === e.getMonth()
    ? `${s.getDate()}–${e.getDate()} ${CAL_MONTHS_GEN[e.getMonth()]} ${e.getFullYear()}`
    : `${s.getDate()} ${CAL_MONTHS_GEN[s.getMonth()]} – ${e.getDate()} ${CAL_MONTHS_GEN[e.getMonth()]} ${e.getFullYear()}`;
}

async function renderTaskCalendar(main) {
  clearViewPoll();
  const now = new Date();
  if (!calUi.anchor) calUi.anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!calUi.selected) calUi.selected = calIso(now);
  main.innerHTML = `
    <div class="topbar">
      <div class="topbar-title-row"><div class="topbar-title">Календарь задач</div></div>
      <div class="td-top-actions">
        <div class="toggle-group" id="calMode">
          <button class="toggle-btn${calUi.mode === "week" ? " active" : ""}" data-mode="week">Неделя</button>
          <button class="toggle-btn${calUi.mode === "month" ? " active" : ""}" data-mode="month">Месяц</button>
        </div>
        <button class="btn btn-primary td-new" id="tdNew">${icon("plus", 15)} Новая задача</button>
      </div>
    </div>
    <div class="page">
      <div class="cal-head">
        <button class="cal-nav" id="calPrev" title="Назад">${icon("chevron", 16)}</button>
        <button class="cal-nav next" id="calNext" title="Вперёд">${icon("chevron", 16)}</button>
        <h2 id="calTitle">${esc(calTitle())}</h2>
        <button class="td-chip" id="calToday">Сегодня</button>
        <div class="toggle-group" id="calScope">
          <button class="toggle-btn${calUi.scope === "all" ? " active" : ""}" data-scope="all">Все</button>
          <button class="toggle-btn${calUi.scope === "mine" ? " active" : ""}" data-scope="mine">Мои</button>
        </div>
        <span class="td-remind">${icon("grip", 14)} перетащите задачу на другой день — срок сдвинется</span>
      </div>
      <div class="td-grid with-drawer cal-layout" id="tdGrid">
        <div id="tdCal"><div class="spinner">Загрузка…</div></div>
        <div class="td-side">
          <aside class="cal-side" id="tdAgenda"></aside>
          <aside class="td-drawer" id="tdDrawer" hidden></aside>
        </div>
      </div>
    </div>`;

  const step = (dir) => {
    const a = calUi.anchor;
    calUi.anchor = calUi.mode === "week" ? calAddDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1);
    main.querySelector("#calTitle").textContent = calTitle();
    loadCalendar(main);
  };
  main.querySelector("#calPrev").onclick = () => step(-1);
  main.querySelector("#calNext").onclick = () => step(1);
  main.querySelector("#calToday").onclick = () => {
    const n = new Date(); calUi.anchor = new Date(n.getFullYear(), n.getMonth(), n.getDate()); calUi.selected = calIso(n);
    main.querySelector("#calTitle").textContent = calTitle(); loadCalendar(main);
  };
  main.querySelectorAll("#calMode .toggle-btn").forEach((b) => { b.onclick = () => { calUi.mode = b.dataset.mode; calUi.anchor = taskDay(calUi.selected) || calUi.anchor; renderTaskCalendar(main); }; });
  main.querySelectorAll("#calScope .toggle-btn").forEach((b) => { b.onclick = () => { calUi.scope = b.dataset.scope; renderTaskCalendar(main); }; });
  main.querySelector("#tdNew").onclick = () => openTaskForm(main, calUi.selected || "");

  if (!tasksPeople) {
    try { tasksPeople = (await api("/tasks/people")).people; } catch { tasksPeople = []; }
  }
  await loadCalendar(main);
  if (state.taskOpenId) openTask(main, state.taskOpenId);
}

async function loadCalendar(main) {
  const host = main.querySelector("#tdCal");
  if (!host) return;
  const [start, end] = calRange();
  const scope = calUi.scope;
  let ranged, open;
  try {
    [ranged, open] = await Promise.all([
      api(`/tasks?${new URLSearchParams({ scope, status: "all", from: calIso(start), to: calIso(end) })}`),
      api(`/tasks?${new URLSearchParams({ scope, status: "open" })}`),
    ]);
  } catch (e) {
    host.innerHTML = `<div class="empty-state">Не удалось загрузить задачи: ${esc(e.message)}</div>`;
    return;
  }
  if (!main.querySelector("#tdCal")) return;
  const byDay = new Map();
  const put = (iso, t) => { if (!byDay.has(iso)) byDay.set(iso, []); byDay.get(iso).push(t); };
  for (const t of ranged.tasks) {
    if (!t.due_from) { put(t.due_date, t); continue; }
    // Период — во все свои дни на экране.
    const last = t.due_date < calIso(end) ? taskDay(t.due_date) : end;
    for (let d = t.due_from > calIso(start) ? taskDay(t.due_from) : new Date(start); d <= last; d = calAddDays(d, 1)) put(calIso(d), t);
  }
  calData = { byDay, undated: open.tasks.filter((t) => !t.due_date), open: open.tasks, today: ranged.today };

  const month = calUi.anchor.getMonth();
  const cells = [];
  for (let d = new Date(start); d <= end; d = calAddDays(d, 1)) cells.push(new Date(d));
  const week = calUi.mode === "week";
  host.innerHTML = `
    <div class="cal${week ? " week" : ""}">
      ${CAL_DOW.map((d) => `<div class="dow">${d}</div>`).join("")}
      ${cells.map((d, i) => {
        const iso = calIso(d);
        const list = byDay.get(iso) || [];
        const shown = week ? list : list.slice(0, CAL_MONTH_LIMIT);
        const cls = [
          "d",
          !week && d.getMonth() !== month ? "out" : "",
          i % 7 >= 5 ? "we" : "",
          iso === calData.today ? "today" : "",
          iso === calUi.selected ? "sel" : "",
        ].filter(Boolean).join(" ");
        return `<div class="${cls}" data-date="${iso}">
          <div class="d-top"><span class="num">${d.getDate()}</span>${week ? `<span class="wd">${d.getDate() === 1 || i === 0 ? CAL_MONTHS_GEN[d.getMonth()] : ""}</span>` : ""}
            <button class="d-add" data-add="${iso}" title="Новая задача на этот день">${icon("plus", 12)}</button></div>
          ${shown.map(calEventHtml).join("")}
          ${list.length > shown.length ? `<button class="more" data-more="${iso}">+ ещё ${list.length - shown.length}</button>` : ""}
        </div>`;
      }).join("")}
    </div>`;

  host.querySelectorAll(".cal-ev").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openTask(main, Number(el.dataset.id)); };
  });
  host.querySelectorAll(".d").forEach((cell) => {
    cell.onclick = () => { calUi.selected = cell.dataset.date; host.querySelectorAll(".d.sel").forEach((c) => c.classList.remove("sel")); cell.classList.add("sel"); closeTaskDrawer(main); renderCalAgenda(main); };
    cell.ondblclick = (e) => { if (!e.target.closest(".cal-ev")) openTaskForm(main, cell.dataset.date); };
  });
  host.querySelectorAll(".d-add").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openTaskForm(main, b.dataset.add); }; });
  host.querySelectorAll(".more").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); calUi.selected = b.dataset.more; closeTaskDrawer(main); loadCalendar(main); };
  });
  wireCalDrop(main, host);
  if (main.querySelector("#tdAgenda") && !main.querySelector("#tdAgenda").hidden) renderCalAgenda(main);
  markCalOpen(main);
}

function calEventHtml(t) {
  const p = taskPriority(t.priority);
  const cls = ["cal-ev", t.due_from ? "period" : "", t.status === "done" ? "done" : "", t.overdue ? "over" : "", t.unread ? "unread" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}" data-id="${t.id}" ${t.status === "done" ? "" : 'draggable="true"'} style="border-left-color:${p.color}"
    title="${esc(t.title)}${t.due_from ? ` (${esc(taskDueLabel(t))})` : ""}${t.assignees.length ? " — " + esc(t.assignees.map((a) => a.full_name).join(", ")) : ""}">
    ${t.overdue ? '<span class="bang">!</span>' : ""}${t.due_time ? `<span class="tm">${esc(t.due_time)}</span>` : ""}<span class="tt">${esc(t.title)}</span>
  </div>`;
}

const markCalOpen = markOpenRow;

// Перетаскивание: задачу — на день. Своё поле dataTransfer, а не text/plain:
// иначе брошенный на клетку посторонний текст (выделенный кусок страницы)
// превращался бы в попытку сдвинуть «задачу» с таким номером.
const CAL_DND_TYPE = "application/x-center-task";

function wireCalDrop(main, root) {
  main.querySelectorAll("[draggable=true][data-id]").forEach((el) => {
    el.ondragstart = (e) => {
      // С какого дня тащат: период сдвигается целиком на ту же разницу.
      const src = el.closest(".d");
      e.dataTransfer.setData(CAL_DND_TYPE, `${el.dataset.id}|${src ? src.dataset.date : ""}`);
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    };
    el.ondragend = () => el.classList.remove("dragging");
  });
  root.querySelectorAll(".d").forEach((cell) => {
    cell.ondragover = (e) => {
      if (!e.dataTransfer.types.includes(CAL_DND_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      cell.classList.add("drop");
    };
    cell.ondragleave = (e) => { if (!cell.contains(e.relatedTarget)) cell.classList.remove("drop"); };
    cell.ondrop = async (e) => {
      cell.classList.remove("drop");
      const [rawId, srcDate] = e.dataTransfer.getData(CAL_DND_TYPE).split("|");
      const id = Number(rawId);
      if (!id) return;
      e.preventDefault();
      const date = cell.dataset.date;
      const all = [...calData.byDay.values()].flat().concat(calData.undated);
      const t = all.find((x) => x.id === id);
      let body = { due_date: date };
      if (t && t.due_from) {
        const shift = Math.round((taskDay(date) - taskDay(srcDate || t.due_date)) / 86400000);
        if (!shift) return;
        body = { due_from: calIso(calAddDays(taskDay(t.due_from), shift)), due_date: calIso(calAddDays(taskDay(t.due_date), shift)) };
      } else if (t && t.due_date === date) return;
      try {
        await api(`/tasks/${id}`, { method: "PATCH", body });
        const d = taskDay(date);
        toast(t && t.due_from ? `Период перенесён: ${taskDueLabel({ ...t, ...body })}` : `Срок перенесён на ${d.getDate()} ${CAL_MONTHS_GEN[d.getMonth()]}`);
        calUi.selected = date;
        await loadCalendar(main);
        if (state.taskOpenId === id) openTask(main, id);
        refreshTaskBadge();
      } catch (err) { toast(err.message, true); }
    };
  });
}

function renderCalAgenda(main) {
  const box = main.querySelector("#tdAgenda");
  if (!box) return;
  const iso = calUi.selected;
  const d = taskDay(iso);
  // Сначала дела на этот день (по времени), за ними — периоды, которые идут сейчас.
  const list = (calData.byDay.get(iso) || []).slice().sort((a, b) => (a.due_from ? 1 : 0) - (b.due_from ? 1 : 0) || (a.due_time || "99").localeCompare(b.due_time || "99"));
  const isToday = iso === calData.today;
  const late = isToday ? calData.open.filter((t) => t.overdue && t.due_date !== iso) : [];
  const openCount = list.filter((t) => t.status !== "done").length;

  // Нагрузка — открытые задачи со сроком на ТЕКУЩЕЙ неделе, по людям.
  const mon = calMonday(taskDay(calData.today) || new Date());
  const [ws, we] = [calIso(mon), calIso(calAddDays(mon, 6))];
  const load = new Map();
  for (const t of calData.open) {
    if (!t.due_date || t.due_date < ws || t.due_date > we) continue;
    for (const a of t.assignees) load.set(a.id, { p: a, n: ((load.get(a.id) || {}).n || 0) + 1 });
  }
  const loadRows = [...load.values()].sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...loadRows.map((r) => r.n));

  const item = (t, time) => `
    <div class="ag-item${t.status === "done" ? " done" : ""}" data-id="${t.id}">
      <span class="tm${t.overdue ? " red" : ""}">${time}</span>
      <div style="min-width:0"><div class="tt">${esc(t.title)}</div>
        <div class="mm">${t.assignees.map((a) => taskAvatar(a, 18)).join("")} ${t.assignees.length === 1 ? esc(t.assignees[0].full_name) : ""}</div></div>
    </div>`;

  box.innerHTML = `
    <h4>${d ? `${CAL_WEEKDAYS_FULL[d.getDay()]}, ${d.getDate()} ${CAL_MONTHS_GEN[d.getMonth()]}` : ""}</h4>
    <div class="sub">${list.length ? `${openCount} ${openCount === 1 ? "задача" : openCount >= 2 && openCount <= 4 ? "задачи" : "задач"}${list.length > openCount ? `, выполнено ${list.length - openCount}` : ""}` : "задач на этот день нет"}${late.length ? ` · просрочено ${late.length}` : ""}</div>
    ${list.map((t) => item(t, t.due_from ? `до ${esc(taskDueLabel({ due_date: t.due_date }))}` : t.due_time || "весь день")).join("")}
    ${late.length ? `<div class="td-sec">Срок прошёл</div>${late.map((t) => item(t, esc(taskDueLabel(t)))).join("")}` : ""}
    <button class="btn btn-ghost ag-add" data-add="${esc(iso)}">${icon("plus", 14)} Задача на этот день</button>
    ${calData.undated.length ? `
      <div class="td-sec">Без срока — перетащите на день</div>
      ${calData.undated.slice(0, 10).map((t) => `<div class="ag-undated" draggable="true" data-id="${t.id}" style="border-left-color:${taskPriority(t.priority).color}">${icon("grip", 12)} <span>${esc(t.title)}</span></div>`).join("")}
      ${calData.undated.length > 10 ? `<div class="td-muted" style="font-size:12px;">и ещё ${calData.undated.length - 10} — в списке задач</div>` : ""}` : ""}
    ${loadRows.length ? `
      <div class="td-sec">Нагрузка на эту неделю</div>
      <div class="ag-load">${loadRows.map((r) => `
        <div class="r">${taskAvatar(r.p, 22)}<span class="b" title="${esc(r.p.full_name)}"><i style="width:${Math.round((r.n / max) * 100)}%;background:${taskAvatarColor(r.p.id)}"></i></span><b>${r.n}</b></div>`).join("")}
      </div>` : ""}`;

  box.querySelectorAll(".ag-item, .ag-undated").forEach((el) => { el.onclick = () => openTask(main, Number(el.dataset.id)); });
  box.querySelector(".ag-add").onclick = () => openTaskForm(main, iso);
  wireCalDrop(main, main.querySelector("#tdCal"));
  markCalOpen(main);
}

// ====== Заметки: доска с карточками, как стикеры ======
//
// Общая для администраторов доска 6000×6000 точек. Карточка — заголовок и
// текст с оформлением, цвет, место и размер. Тянуть за верх карточки —
// переместить, за уголок — изменить размер; доску можно приближать и
// отдалять (кнопки или Ctrl+колесо), «Разложить» выстраивает карточки
// столбиками. Текст сохраняется сам через секунду после набора; если
// карточку успел поменять коллега — спросим, чей вариант оставить.
// Правки коллег подтягиваются раз в 15 секунд.

const NOTE_COLORS = [
  ["default", "Без цвета"], ["red", "Красный"], ["orange", "Оранжевый"], ["yellow", "Жёлтый"], ["green", "Зелёный"],
  ["teal", "Бирюзовый"], ["blue", "Голубой"], ["purple", "Фиолетовый"], ["pink", "Розовый"], ["brown", "Коричневый"], ["gray", "Серый"],
];
const KB_SIZE = 6000;
const KB_ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5];
const kbUi = { zoom: 1 };
try { const z = Number(localStorage.getItem("kbZoom")); if (KB_ZOOMS.includes(z)) kbUi.zoom = z; } catch { /* хранилище недоступно */ }

async function renderTaskNotes(main) {
  clearViewPoll();
  main.innerHTML = `
    <div class="topbar">
      <div class="topbar-title-row"><div class="topbar-title">Заметки</div></div>
      <div class="td-top-actions">
        <span class="tn-status" id="kbStatus"></span>
        <div class="kb-zoom" title="Масштаб доски (Ctrl+колесо мыши)">
          <button class="kb-zbtn" data-z="-1" title="Отдалить">−</button>
          <button class="kb-zbtn kb-zval" data-z="0" title="Обычный размер"></button>
          <button class="kb-zbtn" data-z="1" title="Приблизить">+</button>
        </div>
        <button class="btn btn-ghost" id="kbArrange" title="Выстроить карточки столбиками">Разложить</button>
        <button class="btn btn-primary" id="kbNew">${icon("plus", 15)} Заметка</button>
      </div>
    </div>
    <div class="page kb-page">
      <div class="kb-fmt" id="kbFmt" title="Оформление текста в заметке, где стоит курсор">
        <button data-cmd="bold" title="Жирный (Ctrl+B)"><b>Ж</b></button>
        <button data-cmd="italic" title="Курсив (Ctrl+I)"><i style="font-family:Georgia,serif">К</i></button>
        <button data-cmd="underline" title="Подчёркнутый (Ctrl+U)"><u>Ч</u></button>
        <button data-cmd="strikeThrough" title="Зачёркнутый"><s>З</s></button>
        <span class="rte-sep"></span>
        <button data-cmd="insertUnorderedList" title="Маркированный список">•&#8202;≡</button>
        <button data-cmd="insertOrderedList" title="Нумерованный список">1.≡</button>
        <button data-act="check" title="Список с галочками: щёлкните по квадратику, чтобы отметить">☑</button>
        <button data-act="big" title="Крупнее">A<sup>+</sup></button>
        <button data-act="small" title="Мельче">a<sup>−</sup></button>
        <button data-act="link" title="Ссылка">${icon("link", 14)}</button>
        <button data-cmd="removeFormat" title="Убрать оформление">Aa<sub>×</sub></button>
        <span class="kb-fmt-hint">Тяните карточку за верх, размер — за правый нижний угол. Двойной щелчок по доске — новая заметка. Галочку в списке — щелчком по квадратику.</span>
      </div>
      <div class="kb-scroll" id="kbScroll"><div class="kb-sizer" id="kbSizer"><div class="kb-board" id="kbBoard"></div></div></div>
    </div>`;
  const $ = (id) => main.querySelector("#" + id);
  const board = $("kbBoard"), scroll = $("kbScroll"), status = $("kbStatus");
  const notes = new Map();   // id -> { data, el, dirty, timer, saving }
  const say = (t, cls = "") => { status.textContent = t; status.className = `tn-status ${cls}`; };

  const applyZoom = () => {
    board.style.transform = `scale(${kbUi.zoom})`;
    $("kbSizer").style.width = `${KB_SIZE * kbUi.zoom}px`;
    $("kbSizer").style.height = `${KB_SIZE * kbUi.zoom}px`;
    main.querySelector(".kb-zval").textContent = `${Math.round(kbUi.zoom * 100)}%`;
    try { localStorage.setItem("kbZoom", String(kbUi.zoom)); } catch { /* не страшно */ }
  };
  const zoomBy = (dir) => {
    // Точка в центре видимой части остаётся на месте.
    const cx = (scroll.scrollLeft + scroll.clientWidth / 2) / kbUi.zoom, cy = (scroll.scrollTop + scroll.clientHeight / 2) / kbUi.zoom;
    const i = KB_ZOOMS.indexOf(kbUi.zoom);
    kbUi.zoom = dir === 0 ? 1 : KB_ZOOMS[Math.max(0, Math.min(KB_ZOOMS.length - 1, i + dir))];
    applyZoom();
    scroll.scrollLeft = cx * kbUi.zoom - scroll.clientWidth / 2;
    scroll.scrollTop = cy * kbUi.zoom - scroll.clientHeight / 2;
  };
  main.querySelectorAll(".kb-zbtn").forEach((b) => { b.onclick = () => zoomBy(Number(b.dataset.z)); });
  scroll.addEventListener("wheel", (e) => { if (e.ctrlKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
  applyZoom();

  const toBoard = (clientX, clientY) => {
    const r = board.getBoundingClientRect();
    return { x: (clientX - r.left) / kbUi.zoom, y: (clientY - r.top) / kbUi.zoom };
  };
  const patch = async (id, body) => {
    try { return (await api(`/tasks/notes/${id}`, { method: "PATCH", body })).note; } catch (e) { toast(e.message, true); return null; }
  };

  // ---- карточка ----
  function paintNote(n, el) {
    el.className = `kb-note kb-c-${n.color}`;
    Object.assign(el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px`, zIndex: n.z });
    el.querySelector(".kb-meta").textContent = n.updated_by_name ? `${n.updated_by_name} · ${fmtDate(n.updated_at)}` : fmtDate(n.updated_at);
  }
  function setContent(rec) {
    rec.el.querySelector(".kb-title").value = rec.data.title;
    rec.el.querySelector(".kb-body").innerHTML = rec.data.html;
  }
  function addNote(n) {
    const el = document.createElement("div");
    el.dataset.id = n.id;
    el.innerHTML = `
      <div class="kb-head"><input class="kb-title" maxlength="200" placeholder="Заголовок"></div>
      <div class="kb-body" contenteditable="true" data-placeholder="Заметка…"></div>
      <div class="kb-foot">
        <span class="kb-meta"></span>
        <span class="kb-tools">
          <button class="kb-tool" data-a="color" title="Цвет">${icon("palette", 15)}</button>
          <button class="kb-tool" data-a="copy" title="Копия">${icon("plus", 15)}</button>
          <button class="kb-tool" data-a="del" title="Удалить">${icon("trash", 15)}</button>
        </span>
      </div>
      <div class="kb-resize" title="Потяните, чтобы изменить размер"></div>`;
    board.appendChild(el);
    const rec = { data: n, el, dirty: false, timer: null, saving: null };
    notes.set(n.id, rec);
    paintNote(n, el);
    setContent(rec);
    wireNote(rec);
    paintEmpty();
    return rec;
  }

  function wireNote(rec) {
    const { el } = rec;
    const id = rec.data.id;
    const title = el.querySelector(".kb-title"), body = el.querySelector(".kb-body");
    // Щёлкнули по карточке — она наверх.
    el.addEventListener("pointerdown", () => {
      const top = Math.max(...[...notes.values()].map((r) => r.data.z));
      if (rec.data.z < top) { rec.data.z = top + 1; el.style.zIndex = rec.data.z; patch(id, { front: true }); }
    });
    const changed = () => { rec.dirty = true; say("не сохранено…"); clearTimeout(rec.timer); rec.timer = setTimeout(() => saveContent(rec), 1000); };
    title.addEventListener("input", changed);
    body.addEventListener("input", changed);
    // Список с галочками: щелчок по квадратику слева от пункта — отметить/снять.
    body.addEventListener("click", (e) => {
      const li = e.target.closest && e.target.closest("ul[data-checklist] > li");
      if (!li || !body.contains(li)) return;
      if (e.clientX - li.getBoundingClientRect().left > 22 * kbUi.zoom) return;
      e.preventDefault();
      if (li.dataset.checked === "1") delete li.dataset.checked; else li.dataset.checked = "1";
      changed();
    });
    // Enter в отмеченном пункте: новый пункт браузер копирует вместе с галочкой — снимаем её.
    body.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      setTimeout(() => {
        const node = getSelection().anchorNode;
        const li = node && (node.nodeType === 1 ? node : node.parentElement).closest("ul[data-checklist] > li");
        if (li && li.dataset.checked === "1" && !li.textContent.trim()) { delete li.dataset.checked; changed(); }
      }, 0);
    });
    title.addEventListener("blur", () => rec.dirty && saveContent(rec));
    body.addEventListener("blur", () => rec.dirty && saveContent(rec));

    // Перетаскивание за верх карточки (кроме самого поля заголовка, пока в нём курсор).
    el.querySelector(".kb-head").addEventListener("pointerdown", (e) => {
      if (e.target === title && document.activeElement === title) return;
      e.preventDefault();
      const start = toBoard(e.clientX, e.clientY), x0 = rec.data.x, y0 = rec.data.y;
      let moved = false;
      const move = (ev) => {
        const p = toBoard(ev.clientX, ev.clientY);
        const nx = Math.max(0, Math.min(KB_SIZE - rec.data.w, Math.round(x0 + p.x - start.x)));
        const ny = Math.max(0, Math.min(KB_SIZE - 40, Math.round(y0 + p.y - start.y)));
        if (Math.abs(nx - x0) + Math.abs(ny - y0) > 2) { moved = true; el.classList.add("dragging"); }
        rec.data.x = nx; rec.data.y = ny; el.style.left = `${nx}px`; el.style.top = `${ny}px`;
      };
      const up = () => {
        document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
        el.classList.remove("dragging");
        if (moved) patch(id, { x: rec.data.x, y: rec.data.y });
        else title.focus();
      };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    });

    // Размер — за уголок.
    el.querySelector(".kb-resize").addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const start = toBoard(e.clientX, e.clientY), w0 = rec.data.w, h0 = rec.data.h;
      const move = (ev) => {
        const p = toBoard(ev.clientX, ev.clientY);
        rec.data.w = Math.max(180, Math.min(2000, Math.round(w0 + p.x - start.x)));
        rec.data.h = Math.max(120, Math.min(2000, Math.round(h0 + p.y - start.y)));
        el.style.width = `${rec.data.w}px`; el.style.height = `${rec.data.h}px`;
      };
      const up = () => {
        document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
        patch(id, { w: rec.data.w, h: rec.data.h });
      };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    });

    el.querySelectorAll(".kb-tool").forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (b.dataset.a === "del") {
          if (!confirm(`Удалить заметку${rec.data.title ? ` «${rec.data.title}»` : ""}?`)) return;
          try { await api(`/tasks/notes/${id}`, { method: "DELETE" }); notes.delete(id); shrinkOut(el, () => { el.remove(); paintEmpty(); }); } catch (err) { toast(err.message, true); }
        } else if (b.dataset.a === "copy") {
          await createNote({ title: rec.data.title, html: body.innerHTML, color: rec.data.color, x: rec.data.x + 28, y: rec.data.y + 28, w: rec.data.w, h: rec.data.h });
        } else if (b.dataset.a === "color") {
          showPalette(rec);
        }
      };
    });
  }

  function showPalette(rec) {
    main.querySelectorAll(".kb-palette").forEach((p) => p.remove());
    const pop = document.createElement("div");
    pop.className = "kb-palette";
    pop.innerHTML = NOTE_COLORS.map(([c, l]) => `<button class="kb-dot kb-c-${c}${c === rec.data.color ? " on" : ""}" data-c="${c}" title="${l}"></button>`).join("");
    rec.el.appendChild(pop);
    pop.querySelectorAll(".kb-dot").forEach((d) => {
      d.onclick = async (e) => {
        e.stopPropagation();
        rec.data.color = d.dataset.c; paintNote(rec.data, rec.el); pop.remove();
        await patch(rec.data.id, { color: rec.data.color });
      };
    });
    // В фазе перехвата: ручка размера и шапка заметки гасят pointerdown, и на всплытии палитра бы не закрылась.
    setTimeout(() => document.addEventListener("pointerdown", function off(ev) { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener("pointerdown", off, true); } }, true), 0);
  }

  async function saveContent(rec) {
    clearTimeout(rec.timer);
    if (!rec.dirty || rec.saving) return;
    const title = rec.el.querySelector(".kb-title").value, html = rec.el.querySelector(".kb-body").innerHTML;
    say("сохраняю…");
    rec.saving = (async () => {
      try {
        const { note } = await api(`/tasks/notes/${rec.data.id}`, { method: "PATCH", body: { title, html, version: rec.data.version } });
        rec.data = { ...rec.data, ...note, x: rec.data.x, y: rec.data.y, w: rec.data.w, h: rec.data.h, z: rec.data.z, color: rec.data.color };
        if (rec.el.querySelector(".kb-title").value === title && rec.el.querySelector(".kb-body").innerHTML === html) rec.dirty = false;
        paintNote(rec.data, rec.el);
        say("сохранено", "ok");
      } catch (e) {
        if (e.status === 409 && e.data && e.data.note) {
          const theirs = e.data.note;
          const keepMine = confirm(`Заметку «${theirs.title || "без заголовка"}» только что изменил ${theirs.updated_by_name || "другой администратор"}.\n\n`
            + "ОК — сохранить ваш вариант (его изменения пропадут).\nОтмена — показать его вариант (ваши последние правки пропадут).");
          rec.data.version = theirs.version;
          if (!keepMine) { rec.data = { ...rec.data, ...theirs }; setContent(rec); paintNote(rec.data, rec.el); rec.dirty = false; say("показан вариант коллеги", "ok"); }
        } else say(`не сохранено: ${e.message}`, "err");
      } finally { rec.saving = null; }
      if (rec.dirty) rec.timer = setTimeout(() => saveContent(rec), 1000);
    })();
    return rec.saving;
  }

  async function createNote(body) {
    try {
      const { note } = await api("/tasks/notes", { method: "POST", body });
      const rec = addNote(note);
      growIn(rec.el);
      rec.el.querySelector(".kb-body").focus();
      return rec;
    } catch (e) { toast(e.message, true); return null; }
  }
  // Новая — в середине того, что сейчас видно, с небольшим сдвигом, чтобы не ложились стопкой.
  let cascade = 0;
  $("kbNew").onclick = () => {
    const x = (scroll.scrollLeft + scroll.clientWidth / 2) / kbUi.zoom - 140 + (cascade % 5) * 24;
    const y = (scroll.scrollTop + scroll.clientHeight / 2) / kbUi.zoom - 110 + (cascade % 5) * 24;
    cascade++;
    createNote({ x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) });
  };
  board.addEventListener("dblclick", (e) => {
    if (e.target !== board) return;
    const p = toBoard(e.clientX, e.clientY);
    createNote({ x: Math.max(0, Math.round(p.x - 140)), y: Math.max(0, Math.round(p.y - 20)) });
  });

  // «Разложить»: столбиками шириной в видимую часть доски, без наложений.
  $("kbArrange").onclick = async () => {
    const list = [...notes.values()].sort((a, b) => a.data.y - b.data.y || a.data.x - b.data.x);
    if (!list.length) return;
    const gap = 20, colW = 300;
    const cols = Math.max(1, Math.floor((scroll.clientWidth / kbUi.zoom - gap) / (colW + gap)));
    const heights = Array(cols).fill(gap);
    for (const rec of list) {
      const c = heights.indexOf(Math.min(...heights));
      Object.assign(rec.data, { x: gap + c * (colW + gap), y: heights[c], w: colW });
      heights[c] += rec.data.h + gap;
      paintNote(rec.data, rec.el);
    }
    scroll.scrollTo({ left: 0, top: 0, behavior: "smooth" });
    await Promise.all(list.map((r) => patch(r.data.id, { x: r.data.x, y: r.data.y, w: r.data.w })));
    say("разложено", "ok");
  };

  // Оформление — к той заметке, где курсор.
  const fmt = $("kbFmt");
  let savedRange = null;
  document.addEventListener("selectionchange", function track() {
    if (!fmt.isConnected) { document.removeEventListener("selectionchange", track); return; }
    const sel = getSelection();
    const node = sel.rangeCount ? sel.anchorNode : null;
    const elNode = node && (node.nodeType === 1 ? node : node.parentElement);
    if (elNode && elNode.closest(".kb-body")) savedRange = sel.getRangeAt(0).cloneRange();
  });
  const restore = () => {
    if (!savedRange) return false;
    const host = (savedRange.startContainer.nodeType === 1 ? savedRange.startContainer : savedRange.startContainer.parentElement).closest(".kb-body");
    if (!host || !host.isConnected) return false;
    host.focus(); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(savedRange);
    return host;
  };
  const exec = (cmd, value = null) => {
    const host = restore();
    if (!host) { toast("Поставьте курсор в текст заметки", true); return; }
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(cmd, false, value);
    host.dispatchEvent(new Event("input"));
  };
  fmt.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
  fmt.querySelectorAll("[data-cmd]").forEach((b) => { b.onclick = () => exec(b.dataset.cmd); });
  // Список с галочками: обычный маркированный список с пометкой data-checklist.
  // Повторное нажатие внутри такого списка превращает его обратно в текст.
  fmt.querySelector("[data-act=check]").onclick = () => {
    const host = restore();
    if (!host) { toast("Поставьте курсор в текст заметки", true); return; }
    const at = () => { const n = getSelection().anchorNode; return n && (n.nodeType === 1 ? n : n.parentElement); };
    const cur = at() && at().closest("ul");
    if (cur && host.contains(cur) && cur.dataset.checklist === "1") {
      document.execCommand("insertUnorderedList");
    } else if (cur && host.contains(cur)) {
      cur.dataset.checklist = "1";
    } else {
      // Куда браузер поставит курсор после команды, заранее не знаем — новый
      // список находим сравнением «было/стало».
      const before = new Set(host.querySelectorAll("ul"));
      document.execCommand("insertUnorderedList");
      host.querySelectorAll("ul").forEach((ul) => { if (!before.has(ul)) ul.dataset.checklist = "1"; });
    }
    host.dispatchEvent(new Event("input"));
  };
  fmt.querySelector("[data-act=big]").onclick = () => exec("fontSize", "5");
  fmt.querySelector("[data-act=small]").onclick = () => exec("fontSize", "2");
  fmt.querySelector("[data-act=link]").onclick = () => {
    const url = prompt("Адрес ссылки (начинается с https:// или mailto:)", "https://");
    if (url && /^(https?:\/\/|mailto:)\S+$/i.test(url.trim())) exec("createLink", url.trim());
    else if (url) toast("Ссылка должна начинаться с https:// или mailto:", true);
  };

  function paintEmpty() {
    let hint = board.querySelector(".kb-empty");
    if (notes.size) { if (hint) hint.remove(); return; }
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "kb-empty";
      hint.textContent = "Заметок пока нет. Нажмите «+ Заметка» или дважды щёлкните по доске.";
      board.appendChild(hint);
    }
  }

  // Первая загрузка и подтягивание правок коллег.
  async function sync(first) {
    let list;
    try { ({ notes: list } = await api("/tasks/notes")); } catch (e) { if (first) say(`не загрузились: ${e.message}`, "err"); return; }
    if (state.view !== "tasknotes" || !board.isConnected) return;
    const seen = new Set();
    for (const n of list) {
      seen.add(n.id);
      const rec = notes.get(n.id);
      if (!rec) { addNote(n); continue; }
      const editing = rec.dirty || rec.saving || rec.el.contains(document.activeElement) || rec.el.classList.contains("dragging");
      if (editing) continue;
      const contentChanged = n.version !== rec.data.version;
      rec.data = n;
      paintNote(n, rec.el);
      if (contentChanged) setContent(rec);
    }
    for (const [id, rec] of notes) if (!seen.has(id) && !rec.dirty) { rec.el.remove(); notes.delete(id); }
    paintEmpty();
  }
  await sync(true);
  viewPollHandle = setInterval(() => sync(false), 15000);
}
