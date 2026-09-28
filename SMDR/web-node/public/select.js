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

    // Перечень раскрывается ПОВЕРХ страницы (position: fixed), а не внутри
    // обёртки. Внутри его обрезал любой предок с overflow: hidden — например
    // раскрывающийся ряд «Ещё фильтры»: он обязан прятать переполнение, иначе
    // не анимируется высота, и список уходил под таблицу журнала.
    // Раз координаты считаются от окна, их надо считать при каждом открытии;
    // а на прокрутку список закрывается — так же ведёт себя и системный.
    var ОТСТУП = 8;   // от края окна
    var ЗАЗОР = 6;    // между кнопкой и перечнем
    function place() {
      var r = btn.getBoundingClientRect();
      menu.style.maxHeight = '';
      menu.style.minWidth = r.width + 'px';
      var снизу = window.innerHeight - r.bottom - ЗАЗОР - ОТСТУП;
      var сверху = r.top - ЗАЗОР - ОТСТУП;
      var высота = menu.offsetHeight;
      if (высота > снизу && сверху > снизу) {
        menu.style.top = Math.max(ОТСТУП, r.top - ЗАЗОР - Math.min(высота, сверху)) + 'px';
        menu.style.maxHeight = сверху + 'px';
      } else {
        menu.style.top = (r.bottom + ЗАЗОР) + 'px';
        if (высота > снизу) menu.style.maxHeight = снизу + 'px';
      }
      var ширина = menu.offsetWidth;
      menu.style.left = Math.max(ОТСТУП,
        Math.min(r.left, document.documentElement.clientWidth - ширина - ОТСТУП)) + 'px';

      // Кнопка может оказаться за краем окна целиком — страница журнала не
      // прокручивается, и в очень низком окне панель фильтров уходит вниз.
      // Перечень в любом случае не должен уезжать за экран.
      var потолок = window.innerHeight - ОТСТУП * 2;
      if (menu.offsetHeight > потолок) menu.style.maxHeight = потолок + 'px';
      menu.style.top = Math.max(ОТСТУП,
        Math.min(parseFloat(menu.style.top), window.innerHeight - menu.offsetHeight - ОТСТУП)) + 'px';
    }

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
      // Показать, измерить и расставить за один кадр: если сначала показать,
      // а расставить потом, перечень успеет мигнуть в левом верхнем углу.
      menu.style.visibility = 'hidden';
      menu.hidden = false;
      place();
      menu.style.visibility = '';
    }
    btn.onclick = function (e) { e.stopPropagation(); menu.hidden ? open() : close(); };
    sel.addEventListener('change', syncLabel);
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    // capture: true — прокручиваться может не окно, а внутренний блок
    // (в журнале скроллится сама таблица), а его событие всплывать не будет.
    window.addEventListener('scroll', function () { if (!menu.hidden) close(); }, true);
    window.addEventListener('resize', function () { if (!menu.hidden) close(); });
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
