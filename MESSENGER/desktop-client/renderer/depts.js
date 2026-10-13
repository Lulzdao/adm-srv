// Какие отделы в списке сотрудников свёрнуты — два режима.
//
//   обычный        каждый отдел сворачивается сам по себе, выбор запоминается (как было всегда);
//   «по одному»    настройка «Открывать отделы по одному»: все отделы свёрнуты, открыт может быть
//                  только один — открыл другой, прежний свернулся сам. Когда отделов два десятка,
//                  список иначе превращается в простыню, в которой нужный отдел приходится искать.
//
// В режиме «по одному» открытый отдел не запоминается между запусками: при старте свёрнуты все.
// Обычный выбор при этом не трогается — выключил настройку, и список такой же, каким был до неё.
//
// Подключается в окно списка; для теста — обычный модуль Node (см. depts.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Depts = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // collapsed — имена свёрнутых отделов обычного режима; single — включён ли режим «по одному».
  function createState(collapsed, single) {
    return { collapsed: new Set(collapsed || []), single: !!single, open: null };
  }

  function isCollapsed(state, key) {
    return state.single ? state.open !== key : state.collapsed.has(key);
  }

  // Щелчок по заголовку отдела. Возвращает, что изменилось на экране: [{ key, collapsed }] —
  // в режиме «по одному» это может быть два отдела сразу (новый открылся, прежний свернулся).
  function toggle(state, key) {
    if (!state.single) {
      const collapsed = !state.collapsed.has(key);
      if (collapsed) state.collapsed.add(key); else state.collapsed.delete(key);
      return [{ key, collapsed }];
    }
    if (state.open === key) {
      state.open = null;
      return [{ key, collapsed: true }];
    }
    const changes = [];
    if (state.open !== null) changes.push({ key: state.open, collapsed: true });
    state.open = key;
    changes.push({ key, collapsed: false });
    return changes;
  }

  // Смена настройки: включили — все свёрнуты; выключили — возвращается обычный выбор.
  function setSingle(state, single) {
    state.single = !!single;
    state.open = null;
  }

  return { createState, isCollapsed, toggle, setSingle };
});
