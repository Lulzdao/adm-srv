// Анимации интерфейса «Центра» — общие для разделов (заявки, задачи, заметки, меню).
// Обычный скрипт без сборщика, подключается до app.js: функции общие для всех файлов страницы.
//
// Экраны перерисовываются целиком (innerHTML), поэтому движение рисуется копиями элементов поверх
// страницы: прежний экран снимается до перерисовки (snapshotMain), карточка или строка — копией
// (snapshotEl) и улетает в кнопку или пункт меню (flyInto). Web Animations API — есть и в Chrome 109
// (Windows 7). Кто отключил анимацию в системе (prefers-reduced-motion), видит всё как раньше, без
// движения: каждая функция в этом случае ничего не делает.

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

// Копия элемента и его место на экране — снимать ДО перерисовки, после неё элемента уже нет.
function snapshotEl(el) {
  return el && motionAllowed() ? { node: cloneWithoutIds(el), rect: el.getBoundingClientRect() } : null;
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

// Дать доиграть короткому движению перед перерисовкой; без анимации — не ждать вовсе.
function motionPause(ms) {
  return new Promise((r) => setTimeout(r, motionAllowed() ? ms : 0));
}

// Кнопка «проглотила» прилетевшее: короткий толчок.
function gulp(target) {
  if (!motionAllowed() || !target) return;
  target.animate([{ transform: "scale(1)" }, { transform: "scale(1.16)" }, { transform: "scale(0.96)" }, { transform: "scale(1)" }],
    { duration: 320, easing: "ease-out" });
}

// item — снятая копия (snapshotEl) карточки или строки; target — куда «втянуть» (кнопка, пункт меню).
// snap — копия прежнего экрана (snapshotMain), если экран сменился: она растворяется под полётом.
function flyInto(item, target, { snap = null, onDone = null } = {}) {
  if (!motionAllowed() || !item || !target) { if (onDone) onDone(); return; }
  const from = item.rect, to = target.getBoundingClientRect();
  if (!to.width || !from.width) { if (onDone) onDone(); return; }
  const old = snap ? mountSnapshot(snap, 1999) : null;
  if (old) old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-out", fill: "forwards" });
  const g = item.node;
  g.classList.add("fly-ghost");
  Object.assign(g.style, { left: from.left + "px", top: from.top + "px", width: from.width + "px", height: from.height + "px" });
  document.body.appendChild(g);
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const end = Math.max(0.02, Math.min(to.width / from.width, to.height / from.height) * 0.5);
  // Сначала чуть приподнимается и сжимается, потом с ускорением уходит в цель — «втягивается».
  const suck = g.animate([
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(${dx * 0.15}px, ${dy * 0.15 - 18}px) scale(0.62)`, opacity: 1, offset: 0.32 },
    { transform: `translate(${dx}px, ${dy}px) scale(${end})`, opacity: 0.2 },
  ], { duration: 560, easing: "cubic-bezier(0.55, 0, 0.8, 0.3)", fill: "forwards" });
  suck.onfinish = suck.oncancel = () => {
    g.remove(); if (old) old.remove();
    gulp(target);
    if (onDone) onDone();
  };
}

// Пункт меню, если он виден; иначе запасной (заголовок свёрнутой группы).
function visibleNav(selector, fallback) {
  const el = document.querySelector(selector);
  if (el && el.getClientRects().length && el.getBoundingClientRect().height > 4) return el;
  return fallback ? document.querySelector(fallback) : null;
}

// Число на значке выросло — значок «подпрыгивает», значок пункта меню покачивается.
function popBadge(badge, iconEl) {
  if (!motionAllowed() || !badge) return;
  badge.animate([{ transform: "scale(1)" }, { transform: "scale(1.45)" }, { transform: "scale(0.9)" }, { transform: "scale(1)" }],
    { duration: 420, easing: "cubic-bezier(0.3, 1.4, 0.6, 1)" });
  if (iconEl) {
    iconEl.animate([{ transform: "rotate(0)" }, { transform: "rotate(-14deg)" }, { transform: "rotate(11deg)" }, { transform: "rotate(-6deg)" }, { transform: "rotate(0)" }],
      { duration: 520, easing: "ease-in-out" });
  }
}

// Новый элемент въезжает снизу и проявляется (комментарий в ленте).
function enterFromBelow(el) {
  if (!motionAllowed() || !el) return;
  el.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "translateY(0)" }],
    { duration: 300, easing: "cubic-bezier(0.2, 0, 0, 1)" });
}

// Появление «из точки» (новая заметка) и исчезновение со сжатием (удалённая).
function growIn(el) {
  if (!motionAllowed() || !el) return;
  el.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "scale(1.03)", offset: 0.7 }, { opacity: 1, transform: "scale(1)" }],
    { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" });
}
function shrinkOut(el, then) {
  if (!motionAllowed() || !el) { then(); return; }
  const a = el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.6)" }],
    { duration: 220, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
  a.onfinish = a.oncancel = then;
}

// Боковая панель (карточка задачи) выезжает справа.
function slideInRight(el) {
  if (!motionAllowed() || !el) return;
  el.animate([{ opacity: 0, transform: "translateX(24px)" }, { opacity: 1, transform: "translateX(0)" }],
    { duration: 280, easing: "cubic-bezier(0.2, 0, 0, 1)" });
}

// Галочка «прорисовывается» и отметка коротко пружинит — только у той, по которой щёлкнули
// (вызывается после перерисовки для конкретного элемента, а не стилем на всех отмеченных).
function checkDraw(box) {
  if (!motionAllowed() || !box) return;
  box.animate([{ transform: "scale(0.7)" }, { transform: "scale(1.2)" }, { transform: "scale(1)" }], { duration: 300, easing: "ease-out" });
  const path = box.querySelector("svg path, svg polyline");
  if (path && path.getTotalLength) {
    const len = path.getTotalLength();
    path.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }],
      { duration: 260, delay: 60, easing: "ease-out", fill: "backwards" });
  }
}
