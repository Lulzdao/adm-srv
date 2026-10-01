// Цветовая тема: личный выбор, хранится в этом браузере (localStorage), на сервер не уходит.
//
// Подключается в <head> ДО стилей страницы и сразу ставит <html data-theme="…"> — иначе страница
// успевала бы мигнуть голубой темой. Сами темы — themes.css.
//
// Ключи:
//   center.theme            — тема, действующая в этом браузере сейчас (её же читают модули,
//                             открытые внутри «Центра»: они на том же адресе, хранилище общее);
//   center.theme:<логин>    — выбор конкретного сотрудника. За одним компьютером работают
//                             сменами: вошёл другой человек — применяется его тема.
// Событие storage приходит во все остальные вкладки и встроенные страницы этого адреса — тема
// меняется в них сразу, без перезагрузки.
(function () {
  var KEY = 'center.theme';
  var THEMES = [
    { id: 'blue', name: 'Голубая', swatch: ['#0A61AE', '#E8EDF5'] },
    { id: 'lilac', name: 'Сиреневая', swatch: ['#663AB5', '#ECE8F4'] },
    { id: 'emerald', name: 'Изумрудная', swatch: ['#00818F', '#E4EFF0'] },
    { id: 'pink', name: 'Розовая', swatch: ['#C2003F', '#F5E9ED'] },
    { id: 'light', name: 'Светлая', swatch: ['#FFFFFF', '#E8EDF5'] },
    { id: 'dark', name: 'Тёмная', swatch: ['#121416', '#23262B'] },
  ];
  var DEFAULT = 'blue';
  var known = function (t) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === t) return true; return false; };
  // Хранилище может быть недоступно (режим инкогнито со строгими настройками) — тогда просто
  // голубая тема на время сеанса.
  var read = function (key) { try { var t = localStorage.getItem(key); return known(t) ? t : null; } catch (e) { return null; } };
  var write = function (key, t) { try { localStorage.setItem(key, t); } catch (e) { /* не сохранилось — не беда */ } };

  var user = null;
  function apply(t) {
    var el = document.documentElement;
    if (!t || t === DEFAULT) el.removeAttribute('data-theme'); else el.setAttribute('data-theme', t);
  }
  function current() { return (user && read(KEY + ':' + user)) || read(KEY) || DEFAULT; }

  apply(current());
  window.addEventListener('storage', function (e) { if (!e.key || e.key.indexOf(KEY) === 0) apply(current()); });

  window.CenterTheme = {
    list: THEMES,
    get: current,
    /** Выбрать тему: запоминается для вошедшего сотрудника и как действующая в браузере. */
    set: function (t) {
      if (!known(t)) return;
      if (user) write(KEY + ':' + user, t);
      write(KEY, t);
      apply(t);
    },
    /** После входа: применить тему этого сотрудника (или оставить действующую, если он не выбирал). */
    useUser: function (login) {
      user = login ? String(login).toLowerCase() : null;
      var t = current();
      write(KEY, t);
      apply(t);
    },
  };
})();
