/* --- Выпадающий список ---
   Системный <select> оформить нельзя: стрелку рисует браузер, она прижата к
   краю, а раскрытый перечень берёт вид от системы и в палитру не попадает.
   Настоящий select остаётся в разметке скрытым — весь код, который читает и
   пишет .value, работает как раньше, — а видимую часть рисуем сами.
   Тот же приём, что и в панели платформы; общей сборки у сервисов нет,
   поэтому код продублирован сознательно. */
(function () {
  var CHEVRON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

  function enhance(sel) {
    if (sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';
    var wrap = document.createElement('div');
    wrap.className = 'select-wrap';
    if (sel.style.width) wrap.style.width = sel.style.width;
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'select-btn';
    btn.innerHTML = '<span class="select-value"></span><span class="select-chevron">' + CHEVRON + '</span>';
    wrap.appendChild(btn);

    var menu = document.createElement('div');
    menu.className = 'select-menu';
    menu.hidden = true;
    wrap.appendChild(menu);

    var label = btn.querySelector('.select-value');
    function syncLabel() {
      var opt = sel.options[sel.selectedIndex];
      label.textContent = opt ? opt.textContent : '';
    }
    function close() { wrap.classList.remove('open'); menu.hidden = true; }
    function open() {
      menu.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (opt, i) {
        var row = document.createElement('div');
        row.className = 'select-option' + (i === sel.selectedIndex ? ' selected' : '');
        row.textContent = opt.textContent;
        row.onclick = function () {
          sel.selectedIndex = i;
          syncLabel();
          close();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        };
        menu.appendChild(row);
      });
      wrap.classList.add('open');
      menu.hidden = false;
    }
    btn.onclick = function (e) { e.stopPropagation(); menu.hidden ? open() : close(); };
    sel.addEventListener('change', syncLabel);
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    syncLabel();
  }

  function enhanceAll() {
    document.querySelectorAll('select:not([data-enhanced])').forEach(enhance);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhanceAll);
  else enhanceAll();
  // Экраны перерисовываются, поэтому следим за появлением новых select.
  new MutationObserver(enhanceAll).observe(document.documentElement, { childList: true, subtree: true });
})();
