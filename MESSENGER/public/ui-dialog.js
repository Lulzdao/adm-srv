// Свои окна вместо браузерных alert()/confirm()/prompt(): в оформлении панели и в теме «Центра»,
// с понятными надписями на кнопках («Удалить», а не «ОК»). Подход тот же, что в платформе
// (helpdesk-backend/public/dialog.js); общей сборки у сервисов нет, поэтому код свой.
// Обычный скрипт без сборщика, подключается в index.html ДО panel.js. Стили — в конце panel.css,
// блок «Свои окна и уведомления».
//
// Окна возвращают Promise — вызывать через await в асинхронном обработчике:
//   if (!(await uiConfirm('Удалить отдел?', { ok: 'Удалить', danger: true }))) return;
//   const name = await uiPrompt('Новое название отдела:', 'Старое');   // null — отменили
//   const pw = await uiPrompt('Новый пароль', '', { password: true }); // ввод точками
//   await uiAlert('Сервер ответил ошибкой', { title: 'Не получилось' });
//   uiToast('Пароль обновлён');                                       // ненавязчиво, само исчезнет
//
// Esc и щелчок мимо окна — отмена. Enter в поле ввода — главная кнопка; Enter на кнопке — эта
// кнопка: в окне удаления фокус стоит на «Отмене», и Enter не должен молча удалять.

(function () {
  function motionAllowed() {
    try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return true; }
  }

  let seq = 0; // для id заголовка и текста: окно поверх окна не должно делить их с нижним

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // validate(value) — для окна ввода: вернуть текст ошибки, чтобы окно осталось открытым и
  // показало её под полем, или пусто, если значение годится.
  function uiDialog({ title = '', text = '', ok = 'ОК', cancel = 'Отмена', danger = false, input = null, dismissable = true, validate = null }) {
    return new Promise((resolve) => {
      const back = el('div', 'ui-dialog-back');
      const box = el('div', 'ui-dialog');
      box.setAttribute('role', cancel ? 'dialog' : 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      if (title) {
        const t = el('div', 'ui-dialog-title', title);
        t.id = 'uiDialogTitle' + (++seq);
        box.setAttribute('aria-labelledby', t.id);
        box.appendChild(t);
      }
      if (text) {
        const d = el('div', 'ui-dialog-text', text);
        d.id = 'uiDialogText' + (++seq);
        box.setAttribute('aria-describedby', d.id);
        box.appendChild(d);
      }
      let field = null, hint = null;
      if (input) {
        field = el('input', 'ui-dialog-input');
        field.type = input.password ? 'password' : 'text';
        // Новый пароль для чужой учётной записи: браузер не должен подставлять сюда пароль
        // администратора и предлагать его сохранить.
        field.autocomplete = input.password ? 'new-password' : 'off';
        field.spellcheck = false;
        if (input.placeholder) field.placeholder = input.placeholder;
        field.value = input.value || '';
        box.appendChild(field);
        hint = el('div', 'ui-dialog-error');
        hint.setAttribute('aria-live', 'polite');
        box.appendChild(hint);
        field.addEventListener('input', () => { hint.textContent = ''; field.classList.remove('invalid'); });
      }
      const actions = el('div', 'ui-dialog-actions');
      let cancelBtn = null;
      if (cancel) {
        cancelBtn = el('button', 'ui-dialog-btn ui-dialog-btn-cancel', cancel);
        cancelBtn.type = 'button';
        actions.appendChild(cancelBtn);
      }
      const okBtn = el('button', 'ui-dialog-btn ' + (danger ? 'ui-dialog-btn-danger' : 'ui-dialog-btn-ok'), ok);
      okBtn.type = 'button';
      actions.appendChild(okBtn);
      box.appendChild(actions);
      back.appendChild(box);

      const before = document.activeElement;
      let done = false;
      const close = (result) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        const finish = () => {
          back.remove();
          if (before && before.focus && document.contains(before)) before.focus({ preventScroll: true });
          resolve(result);
        };
        if (motionAllowed() && back.animate) {
          back.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
          box.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' }).onfinish = finish;
        } else finish();
      };
      const cancelValue = field ? null : false;
      const submit = () => {
        if (!field) return close(true);
        const problem = validate ? validate(field.value) : '';
        if (problem) {
          hint.textContent = problem;
          field.classList.add('invalid');
          field.focus();
          return;
        }
        close(field.value);
      };
      function onKey(e) {
        // Окно поверх окна (редко, но бывает): клавиши достаются только верхнему.
        const all = document.querySelectorAll('.ui-dialog-back');
        if (all[all.length - 1] !== back) return;
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          if (dismissable) close(cancelValue);
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault(); e.stopPropagation();
          if (document.activeElement === cancelBtn) close(cancelValue);
          else submit();
        } else if (e.key === 'Tab') {
          // Фокус не уходит из окна — страница под затемнением недоступна.
          const f = [...box.querySelectorAll('input, button')];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
        }
      }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('mousedown', (e) => { if (e.target === back && dismissable) close(cancelValue); });
      okBtn.onclick = submit;
      if (cancelBtn) cancelBtn.onclick = () => close(cancelValue);

      document.body.appendChild(back);
      if (motionAllowed() && back.animate) {
        back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
        box.animate([{ opacity: 0, transform: 'translateY(8px) scale(0.96)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
          { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
      }
      if (field) { field.focus(); field.select(); }
      else (danger && cancelBtn ? cancelBtn : okBtn).focus(); // на необратимом фокус — на «Отмене»
    });
  }

  /** Подтверждение: true — нажали главную кнопку, false — отмена. */
  function uiConfirm(text, opts = {}) {
    return uiDialog({ ...opts, text, ok: opts.ok || 'Да', cancel: opts.cancel === undefined ? 'Отмена' : opts.cancel });
  }

  /** Ввод строки: введённое значение (может быть пустым) или null, если отменили. */
  function uiPrompt(text, value = '', opts = {}) {
    return uiDialog({ ...opts, text, ok: opts.ok || 'Сохранить', input: { value, placeholder: opts.placeholder, password: !!opts.password } });
  }

  /** Сообщение с одной кнопкой — для ошибок и того, что нужно обязательно прочесть. */
  function uiAlert(text, opts = {}) {
    return uiDialog({ ...opts, text, ok: opts.ok || 'Понятно', cancel: null }).then(() => undefined);
  }

  /** Короткое уведомление внизу экрана, исчезает само: «готово», «отправлено». Ничего не ждёт. */
  function uiToast(text, opts = {}) {
    let stack = document.getElementById('uiToastStack');
    if (!stack) {
      stack = el('div');
      stack.id = 'uiToastStack';
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    const t = el('div', 'ui-toast' + (opts.error ? ' error' : ''), text);
    stack.appendChild(t);
    if (motionAllowed() && t.animate) {
      t.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
    const remove = () => { t.remove(); if (!stack.childElementCount) stack.remove(); };
    setTimeout(() => {
      if (motionAllowed() && t.animate) t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).onfinish = remove;
      else remove();
    }, opts.duration || 3500);
  }

  window.uiDialog = uiDialog;
  window.uiConfirm = uiConfirm;
  window.uiPrompt = uiPrompt;
  window.uiAlert = uiAlert;
  window.uiToast = uiToast;
})();
