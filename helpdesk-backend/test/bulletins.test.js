'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ldap = require("./helpers/fakeLdap");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const table = require("./helpers/bulletinTable");
const B = require("../services/bulletins");
const { readXlsFirstSheet } = require("../services/xls");
const { readFirstSheet } = require("../services/xlsx");
const { readZip } = require("../services/zip");

// ============================================================================
//  Бюллетени: таблица из ЦСОД + шаблон Word → документ; группы и права
//
//  Таблица — выдуманная, устроена как выгрузка индексов производства (см.
//  helpers/bulletinTable.js). Шаблон — встроенная форма «350 Индексы
//  производства», та же, что получает отдел после установки.
// ============================================================================

const XLS = fs.readFileSync(path.join(__dirname, "fixtures", "bulletin-sample.xls"));
const TEMPLATE_350 = fs.readFileSync(path.join(__dirname, "..", "bulletins", "350.docx"));
const SETTINGS_350 = B.normalizeSettings({
  sign: "Индексы производства по видам экономической деятельности", fileName: "350_{ММ}_{ГГГГ}",
  valueCols: ["C", "D", "E"],
  rules: [{ kind: "раздел", codes: "@", sentenceCase: true }, { kind: "вид", codes: "##", sections: ["C"] }],
});

/** Текст документа: абзацы и ячейки таблиц, без разметки. */
function docText(docx) {
  const xml = readZip(docx).get("word/document.xml").toString("utf8");
  return xml.replace(/<w:br\/>/g, "\n").replace(/<\/w:p><\/w:tc>/g, "|").replace(/<\/w:(p|tc)>/g, "|").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const trimRow = (r) => { const x = (r || []).map(String); while (x.length && x[x.length - 1] === "") x.pop(); return x; };

// ---------------------------------------------------------------------------
//  Таблица
// ---------------------------------------------------------------------------

test(".xls читается так же, как та же таблица в .xlsx — включая длинный список строк книги", () => {
  const a = readXlsFirstSheet(XLS).map(trimRow);
  const b = readFirstSheet(table.xlsx()).map(trimRow);
  assert.strictEqual(a.length, b.length);
  assert.deepStrictEqual(a, b);
  assert.match(a[a.length - 1][0], /номер 150:/, "последняя строка — из продолжения списка строк");
});

test("не таблица и битый .xls — понятный отказ, а не падение", () => {
  assert.throws(() => B.readTable(Buffer.from("просто текст")), /не таблица Excel/);
  const cut = XLS.subarray(0, 4096);
  assert.throws(() => B.readTable(cut), /повреждён или обрезан/);
  assert.throws(() => B.readTable(Buffer.alloc(0)), /пустой/);
});

test("месяц и год — из заголовка; январь и декабрь склоняются правильно", () => {
  assert.deepStrictEqual(B.parsePeriod([["Индексы … за март 2031 года"]]), { month: 3, year: 2031 });
  assert.strictEqual(B.parsePeriod([["Индексы без периода"]]), null);
  const jan = B.periodData({ month: 1, year: 2027 }, "01.02.2027");
  assert.deepStrictEqual([jan.ПЕРИОД, jan.периоду, jan.пред_месяцу, jan.год_пред_месяца], ["ЯНВАРЬ", "январю", "декабрю", "2026"]);
  const dec = B.periodData({ month: 12, year: 2027 }, "");
  assert.deepStrictEqual([dec.Период, dec.месяцем, dec.пред_месяц], ["Январь-декабрь", "декабрём", "ноябрь"]);
});

test("маска кодов: # — цифра, @ — латинская буква, * — что угодно, список через запятую", () => {
  const ok = (mask, code) => B.maskToRegExp(mask).test(code);
  assert.ok(ok("##", "10") && !ok("##", "10.1") && !ok("##", "B"));
  assert.ok(ok("@", "C") && !ok("@", "CC") && !ok("@", "1"));
  assert.ok(ok("##.#", "10.1") && !ok("##.#", "10x1"), "точка в маске — точка, а не любой знак");
  assert.ok(ok("10, 11", "11") && !ok("10, 11", "12"));
  assert.ok(ok("10.*", "10.13") && !ok("10.*", "11.1"));
});

test("значения: запятая, знаки после неё, от порога — в разах, не число — как есть", () => {
  const s = { digits: 1, timesFrom: 200 };
  assert.strictEqual(B.fmtValue("103.9", s), "103,9");
  assert.strictEqual(B.fmtValue("98.25", s), "98,3");
  assert.strictEqual(B.fmtValue("199.99", s), "200,0", "ниже порога — процентами, даже если округлится до 200");
  assert.strictEqual(B.fmtValue("250.3", s), "в 2,5 р.");
  assert.strictEqual(B.fmtValue("1000", s), "в 10,0 р.");
  assert.strictEqual(B.fmtValue("1000", { digits: 1, timesFrom: 0 }), "1000,0", "порог 0 — не переводить");
  assert.strictEqual(B.fmtValue("…", s), "…");
  assert.strictEqual(B.fmtValue("", s), "…");
});

// ---------------------------------------------------------------------------
//  Документ
// ---------------------------------------------------------------------------

test("документ по форме 350: текст, шапка и строки — из таблицы и месяца", () => {
  for (const source of [table.xlsx(), XLS]) {
    const out = B.makeDocument({ table: source, template: TEMPLATE_350, settings: SETTINGS_350, date: "05.05.2031" });
    const text = docText(out.docx);
    assert.deepStrictEqual(out.period, { month: 3, year: 2031 });
    assert.match(text, /05\.05\.2031г\./);
    assert.match(text, /ЗА ЯНВАРЬ-МАРТ 2031 ГОДА/);
    assert.match(text, /за январь-март 2031 года по сравнению с соответствующим периодом 2030 года составил 102,3%, в марте 2031 года по сравнению с мартом 2030 года – 101,5%, по сравнению с предыдущим месяцем – 98,3%/);
    assert.match(text, /Март 2031 г\. в % к/);
    assert.match(text, /марту \n2030 г\./);
    assert.match(text, /февралю\n2031 г\./);
    // Разделы — обычными буквами; виды деятельности — только из раздела C.
    assert.match(text, /\|Добыча полезных ископаемых\|97,4\|101,1\|99,0\|/);
    assert.match(text, /\|Производство напитков\|в 2,5 р\.\|87,6\|121,0\|/);
    assert.match(text, /\|Водоснабжение; водоотведение, организация сбора и утилизации отходов\|102,0\|100,0\|в 10,0 р\.\|/);
    assert.doesNotMatch(text, /Добыча угля/, "двузначные коды вне раздела C не выводятся");
    assert.doesNotMatch(text, /Переработка и консервирование мяса/, "подгруппы с точкой не выводятся");
    assert.doesNotMatch(text, /[{}]/, "ни одной незаполненной метки");
    assert.strictEqual(out.rows, 7, "4 раздела + 3 вида деятельности раздела C");
  }
});

test("нет месяца в заголовке или нужной строки — отказ с причиной, а не дыра в документе", () => {
  assert.throws(
    () => B.makeDocument({ table: table.xlsx({ title: "Индексы производства по видам экономической деятельности" }), template: TEMPLATE_350, settings: SETTINGS_350, date: "01.01.2031" }),
    /не нашлись месяц и год/);
  assert.throws(
    () => B.makeDocument({ table: table.xlsx({ data: table.DATA.filter((r) => r[1] !== "102") }), template: TEMPLATE_350, settings: SETTINGS_350, date: "01.01.2031" }),
    /нет строки с кодом 102/);
  // Значений в форме меньше, чем использует шаблон ({3}) — метка неизвестна.
  assert.throws(
    () => B.makeDocument({ table: table.xlsx(), template: TEMPLATE_350, settings: { ...SETTINGS_350, valueCols: ["C", "D"] }, date: "01.01.2031" }),
    /неизвестная метка \{3\}/);
});

test("правила формы проверяются: столбцы, виды строк, маски, порог", () => {
  assert.throws(() => B.normalizeSettings({ valueCols: ["C", "1"], rules: [] }), /буква столбца/);
  assert.throws(() => B.normalizeSettings({ valueCols: ["C"], rules: [{ kind: "два слова", codes: "##" }] }), /одно слово/);
  assert.throws(() => B.normalizeSettings({ valueCols: ["C"], rules: [{ kind: "наименование", codes: "##" }] }), /служебной меткой/);
  assert.throws(() => B.normalizeSettings({ valueCols: ["C"], rules: [{ kind: "вид", codes: "" }] }), /не заданы коды/);
  assert.throws(() => B.normalizeSettings({ valueCols: ["C"], rules: [{ kind: "вид", codes: "##", sections: "C, 1" }] }), /латинские буквы/);
  assert.throws(() => B.normalizeSettings({ valueCols: ["C"], rules: [], digits: 7 }), /от 0 до 4/);
  const s = B.normalizeSettings({ valueCols: ["c"], rules: [{ kind: "вид", codes: "##", sections: "c, b" }] });
  assert.deepStrictEqual([s.valueCols, s.rules[0].sections, s.nameCol, s.timesFrom], [["C"], ["C", "B"], "A", 200]);
});

test("имя файла — по образцу формы, без запрещённых в Windows знаков", () => {
  assert.strictEqual(B.outputName({ name: "350", settings: SETTINGS_350 }, { month: 3, year: 2031 }), "350_03_2031.docx");
  assert.strictEqual(B.outputName({ name: "Цены: и/или", settings: { fileName: "{название} {месяц}" } }, { month: 1, year: 2031 }), "Цены_ и_или январь.docx");
});

// ---------------------------------------------------------------------------
//  Платформа: группы, права, маршруты
// ---------------------------------------------------------------------------

async function стенд(t) {
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Админов Админ", isAdmin: true });
  await makeLocalUser(db, { login: "stat1", name: "Статова Стат" });
  await makeLocalUser(db, { login: "stat2", name: "Шаблонов Шаблон" });
  await makeLocalUser(db, { login: "other1", name: "Чужов Чужой" });
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });
  const login = async (name) => { const c = client(app.url); await c.login(name); return c; };
  return { db, app, Adm: await login("adm1"), Stat: await login("stat1"), Mgr: await login("stat2"), Other: await login("other1") };
}

/** Запрос с файлом: тест-клиент шлёт только JSON. */
async function multipart(app, c, method, url, { file, name = "table.xlsx", fields = {} } = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === "string" ? v : JSON.stringify(v));
  if (file) f.append("file", new Blob([file]), name);
  const res = await fetch(app.url + url, { method, headers: { Cookie: c.cookie }, body: f });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch { /* файл */ }
  return { status: res.status, json, buf, headers: res.headers };
}

const form350 = (db) => db.prepare("SELECT id FROM bulletin_forms WHERE name = '350 Индексы производства'").get().id;

test("встроенная форма заводится один раз: удалённая не возвращается при следующем запуске", () => {
  const { db, cleanup } = freshDb();
  try {
    assert.ok(form350(db));
    db.prepare("DELETE FROM bulletin_forms").run();
    B.seedBuiltinForms(db);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM bulletin_forms").get().n, 0);
  } finally { cleanup(); }
});

test("группы — только администратору; сотрудник группы видит её формы и собирает документ", async (t) => {
  const { db, app, Adm, Stat, Other } = await стенд(t);
  const id = form350(db);

  assert.strictEqual((await Stat.get("/api/bulletins/groups")).status, 403);
  assert.strictEqual((await Stat.post("/api/bulletins/groups", { name: "Х", ad_groups: "", logins: "stat1", forms: [] })).status, 403);

  const g = await Adm.post("/api/bulletins/groups", { name: "Отдел статистики предприятий", ad_groups: "", logins: "Stat1\nDOMAIN\\stat2", can_manage: false, forms: [id] });
  assert.strictEqual(g.status, 201, g.text);
  const list = (await Adm.get("/api/bulletins/groups")).json;
  assert.deepStrictEqual(list.groups[0].logins.map((l) => [l.login, l.name]), [["stat1", "Статова Стат"], ["stat2", "Шаблонов Шаблон"]]);

  // Участник видит форму, посторонний — нет.
  const mine = (await Stat.get("/api/bulletins")).json;
  assert.deepStrictEqual(mine.forms.map((f) => f.id), [id]);
  assert.strictEqual(mine.canManage, false);
  assert.deepStrictEqual((await Other.get("/api/bulletins")).json.forms, []);

  // Форма определяется по заголовку таблицы; ответ — готовый .docx с именем по образцу.
  const r = await multipart(app, Stat, "POST", "/api/bulletins/make", { file: XLS, name: "выгрузка.xls", fields: { date: "05.05.2031" } });
  assert.strictEqual(r.status, 200, r.json && r.json.error);
  assert.match(r.headers.get("content-disposition"), /350_03_2031\.docx/);
  assert.match(docText(r.buf), /ЗА ЯНВАРЬ-МАРТ 2031 ГОДА/);

  // Чужая форма по номеру не собирается; плохая дата — 400.
  const other = await multipart(app, Other, "POST", "/api/bulletins/make", { file: XLS, fields: { form_id: String(id) } });
  assert.strictEqual(other.status, 400);
  assert.match(other.json.error, /недоступна/);
  const badDate = await multipart(app, Stat, "POST", "/api/bulletins/make", { file: XLS, fields: { date: "2031-05-05" } });
  assert.strictEqual(badDate.status, 400);

  // Таблица не к той форме — понятная причина.
  const wrong = await multipart(app, Stat, "POST", "/api/bulletins/make", { file: table.xlsx({ title: "Цены производителей за март 2031 года" }) });
  assert.strictEqual(wrong.status, 400);
  assert.match(wrong.json.error, /Не удалось определить форму/);

  // Управлять формой без права нельзя — и её существование не выдаётся.
  assert.strictEqual((await Stat.get(`/api/bulletins/forms/${id}`)).status, 404);
  assert.strictEqual((await Stat.delete(`/api/bulletins/forms/${id}`)).status, 404);
  assert.strictEqual((await multipart(app, Stat, "POST", "/api/bulletins/forms", { file: TEMPLATE_350, name: "x.docx", fields: { payload: { name: "Х", settings: SETTINGS_350 } } })).status, 403);

  // Исключили из группы — форма пропала сразу, без повторного входа.
  await Adm.put(`/api/bulletins/groups/${g.json.id}`, { name: "Отдел статистики предприятий", ad_groups: "", logins: "stat2", can_manage: false, forms: [id] });
  assert.deepStrictEqual((await Stat.get("/api/bulletins")).json.forms, []);
  assert.ok(db.prepare("SELECT 1 FROM admin_audit WHERE summary LIKE 'Бюллетени: изменена группа%'").get(), "правка группы — в журнале действий");
});

test("группа с правом управления правит только свои формы, новую кладёт в свою группу", async (t) => {
  const { db, app, Adm, Stat, Mgr } = await стенд(t);
  const id = form350(db);
  const mgrGroup = (await Adm.post("/api/bulletins/groups", { name: "Шаблоны отдела", ad_groups: "", logins: "stat2", can_manage: true, forms: [id] })).json.id;
  await Adm.post("/api/bulletins/groups", { name: "Отдел", ad_groups: "", logins: "stat1", can_manage: false, forms: [id] });
  const foreign = (await multipart(app, Adm, "POST", "/api/bulletins/forms", { file: TEMPLATE_350, name: "чужая.docx", fields: { payload: { name: "Чужая форма", settings: SETTINGS_350 } } })).json.id;

  const access = (await Mgr.get("/api/bulletins")).json;
  assert.strictEqual(access.canManage, true);
  assert.deepStrictEqual(access.manageGroups.map((g) => g.id), [mgrGroup]);
  assert.strictEqual((await Mgr.get(`/api/bulletins/forms/${foreign}`)).status, 404, "форма не своей группы");

  const f = (await Mgr.get(`/api/bulletins/forms/${id}`)).json;
  assert.deepStrictEqual(f.warnings, []);
  const tpl = await fetch(`${app.url}/api/bulletins/forms/${id}/template`, { headers: { Cookie: Mgr.cookie } });
  assert.strictEqual(tpl.status, 200);

  // Новая форма — в группу управляющего, без явного выбора (группа одна).
  const created = await multipart(app, Mgr, "POST", "/api/bulletins/forms", {
    file: TEMPLATE_350, name: "копия.docx", fields: { payload: { name: "350 копия", settings: { ...SETTINGS_350, sign: "" } } },
  });
  assert.strictEqual(created.status, 201, created.json && created.json.error);
  assert.ok(db.prepare("SELECT 1 FROM bulletin_group_forms WHERE group_id = ? AND form_id = ?").get(mgrGroup, created.json.id));

  // Правка: битые правила — 400, шаблон с лишней меткой — сохраняется с предупреждением.
  const bad = await multipart(app, Mgr, "PUT", `/api/bulletins/forms/${created.json.id}`, { fields: { payload: { name: "350 копия", settings: { ...SETTINGS_350, valueCols: [] } } } });
  assert.strictEqual(bad.status, 400);
  const fewer = await multipart(app, Mgr, "PUT", `/api/bulletins/forms/${created.json.id}`, { fields: { payload: { name: "350 копия", settings: { ...SETTINGS_350, valueCols: ["C", "D"] } } } });
  assert.strictEqual(fewer.status, 200);
  assert.match(fewer.json.warnings[0], /\{3\}/);

  // Не шаблон Word — отказ.
  const notDocx = await multipart(app, Mgr, "PUT", `/api/bulletins/forms/${created.json.id}`, { file: Buffer.from("не docx"), name: "x.docx", fields: { payload: { name: "350 копия", settings: SETTINGS_350 } } });
  assert.strictEqual(notDocx.status, 400);

  // Обычный участник группы формы не правит; управляющий — удаляет свою.
  assert.strictEqual((await Stat.delete(`/api/bulletins/forms/${created.json.id}`)).status, 404);
  assert.strictEqual((await Mgr.delete(`/api/bulletins/forms/${created.json.id}`)).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM admin_audit WHERE summary = 'Бюллетени: удалена форма «350 копия»'").get());
});

test("участник по группе домена: форма видна тому, кто вошёл с этой группой", async (t) => {
  const env = {
    DOMAIN_A_LABEL: "Тестовый домен", DOMAIN_A_LDAP_URL: "ldaps://dc.test.local:636", DOMAIN_A_BASE_DN: "DC=test,DC=local",
    DOMAIN_A_SVC_DN: "CN=svc,DC=test,DC=local", DOMAIN_A_SVC_PASSWORD: "пароль-сервисной", DOMAIN_A_ADMIN_GROUP: "Админы-Платформы",
    NETWORK_DOMAIN_A_CIDR: "127.0.0.0/8",
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  ldap.reset();
  ldap.directory.svc = { dn: env.DOMAIN_A_SVC_DN, password: env.DOMAIN_A_SVC_PASSWORD };
  ldap.addUser("ivanova", { password: "п1", displayName: "Иванова Тест", memberOf: [ldap.group("Otdel-Statistiki Predpriyatiy")] });
  ldap.addUser("petrov", { password: "п2", displayName: "Петров Тест", memberOf: [ldap.group("Otdel-Statistiki-Praktikanty")] });

  const { db, app, Adm } = await стенд(t);
  await Adm.post("/api/bulletins/groups", { name: "Статистика", ad_groups: "Prochaya-Gruppa\n  otdel-statistiki predpriyatiy  ", logins: "", can_manage: false, forms: [form350(db)] });

  const I = client(app.url), P = client(app.url);
  assert.strictEqual((await I.post("/api/auth/login", { mode: "A", login: "ivanova", password: "п1" })).status, 200);
  assert.strictEqual((await P.post("/api/auth/login", { mode: "A", login: "petrov", password: "п2" })).status, 200);
  assert.strictEqual((await I.get("/api/bulletins")).json.forms.length, 1, "группа домена совпала: регистр и пробелы по краям не мешают, групп у формы может быть несколько");
  assert.strictEqual((await P.get("/api/bulletins")).json.forms.length, 0, "похожее имя группы — не та группа");
});
