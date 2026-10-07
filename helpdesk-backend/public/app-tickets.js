// Фронтенд платформы: список, создание и карточка заявки.
// Обычный скрипт без сборщика — функции общие для всех файлов страницы (см. index.html: app.js
// подключается первым, запуск — в нём по DOMContentLoaded, когда загружены все).
// ====== Список заявок ======
// Где человек был в списке: страница, открытые/закрытые, поиск, отдел — отдельно для
// «Входящих» и «Моих». Открыл заявку с пятой страницы, вернулся — снова на пятой, а не
// на первой. Живёт, пока открыта вкладка: после обновления страницы начинать с начала
// естественно.
const listMemory = {};

// ====== Анимация: заявка раскрывается из строки, закрытая «втягивается» в кнопку списка ======
// Экран перерисовывается целиком (setView), поэтому прежний экран перед перерисовкой снимается
// копией (snapshotMain) и на время движения кладётся поверх или под новым — так нет ни пустого
// белого кадра, ни плашки другого цвета:
//   открытие — копия строки вырастает в карточку заявки (см. playTicketOpen), вокруг проявляется
//   экран заявки, список под ним гаснет;
//   закрытие / возврат в работу — копия самой карточки сжимается и уходит в кнопку «Закрытые» или
//   «Открытые», экран заявки под ней растворяется в список.
// Web Animations API — есть и в Chrome 109 (Windows 7). Кто отключил анимацию в системе
// (prefers-reduced-motion), видит переходы как раньше, без движения.
function motionAllowed() {
  return typeof Element.prototype.animate === "function"
    && !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
}
// Копия без id: иначе на странице на время анимации оказались бы два #statusSelect и т.п.
function cloneWithoutIds(el) {
  const c = el.cloneNode(true);
  c.removeAttribute("id");
  c.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  return c;
}
function snapshotMain() {
  const area = document.getElementById("mainArea");
  if (!area || !motionAllowed()) return null;
  const page = area.querySelector(".page");
  return { node: cloneWithoutIds(area), rect: area.getBoundingClientRect(), scroll: page ? page.scrollTop : 0 };
}
function mountSnapshot(snap, zIndex) {
  const el = snap.node;
  el.classList.add("fly-snapshot");
  Object.assign(el.style, { left: snap.rect.left + "px", top: snap.rect.top + "px", width: snap.rect.width + "px", height: snap.rect.height + "px", zIndex: String(zIndex) });
  document.body.appendChild(el);
  const page = el.querySelector(".page");
  if (page) page.scrollTop = snap.scroll;
  return el;
}

// row — копия строки, по которой щёлкнули, и её место ({ node, rect }); snap — копия списка. Сняты до
// перерисовки. Копия строки вырастает до места карточки заявки; по дороге её содержимое сменяется
// копией самой карточки, так что в конце «призрак» неотличим от настоящей карточки и подмены не
// видно. Остальной экран заявки проявляется вокруг, список под ним гаснет.
function playTicketOpen(row, snap) {
  const area = document.getElementById("mainArea");
  const card = document.querySelector(".detail-main .card");
  if (!motionAllowed() || !row || !snap || !area || !card) return;
  const from = row.rect, to = card.getBoundingClientRect();
  const old = mountSnapshot(snap, 1);
  // Сама строка в копии списка прячется — будто это она вылетает из списка, а не её двойник.
  const src = old.querySelector(`.ticket-row[data-id="${row.node.dataset.id}"]`);
  if (src) src.style.visibility = "hidden";
  // Новый экран — над копией списка, без своего фона (иначе список пропал бы сразу), и проявляется.
  const keep = { position: area.style.position, zIndex: area.style.zIndex, background: area.style.background };
  Object.assign(area.style, { position: "relative", zIndex: "2", background: "transparent" });
  card.style.visibility = "hidden";

  const g = document.createElement("div");
  g.className = "fly-ghost fly-grow";
  const rowLayer = row.node, cardLayer = cloneWithoutIds(card);
  rowLayer.classList.add("fly-layer");
  cardLayer.classList.add("fly-layer");
  Object.assign(rowLayer.style, { width: from.width + "px", height: from.height + "px", transform: "none" });
  Object.assign(cardLayer.style, { width: to.width + "px", height: to.height + "px", visibility: "visible" });
  g.append(rowLayer, cardLayer);
  Object.assign(g.style, { left: from.left + "px", top: from.top + "px", width: from.width + "px", height: from.height + "px" });
  document.body.appendChild(g);

  const D = 460, ease = "cubic-bezier(0.2, 0, 0, 1)";
  const radius = (el) => getComputedStyle(el).borderTopLeftRadius || "12px";
  const grow = g.animate([
    { left: from.left + "px", top: from.top + "px", width: from.width + "px", height: from.height + "px", borderRadius: radius(row.node), boxShadow: "0 2px 6px rgba(0, 0, 0, 0.06)" },
    { left: to.left + "px", top: to.top + "px", width: to.width + "px", height: to.height + "px", borderRadius: radius(card), boxShadow: "0 0 0 rgba(0, 0, 0, 0)" },
  ], { duration: D, easing: ease, fill: "forwards" });
  rowLayer.animate([{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }], { duration: D, fill: "forwards" });
  cardLayer.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1, offset: 0.8 }, { opacity: 1 }], { duration: D, fill: "forwards" });
  // Список гаснет в первой трети, экран заявки проявляется со второй половины — чтобы тексты двух экранов
  // не накладывались друг на друга полупрозрачными.
  [...old.children].forEach((c) => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: D * 0.35, easing: "ease-out", fill: "forwards" }));
  [...area.children].forEach((c) => c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: D, easing: "ease-out" }));
  grow.onfinish = grow.oncancel = () => {
    card.style.visibility = "";
    g.remove(); old.remove();
    Object.assign(area.style, keep);
  };
}

// card — карточка заявки (её копия и улетает), snap — копия экрана заявки; target — кнопка списка.
// Всё снято до перехода к списку.
function playTicketFly(card, snap, target) {
  if (!motionAllowed() || !card || !snap || !target) return;
  const from = card.rect, to = target.getBoundingClientRect();
  const old = mountSnapshot(snap, 1999);
  old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-out", fill: "forwards" });
  const g = card.node;
  g.classList.add("fly-ghost");
  Object.assign(g.style, { left: from.left + "px", top: from.top + "px", width: from.width + "px", height: from.height + "px" });
  document.body.appendChild(g);
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const end = Math.max(0.02, Math.min(to.width / from.width, to.height / from.height) * 0.5);
  // Сначала карточка чуть приподнимается и сжимается, потом с ускорением уходит в кнопку — «втягивается».
  const suck = g.animate([
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(${dx * 0.15}px, ${dy * 0.15 - 18}px) scale(0.62)`, opacity: 1, offset: 0.32 },
    { transform: `translate(${dx}px, ${dy}px) scale(${end})`, opacity: 0.2 },
  ], { duration: 560, easing: "cubic-bezier(0.55, 0, 0.8, 0.3)", fill: "forwards" });
  suck.onfinish = suck.oncancel = () => {
    g.remove(); old.remove();
    target.animate([{ transform: "scale(1)" }, { transform: "scale(1.16)" }, { transform: "scale(0.96)" }, { transform: "scale(1)" }],
      { duration: 320, easing: "ease-out" });
  };
}
function snapshotCard() {
  const card = document.querySelector(".detail-main .card");
  return card && motionAllowed() ? { node: cloneWithoutIds(card), rect: card.getBoundingClientRect() } : null;
}

// Номера страниц для переключателя: первая, последняя и соседи текущей, между ними —
// многоточие. 1 … 4 5 [6] 7 8 … 20 — а не двадцать кнопок в ряд.
function pageNumbers(current, pages) {
  const set = new Set([1, pages]);
  for (let p = current - 2; p <= current + 2; p++) if (p >= 1 && p <= pages) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("…");
    out.push(p);
  });
  return out;
}

async function renderList(main, opts = {}) {
  clearViewPoll();
  const u = state.user;
  const isAdmin = Boolean(u.is_admin);
  const isExecutor = myDepts(u).length > 0;
  const isPrivileged = isAdmin || isExecutor; // видит колонки "От кого"/"Кабинет"
  const scope = opts.scope || "inbox";
  // Фильтр по отделу имеет смысл только администратору: исполнителю сервер и
  // так отдаёт очередь одного его отдела, выбирать не из чего.
  const showDeptFilter = isAdmin && scope === "inbox";

  const memory = listMemory[scope] || (listMemory[scope] = { page: 1, closed: false, q: "", dept: "" });
  let closed = memory.closed; // открытые/закрытые — переключатель внутри страницы, не выпадающий список
  let q = memory.q;
  let page = memory.page;

  const titles = {
    inbox: isAdmin || isExecutor ? "Входящие заявки" : "Мои заявки",
    mine: "Мои заявки",
  };

  // Тема занимает всё свободное место (1fr), а не упирается в 260px:
  // на широком экране заголовок заявки иначе обрезался посреди слова.
  // Последней колонки со стрелкой больше нет: строка и так кликается целиком,
  // а стрелка только занимала место и намекала на несуществующее действие.
  // Ширины подрезаны так, чтобы строка целиком помещалась на экране 1440
  // рядом с боковой панелью: прежние (150/80/130/150/140) требовали 1105 px
  // при доступных 1080, и горизонтальная полоса висела всегда, а не только
  // при узком окне. Замерено в браузере; даты «04.09.2026, 06:18» хватает
  // 132 px, бейджу статуса — 118.
  const gridCols = isPrivileged
    ? "92px minmax(200px,1fr) 140px 72px 118px 140px 132px"
    : "92px minmax(200px,1fr) 118px 140px 132px";
  // Минимальная ширина строки — сумма колонок, промежутков и полей. Нужна
  // и шапке, и строкам: без общей ширины доля 1fr считалась бы по содержимому
  // каждой строки отдельно, и колонки разъезжались (см. .ticket-row в стилях).
  // Считаем из той же строки описания сетки, чтобы два места не разошлись.
  //
  // Колонка «Тема» задана как minmax(200px,1fr), и её нижнюю границу надо
  // брать ОТТУДА ЖЕ. Раньше здесь стояла отдельная константа TEMA_MIN=160,
  // которая ни на что не влияла: сетка всё равно не сжималась ниже 200, и
  // объявленный min-width строки оказывался меньше её настоящего минимума —
  // строка вылезала за собственную заявленную ширину.
  const колонки = gridCols.split(" ");
  const ПОЛЯ = 35;   // паддинги строки 16+16 и цветная кромка слева 3
  const gridMin = колонки.reduce((сумма, track) => {
    const м = track.match(/^(\d+)px$/) || track.match(/^minmax\((\d+)px,/);
    return сумма + Number(м ? м[1] : 0);
  }, 0) + (колонки.length - 1) * 18 + ПОЛЯ;

  main.innerHTML = `
    <div class="topbar">
      <div class="topbar-title">${titles[scope]}</div>
      <div class="search-wrap"><span class="search-icon">${icon("search", 15)}</span>
        <input class="input" id="searchInput" placeholder="Поиск по номеру или теме">
      </div>
    </div>
    <div class="page">
      <div class="filters-row">
        <div class="toggle-group">
          <button class="toggle-btn${closed ? "" : " active"}" data-closed="0">Открытые</button>
          <button class="toggle-btn${closed ? " active" : ""}" data-closed="1">Закрытые</button>
        </div>
        ${showDeptFilter ? `
        <select class="input" id="deptFilter">
          <option value="">Все отделы</option>
          ${state.departments.map(d => `<option${d.name === memory.dept ? " selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select>` : ""}
        <div class="filters-count" id="countLabel">Загрузка…</div>
      </div>
      <div class="ticket-table">
        <div class="ticket-row-head" style="grid-template-columns:${gridCols};min-width:${gridMin}px;">
          <div>Номер</div><div>Тема</div>
          ${isPrivileged ? `<div>От кого</div><div>Кабинет</div>` : ""}
          <div>Статус</div><div>Исполнитель</div><div>Создано</div>
        </div>
        <div id="ticketRows"><div class="spinner">Загрузка заявок…</div></div>
      </div>
      <div class="pager" id="pager"></div>
    </div>`;
  document.getElementById("searchInput").value = q;

  const remember = () => {
    memory.page = page; memory.closed = closed; memory.q = q;
    if (showDeptFilter) memory.dept = document.getElementById("deptFilter").value;
  };

  const renderPager = (pages) => {
    const el = document.getElementById("pager");
    if (!el) return;
    if (pages <= 1) { el.innerHTML = ""; return; }
    const btn = (label, target, extra = "") =>
      `<button class="btn btn-ghost pager-btn${extra}" data-page="${target}"${target === page ? ' aria-current="page"' : ""}>${label}</button>`;
    el.innerHTML =
      (page > 1 ? btn("‹", page - 1, " pager-step") : "") +
      pageNumbers(page, pages).map(p => p === "…"
        ? `<span class="pager-gap">…</span>`
        : btn(String(p), p, p === page ? " pager-current" : "")).join("") +
      (page < pages ? btn("›", page + 1, " pager-step") : "");
    el.querySelectorAll(".pager-btn").forEach(b => {
      b.onclick = () => {
        page = Number(b.dataset.page);
        load();
        main.scrollTop = 0;
        window.scrollTo(0, 0);
      };
    });
  };

  const load = async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("status", closed ? "archive" : "");
    if (scope === "mine") params.set("mine", "1");
    if (showDeptFilter) {
      const dept = document.getElementById("deptFilter").value;
      if (dept) params.set("category", dept);
    }
    params.set("page", String(page));
    try {
      const res = await api("/tickets?" + params.toString());
      const { tickets, total, limit } = res;
      // Страницу мог поправить сервер (заявок стало меньше — пятой уже нет).
      page = res.page || 1;
      remember();
      const rowsEl = document.getElementById("ticketRows");
      if (!rowsEl) return; // пока ждали ответ, человек ушёл в другой раздел
      const from = (page - 1) * limit + 1;
      const to = from + tickets.length - 1;
      document.getElementById("countLabel").textContent = total > tickets.length
        ? `Заявок: ${total} · показаны ${from}–${to}`
        : `Заявок: ${total}`;
      renderPager(res.pages || 1);
      if (tickets.length === 0) {
        rowsEl.innerHTML = `<div class="empty-state">Ничего не найдено.</div>`;
        return;
      }
      const unreadTicketIds = new Set(state.notifications.filter(n => !n.is_read).map(n => n.ticket_id));
      rowsEl.innerHTML = tickets.map(t => {
        const p = PRIORITIES.find(x => x.id === t.priority) || PRIORITIES[2];
        const [sc, ss] = STATUS_COLORS[t.status] || STATUS_COLORS.new;
        const sLabel = statusLabel(t.status);
        const isUnread = unreadTicketIds.has(t.id);
        return `
        <div class="ticket-row" data-id="${t.id}" data-prio="${t.priority}" title="Приоритет: ${p.label.toLowerCase()}" style="grid-template-columns:${gridCols};min-width:${gridMin}px;">
          <div class="ticket-id mono">${esc(t.display_id)}</div>
          <div class="ticket-title-cell${isUnread ? " unread" : ""}"${isUnread ? ` title="Есть новые комментарии"` : ""}>
            <span class="title" style="${isUnread ? "font-weight:700;" : ""}">${esc(t.title)}</span>
          </div>
          ${isPrivileged ? `
            <div class="cell-wrap" style="color:var(--ink-soft);font-size:13px;">${esc(t.created_by || "—")}</div>
            <div class="cell-ellipsis mono" style="color:var(--ink-soft);font-size:13px;">${esc(t.room || "—")}</div>
          ` : ""}
          <div><span class="badge" style="color:${sc};background:${ss};">${sLabel}</span></div>
          <div class="cell-wrap" style="color:var(--ink-soft);font-size:13px;">${esc(t.assigned_to || "—")}</div>
          <div class="cell-ellipsis" style="color:var(--ink-soft);font-size:12px;">${fmtDate(t.created_at)}</div>
        </div>`;
      }).join("");
      rowsEl.querySelectorAll(".ticket-row").forEach(row => {
        row.onclick = async () => {
          try {
            const { ticket } = await api("/tickets/" + row.dataset.id);
            api(`/notifications/ticket/${row.dataset.id}/read`, { method: "PATCH" })
              .then(refreshNotifications).then(updateBadgeDom).catch(() => {});
            // До перерисовки: после неё ни строки, ни списка уже не будет.
            const rowSnap = motionAllowed() ? { node: cloneWithoutIds(row), rect: row.getBoundingClientRect() } : null;
            const snap = snapshotMain();
            setView("detail", ticket);
            playTicketOpen(rowSnap, snap);
          } catch (e) { toast(e.message, true); }
        };
      });
    } catch (e) {
      document.getElementById("ticketRows").innerHTML = `<div class="empty-state">Не удалось загрузить заявки: ${esc(e.message)}</div>`;
    }
  };

  // Сменили условие отбора — начинаем с первой страницы: пятая страница прежнего
  // списка к новому отношения не имеет.
  main.querySelectorAll(".toggle-btn").forEach(btn => {
    btn.onclick = () => {
      closed = btn.dataset.closed === "1";
      main.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      page = 1;
      load();
    };
  });
  if (showDeptFilter) document.getElementById("deptFilter").onchange = () => { page = 1; load(); };
  let searchTimer;
  document.getElementById("searchInput").oninput = () => {
    q = document.getElementById("searchInput").value;
    page = 1;
    clearTimeout(searchTimer); searchTimer = setTimeout(load, 300);
  };

  load();
  viewPollHandle = setInterval(load, 20000); // автообновление списка
}

// ====== Новая заявка ======
//
// Отдел выбирается плитками в ГОРИЗОНТАЛЬНОЙ ЛЕНТЕ, а не выпадающим списком и
// не сеткой с переносом. Причин две.
//
// Список не годился потому, что «ЕГРПО» и «ХОЗ» человеку со стороны ни о чём
// не говорят: под названием нужна строка с примерами, а в <option> ей места
// нет. Плитка её вмещает.
//
// Лента, а не сетка, потому что отделы задаются в config/departments.js и их
// число может вырасти. При переносе четвёртая плитка встала бы во вторую
// строку, форма подросла бы, и всё под ней уехало вниз — а высота ленты
// одинакова при любом числе отделов.
function renderCreate(main) {
  let files = [];
  // Скрытые в Администрировании группы плиток не получают: заявки к ним
  // приходят своими путями (например, по программам из Заявки на доступ).
  const отделы = state.departments.filter((d) => !d.hidden);
  // Первый отдел выбран заранее — как и раньше, когда здесь стоял <select> и
  // выбранным по умолчанию был первый пункт.
  let отдел = отделы.length ? отделы[0].name : "";
  let приоритет = "medium";

  const плиткаHtml = (d, i) => `
    <button type="button" class="dept-tile ${d.name === отдел ? "active" : ""}" data-dept="${esc(d.name)}">
      <span class="dept-icon" style="color:${esc(deptColor(d, i))};">${icon(deptIcon(d), 22)}</span>
      <span class="dept-name">${esc(d.name)}</span>
      <span class="dept-hint">${esc(d.hint || "")}</span>
      <span class="dept-check">${icon("check", 12)}</span>
    </button>`;

  // Заявка на доступ сотрудника — не отдел, а готовая анкета для отдела ИТ:
  // по ней ИТ заводит учётную запись, а сотрудник печатает служебную записку.
  // Плитка стоит сразу за ИТ, потому что уходит туда же.
  const ACCESS = "__access";
  const доступHtml = `
    <button type="button" class="dept-tile access" data-dept="${ACCESS}">
      <span class="dept-icon">${icon("key", 22)}</span>
      <span class="dept-name">Заявка на доступ</span>
      <span class="dept-hint">Учётная запись сотрудника: регистрация, блокировка, восстановление, права</span>
      <span class="dept-check">${icon("check", 12)}</span>
    </button>`;
  const плитки = отделы.map(плиткаHtml);
  плитки.splice(Math.min(1, плитки.length), 0, доступHtml);

  main.innerHTML = `
    <div class="topbar"><div class="topbar-title">Новая заявка</div></div>
    <div class="page">
      <div class="form-narrow">

        <div class="form-card">
          <div class="form-card-title">Куда направить</div>
          <div class="form-card-sub">Выберите отдел, который решает такие вопросы</div>
          <div class="dept-strip" id="deptStrip">
            <div class="dept-fade left" hidden></div>
            <button type="button" class="dept-nav prev" hidden aria-label="Предыдущие отделы">${icon("chevron-left", 16)}</button>
            <div class="dept-scroll" id="deptScroll">${плитки.join("")}</div>
            <div class="dept-fade right" hidden></div>
            <button type="button" class="dept-nav next" hidden aria-label="Следующие отделы">${icon("chevron", 16)}</button>
          </div>
        </div>

        <div id="ticketPart">
        <div class="form-card">
          <div class="form-card-title" style="margin-bottom:16px;">Суть обращения</div>

          <div class="field-label">Тема</div>
          <input class="field-input" id="cTitle" maxlength="${TITLE_MAX}" placeholder="Коротко опишите проблему" style="margin-bottom:4px;">
          <div class="counter" style="margin-bottom:16px;" id="titleCount">0/${TITLE_MAX}</div>

          <div class="field-label">Описание</div>
          <textarea class="input field-input" id="cDesc" maxlength="${DESCRIPTION_MAX}" rows="4"
            placeholder="Что произошло, когда началось, что уже пробовали"
            style="width:100%;box-sizing:border-box;margin-bottom:4px;resize:vertical;"></textarea>
          <div class="counter" id="descCount">0/${DESCRIPTION_MAX}</div>

          <div class="dropzone" id="dropzone"><span class="dropzone-icon">${icon("paperclip", 18)}</span>Перетащите файлы сюда или нажмите, чтобы выбрать</div>
          <input type="file" id="fileInput" multiple style="display:none;">
          <div id="fileList" style="margin-bottom:18px;"></div>

          <div class="field-label">Приоритет</div>
          <div class="prio-row" id="prioRow">
            ${PRIORITIES.map(p => `
              <button type="button" class="prio-chip ${p.id === приоритет ? "active" : ""}" data-prio="${p.id}">
                <i style="background:${p.color}"></i>${p.label}
              </button>`).join("")}
          </div>

          <div class="form-row" style="margin-bottom:0;">
            <div><div class="field-label">Кабинет</div><input class="field-input" id="cRoom" placeholder="напр. 214" style="margin-bottom:0;"></div>
            <div><div class="field-label">Внутренний номер</div><input class="field-input" id="cExt" placeholder="напр. 214" style="margin-bottom:0;"></div>
          </div>
        </div>

        <div class="form-foot">
          <div class="hint" id="routeHint"></div>
          <div class="actions">
            <button class="btn-text" id="cancelBtn">Отмена</button>
            <button class="btn-send" id="submitBtn">Отправить заявку</button>
          </div>
        </div>
        </div>
        <div id="accessPart" hidden></div>

      </div>
    </div>`;

  const titleEl = document.getElementById("cTitle");
  const descEl = document.getElementById("cDesc");
  const roomEl = document.getElementById("cRoom");
  const extEl = document.getElementById("cExt");
  const submitBtn = document.getElementById("submitBtn");
  const routeHint = document.getElementById("routeHint");

  // --- Лента отделов ------------------------------------------------------
  const strip = document.getElementById("deptStrip");
  const scroll = document.getElementById("deptScroll");
  const nav = { prev: strip.querySelector(".dept-nav.prev"), next: strip.querySelector(".dept-nav.next") };
  const fade = { left: strip.querySelector(".dept-fade.left"), right: strip.querySelector(".dept-fade.right") };

  function updateStrip() {
    // Класс ставим ДО замеров: он отводит поля по краям под кнопки, и без него
    // ширина ленты считалась бы по старой раскладке. Поля появляются только
    // когда прокручивать есть что — иначе при трёх отделах, которые и так
    // помещаются, две пустые колонки съели бы 68 px и лента поехала бы на
    // ровном месте.
    strip.classList.toggle("scrollable", scroll.scrollWidth > scroll.clientWidth + 4);
    const влево = scroll.scrollLeft > 4;
    const вправо = scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 4;
    nav.prev.hidden = !влево; fade.left.hidden = !влево;
    nav.next.hidden = !вправо; fade.right.hidden = !вправо;
  }
  const шаг = () => scroll.clientWidth * 0.8;
  nav.prev.onclick = () => scroll.scrollBy({ left: -шаг(), behavior: "smooth" });
  nav.next.onclick = () => scroll.scrollBy({ left: шаг(), behavior: "smooth" });
  scroll.addEventListener("scroll", updateStrip);
  // Колесо мыши крутит ленту вбок. Прокрутку страницы перехватываем только
  // когда ленте есть куда ехать, иначе колесо над ней «залипало» бы.
  scroll.addEventListener("wheel", (e) => {
    if (scroll.scrollWidth <= scroll.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    scroll.scrollLeft += e.deltaY;
  }, { passive: false });
  window.addEventListener("resize", updateStrip);
  updateStrip();

  const ticketPart = document.getElementById("ticketPart");
  const accessPart = document.getElementById("accessPart");
  scroll.querySelectorAll(".dept-tile").forEach(tile => {
    tile.onclick = () => {
      scroll.querySelectorAll(".dept-tile").forEach(t => t.classList.toggle("active", t === tile));
      const доступ = tile.dataset.dept === ACCESS;
      ticketPart.hidden = доступ;
      accessPart.hidden = !доступ;
      // Анкету рисуем один раз: вернулись с другой плитки — введённое на месте.
      if (доступ && !accessPart.childElementCount) renderAccessForm(accessPart, { onCancel: () => setView("inbox") });
      if (доступ) return;
      отдел = tile.dataset.dept;
      showRouteHint();
    };
  });

  document.getElementById("prioRow").querySelectorAll(".prio-chip").forEach(chip => {
    chip.onclick = () => {
      приоритет = chip.dataset.prio;
      document.getElementById("prioRow").querySelectorAll(".prio-chip")
        .forEach(c => c.classList.toggle("active", c === chip));
    };
  });

  function showRouteHint() {
    routeHint.classList.remove("invalid");
    routeHint.textContent = отдел
      ? `Заявка попадёт в очередь отдела ${отдел}. Ход работы и ответы исполнителя придут в оповещения.`
      : "Выберите отдел, в который отправить заявку.";
  }
  showRouteHint();

  // --- Проверка заполнения ------------------------------------------------
  //
  // Кнопка НЕ блокируется: заблокированная кнопка молчит о том, чего не
  // хватает, и человек жмёт на неё, не понимая, почему ничего не происходит.
  // Отправку останавливаем на клике и сразу показываем, какие поля пустые.
  //
  // Вложения не обязательны: заявка про «не открывается диск» прикладывать
  // нечего, и требовать файл значило бы заставлять людей прикладывать что
  // попало.
  const ОБЯЗАТЕЛЬНЫЕ = [
    { el: titleEl, имя: "тема" },
    { el: descEl, имя: "описание" },
    { el: roomEl, имя: "кабинет" },
    { el: extEl, имя: "внутренний номер" },
  ];
  ОБЯЗАТЕЛЬНЫЕ.forEach(({ el }) => el.oninput = () => el.classList.remove("invalid"));

  titleEl.addEventListener("input", () => {
    document.getElementById("titleCount").textContent = `${titleEl.value.length}/${TITLE_MAX}`;
  });
  descEl.addEventListener("input", () => {
    document.getElementById("descCount").textContent = `${descEl.value.length}/${DESCRIPTION_MAX}`;
  });

  /** Отмечает пустые поля и возвращает список их названий. */
  function пустые() {
    const список = [];
    for (const { el, имя } of ОБЯЗАТЕЛЬНЫЕ) {
      const пусто = !el.value.trim();
      el.classList.toggle("invalid", пусто);
      if (пусто) список.push(имя);
    }
    if (!отдел) {
      routeHint.classList.add("invalid");
      список.unshift("отдел");
    }
    return список;
  }

  document.getElementById("cancelBtn").onclick = () => setView("inbox");

  // --- Вложения -----------------------------------------------------------
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const fileList = document.getElementById("fileList");
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = () => { files = [...files, ...fileInput.files]; renderFiles(); };
  function renderFiles() {
    fileList.innerHTML = files.map((f, i) => `
      <div class="file-chip"><span class="file-chip-name">${icon("paperclip", 13)} ${esc(f.name)} <span style="color:var(--ink-soft);">· ${(f.size/1024).toFixed(0)} КБ</span></span><span class="file-chip-remove" data-i="${i}">${icon("x", 13)}</span></div>`).join("");
    fileList.querySelectorAll("[data-i]").forEach(el => el.onclick = () => { files.splice(+el.dataset.i, 1); renderFiles(); });
  }

  submitBtn.onclick = async () => {
    const незаполнено = пустые();
    if (незаполнено.length) {
      toast(`Заполните: ${незаполнено.join(", ")}`, true);
      const первое = ОБЯЗАТЕЛЬНЫЕ.find(({ el }) => el.classList.contains("invalid"));
      if (первое) первое.el.focus();
      else strip.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const title = titleEl.value.trim();
    submitBtn.disabled = true; submitBtn.textContent = "Отправка…";

    // Создание заявки и прикрепление файлов разделены намеренно. Раньше оба
    // шага стояли в одном try: если заявка создавалась, а файл не проходил
    // (слишком большой, неподходящий тип, оборвалась сеть), человек видел
    // только сообщение об ошибке и нажимал «Отправить» ещё раз — так
    // появлялась вторая заявка, а первая оставалась висеть без вложения.
    let ticket;
    try {
      ticket = await api("/tickets", { method: "POST", body: {
        title,
        category: отдел,
        priority: приоритет,
        room: roomEl.value.trim(),
        extension: extEl.value.trim(),
        description: descEl.value.trim(),
      }});
    } catch (e) {
      // Заявки нет — повторить целиком безопасно.
      toast(e.message, true);
      submitBtn.disabled = false; submitBtn.textContent = "Отправить заявку";
      return;
    }

    // Дальше заявка УЖЕ существует, и отказ вложения её не отменяет.
    const notAttached = [];
    for (const f of files) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        await api(`/tickets/${ticket.id}/attachments`, { method: "POST", body: fd });
      } catch (e) {
        notAttached.push(`${f.name} (${e.message})`);
      }
    }

    if (notAttached.length) {
      toast(`Заявка ${ticket.display_id} создана, но не прикрепились файлы: ${notAttached.join(", ")}. `
        + "Добавьте их в карточке заявки.", true);
    } else {
      toast(`Заявка ${ticket.display_id} создана`);
    }
    // Открываем саму заявку, а не список: человек видит, что она есть, и может
    // тут же дослать то, что не прикрепилось.
    setView("detail", ticket);
  };
}

// ====== Карточка заявки ======
async function reloadTicket(id) {
  const { ticket } = await api("/tickets/" + id);
  state.currentTicket = ticket;
  return ticket;
}

function renderDetail(main, ticket) {
  const u = state.user;
  const isAdmin = Boolean(u.is_admin);
  const depts = myDepts(u);
  // Право оставить внутреннюю заметку — у любого сотрудника службы, не только
  // у администратора: исполнитель ведёт заявку и пишет по ней служебные пометки.
  const isPrivileged = isAdmin || depts.length > 0;
  // А управлять заявкой (статус, исполнитель, приоритет) вправе администратор
  // и исполнитель ТОГО отдела, куда заявка заведена. Ровно это же правило
  // проверяет сервер в canManageTicket — расхождение здесь означало бы кнопки,
  // которые не работают.
  const canManage = isAdmin || depts.includes(ticket.category);
  const p = PRIORITIES.find(x => x.id === ticket.priority) || PRIORITIES[2];

  main.innerHTML = `
    <div class="topbar"><div class="topbar-title-row"><button class="icon-btn" id="backBtn" title="Назад">${icon("chevron", 18)}</button><div class="topbar-title mono" style="color:var(--wire);">${esc(ticket.display_id)}</div></div></div>
    <div class="page">
      <div class="detail-layout">
        <div class="detail-main">
          <div class="card" style="margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:10px;">
              <div style="font-size:17px;font-weight:700;letter-spacing:-0.2px;word-break:break-word;overflow-wrap:break-word;">${esc(ticket.title)}</div>
              <span class="priority-dot" style="background:${p.color};margin-top:6px;"></span>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:16px;" id="statusRow"></div>
            <div style="font-size:13.5px;line-height:1.55;margin-bottom:16px;word-break:break-word;overflow-wrap:break-word;">${esc(ticket.description || "Без описания")}</div>
            <div id="attachList" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
          </div>
          ${ticket.form ? ticketFormCard(ticket) : ""}
          <div class="card">
            <div class="section-label">Комментарии</div>
            <div id="commentsList" style="margin-bottom:18px;"></div>
            <textarea class="input" id="commentText" rows="3" placeholder="Написать комментарий..." style="width:100%;margin-bottom:10px;"></textarea>
            <div style="display:flex;align-items:center;justify-content:space-between;">
              ${isPrivileged ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-soft);"><input type="checkbox" id="internalCheck"> Внутренняя заметка</label>` : "<span></span>"}
              <button class="btn btn-wire" id="sendCommentBtn">Отправить</button>
            </div>
          </div>
          <div class="history-toggle" id="historyToggle"><span class="chevron-icon">${icon("chevron", 13)}</span>История изменений статуса</div>
          <div id="historyList" style="display:none;margin-top:8px;padding-left:18px;border-left:2px solid var(--line-soft);"></div>
        </div>
        <div class="detail-side">
          <div class="card" style="margin-bottom:14px;">
            <div class="section-label">Детали</div>
            <div class="field-mini"><div class="field-mini-label">Создал</div><div class="field-mini-value">${esc(ticket.created_by_name)}</div></div>
            ${ticket.room ? `<div class="field-mini"><div class="field-mini-label">Кабинет</div><div class="field-mini-value mono">${esc(ticket.room)}</div></div>` : ""}
            ${ticket.extension ? `<div class="field-mini"><div class="field-mini-label">Внутр. номер</div><div class="field-mini-value mono">${esc(ticket.extension)}</div></div>` : ""}
            ${!canManage ? `<div class="field-mini"><div class="field-mini-label">Исполнитель</div><div class="field-mini-value">${esc(ticket.assigned_to_name || "—")}</div></div>` : ""}
            <div class="field-mini"><div class="field-mini-label">Создана</div><div class="field-mini-value mono">${fmtDate(ticket.created_at)}</div></div>
            <div class="field-mini"><div class="field-mini-label">Обновлена</div><div class="field-mini-value mono">${fmtDate(ticket.updated_at)}</div></div>
          </div>
          ${canManage ? `
          <div class="card">
            <div class="section-label">Управление</div>
            <div class="field-label">Статус</div>
            <select class="input" id="statusSelect" style="width:100%;margin-bottom:14px;">${STATUSES.map(s => `<option value="${s.id}" ${s.id === ticket.status ? "selected" : ""}>${s.label}</option>`).join("")}</select>
            <div class="field-label">Исполнитель</div>
            <select class="input" id="assigneeSelect" style="width:100%;"><option value="">Загрузка…</option></select>
          </div>` : ""}
        </div>
      </div>
    </div>`;

  function renderStatusRow() {
    const [sc, ss] = STATUS_COLORS[ticket.status] || STATUS_COLORS.new;
    const sLabel = statusLabel(ticket.status);
    document.getElementById("statusRow").innerHTML = `
      <span class="badge" style="color:${sc};background:${ss};">${sLabel}</span>
      <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${esc(ticket.category || "—")}</span>`;
  }
  function renderAttachments() {
    document.getElementById("attachList").innerHTML = (ticket.attachments || []).map(a => `
      <a class="badge" href="/api/tickets/${ticket.id}/attachments/${a.id}" download="${esc(a.filename)}"
         style="color:var(--ink);background:var(--line-soft);text-decoration:none;">
        ${icon("paperclip", 13)} ${esc(a.filename)} <span style="color:var(--ink-soft);">· ${(a.filesize/1024).toFixed(0)} КБ</span>
      </a>`).join("");
  }
  function renderComments() {
    const list = ticket.comments || [];
    document.getElementById("commentsList").innerHTML = list.length ? list.map(c => `
      <div class="comment-box ${c.is_internal ? "internal" : "public"}">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:700;">${esc(c.author)} ${c.is_internal ? `<span style="color:var(--note);font-size:10.5px;">ВНУТРЕННЯЯ ЗАМЕТКА</span>` : ""}</span>
          <span style="font-size:11px;color:var(--ink-soft);">${fmtDate(c.created_at)}</span>
        </div>
        <div style="font-size:13px;line-height:1.5;">${esc(c.text)}</div>
      </div>`).join("") : `<div style="font-size:12.5px;color:var(--ink-soft);">Комментариев пока нет.</div>`;
  }
  function renderHistory() {
    const list = ticket.history || [];
    document.getElementById("historyList").innerHTML = list.length ? list.map(h => `
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">
        <span class="mono" style="color:var(--ink);">${fmtDate(h.changed_at)}</span> —
        ${esc(h.old_status ? statusLabel(h.old_status) : "—")} →
        <b style="color:var(--ink);">${esc(statusLabel(h.new_status))}</b>, ${esc(h.changed_by)}
      </div>`).join("") : `<div style="font-size:12px;color:var(--ink-soft);">Изменений не было.</div>`;
  }
  async function renderAssigneeSelect() {
    const sel = document.getElementById("assigneeSelect");
    if (!sel) return;
    try {
      const { users } = await api(`/tickets/${ticket.id}/assignees`);
      sel.innerHTML = `<option value="">— не назначено —</option>` +
        users.map(usr => `<option value="${usr.id}" ${usr.id === ticket.assigned_to ? "selected" : ""}>${esc(usr.full_name)}</option>`).join("");
    } catch (e) {
      sel.innerHTML = `<option value="">Не удалось загрузить список</option>`;
    }
  }

  renderStatusRow(); renderAttachments(); renderComments(); renderHistory();
  if (canManage) renderAssigneeSelect();

  document.getElementById("historyToggle").onclick = () => {
    const el = document.getElementById("historyList");
    const toggleEl = document.getElementById("historyToggle");
    const open = el.style.display !== "none";
    el.style.display = open ? "none" : "block";
    toggleEl.classList.toggle("open", !open);
  };

  document.getElementById("sendCommentBtn").onclick = async () => {
    const text = document.getElementById("commentText").value.trim();
    if (!text) return;
    const isInternal = isPrivileged && document.getElementById("internalCheck").checked;
    try {
      await api(`/tickets/${ticket.id}/comments`, { method: "POST", body: { text, is_internal: isInternal } });
      const fresh = await reloadTicket(ticket.id);
      renderDetail(main, fresh);
    } catch (e) { toast(e.message, true); }
  };

  if (canManage) {
    document.getElementById("statusSelect").onchange = async (e) => {
      try {
        await api(`/tickets/${ticket.id}`, { method: "PATCH", body: { status: e.target.value } });
        const m = listMemory.inbox || (listMemory.inbox = { page: 1, closed: false, q: "", dept: "" });
        // Закрыли — работа с заявкой окончена: назад к открытым входящим, за следующей; карточка
        // улетает в «Закрытые». Вернули закрытую в работу — назад в список, откуда пришли, карточка
        // улетает в «Открытые».
        const closing = e.target.value === "closed";
        const reopening = ticket.status === "closed" && !closing;
        if (closing || reopening) {
          if (closing) m.closed = false;
          toast(closing ? `Заявка ${ticket.display_id} закрыта` : `Заявка ${ticket.display_id} снова открыта`);
          const card = snapshotCard(), snap = snapshotMain();
          setView("inbox");
          playTicketFly(card, snap, document.querySelector(`.toggle-btn[data-closed="${closing ? 1 : 0}"]`));
          return;
        }
        const fresh = await reloadTicket(ticket.id);
        renderDetail(main, fresh);
        toast("Статус обновлён");
      } catch (err) { toast(err.message, true); }
    };
    document.getElementById("assigneeSelect").onchange = async (e) => {
      try {
        await api(`/tickets/${ticket.id}`, { method: "PATCH", body: { assigned_to: e.target.value ? Number(e.target.value) : null } });
        const fresh = await reloadTicket(ticket.id);
        renderDetail(main, fresh);
        toast("Исполнитель обновлён");
      } catch (err) { toast(err.message, true); }
    };
  }

  document.getElementById("backBtn").onclick = () => setView(state.previousView || "inbox");

  // Открыли заявку — гасим счётчик уведомлений по ней.
  api(`/notifications/ticket/${ticket.id}/read`, { method: "PATCH" })
    .then(refreshNotifications).then(updateBadgeDom).catch(() => {});

  // Автообновление карточки — не трогаем, если в поле комментария уже
  // что-то набрано, чтобы не затереть недописанный текст. renderDetail
  // вызывается повторно после каждого действия (комментарий, смена статуса)
  // и самим опросом — поэтому сперва гасим предыдущий интервал.
  clearViewPoll();
  viewPollHandle = setInterval(async () => {
    const box = document.getElementById("commentText");
    if (box && box.value.trim()) return;
    try {
      const fresh = await reloadTicket(ticket.id);
      renderDetail(main, fresh);
    } catch (e) { /* тихо пропускаем сбой одного цикла опроса */ }
  }, 20000);
}
