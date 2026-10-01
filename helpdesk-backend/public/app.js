// ====== Иконки (единый набор — обводка, без внешних зависимостей) ======
const ICON_PATHS = {
  inbox: '<path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 5h14l2 7v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7l2-7z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chart: '<line x1="5" y1="20" x2="5" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="19" y1="20" x2="19" y2="14"/>',
  sliders: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="1.8"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="1.8"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="1.8"/>',
  shield: '<path d="M12 3l7 3v6c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6l7-3z"/><path d="M9 12.2l2.1 2.1L15.3 10"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  chevron: '<polyline points="9 6 15 12 9 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  paperclip: '<path d="M21 12.5l-8.5 8.5a4 4 0 1 1-5.66-5.66l9-9a2.5 2.5 0 1 1 3.54 3.54l-9 9a1 1 0 1 1-1.42-1.42l8-8"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  box: '<path d="M21 8L12 3 3 8l9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  // Иконки модулей: печать с лентами — Сертвивер, трубка — журнал звонков,
  // облачко реплики — «Искра». Общий «ящик» остаётся запасным вариантом для
  // модулей, которые подключат позже.
  seal: '<circle cx="12" cy="9" r="5.5"/><path d="M8.6 13.5L7.2 21 12 18.6 16.8 21l-1.4-7.5"/>',
  phone: '<path d="M21.5 16.9v2.6a2 2 0 0 1-2.2 2 19.4 19.4 0 0 1-8.5-3 19.1 19.1 0 0 1-5.9-5.9 19.4 19.4 0 0 1-3-8.6 2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1.9.3 1.7.6 2.5a2 2 0 0 1-.5 2.1L7.5 9.4a15.6 15.6 0 0 0 5.9 5.9l1.3-1.1a2 2 0 0 1 2.1-.5c.8.3 1.6.5 2.5.6a2 2 0 0 1 1.7 2z"/>',
  // Раздел оповещений: колокольчик — лента, конверт — настройки отправки,
  // лист с пером — шаблоны писем.
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7z"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
  pen: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/>',
  // Лист с подписью — вкладка МЧД: доверенность это документ, а не сертификат,
  // и в сайдбаре их надо различать с одного взгляда.
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/><path d="M8.5 16.5c1.2-2.4 2-3.6 2.6-3.6.8 0 .5 2.4 1.4 2.4.6 0 1-.8 1.5-.8.4 0 .8.5 1.5 1.4"/>',
  // Искра — та же четырёхлучевая вспышка, что нарисована на иконке
  // десктоп-клиента (MESSENGER/desktop-client/build/icon.png): длинные лучи по
  // осям, короткие по диагоналям.
  spark: '<line x1="12" y1="1.5" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="22.5" y2="12"/><line x1="7.6" y1="7.6" x2="9.9" y2="9.9"/><line x1="16.4" y1="7.6" x2="14.1" y2="9.9"/><line x1="7.6" y1="16.4" x2="9.9" y2="14.1"/><line x1="16.4" y1="16.4" x2="14.1" y2="14.1"/>',
  // Галочка выбранной плитки и стрелки прокрутки ленты отделов.
  check: '<polyline points="20 6 9 17 4 12"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  task: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  'chevron-left': '<polyline points="15 6 9 12 15 18"/>',
  // Ассистент: портфель — сам раздел, скачивание — кнопки документов,
  // загрузка — файлы и выгрузки, пауза и продолжение — рассылки.
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>',
  download: '<path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><polyline points="7 14 12 9 17 14"/><path d="M5 3h14"/>',
  pause: '<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/>',
  play: '<polygon points="7 4 20 12 7 20 7 4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/>',
  edit: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/>',
  // Значки отделов на экране новой заявки. Имя пишется в config/departments.js,
  // там же перечислен доступный набор. Монитор — техника, лист со строками —
  // деньги и отчётность, два силуэта — люди, ключ — доступ и режим; перо, лист
  // с подписью, трубка, печать и ящик уже есть выше.
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>',
  receipt: '<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6"/><path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 20"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8"/><path d="M17 5l2 2"/><path d="M14.5 7.5l2 2"/>',
};

// Оформление плитки отдела, когда в config/departments.js для него ничего не
// задано. Цвет берётся по порядку отдела в справочнике, а не случайно: иначе
// он менялся бы при каждой перезагрузке страницы.
const DEPT_FALLBACK_COLORS = ["#0A61AE", "#663AB5", "#008F9F", "#C25A18", "#E7004B", "#5A5A5A"];
const deptIcon = (d) => (d.icon && ICON_PATHS[d.icon] ? d.icon : "box");
const deptColor = (d, i) => d.color || DEPT_FALLBACK_COLORS[i % DEPT_FALLBACK_COLORS.length];
function icon(name, size) {
  size = size || 16;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
}

// Государственный герб — фирменный знак системы вместо прежней плитки с
// буквой.
//
// Основной вариант — ФАЙЛ рядом с фронтендом: public/emblem.svg. Официальное
// изображение лучше положить как есть, чем перерисовывать: в государственном
// символе неточность заметнее, чем в любой другой картинке. Файл нужен с
// прозрачным фоном — на белом квадрате герб будет висеть заплаткой на тёплой
// поверхности панели. Растровый годится тоже: поправьте имя в EMBLEM_FILE, а
// размеры проставляются атрибутами, так что 1024 px ужмётся аккуратно.
//
// Пока файла нет, рисуется запасной герб ниже — упрощённый, но узнаваемый:
// пустое место в шапке хуже стилизации. Щиток на груди у него сделан дыркой в
// тулове (fill-rule="evenodd"), а не светлой заплаткой поверх, — иначе
// заплатку пришлось бы перекрашивать под каждый фон.
const EMBLEM_FILE = "emblem.svg";
const EMBLEM_BODY = "M24 18.9c2.6 0 4.5 1.5 4.5 4.1v6.6c0 3-1.7 5.4-4.5 6.9-2.8-1.5-4.5-3.9-4.5-6.9v-6.6c0-2.6 1.9-4.1 4.5-4.1z";
const EMBLEM_SHIELD_OUTER = "M24 21c1.7 0 3 .5 3.8 1v4.6c0 2.4-1.5 4.2-3.8 5.2-2.3-1-3.8-2.8-3.8-5.2v-4.6c.8-.5 2.1-1 3.8-1z";

function emblem(size) {
  size = size || 28;
  // onerror срабатывает, когда файла нет (сервер отвечает 404) — тогда на его
  // место встаёт нарисованный. Обработчик глобальный, потому что выполняется в
  // области видимости страницы, а не этой функции.
  return `<img class="brand-emblem" src="${EMBLEM_FILE}" width="${size}" height="${size}" alt=""
    onerror="this.outerHTML = emblemFallback(${size})">`;
}

function emblemFallback(size) {
  return `<svg class="brand-emblem" width="${size}" height="${size}" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
    <path d="M19.6 20.8c-4.4-1.4-9.2-1.2-13.9 1.6 3.1-.5 5.6.1 7.6 1.2-3.6.2-6.6 1.8-8.9 4.7 2.9-1.4 5.5-1.8 7.9-1.2-3.3 1-5.8 3-7.4 6.1 2.9-2 5.7-2.8 8.4-2.4 2 .3 4-.5 5.9-2.2z"/>
    <path d="M28.4 20.8c4.4-1.4 9.2-1.2 13.9 1.6-3.1-.5-5.6.1-7.6 1.2 3.6.2 6.6 1.8 8.9 4.7-2.9-1.4-5.5-1.8-7.9-1.2 3.3 1 5.8 3 7.4 6.1-2.9-2-5.7-2.8-8.4-2.4-2 .3-4-.5-5.9-2.2z"/>
    <path d="M15.6 12.4c2.5 0 4.4 1.9 4.4 4.4 0 1.2-.5 2.3-1.2 3.1l1.6 1.9-3.2.5-1.6-1.1c-2.4-.2-4.2-2.1-4.2-4.4 0-2.5 1.7-4.4 4.2-4.4z"/>
    <path d="M11.5 15.9l-3.8.5 3.5 1.6z"/>
    <path d="M32.4 12.4c-2.5 0-4.4 1.9-4.4 4.4 0 1.2.5 2.3 1.2 3.1l-1.6 1.9 3.2.5 1.6-1.1c2.4-.2 4.2-2.1 4.2-4.4 0-2.5-1.7-4.4-4.2-4.4z"/>
    <path d="M36.5 15.9l3.8.5-3.5 1.6z"/>
    <path d="M20.2 9.4h7.6l-.6-3.8-2.1 1.6L24 4.4l-1.1 2.8-2.1-1.6z"/>
    <path d="M23.5 1.2h1v1.2h1.2v1h-1.2v1.3h-1V3.4h-1.2v-1h1.2z"/>
    <path d="M12.4 11.6h6.4l-.5-3.2-1.8 1.3-.9-2.4-.9 2.4-1.8-1.3z"/>
    <path d="M29.2 11.6h6.4l-.5-3.2-1.8 1.3-.9-2.4-.9 2.4-1.8-1.3z"/>
    <path d="M19.9 10.5c-.2 1.2-.7 2.1-1.6 2.8l-.9-1.1c.7-.5 1.1-1.2 1.3-2.1zM28.1 10.5c.2 1.2.7 2.1 1.6 2.8l.9-1.1c-.7-.5-1.1-1.2-1.3-2.1z"/>
    <path fill-rule="evenodd" d="${EMBLEM_BODY} ${EMBLEM_SHIELD_OUTER}"/>
    <path d="M18.1 30.9l-4 1.9.7 1.4 3.9-1.9zM29.9 30.9l4 1.9-.7 1.4-3.9-1.9z"/>
    <path d="M24 35.8c2.1 1.5 3.5 3.9 4 6.8-1.3-.9-2.6-1.3-4-1.3s-2.7.4-4 1.3c.5-2.9 1.9-5.3 4-6.8z"/>
    <path d="M24 22.1c1.3 0 2.3.4 2.9.8v3.7c0 1.9-1.2 3.3-2.9 4.1-1.7-.8-2.9-2.2-2.9-4.1v-3.7c.6-.4 1.6-.8 2.9-.8z"/>
  </svg>`;
}

// ====== Выпадающий список ======
//
// Системный <select> оформить нельзя: стрелку рисует браузер, она прижата к
// краю, а раскрытый перечень берёт вид от системы и в палитру не попадает.
// Поэтому настоящий select остаётся в разметке (скрытый), и весь код, который
// читает и пишет .value, продолжает работать как раньше, — а видимую часть
// рисуем сами и держим в согласии с ним в обе стороны.
//
// Навешивается автоматически на каждый появившийся select (см. observeSelects
// в boot), чтобы про это не нужно было помнить в каждом экране.
function enhanceSelect(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = "1";

  const wrap = document.createElement("div");
  wrap.className = "select-wrap";
  // Поле в форме и фильтр выглядят по-разному: у фильтра «таблетка» под стать
  // переключателю рядом, у поля — прямоугольник под стать соседним полям.
  if (sel.closest(".card") || sel.classList.contains("field-select")) wrap.classList.add("select-field");
  if (sel.style.width) wrap.style.width = sel.style.width;
  else if (sel.classList.contains("select-field")) wrap.style.width = "100%";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "select-btn";
  btn.innerHTML = `<span class="select-value"></span><span class="select-chevron">${icon("chevron", 15)}</span>`;
  wrap.appendChild(btn);

  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.hidden = true;
  wrap.appendChild(menu);

  const label = btn.querySelector(".select-value");
  const syncLabel = () => {
    const opt = sel.options[sel.selectedIndex];
    label.textContent = opt ? opt.textContent : "";
  };
  const close = () => { wrap.classList.remove("open"); menu.hidden = true; };
  const open = () => {
    // Перечень строим при открытии: у списка исполнителей варианты
    // подгружаются позже, и построенный заранее оказался бы пустым.
    menu.innerHTML = "";
    [...sel.options].forEach((opt, i) => {
      const row = document.createElement("div");
      row.className = "select-option" + (i === sel.selectedIndex ? " selected" : "");
      row.textContent = opt.textContent;
      row.onclick = () => {
        sel.selectedIndex = i;
        syncLabel();
        close();
        // Событие обязательно: обработчики висят на самом select (onchange).
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      };
      menu.appendChild(row);
    });
    wrap.classList.add("open");
    menu.hidden = false;
    const sel_ = menu.querySelector(".selected");
    if (sel_) sel_.scrollIntoView({ block: "nearest" });
  };

  btn.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close(); };
  btn.onkeydown = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" && menu.hidden) { e.preventDefault(); open(); }
  };
  // Значение могли поменять из кода (например, сбросом фильтров) — подпись
  // должна следовать за ним, иначе покажет уже не то, что выбрано.
  sel.addEventListener("change", syncLabel);
  // ...а варианты могли приехать позже самой отрисовки. Список исполнителей
  // заполняется отдельным запросом уже после того, как карточка нарисована, и
  // подмена вариантов через innerHTML никаких событий не порождает — на кнопке
  // так и оставалась заглушка «Загрузка…», хотя в самом select уже лежало
  // «— не назначено —». Наблюдатель чинит это для любого списка, который
  // наполняется позже, а не только для исполнителя.
  new MutationObserver(syncLabel).observe(sel, { childList: true });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });
  syncLabel();
}

function enhanceSelects(root) {
  (root || document).querySelectorAll("select:not([data-enhanced])").forEach(enhanceSelect);
}

// Экраны перерисовываются целиком, и вызывать enhanceSelects из каждого
// значило бы однажды забыть. Наблюдатель делает это сам.
function observeSelects() {
  enhanceSelects(document);
  new MutationObserver(() => enhanceSelects(document))
    .observe(document.body, { childList: true, subtree: true });
}

// ====== Константы ======
// Подпись системы. Здесь же, чтобы поменять её в одном месте, а не искать по
// разметке; заголовок вкладки задан отдельно в index.html. «Служба заявок» уже
// не описывала целое: заявки — только один из разделов, рядом Сертвивер, журнал
// звонков и «Искра». Письма о заявках подписаны по-прежнему службой заявок —
// они и правда про заявки, а не про платформу (см. services/notifications.js).
const APP_NAME = "Центр";
// Ведомство — второй строкой под подписью. На экране входа оно уже стоит в
// строке «Липецкстат · внутренняя система», поэтому там не дублируется.
const APP_ORG = "Липецкстат";
const TITLE_MAX = 50;
const DESCRIPTION_MAX = 140;
// Цвета — тональные пары Material 3 (насыщенный тон для точки/текста,
// светлый «container» для подложки). Держите их в согласии с палитрой
// public/styles.css: значения продублированы здесь, потому что подставляются
// в инлайновые стили при отрисовке.
// Приоритет виден в списке цветной кромкой слева у строки (см. .ticket-row
// в styles.css) и подложкой в карточке. Цвета — из дополнительной гаммы
// брендбука (3.3): её он и предлагает для акцентов и сигналов.
const PRIORITIES = [
  { id: "critical", label: "Критичный", color: "#E7004B", soft: "#FDE3EA" },
  { id: "high", label: "Высокий", color: "#C25A18", soft: "#FFE7D6" },
  { id: "medium", label: "Средний", color: "#0A61AE", soft: "#DCE7F6" },
  { id: "low", label: "Низкий", color: "#5A5A5A", soft: "#ECECEC" },
];
const STATUSES = [
  { id: "new", label: "Новая" },
  { id: "progress", label: "В работе" },
  { id: "closed", label: "Закрыта" },
];
// Подписи статусов, которых больше нет. Нужны ровно в одном месте — в истории
// заявки: сами заявки при обновлении переведены на новый набор (см. migrateStatuses
// в db/init.js), а записи о прежних переходах остались, и без этих подписей в
// истории вместо «Решена» показывалось бы английское resolved.
const LEGACY_STATUS_LABELS = { waiting: "Ожидает ответа", resolved: "Решена", cancelled: "Отменена" };
const statusLabel = (id) => (STATUSES.find(s => s.id === id) || {}).label || LEGACY_STATUS_LABELS[id] || id;
// [цвет текста, цвет подложки]. Новая — голубая гамма, в работе — сиреневая
// (два основных цвета брендбука), закрыта — серая. Текст тёмный: правило 3.4
// требует тёмно-серого на светлых фонах.
const STATUS_COLORS = {
  new: ["#0A61AE", "#DCE7F6"], progress: ["#663AB5", "#E9E2F6"], closed: ["#5A5A5A", "#ECECEC"],
};

// ====== Состояние ======
// Какие группы бокового меню раскрыты. По умолчанию закрыты все — меню при
// входе умещается целиком, и человек сам решает, что ему держать открытым.
//
// Хранится в sessionStorage, а не только в памяти: без этого каждое F5
// схлопывало то, что человек только что раскрыл. Именно session, а не local, —
// по той же причине, что и позиция прокрутки меню ниже: у двух открытых вкладок
// панели своё состояние, и это правильно.
const NAV_GROUPS_KEY = "adm.navGroups";
function loadNavGroups() {
  try { return JSON.parse(sessionStorage.getItem(NAV_GROUPS_KEY)) || {}; } catch { return {}; }
}
function saveNavGroups() {
  try { sessionStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(state.navGroupOpen)); } catch { /* приватный режим */ }
}
const state = { user: null, view: "inbox", currentTicket: null, notifications: [], departments: [], modules: [], navGroupOpen: loadNavGroups(),
  // Задачи администраторов: какая открыта в карточке справа и сколько «моих»
  // требуют внимания (просрочены или там новое от других) — для счётчика в меню.
  taskOpenId: null, taskAttention: 0,
  // Ассистент: открытая рассылка (#asst:mail/12).
  mailOpenId: null };
let viewPollHandle = null;   // интервал автообновления текущего экрана (список/карточка)
let notifPollHandle = null;  // интервал обновления счётчика уведомлений (работает всегда)

// ====== API-обёртка ======
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: opts.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* пусто тело у некоторых ответов */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Ошибка ${res.status}`);
    err.status = res.status;
    err.code = data && data.code;
    err.hint = data && data.hint; // подсказка «что делать» — например, про сетевой путь для копий
    throw err;
  }
  return data;
}

// Экранируем и КАВЫЧКИ тоже. Прежняя реализация шла через textContent +
// innerHTML, а сериализатор HTML в текстовом узле кавычки не трогает — они там
// законны. Значение же почти всегда подставляется внутрь атрибута
// (`value="${esc(...)}"`, `download="${esc(...)}"`, `data-kind="${esc(...)}"`),
// и любая кавычка разрывала атрибут: дальше в разметку попадал уже чужой
// обработчик события. Проверено в настоящем Chromium.
//
// Досюда доезжает многое, что задаёт человек: шаблоны писем и адреса SMTP из
// настроек, имена файлов сертификатов, имя вложения. Имя вложения через
// обычную форму приходит уже с экранированной кавычкой (%22 — так делают и
// браузеры, и fetch), но сервер имя не чистит, и клиент, отправляющий запрос
// не через форму, положит в базу что угодно. Полагаться на чужое
// экранирование там, где своё стоит пять строк, незачем.
//
// Заодно исчезает создание DOM-узла на каждый вызов — а зовут её сотни раз
// на одну отрисовку списка.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
// Форматтер создаётся ОДИН раз, а не на каждый вызов.
//
// toLocaleString с объектом настроек собирает новый Intl.DateTimeFormat при
// каждом вызове, и это самая дорогая операция во всей отрисовке: на списке в
// 3300 строк только даты занимали 205 мс против 8,4 мс с общим форматтером —
// вдесятеро больше, чем всё экранирование вместе взятое. А зовут fmtDate на
// каждую строку списка, каждый комментарий и каждую запись истории.
const DATE_FMT = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

function fmtDate(iso) {
  if (!iso) return "—";
  // Из SQLite приходит «ГГГГ-ММ-ДД ЧЧ:ММ:СС» в UTC без пояса; из JS (toISOString) —
  // уже с «Z». Приписанная вторая «Z» делала дату нечитаемой, и на экран шла сырая строка.
  const s = String(iso);
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d)) return iso;
  return DATE_FMT.format(d);
}
// Все сообщения складываются в ОДИН контейнер, а не крепятся к body каждое
// само по себе. Раньше у каждого было position:fixed; bottom:24px — два
// сообщения подряд ложились ровно друг на друга, и читалось месиво из двух
// текстов. Заметно это стало на проверке полей новой заявки, где на второй
// клик по «Отправить» приходит второе сообщение поверх ещё живого первого.
function toast(msg, isError) {
  let стопка = document.getElementById("toastStack");
  if (!стопка) {
    стопка = document.createElement("div");
    стопка.id = "toastStack";
    document.body.appendChild(стопка);
  }
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  стопка.appendChild(t);
  setTimeout(() => {
    t.remove();
    if (!стопка.childElementCount) стопка.remove();
  }, 3500);
}

// ====== Точка входа ======
const root = document.getElementById("root");

async function boot() {
  observeSelects();
  try {
    const { user } = await api("/auth/me");
    state.user = user;
    await enterApp();
  } catch (e) {
    await renderLogin();
  }
}

// Отделы, в которых человек исполнитель. Их может быть НЕСКОЛЬКО: сотрудник
// состоит и в группе ИТ, и в группе ХОЗ — значит ведёт очереди обеих. Запасной
// путь по одной role нужен для сессий, выданных до этой правки: они живут до
// 30 дней, и до перелогина списка в них нет.
function myDepts(u) {
  const byRole = Object.fromEntries(state.departments.filter(d => d.role !== "user").map(d => [d.role, d.name]));
  const roles = (u.roles && u.roles.length) ? u.roles : (u.role ? [u.role] : []);
  return roles.map(r => byRole[r]).filter(Boolean);
}

// ====== Экран логина ======
async function renderLogin(errorMsg) {
  let detectedMode = null;
  let manualMode = null; // если автоопределение не сработало, пользователь может выбрать сам
  // Имена доменов приезжают с сервера (DOMAIN_A_LABEL / DOMAIN_B_LABEL).
  // До ответа /auth/detect вкладок на экране всё равно нет, но подстраховка
  // нужна: иначе при недоступном сервере на кнопках было бы «undefined».
  let domainLabels = { A: "rosstat.local", B: "in.local" };

  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">${emblem(44)}<div class="login-title">${APP_NAME}</div></div>
        <div class="login-sub">Липецкстат · внутренняя система</div>
        <div id="networkNote" class="note-box">Определяем вашу сеть…</div>
        <div id="manualSwitch" style="display:none;margin-bottom:16px;"></div>
        ${errorMsg ? `<div class="error-box">${esc(errorMsg)}</div>` : ""}
        <div class="field-label">Логин</div>
        <input class="field-input" id="loginInput" placeholder="48.ivanovii" autocomplete="username">
        <div class="field-label">Пароль</div>
        <input class="field-input hint-long" id="passwordInput" type="password" placeholder="пароль учётной записи компьютера" autocomplete="current-password">
        <button class="btn-primary" id="loginBtn">Войти</button>
      </div>
    </div>`;

  const note = document.getElementById("networkNote");
  const manualSwitch = document.getElementById("manualSwitch");

  function renderManualSwitch() {
    manualSwitch.style.display = "block";
    manualSwitch.innerHTML = `
      <div class="tab-group">
        <button class="tab-btn ${manualMode === "A" ? "active" : ""}" data-mode="A">${esc(domainLabels.A)}</button>
        <button class="tab-btn ${manualMode === "B" ? "active" : ""}" data-mode="B">${esc(domainLabels.B)}</button>
      </div>`;
    manualSwitch.querySelectorAll(".tab-btn").forEach(btn => {
      btn.onclick = () => { manualMode = btn.dataset.mode; renderManualSwitch(); };
    });
  }

  try {
    const { mode, labels } = await api("/auth/detect");
    detectedMode = mode;
    if (labels) domainLabels = labels;
    if (mode) {
      note.textContent = `Определена сеть: ${domainLabels[mode] || mode}`;
    } else {
      note.textContent = "Не удалось определить сеть автоматически — выберите домен вручную.";
      manualMode = "A";
      renderManualSwitch();
    }
  } catch (e) {
    note.textContent = "Не удалось определить сеть — выберите домен вручную.";
    manualMode = "A";
    renderManualSwitch();
  }

  async function doLogin() {
    const loginRaw = document.getElementById("loginInput").value.trim();
    const password = document.getElementById("passwordInput").value;
    const btn = document.getElementById("loginBtn");
    if (!loginRaw || !password) return;

    const isLocal = loginRaw.startsWith("!");
    const mode = isLocal ? "local" : (detectedMode || manualMode);
    if (!mode) {
      renderLogin("Не удалось определить домен для входа. Выберите домен вручную.");
      return;
    }

    btn.disabled = true; btn.textContent = "Вход...";
    try {
      const { user } = await api("/auth/login", { method: "POST", body: { mode, login: loginRaw, password } });
      state.user = user;
      await enterApp();
    } catch (e) {
      renderLogin(e.message || "Не удалось войти");
    }
  }
  document.getElementById("loginBtn").onclick = doLogin;
  document.getElementById("passwordInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

// ====== Оболочка приложения ======
async function enterApp() {
  try {
    const { departments } = await api("/departments");
    state.departments = departments;
  } catch (e) { state.departments = []; }
  try {
    const { modules } = await api("/modules");
    state.modules = modules;
  } catch (e) { state.modules = []; }
  await refreshNotifications();
  // Обновление страницы не должно выбрасывать на «Входящие»: человек нажал F5
  // на журнале звонков и ждёт увидеть журнал звонков. Адрес вкладки держим в
  // якоре URL, а не в хранилище браузера — тогда работают и кнопка «назад», и
  // ссылка, посланную коллеге.
  await restoreViewFromHash();
  if (!notifPollHandle) {
    notifPollHandle = setInterval(async () => {
      await refreshNotifications();
      updateBadgeDom();
    }, 20000);
  }
}

function clearViewPoll() {
  if (viewPollHandle) { clearInterval(viewPollHandle); viewPollHandle = null; }
}

// Какой пункт меню подсвечивать. У карточки заявки своего пункта нет, и раньше
// при переходе в неё выделение пропадало совсем — человек терял, в каком он
// разделе. Теперь подсвечивается список, из которого карточку открыли. Если
// открыли не из списка (по ссылке #detail/148), — входящие: у сотрудника так
// называется его единственный список, у исполнителя — очередь.
//
// Откуда пришли, помнит и sessionStorage вкладки: после F5 на карточке state
// создаётся заново, и без этого «Мои заявки» сменялись бы на «Входящие».
const NAV_FROM_KEY = "navFrom";
function navView() {
  if (state.view !== "detail") return state.view;
  let from = state.previousView;
  if (!from) { try { from = sessionStorage.getItem(NAV_FROM_KEY); } catch { /* хранилище недоступно */ } }
  return from && from !== "detail" ? from : "inbox";
}

function setView(view, arg, { replace = false } = {}) {
  clearViewPoll();
  if (view === "detail") {
    state.currentTicket = arg;
    if (state.view !== "detail") {
      state.previousView = state.view; // не затираем при обновлении самой карточки
      try { sessionStorage.setItem(NAV_FROM_KEY, state.view); } catch { /* хранилище недоступно — переживём */ }
    }
  }
  // У раздела задач второй аргумент — номер задачи, открытой в карточке
  // справа. Переход из меню его не передаёт, и карточка закрывается.
  if (view === "tasks" || view === "taskcal") state.taskOpenId = arg || null;
  if (view === "asst:mail") state.mailOpenId = arg || null;
  state.view = view;
  writeHash(replace);
  renderShell();
}

// ====== Вкладка в адресе страницы ======
//
// Экран целиком собирается на клиенте, поэтому сам по себе URL про открытую
// вкладку ничего не знает: после F5 приложение всегда открывалось на
// «Входящих». Держим адрес вкладки в якоре — он не уходит на сервер, переживает
// обновление, и заодно начинают работать кнопки «назад» и «вперёд».
//
// Карточка заявки хранится в якоре номером (#detail/148), а не целым объектом:
// заявку всё равно надо перечитать — за время до обновления её могли изменить.

let applyingHash = false;   // защита от петли «пишем якорь -> ловим hashchange -> пишем якорь»

function writeHash(replace) {
  const hash = state.view === "detail" && state.currentTicket
    ? `#detail/${state.currentTicket.id}`
    : state.view === "tasks" && state.taskOpenId
      ? `#task/${state.taskOpenId}`
      : state.view === "asst:mail" && state.mailOpenId
        ? `#asst:mail/${state.mailOpenId}`
        : `#${state.view}`;
  if (location.hash === hash) return;
  applyingHash = true;
  // Переход, который сделал человек, — новая запись в истории: тогда «назад»
  // возвращает из карточки в список, как он и ожидает. А вот восстановление
  // вкладки после F5 или отработка самой кнопки «назад» историю пополнять не
  // должны, иначе выйти из приложения кнопкой станет невозможно.
  if (replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
  applyingHash = false;
}

/** Акты — администраторам и исполнителям отдела ИТ (роль "it"). */
function canActs(u) {
  const roles = (u.roles && u.roles.length) ? u.roles : (u.role ? [u.role] : []);
  return Boolean(u.is_admin) || roles.includes("it");
}

/** Существует ли такая вкладка у ЭТОЙ роли. Чужую из адреса открывать нельзя. */
function viewExists(view) {
  if (!view) return false;
  const u = state.user;
  if (["inbox", "mine", "create"].includes(view)) return true;
  // Рассылки — всем; акты — администраторам и исполнителям; настройки
  // Ассистента — только администраторам.
  if (view.startsWith("asst:")) {
    if (!ASSISTANT_VIEWS.some((v) => v.id === view)) return false;
    if (view === "asst:settings") return Boolean(u.is_admin);
    if (view === "asst:acts") return canActs(u);
    return true;
  }
  // Разделы администратора — по признаку is_admin, а не по роли: роль "it"
  // теперь значит «исполнитель отдела ИТ», и прав администратора не даёт.
  if (["dashboard", "admin", "certs", "tasks", "taskcal"].includes(view) || view.startsWith("notif:")) return Boolean(u.is_admin);
  if (view.startsWith("module:")) {
    const [, modId, viewId] = view.split(":");
    const mod = state.modules.find((m) => m.id === modId);
    if (!mod) return false;
    const views = (mod.views && mod.views.length) ? mod.views : [{ id: "root" }];
    return views.some((v) => v.id === viewId);
  }
  return false;
}

async function restoreViewFromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ""));

  const detail = raw.match(/^detail\/(\d+)$/);
  if (detail) {
    // Заявку перечитываем, а не достаём из памяти: после обновления страницы
    // никакой памяти нет, да и содержимое могло измениться.
    try {
      const { ticket } = await api("/tickets/" + detail[1]);
      // После F5 state.view — начальное «inbox», и setView записал бы его как
      // список, из которого пришли. Берём сохранённый во вкладке (см. navView).
      if (state.view !== "detail") {
        try { state.previousView = sessionStorage.getItem(NAV_FROM_KEY) || state.previousView; } catch { /* нет хранилища */ }
        state.view = "detail";
      }
      setView("detail", ticket, { replace: true });
      return;
    } catch {
      // Заявку удалили или прав на неё нет — молча возвращаемся к списку,
      // ошибка про чужой номер в адресе пользователю ничего не объясняет.
    }
  }

  // Ссылка на задачу из письма или сообщения «Искры»: #task/148.
  const task = raw.match(/^task\/(\d+)$/);
  if (task && viewExists("tasks")) {
    setView("tasks", Number(task[1]), { replace: true });
    return;
  }

  const mail = raw.match(/^asst:mail\/(\d+)$/);
  if (mail) {
    setView("asst:mail", Number(mail[1]), { replace: true });
    return;
  }

  setView(viewExists(raw) ? raw : "inbox", undefined, { replace: true });
}

// Кнопки «назад» и «вперёд» браузера.
window.addEventListener("hashchange", () => {
  if (applyingHash || !state.user) return;
  restoreViewFromHash();
});

function updateBadgeDom() {
  // Счётчик задач — на заголовке группы «Задачи», а не на пункте «Список»:
  // он про задачи вообще, в каком бы виде их ни смотрели.
  setNavBadge('.nav-group[data-group="tasks"] > .nav-group-header', state.taskAttention);
  const total = state.notifications.filter(n => !n.is_read).length;
  setNavBadge('.nav-btn[data-view="inbox"]', total);
  setNavBadge('.nav-group-header[data-group="tickets"]', total); // для админа бейдж висит на заголовке группы "Заявки"
}

function setNavBadge(selector, count) {
  const el = document.querySelector(selector);
  if (!el) return;
  let badge = el.querySelector(".nav-badge");
  if (count > 0) {
    if (!badge) {
      badge = document.createElement("span"); badge.className = "nav-badge";
      // у заголовка группы бейдж должен идти перед шевроном, а не в самый конец
      const chevron = el.querySelector(".nav-chevron");
      if (chevron) el.insertBefore(badge, chevron); else el.appendChild(badge);
    }
    badge.textContent = count;
  } else if (badge) {
    badge.remove();
  }
}

async function refreshNotifications() {
  try {
    const { notifications } = await api("/notifications");
    state.notifications = notifications;
  } catch (e) { /* не критично для остального интерфейса */ }
  // Счётчик задач — только у администраторов: у остальных раздела нет, и
  // запрос вернул бы 403 на каждом опросе.
  if (state.user && state.user.is_admin) {
    try {
      state.taskAttention = (await api("/tasks/summary")).attention;
    } catch (e) { /* счётчик задач подождёт следующего опроса */ }
  }
}

function navBtnHtml(it, active, indented) {
  return `
    <button class="nav-btn ${active ? "active" : ""} ${indented ? "nav-btn-sub" : ""}" data-view="${it.id}">
      <span class="nav-icon">${it.icon ? icon(it.icon) : ""}</span>${esc(it.label)}
      ${it.badge ? `<span class="nav-badge">${it.badge}</span>` : ""}
    </button>`;
}

// Вложенные пункты рисуются ВСЕГДА, даже у закрытой группы: без них в разметке
// анимировать было бы нечего — раскрытие через появление узла происходит мгновенно.
// Видимостью управляет max-height (см. toggleNavGroup и .nav-subgroup в стилях).
//
// max-height проставляется прямо в разметке, а не классом: у раскрытой группы это
// "none", иначе содержимое обрезалось бы по произвольному числу, а вычислить
// настоящую высоту в момент сборки строки ещё нельзя — узла в документе нет.
// Группы, раскрытые по умолчанию, пока человек сам их не свернёт. «Задачи» —
// потому что внутри всего два вида одного раздела, и прятать их за лишний
// щелчок незачем.
const NAV_GROUPS_OPEN_BY_DEFAULT = new Set(["tasks", "assistant"]);

function navGroupHtml(groupId, label, iconName, badge, items) {
  const saved = state.navGroupOpen[groupId];
  const open = saved === true || (saved === undefined && NAV_GROUPS_OPEN_BY_DEFAULT.has(groupId)); // остальные по умолчанию свёрнуты
  return `
    <div class="nav-group${open ? " open" : ""}" data-group="${groupId}">
      <button class="nav-group-header">
        <span class="nav-icon">${icon(iconName)}</span>${esc(label)}
        ${badge ? `<span class="nav-badge">${badge}</span>` : ""}
        <span class="nav-chevron">${icon("chevron", 13)}</span>
      </button>
      <div class="nav-subgroup" style="max-height:${open ? "none" : "0"}">${items.map(it => navBtnHtml(it, navView() === it.id, true)).join("")}</div>
    </div>`;
}

// Раскрытие и сворачивание группы меню.
//
// Всю оболочку при этом не пересобираем — иначе анимации не было бы вовсе:
// новый узел появляется сразу в конечном состоянии, анимировать нечего.
function toggleNavGroup(group) {
  const sub = group.querySelector(".nav-subgroup");
  const open = !group.classList.contains("open");
  state.navGroupOpen[group.dataset.group] = open;
  saveNavGroups();
  group.classList.toggle("open", open);

  // От "none" браузер не анимирует — в обе стороны сначала подставляем
  // конкретную высоту содержимого, и только от неё идёт переход.
  sub.style.maxHeight = `${sub.scrollHeight}px`;
  if (open) {
    // После раскрытия ограничение снимаем: иначе появившийся позже счётчик
    // непрочитанных или новый пункт оказался бы обрезан.
    sub.addEventListener("transitionend", function done() {
      sub.style.maxHeight = "none";
      sub.removeEventListener("transitionend", done);
    });
  } else {
    void sub.offsetHeight; // заставляем браузер принять высоту как начальную
    sub.style.maxHeight = "0px";
  }
}

const MODULE_VIEW_ICONS = { log: "inbox", stats: "chart", directory: "folder", certs: "seal", mchd: "doc", root: "box" };
// Иконка пункта меню по идентификатору модуля из config/modules.js. Ключ — тот
// же id, что и на сервере; для незнакомого модуля остаётся общий «ящик», так
// что подключение нового ничего здесь не ломает.
const MODULE_ICONS = { certs: "seal", smdr: "phone", messenger: "spark" };
const moduleIcon = (id) => MODULE_ICONS[id] || "box";

// ====== Прокрутка бокового меню ======
//
// renderShell() пересобирает оболочку целиком через innerHTML, а вместе с ней и
// сам прокручиваемый элемент меню. Позиция прокрутки принадлежит УЗЛУ, и с его
// заменой она пропадала: каждый переход между разделами и каждое F5 отматывали
// меню в самое начало, хотя выбранный пункт мог быть в самом низу.
//
// Источник истины — переменная, а не сам элемент. Так задумано: сразу после
// innerHTML раскладка ещё не посчитана, у нового узла нулевая высота, и любое
// чтение позиции с него вернуло бы ноль. Если бы этот ноль записывался обратно,
// он бы затирал настоящую позицию — ровно так первая попытка и не сработала.
//
// В sessionStorage кладём копию, чтобы позиция пережила F5. Именно session, а не
// local: у двух открытых окон панели позиции свои, и это правильно.
const NAV_SCROLL_KEY = "adm.navScroll";

let navScroll = (() => {
  try { return Number(sessionStorage.getItem(NAV_SCROLL_KEY)) || 0; } catch { return 0; }
})();

function rememberNavScroll(value) {
  navScroll = value;
  try { sessionStorage.setItem(NAV_SCROLL_KEY, String(value)); } catch { /* приватный режим — не беда */ }
}

function restoreNavScroll() {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav) return;

  // Проверка isConnected — не перестраховка, а суть починки. При замене
  // содержимого через innerHTML старый элемент меню отсоединяется, его позиция
  // сбрасывается в ноль, и он успевает поднять СВОЁ событие прокрутки. Слушатель
  // на нём ещё жив и записывал этот ноль поверх настоящей позиции — из-за чего
  // меню и отматывалось наверх. Отсоединённый узел про нашу позицию больше
  // ничего не знает, и слушать его незачем.
  nav.addEventListener("scroll", () => {
    if (!nav.isConnected) return;
    rememberNavScroll(nav.scrollTop);
  }, { passive: true });

  if (!navScroll) return;
  // Через кадр: на момент возврата из innerHTML раскладки ещё нет, высота узла
  // нулевая, и присвоение scrollTop браузер обрежет до нуля.
  requestAnimationFrame(() => { nav.scrollTop = navScroll; });
}

// ====== Напоминание о сроке сертификата сервера ======
//
// Сертификат домена живёт два года, автопродления нет — единственный способ не
// проспать замену — напоминать. Щит в шапке (вход в «Сертификаты») краснеет за
// CERT_WARN_DAYS дней до конца срока и остаётся красным, если срок вышел;
// подсказка говорит, сколько осталось. Порог — тот же, что у «Искры»
// (tls_certificate_expiring в её журнале).
const CERT_WARN_DAYS = 30;
const CERT_CHECK_MS = 30 * 60 * 1000; // сертификат меняется редко — чаще спрашивать незачем
let certBadge = { at: 0, cert: null, secure: true };

// Сколько дней осталось — от даты окончания, а не из daysLeft сервера: его
// считают при запуске службы, и через месяц работы без перезапуска он врёт.
function certDaysLeft(c) {
  const t = c && c.validTo ? Date.parse(c.validTo) : NaN;
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : null;
}

function applyCertBadge(btn) {
  const left = certDaysLeft(certBadge.cert);
  const alert = left !== null && left <= CERT_WARN_DAYS;
  btn.classList.toggle("alert", alert);
  btn.title = !certBadge.secure ? "Сертификаты — платформа работает без сертификата (http)"
    : left === null ? "Сертификаты"
    : left < 0 ? `Сертификат сервера ИСТЁК ${-left} дн. назад — замените его`
    : alert ? `Сертификат сервера истекает через ${left} дн. — пора заменить`
    : `Сертификаты — сертификат сервера действует ещё ${left} дн.`;
}

// Оболочка перерисовывается при каждом переходе — поэтому красим сразу по
// запомненному, а спрашиваем сервер не чаще раза в CERT_CHECK_MS.
async function paintCertBadge(btn) {
  applyCertBadge(btn);
  if (Date.now() - certBadge.at < CERT_CHECK_MS) return;
  certBadge.at = Date.now();
  try {
    const s = await api("/certificates/server");
    certBadge = { at: certBadge.at, cert: s.certificate, secure: s.secure };
    // Сертификат ещё разбирается (сразу после запуска службы) — спросим снова при следующем переходе.
    if (s.secure && !s.certificate) certBadge.at = 0;
  } catch { return; }
  const current = document.getElementById("certsBtn");
  if (current) applyCertBadge(current);
}

function renderShell() {
  const u = state.user;
  const totalUnread = state.notifications.filter(n => !n.is_read).length;
  const isAdmin = Boolean(u.is_admin);
  // Исполнитель — тот, у кого есть хотя бы один отдел. Отдел ИТ тоже сюда
  // попадает: администратор и исполнитель ИТ — разные вещи, и человек вполне
  // может быть и тем и другим одновременно.
  const depts = myDepts(u);
  const isExecutor = depts.length > 0;
  const roleLabel = !isExecutor
    ? (isAdmin ? "Администратор" : "Сотрудник")
    : `${depts.join(", ")}${isAdmin ? " · администратор" : ""}`;

  let navHtml;
  // Раздел оповещений собирается здесь, а приписывается в самый конец меню —
  // после модулей: это настройка, а не ежедневная работа, и место ей внизу.
  let notifHtml = "";
  if (isAdmin) {
    const subItems = [
      { id: "inbox", label: "Входящие заявки", icon: "inbox", badge: totalUnread },
      { id: "mine", label: "Мои заявки", icon: "folder" },
      { id: "create", label: "Новая заявка", icon: "plus" },
      { id: "dashboard", label: "Статистика", icon: "chart" },
      { id: "admin", label: "Администрирование", icon: "sliders" },
    ];
    navHtml = navGroupHtml("tickets", "Заявки", "folder", totalUnread, subItems);
    // Задачи — сразу под заявками: это тоже ежедневная работа, а не настройка.
    // Счётчик — мои открытые задачи, которые просрочены или где есть новое.
    navHtml += navGroupHtml("tasks", "Задачи", "task", state.taskAttention, [
      { id: "tasks", label: "Список", icon: "list" },
      { id: "taskcal", label: "Календарь", icon: "calendar" },
    ]);
    // Раздел оповещений — только у ИТ. Исполнителям ХОЗ и ЕГРПО он не нужен:
    // им хватает «Входящих заявок» с бейджем, который работает как работал.
    notifHtml = navGroupHtml("notif", "Оповещения", "bell", 0, [
      { id: "notif:feed", label: "Лента", icon: "bell" },
      { id: "notif:templates", label: "Шаблоны", icon: "pen" },
      { id: "notif:smtp", label: "Отправка", icon: "mail" },
    ]);
  } else if (isExecutor) {
    const items = [
      { id: "inbox", label: "Входящие заявки", icon: "inbox", badge: totalUnread },
      { id: "mine", label: "Мои заявки", icon: "folder" },
      { id: "create", label: "Новая заявка", icon: "plus" },
    ];
    // Исполнителям ХОЗ и ЕГРПО акты не нужны — рассылки отдельным пунктом.
    if (!canActs(u)) items.push({ id: "asst:mail", label: "Рассылки", icon: "mail" });
    navHtml = items.map(it => navBtnHtml(it, navView() === it.id, false)).join("");
  } else {
    // Обычному сотруднику — только его заявки, новая заявка и рассылки:
    // акты ему не нужны, и группа «Ассистент» ради одного пункта лишняя.
    const items = [
      { id: "inbox", label: "Мои заявки", icon: "folder", badge: totalUnread },
      { id: "create", label: "Новая заявка", icon: "plus" },
      { id: "asst:mail", label: "Рассылки", icon: "mail" },
    ];
    navHtml = items.map(it => navBtnHtml(it, navView() === it.id, false)).join("");
  }

  // Ассистент — администраторам и отделу ИТ, после заявок и задач: это тоже
  // ежедневная работа. Настройки в нём — только администраторам.
  if (canActs(u)) {
    navHtml += navGroupHtml("assistant", "Ассистент", "briefcase", 0,
      ASSISTANT_VIEWS.filter((v) => v.id !== "asst:settings" || isAdmin));
  }

  if (state.modules.length) {
    navHtml += state.modules.map(m => {
      const views = (m.views && m.views.length) ? m.views : [{ id: "root", label: m.label, sub: "" }];
      if (views.length === 1) {
        const it = { id: `module:${m.id}:${views[0].id}`, label: m.label, icon: moduleIcon(m.id) };
        return navBtnHtml(it, navView() === it.id, false);
      }
      const items = views.map(v => ({ id: `module:${m.id}:${v.id}`, label: v.label, icon: MODULE_VIEW_ICONS[v.id] }));
      return navGroupHtml(`mod-${m.id}`, m.label, moduleIcon(m.id), 0, items);
    }).join("");
  }

  navHtml += notifHtml;

  root.innerHTML = `
    <div class="app-shell">
      <div class="sidebar">
        <div class="sidebar-head">${emblem(32)}
          <div class="brand-text">
            <div class="brand-name">${APP_NAME}</div>
            <div class="brand-org">${APP_ORG}</div>
          </div>
          ${isAdmin ? `<button class="head-action${state.view === "certs" ? " active" : ""}" id="certsBtn"
            title="Сертификаты">${icon("shield", 18)}</button>` : ""}
        </div>
        <div class="sidebar-nav">${navHtml}</div>
        <div class="sidebar-foot">
          <div class="user-row">
            <div style="min-width:0;">
              <div class="user-name">${esc(u.full_name)}</div>
              <div class="user-dept">${esc(u.department || u.ad_login)}</div>
              <div class="user-role-badge">${esc(roleLabel)}</div>
            </div>
          </div>
          <button class="logout-btn" id="logoutBtn">${icon("logout")} Выйти</button>
        </div>
      </div>
      <div class="main" id="mainArea"></div>
    </div>`;

  restoreNavScroll();

  const certsBtn = document.getElementById("certsBtn");
  if (certsBtn) { certsBtn.onclick = () => setView("certs"); paintCertBadge(certsBtn); }

  root.querySelectorAll(".nav-btn").forEach(btn => btn.onclick = () => setView(btn.dataset.view));
  root.querySelectorAll(".nav-group-header").forEach(btn => btn.onclick = () => toggleNavGroup(btn.closest(".nav-group")));

  document.getElementById("logoutBtn").onclick = async () => {
    clearViewPoll();
    if (notifPollHandle) { clearInterval(notifPollHandle); notifPollHandle = null; }
    await api("/auth/logout", { method: "POST" });
    state.user = null;
    renderLogin();
  };

  const main = document.getElementById("mainArea");
  if (state.view === "inbox") renderList(main, { scope: "inbox" });
  else if (state.view === "mine") renderList(main, { scope: "mine" });
  else if (state.view === "create") renderCreate(main);
  else if (state.view === "detail") renderDetail(main, state.currentTicket);
  else if (state.view === "dashboard") renderDashboard(main);
  else if (state.view === "admin") renderAdmin(main);
  else if (state.view === "certs") renderCertificates(main);
  else if (state.view === "tasks") renderTasks(main);
  else if (state.view === "taskcal") renderTaskCalendar(main);
  else if (state.view.startsWith("notif:")) renderNotifications(main, state.view.slice(6));
  else if (state.view.startsWith("asst:")) renderAssistant(main, state.view.slice(5));
  else if (state.view.startsWith("module:")) {
    const [, modId, viewId] = state.view.split(":");
    const mod = state.modules.find(m => m.id === modId);
    const views = mod && ((mod.views && mod.views.length) ? mod.views : [{ id: "root", label: mod.label, sub: "" }]);
    const view = views && views.find(v => v.id === viewId);
    if (mod && view) renderModule(main, mod, view);
  }
}

// ====== Встроенный модуль (фрейм) ======
function renderModule(main, mod, view) {
  clearViewPoll();
  const src = `${mod.path}/${view.sub || ""}`;
  const title = (mod.views && mod.views.length > 1) ? `${mod.label} — ${view.label}` : mod.label;
  main.innerHTML = `
    <div class="topbar"><div class="topbar-title">${esc(title)}</div></div>
    <div class="page page-flush">
      <iframe class="module-frame" src="${esc(src)}" title="${esc(title)}"></iframe>
    </div>`;
}

// Запуск — когда выполнены все скрипты страницы: разделы (app-tickets.js, app-admin.js,
// app-notifications.js) подключаются после этого файла, а boot() сразу же рисует экран.
document.addEventListener("DOMContentLoaded", boot);
