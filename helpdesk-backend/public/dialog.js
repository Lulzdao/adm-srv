// Свои окна подтверждения и ввода вместо браузерных confirm()/prompt(): в оформлении «Центра» и его теме,
// с понятными надписями на кнопках («Удалить», а не «ОК»). Обычный скрипт без сборщика, подключается до
// app.js. Оба окна возвращают Promise — вызывать через await в асинхронном обработчике.
//   if (!(await uiConfirm("Удалить акт?", { ok: "Удалить", danger: true }))) return;
//   const url = await uiPrompt("Адрес ссылки", "https://");   // null — отменили
// Esc и щелчок мимо окна — отмена, Enter — главная кнопка. dismissable: false — только кнопками (когда
// оба ответа что-то делают, как при конфликте правок заметки).

function uiDialog({ title = "", text = "", ok = "ОК", cancel = "Отмена", danger = false, input = null, dismissable = true }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "ui-dialog-back";
    back.innerHTML = `
      <div class="ui-dialog" role="dialog" aria-modal="true">
        ${title ? `<div class="ui-dialog-title">${esc(title)}</div>` : ""}
        <div class="ui-dialog-text">${esc(text)}</div>
        ${input ? `<input class="input ui-dialog-input" placeholder="${esc(input.placeholder || "")}">` : ""}
        <div class="ui-dialog-actions">
          ${cancel ? `<button type="button" class="btn btn-ghost" data-r="cancel">${esc(cancel)}</button>` : ""}
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-wire"}" data-r="ok">${esc(ok)}</button>
        </div>
      </div>`;
    const box = back.querySelector(".ui-dialog");
    const field = back.querySelector(".ui-dialog-input");
    if (field) field.value = input.value || "";
    const before = document.activeElement;
    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      const finish = () => { back.remove(); if (before && before.focus && document.contains(before)) before.focus({ preventScroll: true }); resolve(result); };
      if (motionAllowed()) {
        back.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-in", fill: "forwards" });
        box.animate([{ transform: "scale(1)" }, { transform: "scale(0.96)" }], { duration: 140, easing: "ease-in", fill: "forwards" }).onfinish = finish;
      } else finish();
    };
    const okValue = () => (field ? field.value : true);
    const cancelValue = field ? null : false;
    function onKey(e) {
      if (e.key === "Escape" && dismissable) { e.preventDefault(); e.stopPropagation(); close(cancelValue); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); close(okValue()); }
      else if (e.key === "Tab") {
        // Фокус не уходит из окна за его пределы — страница под затемнением недоступна.
        const f = [...box.querySelectorAll("input, button")];
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("mousedown", (e) => { if (e.target === back && dismissable) close(cancelValue); });
    back.querySelector('[data-r="ok"]').onclick = () => close(okValue());
    const cancelBtn = back.querySelector('[data-r="cancel"]');
    if (cancelBtn) cancelBtn.onclick = () => close(cancelValue);
    document.body.appendChild(back);
    if (motionAllowed()) {
      back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
      box.animate([{ opacity: 0, transform: "translateY(8px) scale(0.96)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
        { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    if (field) { field.focus(); field.select(); }
    else back.querySelector(danger && cancelBtn ? '[data-r="cancel"]' : '[data-r="ok"]').focus(); // на удалении фокус — на «Отмене»
  });
}

function uiConfirm(text, opts = {}) {
  return uiDialog({ text, ok: opts.ok || "Да", cancel: opts.cancel === undefined ? "Отмена" : opts.cancel, ...opts });
}
function uiPrompt(text, value = "", opts = {}) {
  return uiDialog({ text, ok: opts.ok || "Готово", ...opts, input: { value, placeholder: opts.placeholder } });
}

// Выделение в редакторе (contenteditable) теряется, когда фокус уходит в окно ввода, — запоминаем его
// до окна и возвращаем после, чтобы ссылка встала туда, где было выделено.
function saveSelection() {
  const s = window.getSelection();
  return s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
}
function restoreSelection(range) {
  if (!range) return;
  const host = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const editor = host && host.closest("[contenteditable=true]");
  if (editor) editor.focus({ preventScroll: true });
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
}
