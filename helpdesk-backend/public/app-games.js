// ====== Игры ======
//
// Раздел «Игры» — передохнуть пять минут, не уходя из «Центра». Всё живёт в
// браузере: сервер про игры не знает, в базу ничего не пишется, сеть не нужна.
// Рекорды хранятся как оформление (theme.js): в localStorage этого браузера,
// отдельно для каждого логина — за одним компьютером работают сменами.
//
// Правила игр (функции games…Step/Move/Open/Field) отделены от отрисовки и к
// странице не обращаются: их проверяет test/games.test.js, исполняя этот файл
// как есть. Поэтому на верхнем уровне файла нет ничего, кроме объявлений.
//
// Цвета — только классами и переменными темы (styles.css): поле перекрашивается
// вместе с темой и акцентом, и сторож themes.test.js остаётся доволен.

// ---- Общее -------------------------------------------------------------------

/** Перемешать копию массива (Фишер — Йетс). rnd — подменяется в тестах. */
function gamesShuffle(arr, rnd) {
  const random = rnd || Math.random;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** «1 ход», «3 хода», «25 ходов». */
function gamesPlural(n, forms) {
  const d = n % 10, h = n % 100;
  return forms[d === 1 && h !== 11 ? 0 : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 1 : 2];
}
const gamesMoves = (n) => `${n} ${gamesPlural(n, ["ход", "хода", "ходов"])}`;

/** Секунды как «1:05». */
function gamesTime(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Соседи клетки на поле w×h (до восьми). */
function gamesNeighbors(w, h, idx) {
  const x = idx % w, y = Math.floor(idx / w), out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
    }
  }
  return out;
}

// ---- Змейка: правила -----------------------------------------------------------
// Поле — клетки по номерам (y * w + x). body — от головы к хвосту.

const GAMES_SNAKE_SIZE = 18;
const GAMES_DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function gamesSnakeFood(s, rnd) {
  const taken = new Set(s.body);
  const free = [];
  for (let i = 0; i < s.w * s.h; i++) if (!taken.has(i)) free.push(i);
  s.food = free.length ? free[Math.floor((rnd || Math.random)() * free.length)] : -1;
}

function gamesSnakeNew(w, h, rnd) {
  const head = Math.floor(h / 2) * w + Math.floor(w / 2);
  const s = { w, h, body: [head, head - 1, head - 2], dir: "right", queue: [], food: -1, score: 0, over: false, won: false };
  gamesSnakeFood(s, rnd);
  return s;
}

// Повороты копятся в очереди (до двух): «вверх и сразу влево» между двумя шагами
// должны сработать оба, иначе змейка на скорости не слушается. Разворот на месте
// отбрасывается — сверяем с последним ЗАПРОШЕННЫМ направлением, а не с текущим:
// иначе «вверх, вниз» за один шаг развернули бы змейку в саму себя.
function gamesSnakeTurn(s, dir) {
  const last = s.queue.length ? s.queue[s.queue.length - 1] : s.dir;
  const [ax, ay] = GAMES_DIRS[last], [bx, by] = GAMES_DIRS[dir];
  if (last === dir || (ax + bx === 0 && ay + by === 0) || s.queue.length >= 2) return false;
  s.queue.push(dir);
  return true;
}

function gamesSnakeStep(s, rnd) {
  if (s.over) return s;
  if (s.queue.length) s.dir = s.queue.shift();
  const [dx, dy] = GAMES_DIRS[s.dir];
  const x = (s.body[0] % s.w) + dx, y = Math.floor(s.body[0] / s.w) + dy;
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) { s.over = true; return s; }
  const next = y * s.w + x;
  // На клетку хвоста зайти можно: в этот же шаг хвост с неё уходит (еда на теле не лежит).
  const hit = s.body.indexOf(next);
  if (hit !== -1 && hit !== s.body.length - 1) { s.over = true; return s; }
  s.body.unshift(next);
  if (next === s.food) {
    s.score++;
    gamesSnakeFood(s, rnd);
    if (s.food === -1) { s.over = true; s.won = true; }   // поле заполнено целиком
  } else {
    s.body.pop();
  }
  return s;
}

// ---- Пятнашки: правила ----------------------------------------------------------
// 16 чисел по клеткам слева направо, сверху вниз; 0 — пустая клетка.

function gamesFifteenSolved(t) {
  return t.every((v, i) => v === (i + 1) % t.length);
}

/** Сдвинуть к пустой клетке фишку idx и все между ними (тот же ряд или столбец). → сколько фишек сдвинулось. */
function gamesFifteenMove(t, idx) {
  const blank = t.indexOf(0);
  if (!Number.isInteger(idx) || idx < 0 || idx >= 16 || idx === blank) return 0;
  const sameRow = (blank >> 2) === (idx >> 2), sameCol = (blank & 3) === (idx & 3);
  if (!sameRow && !sameCol) return 0;
  const step = sameRow ? (idx < blank ? -1 : 1) : (idx < blank ? -4 : 4);
  let n = 0;
  for (let p = blank; p !== idx; p += step) { t[p] = t[p + step]; n++; }
  t[idx] = 0;
  return n;
}

// Перемешиваем ходами от собранного поля, а не случайной перестановкой: половина
// перестановок пятнашек не собирается вовсе, а так раскладка решаема по построению.
function gamesFifteenShuffle(rnd) {
  const random = rnd || Math.random;
  const t = Array.from({ length: 16 }, (_, i) => (i + 1) % 16);
  let prev = -1;
  for (let i = 0; i < 300 || (gamesFifteenSolved(t) && i < 1000); i++) {
    const blank = t.indexOf(0);
    const opts = [blank - 4, blank + 4, (blank & 3) > 0 ? blank - 1 : -1, (blank & 3) < 3 ? blank + 1 : -1]
      .filter((p) => p >= 0 && p < 16 && p !== prev);   // сразу назад не ходим — такой ход ничего не мешает
    prev = blank;
    gamesFifteenMove(t, opts[Math.floor(random() * opts.length)]);
  }
  return t;
}

// ---- Пары: правила ---------------------------------------------------------------

// Значки карточек — из общего набора ICON_PATHS (app.js); тест сверяет, что все имена там есть.
const GAMES_PAIR_ICONS = ["seal", "phone", "bell", "mail", "spark", "calendar", "key", "monitor", "briefcase", "shield",
  "moon", "sun", "palette", "clock", "link", "database", "users", "paperclip", "folder", "search"];

/** Колода: pairs случайных значков, каждый дважды, вперемешку. */
function gamesPairsDeck(icons, pairs, rnd) {
  const chosen = gamesShuffle(icons, rnd).slice(0, pairs);
  return gamesShuffle([...chosen, ...chosen], rnd);
}

// ---- Битые секторы: правила --------------------------------------------------------
// «Диск» — поле секторов, часть из них битые. Число в открытом секторе — сколько
// битых рядом. Надо открыть все исправные, не задев ни одного битого.

const GAMES_SECTOR_SIZES = [
  { id: "s", label: "Дискета", w: 8, h: 8, bad: 9 },
  { id: "m", label: "Винчестер", w: 12, h: 12, bad: 24 },
  { id: "l", label: "Массив", w: 20, h: 14, bad: 50 },
];

/**
 * Разметка диска: -1 — битый сектор, иначе число битых соседей. Строится ПОСЛЕ
 * первого щелчка: сектор safe и его соседи исправны — первый ход не бывает
 * проигрышным и сразу открывает кусок поля, а не одинокую цифру.
 */
function gamesSectorsField(w, h, bad, safe, rnd) {
  const keep = new Set([safe, ...gamesNeighbors(w, h, safe)]);
  let pool = [];
  for (let i = 0; i < w * h; i++) if (!keep.has(i)) pool.push(i);
  // Битых больше, чем свободного места вокруг, — бережём только сам сектор.
  if (pool.length < bad) { pool = []; for (let i = 0; i < w * h; i++) if (i !== safe) pool.push(i); }
  const mines = new Set(gamesShuffle(pool, rnd).slice(0, bad));
  return Array.from({ length: w * h }, (_, i) => (mines.has(i) ? -1 : gamesNeighbors(w, h, i).filter((n) => mines.has(n)).length));
}

/**
 * Открыть сектор; от «нуля» открытие растекается по соседям. Помеченные флажком
 * при растекании не трогаются. Без рекурсии: на большом пустом поле она упёрлась
 * бы в глубину стека. → номера открытых этим ходом секторов.
 */
function gamesSectorsOpen(field, opened, w, h, idx, flags) {
  const out = [];
  const stack = [idx];
  while (stack.length) {
    const i = stack.pop();
    if (opened[i] || (flags && flags[i] && i !== idx)) continue;
    opened[i] = true;
    out.push(i);
    if (field[i] === 0) for (const n of gamesNeighbors(w, h, i)) if (!opened[n]) stack.push(n);
  }
  return out;
}

// ---- Список игр и рекорды ------------------------------------------------------------

const GAMES = [
  { id: "snake", label: "Змейка", icon: "snake", tone: "jade",
    hint: "Собирайте точки и растите. Стены и собственный хвост — конец игры.",
    record: (r) => (r.snake ? `Рекорд: ${r.snake}` : "") },
  { id: "pairs", label: "Пары", icon: "cards", tone: "violet",
    hint: "Найдите все пары одинаковых значков за наименьшее число ходов.",
    record: (r) => (r.pairs ? `Лучший результат: ${gamesMoves(r.pairs)}` : "") },
  { id: "fifteen", label: "Пятнашки", icon: "grid", tone: "blue",
    hint: "Расставьте фишки по порядку от 1 до 15.",
    record: (r) => (r.fifteen ? `Лучший результат: ${gamesMoves(r.fifteen)}` : "") },
  { id: "sectors", label: "Битые секторы", icon: "database", tone: "orange",
    hint: "Проверьте диск: откройте все исправные секторы, не задев битые.",
    record: (r) => GAMES_SECTOR_SIZES.filter((z) => r[`sectors-${z.id}`])
      .map((z) => `${z.label}: ${gamesTime(r[`sectors-${z.id}`])}`).join(" · ") },
];

function gamesViewExists(view) {
  return view === "games" || GAMES.some((g) => `games:${g.id}` === view);
}

const GAMES_RECORDS_KEY = () => `adm.games:${String((state.user && state.user.ad_login) || "").toLowerCase()}`;

function gamesRecords() {
  try {
    const r = JSON.parse(localStorage.getItem(GAMES_RECORDS_KEY()));
    return r && typeof r === "object" ? r : {};
  } catch { return {}; }
}

function gamesStore(key, value) {
  const r = gamesRecords();
  r[key] = value;
  try { localStorage.setItem(GAMES_RECORDS_KEY(), JSON.stringify(r)); } catch { /* хранилище недоступно — рекорд проживёт до ухода со страницы */ }
}

/**
 * Запомнить результат, если он лучше прежнего. less — «меньше — лучше» (ходы,
 * секунды). → true, только если побит уже существовавший рекорд: первый результат
 * записывается молча, поздравлять с «рекордом» после первой же партии незачем.
 */
function gamesRecord(key, value, less) {
  if (!(value > 0)) return false;
  const old = Number(gamesRecords()[key]);
  const had = Number.isFinite(old) && old > 0;
  if (had && (less ? value >= old : value <= old)) return false;
  gamesStore(key, value);
  return had;
}

// ---- Оснастка экранов ------------------------------------------------------------------

/**
 * Клавиши игры. Слушатель висит на документе (у поля нет фокуса), а живёт, пока
 * поле на странице: экраны перерисовываются целиком, и узел, которого в документе
 * уже нет, — знак, что с игры ушли. Так не нужно отписываться в каждом переходе.
 */
function gamesKeys(anchor, handler) {
  const onKey = (e) => {
    if (!anchor.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;              // сочетания браузера не трогаем
    if (document.querySelector(".ui-dialog-back")) return;       // открыто окно подтверждения
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    handler(e);
  };
  document.addEventListener("keydown", onKey);
}

// По e.code, а не e.key: W A S D должны работать и в русской раскладке (Ц Ф Ы В).
const GAMES_KEY_DIRS = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right",
};

/** Секундомер партии: показывает время в out и сам останавливается, когда игра ушла со страницы. */
function gamesClock(anchor, out) {
  let from = 0, frozen = 0, handle = null;
  const clock = {
    seconds: () => (from ? Math.floor((Date.now() - from) / 1000) : frozen),
    running: () => Boolean(from),
    start() {
      if (from) return;
      from = Date.now();
      handle = setInterval(() => { if (!anchor.isConnected) clock.stop(); else out.textContent = gamesTime(clock.seconds()); }, 500);
    },
    stop() {
      frozen = clock.seconds();
      from = 0;
      if (handle) { clearInterval(handle); handle = null; }
      out.textContent = gamesTime(frozen);
      return frozen;
    },
    reset() { clock.stop(); frozen = 0; out.textContent = gamesTime(0); },
  };
  return clock;
}

const gamesStat = (label, id, value) => `<div class="gm-stat"><span>${label}</span><b id="${id}">${value}</b></div>`;
const gamesNewBtn = () => `<button type="button" class="btn btn-ghost" id="gmNew">${icon("refresh", 14)} Заново</button>`;

// ---- Экраны ------------------------------------------------------------------------------

function renderGames(main, sub) {
  clearViewPoll();
  const game = GAMES.find((g) => g.id === sub);
  if (!game) return renderGamesHub(main);
  main.innerHTML = `
    <div class="topbar"><div class="topbar-title-row">
      <button class="icon-btn" id="gmBack" title="Все игры" aria-label="Все игры">${icon("chevron", 18)}</button>
      <div class="topbar-title">${esc(game.label)}</div>
    </div></div>
    <div class="page"><div class="gm-wrap" id="gmWrap"></div></div>`;
  main.querySelector("#gmBack").onclick = () => setView("games");
  GAMES_SCREENS[game.id](main.querySelector("#gmWrap"));
}

function renderGamesHub(main) {
  const rec = gamesRecords();
  main.innerHTML = `
    <div class="topbar"><div class="topbar-title">Игры</div></div>
    <div class="page">
      <div class="gm-hub">${GAMES.map((g) => `
        <button type="button" class="gm-tile" data-game="${g.id}">
          <span class="gm-tile-icon gm-tone-${g.tone}">${icon(g.icon, 24)}</span>
          <span class="gm-tile-name">${esc(g.label)}</span>
          <span class="gm-tile-hint">${esc(g.hint)}</span>
          <span class="gm-tile-rec">${esc(g.record(rec) || "Ещё не играли")}</span>
        </button>`).join("")}</div>
      <div class="as-note gm-foot">Рекорды хранятся в этом браузере, у каждого сотрудника свои. На сервер игры ничего не передают.</div>
    </div>`;
  main.querySelectorAll(".gm-tile").forEach((t) => { t.onclick = () => setView(`games:${t.dataset.game}`); });
}

// ---- Змейка ---------------------------------------------------------------------------------

function renderGameSnake(wrap) {
  const W = GAMES_SNAKE_SIZE, H = GAMES_SNAKE_SIZE;
  wrap.innerHTML = `
    <div class="gm-bar">
      ${gamesStat("Счёт", "gmScore", 0)}
      ${gamesStat("Рекорд", "gmBest", gamesRecords().snake || 0)}
      ${gamesNewBtn()}
    </div>
    <div class="gm-board gm-snake" id="gmBoard" style="grid-template-columns:repeat(${W},1fr);grid-template-rows:repeat(${H},1fr)">
      ${"<i></i>".repeat(W * H)}
      <div class="gm-overlay" id="gmOver"><span></span></div>
    </div>
    <div class="gm-help">Стрелки или W A S D — поворот, пробел — пауза. Чем длиннее змейка, тем она быстрее.</div>`;
  const board = wrap.querySelector("#gmBoard");
  const cells = [...board.querySelectorAll("i")];
  const over = wrap.querySelector("#gmOver");
  const scoreEl = wrap.querySelector("#gmScore");
  const bestEl = wrap.querySelector("#gmBest");
  let s, mode, timer = null;   // mode: ready — ждём первую стрелку, run, pause, over

  const say = (text) => { over.firstElementChild.textContent = text; over.hidden = !text; };
  const paint = () => {
    const body = new Set(s.body);
    cells.forEach((c, i) => { c.className = i === s.body[0] ? "h" : body.has(i) ? "s" : i === s.food ? "f" : ""; });
    scoreEl.textContent = s.score;
  };
  const tick = () => {
    timer = null;
    if (!board.isConnected || mode !== "run") return;
    // Переключились на другую вкладку — пауза: вернувшись, человек не должен найти змейку в стене.
    if (document.hidden) { mode = "pause"; say("Пауза. Пробел — продолжить"); return; }
    gamesSnakeStep(s);
    paint();
    if (s.over) {
      mode = "over";
      const beaten = gamesRecord("snake", s.score, false);
      bestEl.textContent = gamesRecords().snake || 0;
      say(`${s.won ? "Поле заполнено — победа!" : "Игра окончена."} Счёт: ${s.score}${beaten ? " — новый рекорд!" : ""}\nEnter — ещё раз`);
      return;
    }
    timer = setTimeout(tick, Math.max(70, 150 - s.score * 3));
  };
  const run = () => { mode = "run"; say(""); if (!timer) timer = setTimeout(tick, 150); };
  const fresh = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    s = gamesSnakeNew(W, H);
    mode = "ready";
    paint();
    say("Нажмите стрелку, чтобы начать");
  };

  // blur: иначе кнопка остаётся в фокусе, и пробел (пауза) нажимал бы её — партия начиналась бы заново.
  wrap.querySelector("#gmNew").onclick = (e) => { e.currentTarget.blur(); fresh(); };
  gamesKeys(board, (e) => {
    const dir = GAMES_KEY_DIRS[e.code];
    if (dir) {
      e.preventDefault();                      // стрелки не должны прокручивать страницу
      if (mode === "over") return;
      gamesSnakeTurn(s, dir);
      if (mode !== "run") run();
    } else if (e.code === "Space") {
      e.preventDefault();
      if (mode === "run") { mode = "pause"; say("Пауза. Пробел — продолжить"); }
      else if (mode === "pause") run();
    } else if (e.code === "Enter" && mode === "over") {
      e.preventDefault();
      fresh();
    }
  });
  fresh();
}

// ---- Пары -------------------------------------------------------------------------------------

function renderGamePairs(wrap) {
  const PAIRS = 10;
  wrap.innerHTML = `
    <div class="gm-bar">
      ${gamesStat("Ходы", "gmMoves", 0)}
      ${gamesStat("Время", "gmTime", "0:00")}
      ${gamesStat("Лучший", "gmBest", gamesRecords().pairs || "—")}
      ${gamesNewBtn()}
    </div>
    <div class="gm-status" id="gmStatus"></div>
    <div class="gm-board gm-pairs" id="gmBoard"></div>
    <div class="gm-help">Открывайте по две карточки. Совпали — остаются открытыми, нет — переворачиваются обратно. Ход — одна пара карточек.</div>`;
  const board = wrap.querySelector("#gmBoard");
  const status = wrap.querySelector("#gmStatus");
  const movesEl = wrap.querySelector("#gmMoves");
  const clock = gamesClock(board, wrap.querySelector("#gmTime"));
  let deck, open, found, moves, lock, round = 0;

  const flip = (btn) => {
    if (lock || btn.classList.contains("open")) return;
    clock.start();
    btn.classList.add("open");
    open.push(btn);
    if (open.length < 2) return;
    movesEl.textContent = ++moves;
    const [a, b] = open;
    open = [];
    if (deck[a.dataset.i] === deck[b.dataset.i]) {
      a.classList.add("done"); b.classList.add("done");
      if (++found < PAIRS) return;
      const sec = clock.stop();
      const beaten = gamesRecord("pairs", moves, true);
      wrap.querySelector("#gmBest").textContent = gamesRecords().pairs || "—";
      status.className = "gm-status win";
      status.textContent = `Все пары найдены: ${gamesMoves(moves)}, ${gamesTime(sec)}${beaten ? " — новый рекорд!" : ""}`;
      return;
    }
    // Даём рассмотреть вторую карточку и только потом закрываем обе. round — номер партии:
    // если за это время нажали «Заново», отложенное закрытие к новой раскладке не относится.
    lock = true;
    const mine = round;
    setTimeout(() => {
      if (mine !== round) return;
      a.classList.remove("open"); b.classList.remove("open");
      lock = false;
    }, 750);
  };
  const fresh = () => {
    round++;
    deck = gamesPairsDeck(GAMES_PAIR_ICONS, PAIRS);
    open = []; found = 0; moves = 0; lock = false;
    clock.reset();
    movesEl.textContent = 0;
    status.className = "gm-status";
    status.textContent = "";
    board.innerHTML = deck.map((name, i) => `
      <button type="button" class="gm-card" data-i="${i}" aria-label="Карточка ${i + 1}">
        <span class="gm-card-in"><span class="gm-card-back"></span><span class="gm-card-face">${icon(name, 30)}</span></span>
      </button>`).join("");
    board.querySelectorAll(".gm-card").forEach((c) => { c.onclick = () => flip(c); });
  };
  wrap.querySelector("#gmNew").onclick = fresh;
  fresh();
}

// ---- Пятнашки -----------------------------------------------------------------------------------

function renderGameFifteen(wrap) {
  wrap.innerHTML = `
    <div class="gm-bar">
      ${gamesStat("Ходы", "gmMoves", 0)}
      ${gamesStat("Время", "gmTime", "0:00")}
      ${gamesStat("Лучший", "gmBest", gamesRecords().fifteen || "—")}
      ${gamesNewBtn()}
    </div>
    <div class="gm-status" id="gmStatus"></div>
    <div class="gm-board gm-fifteen" id="gmBoard">
      ${Array.from({ length: 15 }, (_, i) => `<button type="button" class="gm-chip" data-v="${i + 1}"><span>${i + 1}</span></button>`).join("")}
    </div>
    <div class="gm-help">Щёлкните фишку в одном ряду или столбце с пустой клеткой — сдвинется она и все между ними. Стрелки тоже работают.</div>`;
  const board = wrap.querySelector("#gmBoard");
  const chips = [...board.querySelectorAll(".gm-chip")];
  const status = wrap.querySelector("#gmStatus");
  const movesEl = wrap.querySelector("#gmMoves");
  const clock = gamesClock(board, wrap.querySelector("#gmTime"));
  let t, moves, done;

  // Фишки стоят в одном углу и разъезжаются сдвигом (transform) — поэтому ход анимируется,
  // а не «перескакивает», как было бы при перестановке узлов в сетке.
  const place = () => chips.forEach((ch) => {
    const v = Number(ch.dataset.v), p = t.indexOf(v);
    ch.style.transform = `translate(${(p & 3) * 100}%, ${(p >> 2) * 100}%)`;
    ch.classList.toggle("ok", p === v - 1);
  });
  const go = (idx) => {
    if (done || !gamesFifteenMove(t, idx)) return;
    clock.start();
    movesEl.textContent = ++moves;
    place();
    if (!gamesFifteenSolved(t)) return;
    done = true;
    const sec = clock.stop();
    const beaten = gamesRecord("fifteen", moves, true);
    wrap.querySelector("#gmBest").textContent = gamesRecords().fifteen || "—";
    status.className = "gm-status win";
    status.textContent = `Собрано: ${gamesMoves(moves)}, ${gamesTime(sec)}${beaten ? " — новый рекорд!" : ""}`;
  };
  const fresh = () => {
    t = gamesFifteenShuffle();
    moves = 0; done = false;
    clock.reset();
    movesEl.textContent = 0;
    status.className = "gm-status";
    status.textContent = "";
    place();
  };

  chips.forEach((ch) => { ch.onclick = () => go(t.indexOf(Number(ch.dataset.v))); });
  wrap.querySelector("#gmNew").onclick = (e) => { e.currentTarget.blur(); fresh(); };
  gamesKeys(board, (e) => {
    const dir = GAMES_KEY_DIRS[e.code];
    if (!dir) return;
    e.preventDefault();
    // Стрелка — куда едет фишка: «вверх» двигает ту, что под пустой клеткой.
    const blank = t.indexOf(0);
    const idx = dir === "up" ? blank + 4 : dir === "down" ? blank - 4
      : dir === "left" ? ((blank & 3) < 3 ? blank + 1 : -1) : ((blank & 3) > 0 ? blank - 1 : -1);
    go(idx);
  });
  fresh();
}

// ---- Битые секторы ----------------------------------------------------------------------------------

function renderGameSectors(wrap) {
  const saved = gamesRecords().sectorsSize;
  let size = GAMES_SECTOR_SIZES.find((z) => z.id === saved) || GAMES_SECTOR_SIZES[0];
  wrap.innerHTML = `
    <div class="gm-seg" id="gmSize">${GAMES_SECTOR_SIZES.map((z) => `
      <button type="button" data-size="${z.id}" title="${z.w} × ${z.h}, битых секторов: ${z.bad}">${esc(z.label)}</button>`).join("")}</div>
    <div class="gm-bar">
      ${gamesStat("Осталось", "gmLeft", 0)}
      ${gamesStat("Время", "gmTime", "0:00")}
      ${gamesStat("Лучшее", "gmBest", "—")}
      ${gamesNewBtn()}
    </div>
    <div class="gm-status" id="gmStatus"></div>
    <div class="gm-board gm-sectors" id="gmBoard"></div>
    <div class="gm-help">Число — сколько битых секторов рядом. Правая кнопка мыши — пометить битый сектор флажком.
      Щелчок по числу, вокруг которого стоит столько же флажков, открывает остальных соседей. Первый ход всегда безопасен.</div>`;
  const board = wrap.querySelector("#gmBoard");
  const status = wrap.querySelector("#gmStatus");
  const leftEl = wrap.querySelector("#gmLeft");
  const bestEl = wrap.querySelector("#gmBest");
  const clock = gamesClock(board, wrap.querySelector("#gmTime"));
  let field, opened, flags, result, hit, cells;   // field появляется с первым щелчком; result: "" | "won" | "lost"

  const paint = () => {
    cells.forEach((c, i) => {
      // Битые показываем только в конце: при проигрыше — все, при победе они и так под флажками.
      const bad = field && field[i] === -1 && result === "lost";
      const key = opened[i] && !bad ? `o${field[i]}` : bad ? (i === hit ? "hit" : "bad") : flags[i] ? "flag" : "";
      if (c.dataset.s === key) return;         // перерисовываем только изменившиеся секторы
      c.dataset.s = key;
      c.className = "gm-sec" + (key[0] === "o" ? ` open n${field[i]}` : key ? ` ${key}` : "");
      c.innerHTML = key[0] === "o" ? (field[i] || "") : key === "flag" ? icon("flag", 14) : key ? icon("x", 14) : "";
    });
    leftEl.textContent = size.bad - flags.filter(Boolean).length;
  };
  const finish = (won) => {
    result = won ? "won" : "lost";
    const sec = clock.stop();
    const key = `sectors-${size.id}`;
    const beaten = won && gamesRecord(key, Math.max(1, sec), true);
    if (won) flags = flags.map((f, i) => f || field[i] === -1);   // победа: оставшиеся битые помечаются сами
    bestEl.textContent = gamesRecords()[key] ? gamesTime(gamesRecords()[key]) : "—";
    status.className = `gm-status ${won ? "win" : "lose"}`;
    status.textContent = won
      ? `Диск проверен за ${gamesTime(sec)}${beaten ? " — новый рекорд!" : ""}`
      : "Задет битый сектор — диск посыпался. Попробуйте ещё раз.";
  };
  const reveal = (i) => {
    gamesSectorsOpen(field, opened, size.w, size.h, i, flags);
    if (field[i] === -1 && !result) { hit = i; finish(false); }
  };
  const click = (i) => {
    if (result || flags[i]) return;
    if (!field) { field = gamesSectorsField(size.w, size.h, size.bad, i); clock.start(); }
    if (!opened[i]) reveal(i);
    else if (field[i] > 0) {
      const near = gamesNeighbors(size.w, size.h, i);
      if (near.filter((n) => flags[n]).length === field[i]) near.forEach((n) => { if (!opened[n] && !flags[n]) reveal(n); });
    }
    if (!result && opened.filter(Boolean).length === size.w * size.h - size.bad) finish(true);
    paint();
  };
  const fresh = () => {
    field = null; result = ""; hit = -1;
    opened = new Array(size.w * size.h).fill(false);
    flags = new Array(size.w * size.h).fill(false);
    clock.reset();
    status.className = "gm-status";
    status.textContent = "";
    const best = gamesRecords()[`sectors-${size.id}`];
    bestEl.textContent = best ? gamesTime(best) : "—";
    wrap.querySelectorAll("#gmSize button").forEach((b) => b.classList.toggle("active", b.dataset.size === size.id));
    board.style.gridTemplateColumns = `repeat(${size.w}, 30px)`;
    board.innerHTML = `<button type="button" class="gm-sec"></button>`.repeat(size.w * size.h);
    cells = [...board.children];
    cells.forEach((c, i) => {
      c.onclick = () => click(i);
      c.oncontextmenu = (e) => {
        e.preventDefault();
        if (result || opened[i]) return;
        flags[i] = !flags[i];
        paint();
      };
    });
    paint();
  };

  // Щелчок правой кнопкой в зазор между секторами не должен открывать меню браузера поверх поля.
  board.oncontextmenu = (e) => e.preventDefault();
  wrap.querySelectorAll("#gmSize button").forEach((b) => {
    b.onclick = () => {
      size = GAMES_SECTOR_SIZES.find((z) => z.id === b.dataset.size);
      gamesStore("sectorsSize", size.id);      // в следующий раз откроется тот же размер
      fresh();
    };
  });
  wrap.querySelector("#gmNew").onclick = fresh;
  fresh();
}

const GAMES_SCREENS = { snake: renderGameSnake, pairs: renderGamePairs, fifteen: renderGameFifteen, sectors: renderGameSectors };
