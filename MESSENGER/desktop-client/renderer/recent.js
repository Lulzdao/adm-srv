// Что показывает лента окна чата и окна объявлений: переписку за последние три дня.
//
// Раньше лента «обнулялась» каждый день — в окне были только сегодняшние сообщения, и за вчерашним
// ответом приходилось идти в «Историю». Теперь в ленте три дня: сегодня, вчера и позавчера, с
// разделителем на каждый день; всё, что раньше, — по-прежнему в «Истории», о чём сверху ленты
// напоминает строка-подсказка. Дни считаются по часам этого компьютера, как и в «Истории».
//
// Подключается в окна чата и объявлений; для теста — обычный модуль Node (см. recent.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Recent = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAYS = 3;

  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // Границы запроса к серверу: с начала дня «сегодня минус (days − 1)» до конца сегодняшнего.
  // Через календарные дни, а не вычитанием 24 часов: в сутках перевода часов их 23 или 25.
  function range(now, days) {
    const today = dayStart(now);
    const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((days || DAYS) - 1));
    const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    return { since: since.getTime(), until: until.getTime() };
  }

  // Ключ дня сообщения — чтобы понять, что начался другой день и нужен разделитель.
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  // Подпись разделителя: «Сегодня, 13 октября», «Вчера, 12 октября», дальше — просто дата.
  function dayLabel(ts, now) {
    const d = new Date(ts);
    const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
    const sameYear = d.getFullYear() === now.getFullYear();
    const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
    if (diff === 0) return `Сегодня, ${date}`;
    if (diff === 1) return `Вчера, ${date}`;
    return date;
  }

  const HINT = `Здесь переписка за последние ${DAYS} дня. Более ранняя — по кнопке «История»`;

  return { DAYS, HINT, range, dayKey, dayLabel };
});
