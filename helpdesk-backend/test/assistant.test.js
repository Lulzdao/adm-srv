'use strict';

const test = require("node:test");
const assert = require("node:assert");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { readZip, writeZip } = require("../services/zip");
const { readFirstSheet } = require("../services/xlsx");

// ============================================================================
//  Ассистент через HTTP: права, справочники, заявка на доступ, акты
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

async function download(app, C, path) {
  const res = await fetch(app.url + path, { headers: { Cookie: C.cookie } });
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), buf: Buffer.from(await res.arrayBuffer()) };
}

async function upload(app, C, path, name, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const res = await fetch(app.url + path, { method: "POST", headers: { Cookie: C.cookie }, body: form });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const docText = (buf, part = "word/document.xml") =>
  [...readZip(buf).get(part).toString("utf8").matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

async function справочники(Adm) {
  for (const d of [
    { name: "Отдел выдуманной статистики", chief_name: "Первов П.П.", chief_name_gen: "Первова П.П.", chief_name_dat: "Первову П.П." },
    { name: "Отдел информационных ресурсов и технологий", chief_name: "Айтишный А.А.", chief_name_gen: "Айтишного А.А.", chief_name_dat: "Айтишному А.А." },
  ]) assert.strictEqual((await Adm.post("/api/assistant/settings/dict/depts", d)).status, 201);
  assert.strictEqual((await Adm.put("/api/assistant/settings/general", { itDept: "Отдел информационных ресурсов и технологий" })).status, 200);
  for (const p of [
    { role: "boss", name: "Главный Г.Г.", name_dat: "Главному Г.Г.", post: "Руководитель", post_dat: "Руководителю" },
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
    ["get", "/api/assistant/settings/dict/depts"], ["post", "/api/assistant/settings/dict/depts", {}],
    ["put", "/api/assistant/settings/dict/depts/1", {}], ["delete", "/api/assistant/settings/dict/depts/1"],
    ["get", "/api/assistant/settings/templates"], ["delete", "/api/assistant/settings/templates/access"],
    ["put", "/api/mailings/settings", {}], ["post", "/api/mailings/settings/mailboxes", {}],
    ["put", "/api/mailings/settings/mailboxes/1", {}], ["delete", "/api/mailings/settings/mailboxes/1"], ["post", "/api/mailings/settings/mailboxes/1/verify"],
  ]) {
    assert.strictEqual((await U[m](p, b)).status, 403, `${m} ${p} сотрудник`);
    assert.strictEqual((await It[m](p, b)).status, 403, `${m} ${p} исполнитель ИТ`);
    assert.strictEqual((await гость[m](p, b)).status, 401, `${m} ${p} без входа`);
  }
  assert.strictEqual((await Adm.get("/api/assistant/settings/general")).status, 200);
  for (const p of ["/api/assistant/refs", "/api/assistant/acts", "/api/mailings"]) {
    assert.strictEqual((await U.get(p)).status, 200, p);
    assert.strictEqual((await гость.get(p)).status, 401, p);
  }
});

test("убранных разделов больше нет: системы, передача, журнал, базы из 1С", async (t) => {
  const { app, db, Adm, U } = await стенд(t);
  for (const p of ["/api/assistant/links", "/api/assistant/transfers", "/api/assistant/journal", "/api/assistant/stock", "/api/assistant/equipment?q=a", "/api/assistant/parts?q=a"]) {
    assert.strictEqual((await U.get(p)).status, 404, p);
  }
  assert.strictEqual((await Adm.get("/api/assistant/settings/dict/links")).status, 404);
  const imp = await fetch(app.url + "/api/assistant/settings/imports/equipment", { method: "POST", headers: { Cookie: Adm.cookie } });
  assert.strictEqual(imp.status, 404);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'asst_%'").all().map((r) => r.name);
  for (const gone of ["asst_links", "asst_transfers", "asst_journal", "asst_equipment", "asst_parts"]) assert.ok(!tables.includes(gone), gone);
  const kinds = (await Adm.get("/api/assistant/settings/templates")).json.templates.map((x) => x.kind);
  assert.ok(!kinds.includes("transfer"));
});

test("справочник отделов: правка, повтор имени — 400, переименование отдела ИТ тянет за собой настройку", async (t) => {
  const { Adm } = await стенд(t);
  await справочники(Adm);
  const list = (await Adm.get("/api/assistant/settings/dict/depts")).json.items;
  const it = list.find((d) => d.name.startsWith("Отдел информационных"));
  assert.strictEqual((await Adm.post("/api/assistant/settings/dict/depts", { name: it.name })).status, 400);
  assert.strictEqual((await Adm.put(`/api/assistant/settings/dict/depts/${it.id}`, { name: "Отдел ИТ выдуманный" })).status, 200);
  assert.strictEqual((await Adm.get("/api/assistant/settings/general")).json.itDept, "Отдел ИТ выдуманный");
  assert.strictEqual((await Adm.put("/api/assistant/settings/general", { itDept: "Нет такого" })).status, 400);
  assert.strictEqual((await Adm.post("/api/assistant/settings/dict/people", { role: "it_chief", name: "X" })).status, 400, "роль начальника ИТ убрана");
  assert.strictEqual((await Adm.get("/api/assistant/settings/dict/nope")).status, 404);
});

test("заявка на доступ: заявка в ИТ с анкетой; записка — на имя начальника отдела ИТ, подпись начальника отдела сотрудника", async (t) => {
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
  assert.strictEqual(t1.form.kind, "access");
  assert.ok((await It.get("/api/tickets")).json.tickets.some((x) => x.id === tid));
  assert.ok(db.prepare("SELECT 1 FROM notification_deliveries WHERE user_id = ? AND channel = 'inapp'").get(ids.it));

  const doc = await download(app, U, `/api/assistant/access/${tid}/doc`);
  assert.strictEqual(doc.status, 200);
  const text = docText(doc.buf);
  for (const s of [
    "Начальнику отдела информационных ресурсов и технологий", "Айтишному А.А.",
    "Заявка на регистрацию нового сотрудника", "Новиков Новик Новикович", "Ведущий экономист",
    "АРМ ГС, ВЕБСБОР, формы ЦСОД: 1-Т, П-1", "внутренний — 12-34",
    "Начальник отдела выдуманной статистики", "Первов П.П.",
  ]) assert.ok(text.includes(s), `в записке есть «${s}»`);
  assert.ok(!text.includes("Главному Г.Г."), "записка не руководителю, а начальнику ИТ");
  assert.strictEqual((await U2.get(`/api/assistant/access/${tid}/doc`)).status, 403);
});

test("заявка на доступ: проверки полей и программ", async (t) => {
  const { U } = await стенд(t);
  const base = { type: "register", last_name: "Тестов", first_name: "Тест", department: "Отдел", post: "Экономист", programs: ["АРМ ГС"] };
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, type: "hack" })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, last_name: "" })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, programs: [] })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/access", { ...base, programs: ["Чужая программа"] })).status, 400);
  const r = await U.post("/api/assistant/access", { type: "block", last_name: "Тестов", first_name: "Тест", department: "Отдел" });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await U.get(`/api/tickets/${r.json.ticket.id}`)).json.ticket.priority, "high");
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
  assert.strictEqual((await Adm.delete("/api/assistant/settings/templates/access")).status, 200);
  assert.match(docText((await download(app, U, `/api/assistant/access/${tid}/doc`)).buf), /Служебная записка/);
});

test("акты на ремонт вручную: техника, неисправности, работы, запчасти; служебная записка по желанию", async (t) => {
  const { app, Adm, U, U2 } = await стенд(t);
  await справочники(Adm);
  const body = {
    date: "2026-09-12", with_memo: true,
    equipment: [{ name: "Принтер пробный", inv: "И-0001", location: "каб. 305" }],
    defects: "Износ узла закрепления\nПолосы на отпечатках",
    works: "Замена термоузла\nЗамена ролика",
    parts: [{ name: "Термоузел пробный", nomenclature: "00-02", count: 1 }, { work: "Замена ролика", name: "Ролик пробный", nomenclature: "00-03", count: 2 }],
    remains: "термоузел, непригодный",
  };
  assert.strictEqual((await U.post("/api/assistant/acts/repair", { ...body, equipment: [] })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/acts/repair", { ...body, works: "" })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/acts/repair", { ...body, parts: [{ count: 1 }] })).status, 400);

  const act = await U.post("/api/assistant/acts/repair", body);
  assert.strictEqual(act.status, 201, JSON.stringify(act.json));
  assert.strictEqual(act.json.num, 1);
  const files = readZip((await download(app, U2, `/api/assistant/acts/${act.json.id}/download`)).buf);
  assert.strictEqual(files.size, 3, "неисправности, ремонт, записка на запчасти");
  const repair = docText([...files.entries()].find(([n]) => n.includes("Акт о ремонте"))[1]);
  for (const s of ["№ 1", "12.09.2026", "Принтер пробный", "И-0001", "Замена термоузла", "Термоузел пробный", "Замена ролика", "Ролик пробный", "00-03",
    "термоузел, непригодный", "Составитель С.С.", "Начальник отдела информационных ресурсов и технологий", "Айтишный А.А.", "УТВЕРЖДАЮ", "Главный Г.Г."]) {
    assert.ok(repair.includes(s), `в акте есть «${s}»`);
  }
  const defect = docText((await download(app, U, `/api/assistant/acts/${act.json.id}/download?doc=defect`)).buf);
  assert.ok(defect.includes("Износ узла закрепления") && defect.includes("Полосы на отпечатках"));

  // Без запчастей записки нет, а в акте о ремонте — строки работ.
  const plain = await U.post("/api/assistant/acts/repair", { ...body, parts: [] });
  const docs = (await U.get(`/api/assistant/acts/${plain.json.id}`)).json.act.docs.map((d) => d.kind);
  assert.deepStrictEqual(docs, ["defect", "repair"]);
  assert.match(docText((await download(app, U, `/api/assistant/acts/${plain.json.id}/download?doc=repair`)).buf), /Замена ролика/);

  assert.strictEqual((await U2.delete(`/api/assistant/acts/${act.json.id}`)).status, 403);
  assert.strictEqual((await U.delete(`/api/assistant/acts/${act.json.id}`)).status, 200);
});

test("ведомость по картриджам вручную: Word и Excel, итог по количеству", async (t) => {
  const { app, Adm, U } = await стенд(t);
  await справочники(Adm);
  const r = await U.post("/api/assistant/acts/cartridges", { month: "2026-09", rows: [
    { name: "Картридж выдуманный", nomenclature: "00-01", count: 2, location: "каб. 1" },
    { name: "Картридж пробный", count: 1 },
  ] });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual((await U.post("/api/assistant/acts/cartridges", { month: "2026-13", rows: [{ name: "x" }] })).status, 400);
  assert.strictEqual((await U.post("/api/assistant/acts/cartridges", { month: "2026-09", rows: [] })).status, 400);
  const files = readZip((await download(app, U, `/api/assistant/acts/${r.json.id}/download`)).buf);
  const [docx] = [...files.entries()].filter(([n]) => n.endsWith(".docx")).map(([, b]) => b);
  const text = docText(docx);
  assert.ok(text.includes("сентябрь") && text.includes("Итого: 3 шт.") && text.includes("Картридж пробный"), text);
  const [xlsx] = [...files.entries()].filter(([n]) => n.endsWith(".xlsx")).map(([, b]) => b);
  assert.ok(readFirstSheet(xlsx).some((row) => row.includes("Картридж выдуманный") && row.includes("00-01")));
});

test("акт на списание вручную: комиссия из справочника, нумерация с заданного номера, архив нескольких актов", async (t) => {
  const { app, Adm, U } = await стенд(t);
  await справочники(Adm);
  const w = await U.post("/api/assistant/acts/writeoff", { name: "Монитор пробный", inv: "И-0002", commissioned: "02.02.2011", reason: "Не включается, выгорела матрица", date: "2026-09-15" });
  assert.strictEqual(w.status, 201, JSON.stringify(w.json));
  assert.strictEqual((await U.post("/api/assistant/acts/writeoff", { name: "Без номера" })).status, 400);
  const text = docText((await download(app, U, `/api/assistant/acts/${w.json.id}/download`)).buf);
  for (const s of ["Монитор пробный", "И-0002", "02.02.2011", "выгорела матрица", "Председательский П.П.", "Членов Ч.Ч.", "УТВЕРЖДАЮ"]) assert.ok(text.includes(s), s);

  await Adm.put("/api/assistant/settings/general", { actStart: 40 });
  const w2 = await U.post("/api/assistant/acts/writeoff", { name: "Сканер пробный", inv: "И-0003", reason: "Сломан", date: `${new Date().getFullYear()}-01-10` });
  assert.strictEqual(w2.json.num, 40);
  const both = await download(app, U, `/api/assistant/acts/zip?ids=${w.json.id},${w2.json.id}`);
  assert.strictEqual(readZip(both.buf).size, 2);
});
