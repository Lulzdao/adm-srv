// Своё окно подтверждения вместо браузерного confirm(): в оформлении модуля и в теме «Центра»,
// с понятной надписью на кнопке («Удалить», а не «ОК»). Образец — helpdesk-backend/public/dialog.js;
// общей сборки у платформы и модулей нет, поэтому код повторён здесь, а стили — в app.css (.ui-dialog).
// Возвращает Promise — вызывать через await:
//   if (!(await uiConfirm('Удалить сертификат?', { ok: 'Удалить', danger: true }))) return;
// Esc и щелчок мимо окна — отмена, Enter — главная кнопка. На удалении фокус стоит на «Отмене»:
// случайный Enter ничего не сотрёт.

function uiConfirm(text, opts) {
  opts = opts || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const motion = typeof Element.prototype.animate === 'function'
    && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const danger = Boolean(opts.danger);
  const cancel = opts.cancel === undefined ? 'Отмена' : opts.cancel;

  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'ui-dialog-back';
    back.innerHTML = `
      <div class="ui-dialog" role="dialog" aria-modal="true">
        ${opts.title ? `<div class="ui-dialog-title">${esc(opts.title)}</div>` : ''}
        <div class="ui-dialog-text">${esc(text)}</div>
        <div class="ui-dialog-actions">
          ${cancel ? `<button type="button" class="btn btn-ghost" data-r="cancel">${esc(cancel)}</button>` : ''}
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-wire'}" data-r="ok">${esc(opts.ok || 'Да')}</button>
        </div>
      </div>`;
    const box = back.querySelector('.ui-dialog');
    const before = document.activeElement;
    let done = false;

    function close(result) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      const finish = () => {
        back.remove();
        if (before && before.focus && document.contains(before)) before.focus({ preventScroll: true });
        resolve(result);
      };
      if (motion) {
        back.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
        box.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }],
          { duration: 140, easing: 'ease-in', fill: 'forwards' }).onfinish = finish;
      } else finish();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') {
        // Enter нажимает ту кнопку, на которой фокус (на удалении это «Отмена»).
        e.preventDefault(); e.stopPropagation();
        close(document.activeElement && document.activeElement.dataset.r === 'cancel' ? false : true);
      } else if (e.key === 'Tab') {
        // Фокус не уходит из окна — страница под затемнением недоступна.
        const f = [...box.querySelectorAll('button')];
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(false); });
    back.querySelector('[data-r="ok"]').onclick = () => close(true);
    const cancelBtn = back.querySelector('[data-r="cancel"]');
    if (cancelBtn) cancelBtn.onclick = () => close(false);

    document.body.appendChild(back);
    if (motion) {
      back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      box.animate([{ opacity: 0, transform: 'translateY(8px) scale(0.96)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
        { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
    back.querySelector(danger && cancelBtn ? '[data-r="cancel"]' : '[data-r="ok"]').focus();
  });
}
