// Оформление: светлая или тёмная тема и цвет акцента — личный выбор, хранится в этом браузере
// (localStorage), на сервер не уходит. Как в клиенте «Искры»: те же два переключателя, те же шесть
// акцентов (решение пользователя 2026-10-08; раньше был один список из шести тем).
//
// Подключается в <head> ДО стилей страницы и сразу ставит атрибуты на <html> — иначе страница
// успевала бы мигнуть голубой темой:
//   data-theme="dark"      — тёмная (светлая — без атрибута). Это же имя слушают модули: Сертвивер,
//                            журнал звонков и панель «Искры» держат в своих стилях правила для
//                            html[data-theme="dark"];
//   data-accent="…"        — акцент (Лазурь — по умолчанию, без атрибута). Сами цвета — themes.css.
//
// Ключи хранилища:
//   center.mode, center.accent             — действующие в этом браузере сейчас (их же читают модули,
//                                            открытые внутри «Центра»: адрес тот же, хранилище общее);
//   center.mode:<логин>, center.accent:<логин> — выбор конкретного сотрудника. За одним компьютером
//                                            работают сменами: вошёл другой — применяется его оформление.
//   center.theme[:<логин>]                 — прежний единый выбор (до 2026-10-08); читается один раз,
//                                            чтобы перенести выбор сотрудников, и больше не пишется.
// Событие storage приходит во все остальные вкладки и встроенные страницы этого адреса — оформление
// меняется в них сразу, без перезагрузки.
(function () {
  var MODES = [
    { id: 'light', name: 'Светлая' },
    { id: 'dark', name: 'Тёмная' },
  ];
  // Порядок и названия — как в настройках клиента «Искры».
  var ACCENTS = [
    { id: 'ember', name: 'Янтарь', color: '#C2560F' },
    { id: 'garnet', name: 'Гранат', color: '#B0303F' },
    { id: 'gold', name: 'Латунь', color: '#9A7400' },
    { id: 'jade', name: 'Малахит', color: '#00775A' },
    { id: 'azure', name: 'Лазурь', color: '#0A61AE' },
    { id: 'violet', name: 'Аметист', color: '#663AB5' },
  ];
  var DEFAULT_MODE = 'light', DEFAULT_ACCENT = 'azure';
  // Прежние темы → новое оформление: так выбор, сделанный до обновления, не теряется.
  var LEGACY = {
    blue: ['light', 'azure'], light: ['light', 'azure'], dark: ['dark', 'azure'],
    lilac: ['light', 'violet'], emerald: ['light', 'jade'], pink: ['light', 'garnet'],
  };
  var has = function (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return true; return false; };
  // Хранилище может быть недоступно (режим инкогнито со строгими настройками) — тогда оформление по
  // умолчанию на время сеанса.
  var read = function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } };
  var write = function (key, v) { try { localStorage.setItem(key, v); } catch (e) { /* не сохранилось — не беда */ } };

  var user = null;
  var mode = null, accent = null; // выбор на время сеанса, если хранилище недоступно
  // Сохранённое для ключа (общего или сотрудника): новое, иначе перенесённое из прежней темы.
  function stored(suffix) {
    var m = read('center.mode' + suffix), a = read('center.accent' + suffix);
    var legacy = LEGACY[read('center.theme' + suffix)];
    return {
      mode: has(MODES, m) ? m : legacy ? legacy[0] : null,
      accent: has(ACCENTS, a) ? a : legacy ? legacy[1] : null,
    };
  }
  function current() {
    var own = user ? stored(':' + user) : { mode: null, accent: null };
    var here = stored('');
    return {
      mode: own.mode || here.mode || mode || DEFAULT_MODE,
      accent: own.accent || here.accent || accent || DEFAULT_ACCENT,
    };
  }
  function apply(c) {
    var el = document.documentElement;
    if (c.mode === 'dark') el.setAttribute('data-theme', 'dark'); else el.removeAttribute('data-theme');
    if (c.accent === DEFAULT_ACCENT) el.removeAttribute('data-accent'); else el.setAttribute('data-accent', c.accent);
  }
  function save(c) {
    if (user) { write('center.mode:' + user, c.mode); write('center.accent:' + user, c.accent); }
    write('center.mode', c.mode);
    write('center.accent', c.accent);
  }

  apply(current());
  window.addEventListener('storage', function (e) { if (!e.key || e.key.indexOf('center.') === 0) apply(current()); });

  window.CenterTheme = {
    modes: MODES,
    accents: ACCENTS,
    /** Действующее оформление: { mode: 'light'|'dark', accent: 'azure'|… }. */
    get: current,
    /** Светлая или тёмная — запоминается для вошедшего сотрудника и как действующая в браузере. */
    setMode: function (m) {
      if (!has(MODES, m)) return;
      var c = current(); c.mode = m; mode = m;
      save(c); apply(c);
    },
    /** Цвет акцента — так же. */
    setAccent: function (a) {
      if (!has(ACCENTS, a)) return;
      var c = current(); c.accent = a; accent = a;
      save(c); apply(c);
    },
    /** После входа: применить оформление этого сотрудника (или оставить действующее, если он не выбирал). */
    useUser: function (login) {
      user = login ? String(login).toLowerCase() : null;
      var c = current();
      write('center.mode', c.mode);
      write('center.accent', c.accent);
      apply(c);
    },
  };
})();
