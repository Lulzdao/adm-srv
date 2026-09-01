// Общий модуль клиента: подключается на каждой странице после theme.css.
// 1) Иконки — inline SVG вместо эмодзи. В собранном .exe у пользователей часто нет цветного
//    эмодзи-шрифта (особенно на урезанных/старых системах), из-за чего эмодзи не рисуются вовсе —
//    SVG с currentColor рендерится всегда одинаково, независимо от шрифтов, установленных в системе.
// 2) Тема — читает настройки и выставляет data-theme на <html>, обновляется вживую.
// 3) uiAlert/uiConfirm — модальные окна в стиле клиента вместо системных alert/confirm.

(function () {
  // Пользователь, ЕДИНСТВЕННОЕ активное подключение которого — веб-панель администратора (host из
  // connectPresenceWs() в public/index.html), физически не может получить ни сообщение, ни файл —
  // у веб-панели нет интерфейса чата, она только для управления организацией. Писать/отправлять файл
  // такому человеку бессмысленно, поэтому это запрещено — и в ростере, и в уже открытом окне чата —
  // пока у него не появится ещё один хост (запущен десктоп-клиент на реальном ПК) вдобавок к веб-панели.
  window.ADMIN_WEB_HOSTNAME = 'Веб-панель администратора';
  window.canReceiveMessages = (hosts) => {
    if (!hosts || !hosts.length) return true; // офлайн — обычный случай, не блокируем: сообщение дождётся его
    return hosts.some((h) => h !== window.ADMIN_WEB_HOSTNAME);
  };

  // Строка "с какого момента действует текущий статус" для тултипа — server.js присылает since
  // в presence (момент последней смены агрегированного статуса пользователя). Используется и в
  // ростере (buildTooltip), и в шапке окна чата (статус собеседника).
  window.formatStatusSince = (state, since) => {
    if (!since) return '';
    const d = new Date(since);
    const date = d.toLocaleDateString('ru-RU');
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const label = state === 'active' ? 'В сети с' : state === 'idle' ? 'Отошёл с' : 'Не в сети с';
    return `${label} ${date} ${time}`;
  };

  const ICONS = {
    minimize: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l9 9m0-9l-9 9"/></svg>',
    attach: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.2l-8.4 8.4a4.9 4.9 0 01-7-7l8.9-8.9a3.4 3.4 0 014.9 4.9l-8.4 8.4a1.9 1.9 0 01-2.7-2.7l7.8-7.8"/></svg>',
    settings: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h11M19 6h1M4 12h6M14 12h6M4 18h13M21 18h0"/><circle cx="17" cy="6" r="2.1" fill="currentColor" stroke="none"/><circle cx="10" cy="12" r="2.1" fill="currentColor" stroke="none"/><circle cx="17" cy="18" r="2.1" fill="currentColor" stroke="none"/></svg>',
    megaphone: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4a1 1 0 001 1h2l7 4V5l-7 4H4a1 1 0 00-1 1z"/><path d="M16 9.5a4 4 0 010 5"/><path d="M19 7a8 8 0 010 10"/></svg>',
    person: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0115 0"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M3 11l17-8-6 17-3.3-6.4L3 11z"/></svg>',
    history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 108.5-8.5"/><path d="M3.5 4.5v5h5"/><path d="M12 8v4l3 2"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.3" cy="10.3" r="6.3"/><path d="M20 20l-4.3-4.3"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.4M12 19.6V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.4M19.6 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/></svg>',
    moon: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M20.2 14.9A8.5 8.5 0 019.6 4.3a8.5 8.5 0 1010.6 10.6z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.6 18a1.5 1.5 0 001.3 2.3h16.2a1.5 1.5 0 001.3-2.3L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m3 0l-1 13a2 2 0 01-2 2H8a2 2 0 01-2-2L5 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    file: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.5H7a2 2 0 00-2 2v15a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M14 2.5V8.5h5.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19.5h16"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>',
    checkDouble: '<svg viewBox="0 0 28 24" width="17" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12.5l4.5 4.5L14 8"/><path d="M8 12.5l4.5 4.5L21 8"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
    admin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l7.5 3.2v5c0 5-3.2 8.6-7.5 10.3-4.3-1.7-7.5-5.3-7.5-10.3v-5L12 2.5z"/><path d="M9 12l2 2 4-4.5"/></svg>',
    maximize: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>',
    restore: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="5.5" width="8" height="8" rx="1"/><path d="M5.5 5.5V3.5a1 1 0 011-1h7a1 1 0 011 1v7a1 1 0 01-1 1h-2"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5a1.5 1.5 0 011.5-1.5h4l2 2.5h8.5A1.5 1.5 0 0120.5 9v9a1.5 1.5 0 01-1.5 1.5H4.5A1.5 1.5 0 013 18V6.5z"/></svg>',
    emoji: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.3"/><path d="M8.3 10.2h.01M15.7 10.2h.01"/><path d="M8 14.3c1 1.4 2.4 2.1 4 2.1s3-.7 4-2.1"/></svg>',
    monitor: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 2.4 A9.6 9.6 0 0 1 15.11 2.92 L14.59 4.43 A8 8 0 0 1 17.66 6.34 L18.79 5.21 A9.6 9.6 0 0 1 20.62 7.78 L19.18 8.48 A8 8 0 0 1 20 12 L21.6 12 A9.6 9.6 0 0 1 21.08 15.11 L19.57 14.59 A8 8 0 0 1 17.66 17.66 L18.79 18.79 A9.6 9.6 0 0 1 16.22 20.62 L15.52 19.18 A8 8 0 0 1 12 20 L12 21.6 A9.6 9.6 0 0 1 8.89 21.08 L9.41 19.57 A8 8 0 0 1 6.34 17.66 L5.21 18.79 A9.6 9.6 0 0 1 3.38 16.22 L4.82 15.52 A8 8 0 0 1 4 12 L2.4 12 A9.6 9.6 0 0 1 2.92 8.89 L4.43 9.41 A8 8 0 0 1 6.34 6.34 L5.21 5.21 A9.6 9.6 0 0 1 7.78 3.38 L8.48 4.82 A8 8 0 0 1 12 4 Z"/><circle cx="12" cy="12" r="3.3"/></svg>',
    reply: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 015 5v2"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.4a4 4 0 018 0v3.1"/></svg>',
    capsLock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L4.5 11h4v4h7v-4h4L12 3.5z"/><path d="M8.5 19h7"/></svg>',
    // Герб Росстата (двуглавый орёл с раскрытой книгой) — из фирменного макета RGB.ai,
    // переведён из кривых Illustrator в один путь. Без width/height: размер задаёт CSS
    // контейнера, цвет — currentColor, поэтому один и тот же значок годится и в строке
    // профиля (26px), и крупнее, и в любой теме.
    emblem: '<svg viewBox="0 0 201.9 208.3" fill="currentColor" fill-rule="evenodd"><path d="M99.2 0L99.6 3.4L96.2 3L96.2 7.1L99.6 6.6L99.6 6.6L97.7 16.1L95 9.2C87.3 9.4 81.6 16.6 83.4 24.1L88.6 37.5C89 49.6 68.6 51.7 66.3 46.5C64 41.2 67.4 39.2 70.7 37.2C73.3 35.5 75.9 33.9 75.4 30.7C75 28.3 69.6 27.2 64.5 26.1C63.7 26 63 25.8 62.3 25.7C61 25.4 60.8 24.6 60.5 23.8C60.1 22.7 59.7 21.6 57 21.5C49.7 21.2 41.3 24.4 40 27.7C38.3 31.6 39.9 33.6 41.6 35.5C42.9 37.2 44.3 38.8 43.7 41.7C43 45.4 40.8 44.9 38.2 44.2C36.4 43.8 34.3 43.3 32.4 44.2C28.8 46 28.1 49.3 27.9 51.8C28 51.6 28.1 51.4 28.3 51.2L28.3 51.2C29 50 29.6 49 31.2 48.5C32.1 48.2 32.5 48.1 33.2 48.1C33.8 48 34.6 47.9 36.2 47.5C34.9 48.8 33.8 49.1 32.8 49.4C31.8 49.7 30.9 50 30.2 51C28.4 53.5 30.7 55.8 30.7 55.8C30.7 55.8 30.4 52.5 32.9 51.8C35 51.1 37.4 51 39.8 50.9C44.5 50.7 49.1 50.4 50.5 46C52.1 41 50.8 39.3 49.6 37.8C48.7 36.7 47.8 35.6 48.5 33.2C50 27.7 61.7 26.6 62.1 31.4C62.2 33.7 61.1 34.7 59.8 35.9C58.4 37.2 56.8 38.7 56.5 42.2C56.2 46.5 62.3 54.8 81.4 51.3C92.1 49.3 98.7 43.5 98.7 38.2C98.7 38 98.7 37.8 98.7 37.7L103.8 37.7C103.7 37.8 103.7 38 103.7 38.2C103.7 43.5 110.3 49.3 121.1 51.3C140.2 54.8 146.3 46.5 145.9 42.2C145.7 38.7 144.1 37.2 142.6 35.9C141.4 34.7 140.2 33.7 140.4 31.4C140.8 26.6 152.5 27.7 154 33.2C154.6 35.6 153.8 36.7 152.9 37.8C151.7 39.3 150.4 41 152 46C153.4 50.4 158 50.7 162.7 50.9C165.1 51 167.5 51.1 169.6 51.8C172.1 52.5 171.8 55.8 171.8 55.8C171.8 55.8 174.1 53.5 172.3 51C171.6 50 170.7 49.7 169.7 49.4C168.7 49.1 167.6 48.8 166.3 47.5C167.9 47.9 168.7 48 169.3 48.1C169.9 48.1 170.4 48.2 171.3 48.5C172.9 49 173.5 50 174.2 51.2L174.2 51.2C174.3 51.4 174.5 51.6 174.6 51.8C174.4 49.3 173.7 46 170.1 44.2C168.2 43.3 166.1 43.8 164.3 44.2C161.7 44.9 159.5 45.4 158.8 41.7C158.2 38.8 159.6 37.2 160.9 35.5C162.5 33.6 164.2 31.6 162.5 27.7C161.2 24.4 152.8 21.2 145.4 21.5C142.8 21.6 142.4 22.7 142 23.8C141.7 24.6 141.4 25.4 140.2 25.7C139.5 25.8 138.7 26 138 26.1L138 26.1C132.9 27.2 127.5 28.3 127.1 30.7C126.5 33.9 129.1 35.5 131.8 37.2C135.1 39.2 138.4 41.2 136.1 46.5C133.9 51.7 113.3 49.5 113.9 37.3L119 24.1C120.8 16.6 115.1 9.4 107.4 9.2L104.8 16.1L102.8 6.6L102.8 6.6L106.2 7.1L106.2 3L102.8 3.4L103.3 0ZM195.5 48C180.9 58.1 166.3 68.1 151.7 78.1L152 78.9C155.7 88 152.9 99.1 145.5 104.2C144.3 105 143 105.7 141.8 106.1L141.7 106.1C140.3 106.6 138.9 106.8 137.5 106.8L137.5 106.8L137.4 106.8C137.4 106.8 137.3 106.8 137.3 106.8L136.5 106.8L136.5 129.3C136.5 132.6 138.3 135.5 141.1 136.2C141.9 136.4 142.8 136.6 143.6 136.7L144.8 136.9L142.3 125.8C143.2 125.6 144 125.3 144.9 125L146.1 130.5C147 134.5 150 137.5 153.5 137.3C154.4 137.3 155.3 137.2 156.1 137.1L157.3 137L150.3 122.4C150.7 122.1 151.2 121.8 151.6 121.5C151.9 121.3 152.3 121 152.6 120.8L157 129.9C158.9 133.8 162.7 136 166.3 134.6C167.4 134.2 168.5 133.7 169.6 133.2L170.7 132.7L157.3 116.6C157.9 115.8 158.6 115.1 159.2 114.3L168.5 125.5C171.3 128.9 175.8 129.6 179.2 127C180.6 125.9 182 124.8 182.8 124.1L183.6 123.2L162.7 108.8C163.2 107.9 163.7 106.9 164.1 106L177.8 115.5C182.5 118.7 188.6 118 191.9 112.6C192.5 111.6 193.1 110.6 193.7 109.5L194.2 108.5L166.3 99.5C166.6 98.5 166.8 97.5 167 96.4L186.1 102.6C191.6 104.3 197.7 101.3 199.4 94.6C199.8 93.3 200.1 92 200.3 90.6L200.5 89.5L167.8 89.5C167.8 88.4 167.8 87.4 167.8 86.3L190.4 86.3C196.5 86.3 201.9 80.9 201.6 73.4C201.5 72.1 201.4 70.8 201.3 69.4L201.2 68.4L167 79.3C166.8 78.3 166.6 77.3 166.3 76.3L189.5 68.8C195.7 66.8 199.9 59.1 197.1 51.8C196.7 50.8 196.3 49.9 195.9 48.9ZM6.4 48C21 58.1 35.6 68.1 50.2 78.1L49.9 78.9C46.2 88 49 99.1 56.4 104.2C57.6 105 58.9 105.7 60.2 106.1L60.2 106.1C61.6 106.6 63 106.8 64.4 106.8L64.4 106.8L64.5 106.8L64.6 106.8L64.6 106.8L65.4 106.8L65.4 129.3C65.4 132.6 63.6 135.5 60.9 136.2C60 136.4 59.2 136.6 58.3 136.7L57.1 136.9L59.6 125.8C58.8 125.6 57.9 125.3 57 125L55.8 130.5C54.9 134.5 52 137.5 48.4 137.3C47.5 137.3 46.7 137.2 45.8 137.1L44.6 137L51.6 122.4C51.2 122.1 50.8 121.8 50.3 121.5C50 121.3 49.6 121 49.3 120.8L44.9 129.9C43 133.8 39.3 136 35.6 134.6C34.5 134.2 33.4 133.7 32.3 133.2L31.2 132.7L44.7 116.6C44 115.8 43.4 115.1 42.8 114.3L33.4 125.5C30.6 128.9 26.1 129.6 22.7 127C21.3 125.9 19.9 124.8 19.2 124.1L18.3 123.2L39.2 108.8C38.7 107.9 38.3 106.9 37.9 106L24.2 115.5C19.5 118.7 13.3 118 10 112.6C9.4 111.6 8.8 110.6 8.3 109.5L7.7 108.5L35.6 99.5C35.3 98.5 35.1 97.5 34.9 96.4L15.8 102.6C10.3 104.3 4.2 101.3 2.5 94.6C2.2 93.3 1.9 92 1.6 90.6L1.4 89.5L34.2 89.5C34.1 88.4 34.1 87.4 34.2 86.3L11.5 86.3C5.5 86.3 0 80.9 0.4 73.4C0.4 72.1 0.5 70.8 0.7 69.4L0.8 68.4L34.9 79.3C35.1 78.3 35.4 77.3 35.6 76.3L12.4 68.8C6.2 66.8 2 59.1 4.8 51.8C5.2 50.8 5.6 49.9 6 48.9ZM61.4 177.8C61.4 170.6 67.8 164.3 77.6 160.4C83.9 165.9 92.1 169.3 101.1 169.3C110 169.3 118.1 166 124.4 160.6C134 164.5 140.2 170.7 140.2 177.8C140.2 182.3 137.5 186.5 133.1 190C133.2 189 133.3 188 133.3 187C133.3 181.1 130.4 175.6 125.6 171.4C128.5 174.9 130.2 179.1 130.2 183.6C130.2 191.2 125.4 197.9 118.1 202.1C115.5 203.2 112.8 204 109.9 204.6C112.5 201.7 114.1 197.5 114.1 192.9C114.1 187.9 112.2 183.4 109.2 180.4C110 183.7 110.4 186.8 110.4 189C110.4 196.4 106.8 203.2 100.8 208.3C94.8 203.2 91.1 196.4 91.1 189C91.1 186.7 91.6 183.3 92.4 179.7C89.1 182.7 87 187.5 87 192.9C87 197.5 88.5 201.7 91.1 204.6C89 204.2 87.1 203.6 85.2 202.9C76.9 198.9 71.3 191.7 71.3 183.6C71.3 179.1 73 174.9 75.9 171.4C71.1 175.6 68.2 181.1 68.2 187C68.2 188 68.3 189 68.4 190C64 186.5 61.4 182.3 61.4 177.8M72 148.9L72 148.9C71.6 149.1 71.2 149.4 70.7 149.7C72.5 148.6 74.2 148 75.6 147.8C75.8 147.8 76.1 147.7 76.3 147.7C77.3 147.7 78 147.9 78.3 148.4C78.6 148.9 78.4 149.6 77.9 150.4C77.3 151.3 76.2 152.4 74.8 153.4L74.8 153.4C74.4 153.7 73.9 154 73.4 154.3C73.9 154 74.4 153.7 74.9 153.5L74.9 153.5C76.4 152.7 77.9 152.3 79 152.2C79.9 152.2 80.6 152.4 80.9 152.8C81.3 153.6 80.5 155 78.9 156.5C78.1 157.2 77.1 157.9 75.9 158.6C72.5 160.6 69.2 161.2 68.5 160C67.8 158.8 70 156.2 73.4 154.3C70 156.2 66.6 156.8 65.9 155.5C65.2 154.2 67.3 151.6 70.7 149.7C67.3 151.6 64 152.2 63.3 151C62.6 149.8 64.8 147.3 68.2 145.3C70.8 143.8 73.4 143.1 74.7 143.4C75.2 143.5 75.5 143.6 75.7 144C76 144.4 75.8 145.1 75.3 145.9C74.7 146.8 73.5 147.9 72 148.9M133.4 145.3C130 143.3 126.7 142.7 126 143.9C125.3 145.1 127.5 147.7 130.9 149.7C130.5 149.5 130.2 149.3 129.9 149.1L129.9 149.1C128.2 148.2 126.6 147.8 125.4 147.7C124.8 147.7 124.2 147.8 123.9 148C123.7 148.1 123.5 148.2 123.4 148.4C122.7 149.7 124.8 152.3 128.2 154.3C127.8 154 127.4 153.8 127 153.6L127 153.5C125.4 152.8 123.9 152.3 122.7 152.2C121.8 152.2 121.1 152.3 120.9 152.8C120.8 152.8 120.8 152.8 120.8 152.9C120.8 152.9 120.8 152.9 120.8 152.9C120.1 154.1 122.3 156.7 125.7 158.6C129.1 160.6 132.4 161.2 133.1 160C133.8 158.8 131.6 156.2 128.2 154.3C131.6 156.2 134.9 156.8 135.7 155.5C136.4 154.2 134.3 151.6 130.9 149.7C134.3 151.6 137.6 152.2 138.3 151C139 149.8 136.8 147.3 133.4 145.3M133.7 97.7L68.2 97.7L68.2 133.7C68.2 136.8 68.7 139.7 69.5 142.6C70.6 142.1 71.7 141.7 72.7 141.5C73.5 141.4 74.3 141.3 75.1 141.5C75.9 141.6 76.8 142 77.4 143C78 144 77.8 145 77.6 145.7C77.6 145.8 77.5 145.8 77.5 145.8C77.6 145.8 77.6 145.9 77.6 145.9C77.7 145.9 77.7 145.9 77.7 145.9C78.5 146 79.4 146.4 80 147.4C80.6 148.4 80.4 149.4 80.2 150.2C80.2 150.2 80.2 150.3 80.1 150.3L80.2 150.3L80.2 150.3C80.2 150.3 80.2 150.3 80.3 150.3C81 150.5 82 150.9 82.6 151.9C83.2 152.8 83 153.9 82.7 154.6C82.5 155.3 82 156 81.5 156.6C80.9 157.3 80.3 157.9 79.5 158.5C85.3 163.4 92.8 166.4 101 166.4C109.1 166.4 116.6 163.5 122.3 158.5C121.5 157.9 120.8 157.3 120.3 156.6C119.7 156 119.3 155.3 119 154.6C118.7 153.9 118.6 152.8 119.1 151.9C119.7 150.9 120.7 150.5 121.5 150.3C121.5 150.3 121.5 150.3 121.6 150.3L121.6 150.3C121.6 150.3 121.6 150.2 121.5 150.2L121.5 150.2C121.3 149.4 121.2 148.4 121.7 147.4C122.3 146.4 123.2 146 124 145.9C124.1 145.9 124.1 145.8 124.2 145.8C124.2 145.8 124.2 145.8 124.2 145.7C123.9 145 123.7 144 124.3 143C124.9 142 125.9 141.6 126.6 141.5C127.4 141.3 128.2 141.4 129 141.5C130.1 141.7 131.3 142.1 132.5 142.7C133.3 139.8 133.7 136.8 133.7 133.7ZM101 101.8L107.1 107.9L101 112.3L95 107.9ZM84 105C80.7 102.9 76.3 105.2 76.3 109.1L76.3 120L76.3 129.2L76.3 134C76.3 136.5 78.3 138.6 80.8 138.6C82.9 138.6 84.7 137 85.1 135L99.5 144.4L96.9 152.5L101 161.2L105 152.5L102.5 144.4L116.8 135C117.3 137 119 138.6 121.2 138.6C123.6 138.6 125.6 136.5 125.6 134L125.6 129.2L125.6 120L125.6 109.1C125.6 105.2 121.2 102.9 118 105L101 116.2ZM101 153.6C101.6 153.6 102.1 153.2 102.1 152.6C102.1 152 101.6 151.5 101 151.5C100.4 151.5 99.9 152 99.9 152.6C99.9 153.2 100.4 153.6 101 153.6M64.1 54.7L64.1 54.7L87.6 54.7C87.2 58.9 85.4 61 82.7 62C91.9 68.7 98.1 79.8 99.2 95.1L83.5 95.1C82.6 81.2 77.7 74 70.4 70.7C61.8 66.9 58.3 68 49.2 73.4C45.2 66.9 47.3 58.3 54.7 56.3C58.7 55.2 61.5 54.7 64.1 54.7M131.1 70.7C123.8 74 119 81.2 118.1 95.1L102.3 95.1C103.4 79.8 109.6 68.7 118.9 62C116.2 61 114.5 58.9 114 54.7L137.5 54.7C140.1 54.7 142.9 55.3 146.9 56.3C154.2 58.3 156.3 66.9 152.4 73.4C143.3 68 139.7 66.9 131.1 70.7"/></svg>',
    group: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="8" r="3"/><path d="M2.3 20a6.2 6.2 0 0112.4 0"/><circle cx="17" cy="8.7" r="2.4"/><path d="M15.3 13.3a5.3 5.3 0 015.9 5.1"/></svg>',
  };
  window.uiIcon = (name) => ICONS[name] || '';

  // ---------- Кнопки окна (свернуть/развернуть/закрыть) ----------
  // Общая логика для всех окон: разметка одинаковая везде —
  // <button id="wcMin">, <button id="wcMax"> (необязательна), <button id="wcClose">.
  function wireWindowControls() {
    if (!window.desktop) return;
    const min = document.getElementById('wcMin');
    const max = document.getElementById('wcMax');
    const close = document.getElementById('wcClose');
    if (min) { min.innerHTML = uiIcon('minimize'); min.title = 'Свернуть'; min.onclick = () => desktop.windowAction('minimize'); }
    if (close) { close.innerHTML = uiIcon('close'); close.title = 'Закрыть'; close.onclick = () => desktop.windowAction('close'); }
    if (max) {
      const paint = (maximized) => { max.innerHTML = uiIcon(maximized ? 'restore' : 'maximize'); max.title = maximized ? 'Восстановить' : 'Развернуть'; };
      paint(false);
      max.onclick = () => desktop.windowAction('maximize');
      if (desktop.onWindowState) desktop.onWindowState((state) => paint(state.maximized));
    }
  }
  window.uiWireWindowControls = wireWindowControls;
  wireWindowControls(); // ui-kit.js подключается в конце <body>, разметка кнопок уже в DOM

  // ---------- Тема ----------
  async function applyTheme() {
    if (!window.desktop) return;
    try {
      const s = await window.desktop.getSettings();
      document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
    } catch { /* игнор */ }
  }
  if (window.desktop) {
    applyTheme();
    if (window.desktop.onSettingsChanged) window.desktop.onSettingsChanged(applyTheme);
  }
  window.uiApplyTheme = applyTheme;

  // ---------- Модальные окна ----------
  function modal({ title, message, buttons }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ui-modal-overlay';
      const box = document.createElement('div');
      box.className = 'ui-modal-box';
      const titleEl = document.createElement('div');
      titleEl.className = 'ui-modal-title';
      titleEl.innerHTML = title;
      const msgEl = document.createElement('div');
      msgEl.className = 'ui-modal-msg';
      msgEl.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'ui-modal-actions';
      buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.className = b.className || 'ui-btn-ghost';
        btn.textContent = b.label;
        btn.onclick = () => { overlay.remove(); resolve(b.value); };
        actions.appendChild(btn);
      });
      box.appendChild(titleEl); box.appendChild(msgEl); box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      buttons.length && actions.lastChild.focus();
    });
  }

  window.uiAlert = (message, title = 'Сообщение') =>
    modal({ title: `${uiIcon('warn')} ${title}`, message, buttons: [{ label: 'ОК', value: true, className: 'ui-btn-primary' }] });

  // Диалог "потеряна связь с сервером" — визуально тот же modal(), что и uiConfirm/uiAlert, но
  // не через него напрямую: нужно уметь программно СКРЫТЬ диалог, если соединение восстановится
  // само (см. connectWs в каждом окне), а modal() отдаёт наружу только Promise без такой ручки.
  // Один диалог на окно (каждое окно — свой рендерер, свой WS) — если открыто несколько окон и
  // сервер лёг, у каждого появится свой, это ожидаемо, не дублирование одного и того же окна.
  let connectionLostOverlay = null;
  window.showConnectionLostModal = (onRetry) => {
    if (connectionLostOverlay || window.appShuttingDown) return; // уже показан в этом окне / выключаемся
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ui-modal-box';
    box.innerHTML = `
      <div class="ui-modal-title">${uiIcon('warn')} Соединение с сервером потеряно</div>
      <div class="ui-modal-msg">Проверьте подключение к сети. Можно попробовать ещё раз, выйти из аккаунта или закрыть приложение.</div>
      <div class="ui-modal-actions stacked">
        <button class="ui-btn-primary" id="uiClRetry">Повторить</button>
        <button class="ui-btn-ghost" id="uiClLogout">Выйти из аккаунта</button>
        <button class="ui-btn-ghost" id="uiClExit">Закрыть приложение</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    connectionLostOverlay = overlay;
    // Выход из аккаунта возвращает на экран входа, а он тут единственный способ выбраться из
    // тупика: если адрес сервера задан неверно, приложение бесконечно переподключается, и попасть
    // туда, где адрес можно исправить (Ctrl+S на экране входа), иначе не выйдет — перезапуск не
    // поможет, клиент снова войдёт по сохранённому токену и снова упрётся в тот же адрес.
    // Обращения к серверу выход не требует: токен просто стирается на этой машине (см. logout
    // в main.js), поэтому кнопка работает и при полностью недоступном сервере.
    box.querySelector('#uiClLogout').onclick = () => window.desktop.logout();
    box.querySelector('#uiClExit').onclick = () => window.desktop.windowAction('quit');
    box.querySelector('#uiClRetry').onclick = () => { window.hideConnectionLostModal(); onRetry(); };
  };
  window.hideConnectionLostModal = () => {
    if (!connectionLostOverlay) return;
    connectionLostOverlay.remove();
    connectionLostOverlay = null;
  };

  // Windows завершает сеанс (выключение/перезагрузка), главный процесс вот-вот снесёт окна — см.
  // beginShutdown в main.js. Общий флаг на окно: connectWs в roster/chat/broadcast перестаёт
  // переподключаться, а диалог о потере связи больше не всплывает. Без этого сеть, отваливающаяся
  // на выключении раньше нас, гарантированно роняла каждое окно в цикл реконнекта и показывала
  // модалку прямо поверх экрана выключения — лишняя работа ровно тогда, когда её меньше всего надо.
  window.appShuttingDown = false;
  if (window.desktop && window.desktop.onShuttingDown) {
    window.desktop.onShuttingDown(() => {
      window.appShuttingDown = true;
      window.hideConnectionLostModal();
    });
  }

  // Короткое ненавязчивое уведомление ("Файл скачан", "Скопировано в буфер обмена") — в отличие
  // от uiAlert, ничего не блокирует и само пропадает через пару секунд.
  window.uiToast = (message, opts = {}) => {
    const { icon = 'check', error = false, duration = 2200, bottomOffset } = opts;
    let container = document.getElementById('uiToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'uiToastContainer';
      document.body.appendChild(container);
    }
    // Если на странице есть строка ввода снизу (composer в чате) — тост должен появляться НАД
    // ней, а не поверх/внутри неё. Страница сама подсказывает отступ через bottomOffset (обычно —
    // реальная высота composer на этот момент, он может расти с многострочным текстом).
    if (bottomOffset != null) container.style.bottom = bottomOffset + 'px';
    const toast = document.createElement('div');
    toast.className = 'ui-toast' + (error ? ' ui-toast-error' : '');
    toast.innerHTML = `${uiIcon(error ? 'warn' : icon)}<span>${message}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 200);
    }, duration);
  };

  window.uiConfirm = (message, opts = {}) => {
    const { title = 'Подтверждение', okText = 'Да', cancelText = 'Отмена', danger = false } = opts;
    return modal({
      title, message,
      buttons: [
        { label: cancelText, value: false, className: 'ui-btn-ghost' },
        { label: okText, value: true, className: danger ? 'ui-btn-danger' : 'ui-btn-primary' },
      ],
    });
  };

  // Диалог с текстовым полем (замена window.prompt) — используется, например, для переименования
  // отдела прямо в теме клиента, а не системным всплывающим окном браузера.
  window.uiPrompt = (message, defaultValue = '', opts = {}) => {
    const { title = 'Введите значение', okText = 'ОК', cancelText = 'Отмена' } = opts;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ui-modal-overlay';
      const box = document.createElement('div');
      box.className = 'ui-modal-box';
      box.innerHTML = `
        <div class="ui-modal-title">${title}</div>
        <div class="ui-modal-msg">${message}</div>
        <input id="uiPromptInput" style="width:100%; padding:9px 11px; margin-bottom:14px; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px;">
        <div class="ui-modal-actions">
          <button class="ui-btn-ghost" id="uiPromptCancel">${cancelText}</button>
          <button class="ui-btn-primary" id="uiPromptOk">${okText}</button>
        </div>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const input = box.querySelector('#uiPromptInput');
      input.value = defaultValue;
      input.focus();
      input.select();
      const close = (val) => { overlay.remove(); resolve(val); };
      box.querySelector('#uiPromptCancel').onclick = () => close(null);
      box.querySelector('#uiPromptOk').onclick = () => close(input.value.trim() || null);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim() || null); if (e.key === 'Escape') close(null); });
    });
  };

  // Системный alert() перекрываем на themed-версию — не блокирует поток выполнения (это ок,
  // все текущие вызовы alert(...) в проекте — последняя строка в catch-блоках).
  window.alert = (msg) => { window.uiAlert(String(msg)); };

  // ---------- Эмодзи в тексте сообщений — картинками, а не системным шрифтом ----------
  // На разных Windows один и тот же emoji выглядит по-разному, а на Windows 7 (нет системного
  // цветного эмодзи-шрифта — Segoe UI Emoji появился только в 8.1) большинство эмодзи вообще
  // рисуются чёрно-белыми "текстовыми" глифами. Подключаем свой набор картинок (twemoji, тот же,
  // что раньше использовал Twitter — см. twemoji.min.js + emoji/*.png) — тогда эмодзи выглядят
  // одинаково у всех, независимо от версии Windows и установленных шрифтов. Используется в
  // chat.html/broadcast.html через window.emojiHtml(text) — оборачивает найденные emoji-последова-
  // тельности в <img class="twemoji" src="emoji/<codepoint>.png">, остальной текст не трогает.
  window.emojiHtml = (html) => {
    if (!window.twemoji) return html; // twemoji.min.js не подключён на этой странице — не трогаем текст
    // ВАЖНО: без явного callback twemoji.parse сам собирает src как base + size + '/' + icon + ext,
    // а size по умолчанию — "72x72" (даже если its не задавать) — то есть он пытался бы грузить
    // emoji/72x72/1f600.png, которого нет: у нас все файлы плоско лежат прямо в emoji/1f600.png.
    // Из-за этого КАЖДАЯ картинка 404-илась и вместо неё сразу срабатывал текстовый fallback (см.
    // ниже) — эмодзи молча продолжали рисоваться обычным текстом, а вся возня с размерами .twemoji
    // была бы просто без эффекта. Задаём свой callback, который строит путь без лишней папки.
    return window.twemoji.parse(html, {
      callback: (icon, options) => options.base + icon + options.ext,
      base: 'emoji/',
      ext: '.png',
      className: 'twemoji',
    });
  };
  // У двух-трёх редких emoji (напр. ❤️, ✌️) twemoji.js версии 14 определяет имя файла чуть иначе,
  // чем формат самого набора картинок (лишняя/недостающая приставка "-fe0f") — вместо того чтобы
  // подгонять их вручную (список может со временем меняться), просто подстраховываемся: если
  // картинка не загрузилась, показываем как обычный текстовый символ вместо сломанной иконки.
  // 'error' у <img> не всплывает — слушаем на фазе перехвата (capture), одним обработчиком на всё окно.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.classList && img.classList.contains('twemoji')) {
      img.outerHTML = img.alt;
    }
  }, true);

  // ---------- Отправка ошибок клиента на сервер ----------
  // token/serverUrl объявлены отдельным <script> на каждой странице (roster.html/chat.html/
  // broadcast.html) ПОСЛЕ подключения этого файла — как const верхнего уровня они не становятся
  // свойствами window, поэтому сюда их передают явно, а не читают напрямую. Вызывается один раз на
  // странице, сразу как только token/serverUrl уже объявлены (см. вызовы в конце каждого файла).
  // Цель — чтобы ошибку на чьём-то рабочем месте можно было разобрать по логам НА СЕРВЕРЕ (см.
  // POST /api/client-log в server.js), а не просить сотрудника прислать скриншот или лезть к нему
  // на ПК за локальным логом.
  window.installErrorReporting = (serverUrl, token, source) => {
    function report(kind, message, extra) {
      if (!serverUrl || !token) return;
      fetch(serverUrl + '/api/client-log', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind, source,
          message: String(message == null ? 'Error' : message).slice(0, 2000),
          extra,
          hostname: window.desktop ? window.desktop.hostname : undefined,
        }),
      }).catch(() => {}); // сервер недоступен — теряем эту запись, не ретраим бесконечно ради лога об ошибке
    }
    window.addEventListener('error', (e) => {
      report('window-error', e.message, { filename: e.filename, lineno: e.lineno, stack: e.error && e.error.stack });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      report('unhandled-rejection', reason && reason.message ? reason.message : String(reason), { stack: reason && reason.stack });
    });
  };
})();
