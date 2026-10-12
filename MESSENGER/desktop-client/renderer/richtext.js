// Оформленный текст объявлений: редактор с кнопками и очистка HTML перед показом.
//
// Как редактор рассылок по почте в «Центре» (helpdesk-backend/public/app-mailings.js): жирный, курсив,
// подчёркнутый, зачёркнутый, шрифт, размер, цвет, выравнивание, списки, ссылка. Внутри — contenteditable
// и команды браузера. Сервер чистит HTML по белому списку (MESSENGER/lib/richtext.js) и сам делает
// текстовую версию; здесь при показе чистим ещё раз тем же списком — объявление попадает в окна у всех,
// и полагаться на одну проверку незачем.
//
// Один и тот же файл в двух местах: окно объявлений клиента (desktop-client/renderer/richtext.js) и
// панель администратора (MESSENGER/public/richtext.js). Тест сверяет, что копии одинаковы.
// Цвета — готовым набором, а не любым: объявление читают и в светлой, и в тёмной теме, и тёмно-синий
// на тёмном фоне пропал бы. Эти шесть читаются на обоих фонах.
(function () {
  'use strict';

  const FONTS = ['Arial', 'Times New Roman', 'Calibri', 'Georgia', 'Verdana', 'Tahoma', 'Courier New'];
  const SIZES = [['12px', 'Мелкий'], ['14px', 'Обычный'], ['18px', 'Крупный'], ['24px', 'Очень крупный'], ['32px', 'Заголовок']];
  const COLORS = [['#D93B3B', 'Красный'], ['#D9731A', 'Оранжевый'], ['#2F9E44', 'Зелёный'], ['#2F7BD9', 'Синий'], ['#8B5CD6', 'Фиолетовый'], ['#8A8F98', 'Серый']];

  // ---------- Очистка: тот же белый список, что на сервере ----------
  const TAGS = {
    p: [], div: [], br: [], span: [], b: [], strong: [], i: [], em: [], u: [], s: [], strike: [],
    sub: [], sup: [], ul: [], ol: [], li: [], blockquote: [], h1: [], h2: [], h3: [], hr: [],
    a: ['href'], font: ['face', 'size', 'color'],
  };
  const DROP_WITH_CONTENT = new Set(['script', 'style', 'head', 'title', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'xml', 'textarea', 'select']);
  const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|[a-z]{3,20})$/i;
  const STYLE = {
    'font-weight': /^(bold|bolder|normal|[1-9]00)$/i,
    'font-style': /^(italic|normal|oblique)$/i,
    'text-decoration': /^[a-z\s-]{1,40}$/i,
    'text-decoration-line': /^[a-z\s-]{1,40}$/i,
    'font-size': /^(\d{1,2}(\.\d+)?(px|pt|em|rem|%)|x{0,3}-?(small|large)|medium|smaller|larger)$/i,
    'font-family': /^[\w\s"',.-]{1,120}$/i,
    'color': COLOR,
    'background-color': COLOR,
    'text-align': /^(left|right|center|justify)$/i,
    'margin-left': /^\d{1,3}(px|em)$/i,
    'padding-left': /^\d{1,3}(px|em)$/i,
  };

  function cleanStyle(raw) {
    const out = [];
    for (const decl of String(raw).split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const value = decl.slice(i + 1).trim().replace(/\s*!important$/i, '');
      if (STYLE[prop] && STYLE[prop].test(value) && !/url\s*\(|expression|javascript:|[<>\\]/i.test(value)) out.push(`${prop}: ${value}`);
    }
    return out.join('; ');
  }
  function cleanAttr(tag, name, v) {
    v = String(v).trim();
    if (tag === 'a' && name === 'href') return /^(https?:|mailto:)/i.test(v) ? v : null;
    if (tag === 'font' && name === 'size') return /^[1-7]$/.test(v) ? v : null;
    if (tag === 'font' && name === 'color') return COLOR.test(v) ? v : null;
    if (tag === 'font' && name === 'face') return /^[\w\s"',.-]{1,120}$/.test(v) ? v : null;
    return null;
  }

  // Разбор — шаблоном (<template>): в нём ничего не исполняется и картинки не грузятся. Узлы
  // переносятся в новое дерево только из белого списка, атрибуты — только разрешённые.
  function copyClean(from, to) {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === 3) { to.appendChild(document.createTextNode(node.nodeValue)); continue; }
      if (node.nodeType !== 1) continue;
      const name = node.nodeName.toLowerCase();
      if (DROP_WITH_CONTENT.has(name)) continue;
      if (!TAGS[name]) { copyClean(node, to); continue; }   // неизвестный тег — убираем, текст оставляем
      const el = document.createElement(name);
      for (const attr of Array.from(node.attributes)) {
        const an = attr.name.toLowerCase();
        if (an === 'style') { const st = cleanStyle(attr.value); if (st) el.setAttribute('style', st); }
        else if (TAGS[name].includes(an)) { const v = cleanAttr(name, an, attr.value); if (v !== null) el.setAttribute(an, v); }
      }
      copyClean(node, el);
      to.appendChild(el);
    }
  }
  function clean(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const box = document.createElement('div');
    copyClean(tpl.content, box);
    return box.innerHTML;
  }

  // ---------- Редактор ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (inner, w = 15) => `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const lines = (w) => svg(w.map(([x1, x2], i) => `<line x1="${x1}" y1="${3 + i * 3.4}" x2="${x2}" y2="${3 + i * 3.4}"/>`).join(''));
  const ICON = {
    left: lines([[2, 14], [2, 10], [2, 14], [2, 9]]),
    center: lines([[2, 14], [4, 12], [2, 14], [5, 11]]),
    right: lines([[2, 14], [6, 14], [2, 14], [7, 14]]),
    ul: svg('<circle cx="3" cy="4" r=".9" fill="currentColor"/><circle cx="3" cy="8" r=".9" fill="currentColor"/><circle cx="3" cy="12" r=".9" fill="currentColor"/><line x1="6.5" y1="4" x2="14" y2="4"/><line x1="6.5" y1="8" x2="14" y2="8"/><line x1="6.5" y1="12" x2="14" y2="12"/>'),
    ol: svg('<path d="M2.3 2.8h1v3" stroke-width="1.2"/><path d="M2 10.2c.2-.6 1.8-.8 1.8.2 0 .8-1.8 1.3-1.8 2.3h1.9" stroke-width="1.2"/><line x1="6.5" y1="4" x2="14" y2="4"/><line x1="6.5" y1="8" x2="14" y2="8"/><line x1="6.5" y1="12" x2="14" y2="12"/>'),
    link: svg('<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),
    clear: svg('<path d="M3 3h8M7 3 5 13"/><path d="M10 9l4 4M14 9l-4 4"/>'),
    chev: svg('<path d="M4.5 6.5 8 10l3.5-3.5"/>', 11),
  };

  /**
   * Редактор в box. opts.placeholder, opts.onInput, opts.onEnterCtrl (Ctrl+Enter), opts.askLink(): Promise<string|null>
   * (окно «адрес ссылки» — у клиента и панели свои диалоги). Возвращает { html(), text(), isEmpty(), clear(), focus() }.
   */
  function editor(box, opts = {}) {
    box.innerHTML = `
      <div class="rte">
        <div class="rte-bar" role="toolbar" aria-label="Оформление текста">
          <div class="rte-drop" data-drop="font"><button type="button" class="rte-dd" title="Шрифт">Шрифт ${ICON.chev}</button>
            <div class="rte-menu">${FONTS.map((f) => `<button type="button" data-font="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</button>`).join('')}</div></div>
          <div class="rte-drop" data-drop="size"><button type="button" class="rte-dd" title="Размер">Размер ${ICON.chev}</button>
            <div class="rte-menu">${SIZES.map(([v, l]) => `<button type="button" data-size="${v}" style="font-size:${Math.min(parseInt(v, 10), 20)}px">${l}</button>`).join('')}</div></div>
          <span class="rte-sep"></span>
          <button type="button" data-cmd="bold" title="Жирный (Ctrl+B)"><b>Ж</b></button>
          <button type="button" data-cmd="italic" title="Курсив (Ctrl+I)"><i style="font-family:Georgia,serif">К</i></button>
          <button type="button" data-cmd="underline" title="Подчёркнутый (Ctrl+U)"><u>Ч</u></button>
          <button type="button" data-cmd="strikeThrough" title="Зачёркнутый"><s>З</s></button>
          <div class="rte-drop" data-drop="color"><button type="button" class="rte-dd rte-color" title="Цвет текста"><span class="rte-color-a">А<i></i></span>${ICON.chev}</button>
            <div class="rte-menu rte-swatches"><button type="button" data-color="" class="rte-nocolor" title="Обычный цвет" aria-label="Обычный цвет"></button>${COLORS.map(([c, l]) => `<button type="button" data-color="${c}" title="${l}" aria-label="${l}" style="--c:${c}"></button>`).join('')}</div></div>
          <span class="rte-sep"></span>
          <button type="button" data-cmd="justifyLeft" title="По левому краю">${ICON.left}</button>
          <button type="button" data-cmd="justifyCenter" title="По центру">${ICON.center}</button>
          <button type="button" data-cmd="justifyRight" title="По правому краю">${ICON.right}</button>
          <span class="rte-sep"></span>
          <button type="button" data-cmd="insertUnorderedList" title="Маркированный список">${ICON.ul}</button>
          <button type="button" data-cmd="insertOrderedList" title="Нумерованный список">${ICON.ol}</button>
          <button type="button" data-act="link" title="Ссылка">${ICON.link}</button>
          <button type="button" data-act="clear" title="Убрать оформление">${ICON.clear}</button>
        </div>
        <div class="rte-area empty" contenteditable="true" spellcheck="true" data-placeholder="${esc(opts.placeholder || '')}"></div>
      </div>`;
    const area = box.querySelector('.rte-area');
    let saved = null;   // выделение в тексте: кнопки и меню сверху его сбивают
    let lastColor = COLORS[0][0];
    const colorMark = box.querySelector('.rte-color-a i');
    colorMark.style.background = lastColor;

    const remember = () => {
      const sel = window.getSelection();
      if (sel.rangeCount && area.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
    };
    const restore = () => {
      area.focus();
      if (saved) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(saved); }
    };
    const isEmpty = () => !area.textContent.trim() && !area.querySelector('li');
    const paintState = () => {
      const inside = area.contains(window.getSelection().anchorNode);
      box.querySelectorAll('[data-cmd]').forEach((b) => {
        let on = false;
        try { on = document.queryCommandState(b.dataset.cmd); } catch { /* команда не поддерживается */ }
        b.classList.toggle('on', on && inside);
      });
    };
    // «Обычный цвет»: у браузера нет команды «убрать цвет», поэтому красим служебным цветом. В поле он
    // показывается цветом темы (стиль .rte-area [style*="rgb(1, 2, 3)"]), а снимается при выдаче html():
    // снимать прямо во время набора нельзя — правка узла под курсором сбивает курсор.
    const NO_COLOR = '#010203';
    const dropNoColor = (root) => {
      root.querySelectorAll('[style*="rgb(1, 2, 3)"], [style*="#010203"], font[color="#010203"]').forEach((el) => {
        el.style.removeProperty('color'); el.removeAttribute('color');
        if (!el.getAttribute('style')) el.removeAttribute('style');
        if ((el.nodeName === 'SPAN' || el.nodeName === 'FONT') && !el.attributes.length) el.replaceWith(...el.childNodes);
      });
    };
    const changed = () => { area.classList.toggle('empty', isEmpty()); paintState(); if (opts.onInput) opts.onInput(); };
    const exec = (cmd, value = null) => {
      restore();
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(cmd, false, value);
      remember(); changed();
    };
    const closeMenus = () => box.querySelectorAll('.rte-drop.open').forEach((d) => d.classList.remove('open'));

    // Кнопки не забирают фокус — выделение в тексте остаётся на месте.
    box.querySelectorAll('.rte-bar button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
    box.querySelectorAll('[data-cmd]').forEach((b) => { b.onclick = () => { closeMenus(); exec(b.dataset.cmd); }; });
    box.querySelectorAll('.rte-dd').forEach((b) => {
      b.onclick = () => {
        const drop = b.parentElement;
        const open = !drop.classList.contains('open');
        closeMenus();
        drop.classList.toggle('open', open);
        // Меню не должно вылезать за правый край окна: в узком окне его прижимаем справа.
        const menu = drop.querySelector('.rte-menu');
        menu.style.left = ''; menu.style.right = '';
        if (open && menu.getBoundingClientRect().right > document.documentElement.clientWidth - 6) { menu.style.left = 'auto'; menu.style.right = '0'; }
      };
    });
    document.addEventListener('mousedown', (e) => { if (!e.target.closest || !e.target.closest('.rte-drop')) closeMenus(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box.querySelector('.rte-drop.open')) { e.stopPropagation(); closeMenus(); } });

    box.querySelectorAll('[data-font]').forEach((b) => { b.onclick = () => { closeMenus(); exec('fontName', b.dataset.font); }; });
    box.querySelectorAll('[data-size]').forEach((b) => {
      b.onclick = () => {
        closeMenus();
        // Размер в браузере — только ступенями 1–7; ставим седьмую и меняем её на нужный.
        exec('fontSize', '7');
        area.querySelectorAll('font[size="7"], [style*="xxx-large"]').forEach((el) => {
          el.removeAttribute('size');
          el.style.fontSize = b.dataset.size;
        });
        changed();
      };
    });
    box.querySelectorAll('[data-color]').forEach((b) => {
      b.onclick = () => {
        closeMenus();
        if (!b.dataset.color) { colorMark.style.background = 'currentColor'; exec('foreColor', NO_COLOR); return; }
        lastColor = b.dataset.color; colorMark.style.background = lastColor; exec('foreColor', lastColor);
      };
    });
    box.querySelector('[data-act=link]').onclick = async () => {
      closeMenus();
      const keep = saved;
      const url = opts.askLink ? await opts.askLink() : null;
      saved = keep;
      if (!url) return;
      const u = url.trim();
      if (/^(https?:\/\/|mailto:)\S+$/i.test(u)) {
        restore();
        // Ничего не выделено — вставляем сам адрес ссылкой, иначе ссылкой становится выделенное.
        if (window.getSelection().isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(u)}">${esc(u)}</a>&nbsp;`);
        else document.execCommand('createLink', false, u);
        remember(); changed();
      } else if (opts.onError) opts.onError('Ссылка должна начинаться с https://, http:// или mailto:');
    };
    box.querySelector('[data-act=clear]').onclick = () => { closeMenus(); exec('removeFormat'); exec('unlink'); };

    // Вставка из Word, браузера, почты — сразу чистая: без картинок, классов и чужих стилей разметки.
    area.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      e.preventDefault();
      const html = dt.getData('text/html');
      if (html) document.execCommand('insertHTML', false, clean(html.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, '')));
      else document.execCommand('insertText', false, dt.getData('text/plain'));
      remember(); changed();
    });
    // Перетаскивание текста внутрь поля — тоже вставка, но файлы окно ловит само (прикрепляет).
    area.addEventListener('drop', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && opts.onEnterCtrl) { e.preventDefault(); opts.onEnterCtrl(); }
    });
    area.addEventListener('input', changed);
    area.addEventListener('keyup', remember);
    area.addEventListener('mouseup', remember);
    area.addEventListener('blur', remember);
    document.addEventListener('selectionchange', () => { if (area.contains(window.getSelection().anchorNode)) { remember(); paintState(); } });

    return {
      html: () => { const copy = area.cloneNode(true); dropNoColor(copy); return clean(copy.innerHTML); },
      text: () => area.innerText.replace(/ /g, ' ').trim(),
      isEmpty,
      clear() { area.innerHTML = ''; saved = null; changed(); },
      focus: () => area.focus(),
    };
  }

  window.IskraRich = { editor, clean, FONTS, SIZES, COLORS };
})();
