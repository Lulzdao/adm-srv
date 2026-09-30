'use strict';

const test = require("node:test");
const assert = require("node:assert");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { readZip } = require("../services/zip");
const { readFirstSheet } = require("../services/xlsx");
const { writeZip } = require("../services/zip");

// ============================================================================
//  Ассистент через HTTP: права, справочники, заявка на доступ, передача,
//  журнал техники и акты
//
//  Все ФИО, отделы, инвентарные номера ВЫДУМАНЫ.
// ============================================================================

async function стенд(t) {
  const { db, cleanup } = freshDb();
  const ids = {
    admin: await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд Стендович", isAdmin: true }),
    it: await makeLocalUser(db, { login: "it1", name: "Пробников Пробник Пробникович", role: "it" }),
    user: await makeLocalUser(db, { login: "u1", name: "Макетов Макет Макетович" }),
    other: await makeLocalUser(db, { login: "u2", name: "Образцов Образец Образцович" }),
  };
  db.prepare("UPDATE users SET department = 'Отдел выдуманной статистики' WHERE id = ?").run(ids.user);
  const app = await startApp(db);
  const Adm = client(app.url); await Adm.login("adm1");
  const It = client(app.url); await It.login("it1");
  const U = client(app.url); await U.login("u1");
  const U2 = client(app.url); await U2.login("u2");
  t.after(async () => { await app.close(); cleanup(); });
  return { db, app, ids, Adm, It, U, U2 };
}

/** Загрузка файла формой — так же, как это делает браузер. */
async function upload(app, C, path, name, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const res = await fetch(app.url + path, { method: "POST", headers: { Cookie: C.cookie }, body: form });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function download(app, C, path) {
  const res = await fetch(app.url + path, { headers: { Cookie: C.cookie } });
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), buf: Buffer.from(await res.arrayBuffer()) };
}

const docText = (buf, part = "word/document.xml") =>
  [...readZip(buf).get(part).toString("utf8").matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

async function справочники(Adm) {
  for (const d of [
    { name: "Отдел выдуманной статистики", name_gen: "отдела выдуманной статистики", chief_post: "Начальник", chief_post_gen: "начальника", chief_post_dat: "начальнику", chief_name: "Первов П.П.", chief_name_gen: "Первова П.П.", chief_name_dat: "Первову П.П." },
    { name: "Отдел пробных сводок", name_gen: "отдела пробных сводок", chief_post: "Начальник", chief_post_gen: "начальника", chief_post_dat: "начальнику", chief_name: "Вторых В.В.", chief_name_gen: "Вторых В.В.", chief_name_dat: "Вторых В.В." },
  ]) assert.strictEqual((await Adm.post("/api/assistant/settings/dict/depts", d)).status, 201);
  for (const p of [
    { role: "boss", name: "Главный Г.Г.", name_dat: "Главному Г.Г.", post: "Руководитель", post_dat: "Руководителю" },
    { role: "deputy", name: "Замов З.З.", post: "Заместитель руководителя" },
    { role: "it_chief", name: "Айтишный А.А.", post: "Начальник отдела" },
    { role: "responsible", name: "Составитель С.С.", post: "Ведущий специалист-эксперт" },
    { role: "chair", name: "Председательский П.П.", post: "Заместитель руководителя" },
    { role: "member", name: "Членов Ч.Ч.", post: "Главный специалист-эксперт" },
  ]) assert.strictEqual((await Adm.post("/api/assistant/settings/dict/people", p)).status, 201);
}

// ---------------------------------------------------------------------------

test("настройки — только администраторам, на каждом маршруте; раздел — всем вошедшим", async (t) => {
  const { app, Adm, It, U } = await стенд(t);
  const гость = client(app.url);
  for (const [m, p, b] of [
    ["get", "/api/assistant/settings/general"], ["put", "/api/assistant/settings/general", {}],
    ["get", "/api/assistant/settings/dict/links"], ["post", "/api/assistant/settings/dict/links", {}],
    ["put", "/api/assistant/settings/dict/links/1", {}], ["delete", "/api/assistant/settings/dict/links/1"],
    ["get", "/api/assistant/settings/templates"], ["delete", "/api/assistant/settings/templates/access"],
    ["get", "/api/assistant/settings/imports"], ["put", "/api/mailings/settings", {}], ["post", "/api/mailings/settings/mailboxes", {}],
    ["put", "/api/mailings/settings/mailboxes/1", {}], ["delete", "/api/mailings/settings/mailboxes/1"], ["post", "/api/mailings/settings/mailboxes/1/verify"],
  ]) {
    assert.strictEqual((await U[m](p, b)).status, 403, `${m} ${p} сотрудник`);
    assert.strictEqual((await It[m](p, b)).status, 403, `${m} ${p} исполнитель ИТ`);
    assert.strictEqual((await гость[m](p, b)).status, 401, `${m} ${p} без входа`);
  }
  assert.strictEqual((await Adm.get("/api/assistant/settings/general")).status, 200);
  for (const p of ["/api/assistant/refs", "/api/assistant/links", "/api/assistant/journal", "/api/assistant/acts", "/api/assistant/transfers", "/api/mailings"]) {
    assert.strictEqual((await U.get(p)).status, 200, p);
    assert.strictEqual((await гость.get(p)).status, 401, p);
  }
  const up = await upload(app, U, "/api/assistant/settings/imports/equipment", "tec.txt", "Принтерt###tИ-1t###t01.01.2020t###t1");
  assert.strictEqual(up.status, 403);
});

test("плитки систем: общие видны всем, отдельские — только своему отделу; ссылка только http(s)", async (t) => {
  const { Adm, U, U2 } = await стенд(t);
  assert.strictEqual((await Adm.post("/api/assistant/settings/dict/links", { title: "Общая система", url: "https://example.invalid/a" })).status, 201);
  assert.strictEqual((await Adm.post("/api/assistant/settings/dict/links", {
    title: "Система отдела", url: "http://example.invalid/b", departments: "отдел выдуманной статистики\nДругой отдел",
  })).status, 201);
  const bad = await Adm.post("/api/assistant/settings/dict/links", { title: "Плохая", url: "javascript:alert(1)" });
  assert.strictEqual(bad.status, 400);

  assert.deepStrictEqual((await U.get("/api/assistant/links")).json.links.map((l) => l.title).sort(), ["Общая система", "Система отдела"]);
  assert.deepStrictEqual((await U2.get("/api/assistant/links")).json.links.map((l) => l.title), ["Общая система"]);
  assert.strictEqual((await U2.get("/api/assistant/links?all=1")).json.links.length, 1, "?all=1 — только администратору");
  assert.strictEqual((await Adm.get("/api/assistant/links?all=1")).json.links.length, 2);
});

test("справочники: правка, повтор имени отдела — 400, удаление; неизвестный справочник — 404", async (t) => {
  const { Adm } = await стенд(t);
  const r = await Adm.post("/api/assistant/settings/dict/depts", { name: "Отдел А" });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await Adm.post("/api/assistant/settings/dict/depts", { name: "Отдел А" })).status, 400);
  assert.strictEqual((await Adm.put(`/api/assistant/settings/dict/depts/${r.json.id}`, { chief_name: "Тестов Т.Т." })).status, 200);
  const list = (await Adm.get("/api/assistant/settings/dict/depts")).json.items;
  assert.strictEqual(list[0].chief_name, "Тестов Т.Т.");
  assert.strictEqual(list[0].name, "Отдел А", "частичная правка не стирает остальные поля");
  assert.strictEqual((await Adm.post("/api/assistant/settings/dict/people", { role: "king", name: "X" })).status, 400);
  assert.strictEqual((await Adm.get("/api/assistant/settings/dict/nope")).status, 404);
  assert.strictEqual((await Adm.delete(`/api/assistant/settings/dict/depts/${r.json.id}`)).status, 200);
  assert.strictEqual((await Adm.delete(`/api/assistant/settings/dict/depts/${r.json.id}`)).status, 404);
});

test("заявка на доступ: становится заявкой в ИТ с анкетой, отдел её видит, служебная записка собирается", async (t) => {
  const { app, db, ids, Adm, It, U, U2 } = await стенд(t);
  await справочники(Adm);
  const r = await U.post("/api/assistant/access", {
    type: "register", last_name: "Новиков", first_name: "Новик", middle_name: "Новикович",
    post: "Ведущий экономист", department: "Отдел выдуманной статистики", room: "305", phone_int: "12-34",
    programs: ["АРМ ГС", "ВЕБСБОР"], csod_forms: "1-Т, П-1",
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.match(r.json.ticket.display_id, /^ИТ-\d{4}$/);
  const tid = r.json.ticket.id;

  const t1 = (await U.get(`/api/tickets/${tid}`)).json.ticket;
  assert.strictEqual(t1.title, "Регистрация: Новиков Н.Н.");
  assert.strictEqual(t1.category, "ИТ");
  assert.strictEqual(t1.room, "305");
  assert.strictEqual(t1.form.kind, "access");
  assert.deepStrictEqual(t1.form.data.programs, ["АРМ ГС", "ВЕБСБОР"]);
  // Исполнитель ИТ видит её во входящих — это обычная заявка отдела.
  assert.ok((await It.get("/api/tickets")).json.tickets.some((x) => x.id === tid));
  // Оповещение отделу ушло, как у обычной заявки.
  assert.ok(db.prepare("SELECT 1 FROM notification_deliveries WHERE user_id = ? AND channel = 'inapp'").get(ids.it));

  const doc = await download(app, U, `/api/assistant/access/${tid}/doc`);
  assert.strictEqual(doc.status, 200);
  const text = docText(doc.buf);
  for (const s of ["Заявка на регистрацию нового сотрудника", "Новиков Новик Новикович", "Ведущий экономист", "АРМ ГС, ВЕБСБОР, формы ЦСОД: 1-Т, П-1", "внутренний — 12-34", "Начальник отдела выдуманной статистики", "Первов П.П.", "Руководителю", "Главному Г.Г."]) {
    assert.ok(text.includes(s), `в записке есть «${s}»`);
  }
  // Чужой сотрудник не видит ни заявку, ни записку.
  assert.strictEqual((await U2.get(`/api/assistant/access/${tid}/doc`)).status, 403);
});

test("заявка на доступ: проверки полей и программ", async (t) => {
  const { U } = await стенд(t);
  const base = { type: "register", last_name: "Тестов", first_name: "Тест", department: "Отдел", post: "Экономист", programs: ["АРМ ГС"] };
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, type: "hack" })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, last_name: "" })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, programs: [] })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, programs: ["Чужая программа"] })).status, 400);
  // Блокировке программы не нужны, и она важнее обычной.
  const r = await U.post("/api/assistant/access", { type: "block", last_name: "Тестов", first_name: "Тест", department: "Отдел" });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await U.get(`/api/tickets/${r.json.ticket.id}`)).json.ticket.priority, "high");
});

test("передача оборудования: номер по порядку, документ с падежами, удаляет автор или администратор", async (t) => {
  const { app, Adm, U, U2 } = await стенд(t);
  await справочники(Adm);
  const body = {
    from_dept: "Отдел выдуманной статистики", to_dept: "Отдел пробных сводок",
    items: [{ name: "Монитор выдуманный 24\"", inv: "И-0001", count: 1 }, { name: "Клавиатура выдуманная", inv: "И-0002" }],
  };
  const a = await U.post("/api/assistant/transfers", body);
  assert.strictEqual(a.status, 201, JSON.stringify(a.json));
  assert.strictEqual(a.json.num, 1);
  assert.strictEqual((await U.post("/api/assistant/transfers", body)).json.num, 2);
  assert.strictEqual((await U.post("/api/assistant/transfers", { ...body, to_dept: body.from_dept })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/transfers", { ...body, to_dept: "Нет такого" })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/transfers", { ...body, items: [body.items[0], body.items[0]] })).status, 400);

  const doc = await download(app, U2, `/api/assistant/transfers/${a.json.id}/doc`);
  assert.strictEqual(doc.status, 200);
  const text = docText(doc.buf);
  assert.ok(text.includes("Прошу передать начальнику отдела пробных сводок Вторых В.В. от начальника отдела выдуманной статистики Первова П.П."), text);
  assert.ok(text.includes("Монитор выдуманный 24\"") && text.includes("И-0002"));
  assert.ok(text.includes("Замов З.З."));
  assert.match(decodeURIComponent(doc.disposition), /заявка на передачу оборудования № 1\.docx/);

  assert.strictEqual((await U2.delete(`/api/assistant/transfers/${a.json.id}`)).status, 403);
  assert.strictEqual((await U.delete(`/api/assistant/transfers/${a.json.id}`)).status, 200);
});

test("выгрузки из 1С: база заменяется целиком, поиск без учёта регистра", async (t) => {
  const { app, Adm, U } = await стенд(t);
  const tec = "Принтер Выдуманный LaserJett###tИ-0001t###t01.06.2020t###t1\r\nМонитор пробныйt###tИ-0002t###t02.02.2021t###t1\r\n";
  const r = await upload(app, Adm, "/api/assistant/settings/imports/equipment", "tec.txt", tec);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.count, 2);
  const found = (await U.get("/api/assistant/equipment?q=" + encodeURIComponent("принтер"))).json.items;
  assert.deepStrictEqual(found.map((x) => x.inv), ["И-0001"]);
  assert.strictEqual((await U.get("/api/assistant/equipment?q=И-0002")).json.items[0].name, "Монитор пробный");
  // Повторная загрузка заменяет, а не добавляет.
  await upload(app, Adm, "/api/assistant/settings/imports/equipment", "tec.txt", "Сканер пробныйt###tИ-0009t###tt###t1");
  assert.strictEqual((await U.get("/api/assistant/equipment?q=принтер")).json.items.length, 0);
  assert.strictEqual((await Adm.get("/api/assistant/settings/imports")).json.equipment.count, 1);

  const parts = "Картридж выдуманный черныйt###tt###t00-01t###t10\nФьюзер пробныйt###tсклад t###t00-02t###t3\n";
  assert.strictEqual((await upload(app, Adm, "/api/assistant/settings/imports/parts", "rep.txt", parts)).json.count, 2);
  assert.deepStrictEqual((await U.get("/api/assistant/parts?kind=cartridge&q=выдуман")).json.items.map((x) => x.nomenclature), ["00-01"]);
  assert.strictEqual((await upload(app, Adm, "/api/assistant/settings/imports/parts", "rep.txt", "ерунда")).status, 400);
});

test("шаблоны: загрузка своего, проверка при загрузке, откат к встроенному", async (t) => {
  const { app, Adm, U } = await стенд(t);
  await справочники(Adm);
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const mine = writeZip([["word/document.xml", `<w:document ${W}><w:body><w:p><w:r><w:t>СВОЙ БЛАНК {FIO}</w:t></w:r></w:p></w:body></w:document>`]]);
  const bad = writeZip([["word/document.xml", `<w:document ${W}><w:body><w:p><w:r><w:t>{#tec}</w:t></w:r></w:p></w:body></w:document>`]]);
  assert.strictEqual((await upload(app, Adm, "/api/assistant/settings/templates/access", "bad.docx", bad)).status, 400);
  const ok = await upload(app, Adm, "/api/assistant/settings/templates/access", "мой.docx", mine);
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json.tags, ["FIO"]);

  const tid = (await U.post("/api/assistant/access", { type: "block", last_name: "Тестов", first_name: "Тест", department: "Отдел" })).json.ticket.id;
  assert.strictEqual(docText((await download(app, U, `/api/assistant/access/${tid}/doc`)).buf), "СВОЙ БЛАНК Тестов Тест");
  const list = (await Adm.get("/api/assistant/settings/templates")).json.templates;
  assert.strictEqual(list.find((x) => x.kind === "access").custom.filename, "мой.docx");

  assert.strictEqual((await Adm.delete("/api/assistant/settings/templates/access")).status, 200);
  assert.match(docText((await download(app, U, `/api/assistant/access/${tid}/doc`)).buf), /Служебная записка/);
});

test("журнал: запись, правка автором, чужому нельзя, фильтры и выгрузка в Excel", async (t) => {
  const { app, Adm, U, U2 } = await стенд(t);
  const e = { date: "2026-09-10", kind: "cartridge", part_name: "Картридж выдуманный", nomenclature: "00-01", count: 2, equipment: "Принтер пробный", inv: "И-0001", location: "каб. 305" };
  const a = await U.post("/api/assistant/journal", e);
  assert.strictEqual(a.status, 201);
  assert.strictEqual((await U.post("/api/assistant/journal", { ...e, date: "10.09.2026" })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/journal", { ...e, kind: "x" })).status, 400);
  await U.post("/api/assistant/journal", { ...e, date: "2026-08-01", kind: "part", part_name: "Фьюзер пробный", nomenclature: "00-02", count: 1 });

  assert.strictEqual((await U2.put(`/api/assistant/journal/${a.json.id}`, { ...e, count: 3 })).status, 403);
  assert.strictEqual((await U.put(`/api/assistant/journal/${a.json.id}`, { ...e, count: 3 })).status, 200);
  assert.strictEqual((await Adm.put(`/api/assistant/journal/${a.json.id}`, { ...e, count: 4 })).status, 200);

  assert.strictEqual((await U.get("/api/assistant/journal")).json.total, 2);
  assert.strictEqual((await U.get("/api/assistant/journal?kind=part")).json.total, 1);
  assert.strictEqual((await U.get("/api/assistant/journal?from=2026-09-01")).json.total, 1);
  assert.strictEqual((await U.get("/api/assistant/journal?q=" + encodeURIComponent("пробный фьюзер".split(" ")[1]))).json.total, 1);

  const x = await download(app, U, "/api/assistant/journal/export");
  assert.strictEqual(x.status, 200);
  const rows = readFirstSheet(x.buf);
  assert.ok(rows.some((r) => r.includes("Картридж выдуманный") && r.includes("4")));
});

test("акты на ремонт: из записей с запчастями, номер в реестре, записи привязаны, удаление акта отвязывает", async (t) => {
  const { app, Adm, U, U2 } = await стенд(t);
  await справочники(Adm);
  await Adm.post("/api/assistant/settings/dict/rules", { title: "Принтер", keywords: "принтер, мфу", defect: "Износ узла закрепления", repair_works: "Замена термоузла", remains: "термоузел, непригодный" });
  const add = async (x) => (await U.post("/api/assistant/journal", { date: "2026-09-10", kind: "part", count: 1, equipment: "Принтер пробный", inv: "И-0001", location: "каб. 305", ...x })).json.id;
  const e1 = await add({ part_name: "Фьюзер пробный", nomenclature: "00-02" });
  const e2 = await add({ part_name: "Ролик пробный", nomenclature: "00-03", count: 2 });
  const cart = (await U.post("/api/assistant/journal", { date: "2026-09-10", kind: "cartridge", part_name: "Картридж", count: 1 })).json.id;

  // Картридж в акт на ремонт не берётся — он идёт в ведомость.
  assert.strictEqual((await U.post("/api/assistant/acts/repair", { entry_ids: [e1, cart] })).status, 400);

  const pv = (await U.post("/api/assistant/acts/repair/preview", { entry_ids: [e1, e2] })).json.groups;
  assert.strictEqual(pv.length, 1);
  assert.strictEqual(pv[0].defect, "Износ узла закрепления", "подсказка из справочника по слову «принтер»");

  const act = await U.post("/api/assistant/acts/repair", {
    entry_ids: [e1, e2], date: "2026-09-12", with_memo: true,
    groups: [{ key: pv[0].key, defect: pv[0].defect, repair_works: pv[0].repair_works, remains: pv[0].remains }],
  });
  assert.strictEqual(act.status, 201, JSON.stringify(act.json));
  assert.strictEqual(act.json.num, 1);
  // По этим записям второй акт не составить, и правка их закрыта.
  assert.strictEqual((await U.post("/api/assistant/acts/repair", { entry_ids: [e1] })).status, 400);
  assert.strictEqual((await U.delete(`/api/assistant/journal/${e1}`)).status, 409);

  const zip = await download(app, U2, `/api/assistant/acts/${act.json.id}/download`);
  assert.strictEqual(zip.status, 200);
  const files = readZip(zip.buf);
  assert.strictEqual(files.size, 3, "неисправности, ремонт, записка на запчасти");
  const repair = [...files.entries()].find(([n]) => n.includes("Акт о ремонте"))[1];
  const text = docText(repair);
  for (const s of ["№ 1", "Принтер пробный", "Замена термоузла", "Ролик пробный", "00-03", "термоузел, непригодный", "Составитель С.С.", "Айтишный А.А.", "12.09.2026"]) {
    assert.ok(text.includes(s), `в акте есть «${s}»`);
  }
  const one = await download(app, U, `/api/assistant/acts/${act.json.id}/download?doc=defect`);
  assert.match(docText(one.buf), /Износ узла закрепления/);

  // Удалить акт может автор или администратор; записи журнала освобождаются.
  assert.strictEqual((await U2.delete(`/api/assistant/acts/${act.json.id}`)).status, 403);
  assert.strictEqual((await U.delete(`/api/assistant/acts/${act.json.id}`)).status, 200);
  assert.strictEqual((await U.get("/api/assistant/journal?free=1")).json.total, 3);
});

test("ведомость по картриджам за месяц: Word и Excel, картриджи другого месяца не попадают", async (t) => {
  const { app, Adm, U } = await стенд(t);
  await справочники(Adm);
  for (const [date, n] of [["2026-09-02", 2], ["2026-09-20", 1], ["2026-10-01", 5]]) {
    await U.post("/api/assistant/journal", { date, kind: "cartridge", part_name: `Картридж ${date}`, nomenclature: "00-01", count: n, location: "каб. 1" });
  }
  const r = await U.post("/api/assistant/acts/cartridges", { month: "2026-09" });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual((await U.post("/api/assistant/acts/cartridges", { month: "2026-09" })).status, 400, "повторно — уже нечего");

  const files = readZip((await download(app, U, `/api/assistant/acts/${r.json.id}/download`)).buf);
  const [docx] = [...files.entries()].filter(([n]) => n.endsWith(".docx")).map(([, b]) => b);
  const text = docText(docx);
  assert.ok(text.includes("сентябрь") && text.includes("2026") && text.includes("Итого: 3 шт."), text);
  assert.ok(!text.includes("2026-10-01"));
  const [xlsx] = [...files.entries()].filter(([n]) => n.endsWith(".xlsx")).map(([, b]) => b);
  assert.ok(readFirstSheet(xlsx).some((row) => row.includes("Картридж 2026-09-20")));
});

test("акт на списание: комиссия из справочника, реестр по годам и архив нескольких актов", async (t) => {
  const { app, Adm, U } = await стенд(t);
  await справочники(Adm);
  const w = await U.post("/api/assistant/acts/writeoff", { name: "Монитор пробный", inv: "И-0002", commissioned: "02.02.2011", reason: "Не включается, выгорела матрица", date: "2026-09-15" });
  assert.strictEqual(w.status, 201, JSON.stringify(w.json));
  assert.strictEqual((await U.post("/api/assistant/acts/writeoff", { name: "Без номера" })).status, 400);
  const text = docText((await download(app, U, `/api/assistant/acts/${w.json.id}/download`)).buf);
  for (const s of ["Монитор пробный", "И-0002", "02.02.2011", "выгорела матрица", "Председательский П.П.", "Членов Ч.Ч.", "УТВЕРЖДАЮ"]) assert.ok(text.includes(s), s);

  // Нумерация с заданного администратором номера.
  await Adm.put("/api/assistant/settings/general", { actStart: 40 });
  const w2 = await U.post("/api/assistant/acts/writeoff", { name: "Сканер пробный", inv: "И-0003", reason: "Сломан" });
  assert.strictEqual(w2.json.num, 40);
  const reg = (await U.get("/api/assistant/acts?year=2026")).json;
  assert.ok(reg.acts.length >= 1);
  const both = await download(app, U, `/api/assistant/acts/zip?ids=${w.json.id},${w2.json.id}`);
  assert.strictEqual(readZip(both.buf).size, 2);
});

test("остатки: выгрузка из 1С минус поставленное после неё; отчёт за месяц", async (t) => {
  const { app, Adm, U } = await стенд(t);
  await upload(app, Adm, "/api/assistant/settings/imports/parts", "rep.txt", "Картридж выдуманныйt###tt###t00-01t###t10\n");
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await U.post("/api/assistant/journal", { date: iso, kind: "cartridge", part_name: "Картридж выдуманный", nomenclature: "00-01", count: 3 });
  await U.post("/api/assistant/journal", { date: "2000-01-01", kind: "cartridge", part_name: "Картридж выдуманный", nomenclature: "00-01", count: 100 });
  const s = (await U.get("/api/assistant/stock")).json.items[0];
  assert.strictEqual(s.used, 3, "поставленное до выгрузки уже учтено в 1С");
  assert.strictEqual(s.left, 7);
  const rep = await download(app, U, `/api/assistant/stock/report?month=${iso.slice(0, 7)}`);
  assert.ok(readFirstSheet(rep.buf).some((r) => r.includes("00-01") && r.includes("3") && r.includes("7")));
  assert.strictEqual((await U.get("/api/assistant/stock/report?month=сентябрь")).status, 400);
});
