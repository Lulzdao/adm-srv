'use strict';

const test = require("node:test");
const assert = require("node:assert");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { startFakeSmtp } = require("./helpers/fakeSmtp");
const { buildXlsx, readFirstSheet } = require("../services/xlsx");

// ============================================================================
//  Рассылки респондентам — через настоящий HTTP и поддельный SMTP-приёмник
//
//  Все организации, ОКПО и адреса ВЫДУМАНЫ; домен .invalid не существует.
// ============================================================================

async function стенд(t, smtpOpts = {}) {
  const smtp = await startFakeSmtp(smtpOpts);
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд Стендович", isAdmin: true, email: "adm1@example.invalid" });
  await makeLocalUser(db, { login: "u1", name: "Макетов Макет Макетович", email: "u1@example.invalid" });
  await makeLocalUser(db, { login: "u2", name: "Образцов Образец Образцович" });
  const app = await startApp(db);
  const Adm = client(app.url); await Adm.login("adm1");
  const U = client(app.url); await U.login("u1");
  const U2 = client(app.url); await U2.login("u2");
  const r = await Adm.put("/api/mailings/settings", {
    host: "127.0.0.1", port: smtp.port, secure: false, from: "rassylka@example.invalid", delayMs: 0, signature: "Выдуманный статорган",
  });
  assert.strictEqual(r.status, 200, r.text);
  t.after(async () => { await app.close(); await smtp.close(); cleanup(); });
  return { db, app, smtp, Adm, U, U2 };
}

async function form(app, C, path, { file, payload, attachments = [] }) {
  const f = new FormData();
  if (file) f.append("file", new Blob([file.content]), file.name);
  if (payload) f.append("payload", JSON.stringify(payload));
  for (const a of attachments) f.append("attachments", new Blob([a.content]), a.name);
  const res = await fetch(app.url + path, { method: "POST", headers: { Cookie: C.cookie }, body: f });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

async function дождаться(C, id, pred, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = (await C.get(`/api/mailings/${id}`)).json;
    if (pred(r)) return r;
    if (Date.now() > end) throw new Error("не дождались: " + JSON.stringify(r.campaign));
    await new Promise((res) => setTimeout(res, 50));
  }
}

const LIST_CSV = "ОКПО;Наименование;Почта;Форма\r\n01234567;ООО \"Выдуманное\";one@example.invalid;1-Т\r\n12345678;АО Пробное;two@example.invalid, three@example.invalid;П-1\r\n23456789;ИП Без адреса;;П-4\r\n34567890;ЗАО Опечатка;bad@;1-Т\r\n45678901;ООО Повтор;one@example.invalid;1-Т\r\n";

test("разбор списка: колонки по заголовку, несколько адресов, пустые и кривые адреса, повторы", async (t) => {
  const { app, U } = await стенд(t);
  const r = await form(app, U, "/api/mailings/parse", { file: { name: "список.csv", content: LIST_CSV } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.detected, { email: "Почта", okpo: "ОКПО", name: "Наименование" });
  const [a, b, c, d, e] = r.json.recipients;
  assert.deepStrictEqual(a.emails, ["one@example.invalid"]);
  assert.strictEqual(a.row_no, 2);
  assert.deepStrictEqual(b.emails, ["two@example.invalid", "three@example.invalid"]);
  assert.strictEqual(c.problem, "нет адреса");
  assert.match(d.problem, /неверный адрес: bad@/);
  assert.strictEqual(e.duplicateOf, 2);

  // Тот же список в XLSX и без заголовка — колонки угадываются по содержимому.
  const xlsx = buildXlsx([{ name: "Л", columns: [{ title: "01234567" }, { title: "ООО Длинное выдуманное наименование" }, { title: "x@example.invalid" }], rows: [["12345678", "АО Второе выдуманное", "y@example.invalid"]] }]);
  const r2 = await form(app, U, "/api/mailings/parse", { file: { name: "список.xlsx", content: xlsx } });
  assert.strictEqual(r2.status, 200, r2.text);
  assert.deepStrictEqual(r2.json.recipients.map((x) => [x.okpo, x.emails[0]]), [["01234567", "x@example.invalid"], ["12345678", "y@example.invalid"]]);

  assert.strictEqual((await form(app, U, "/api/mailings/parse", { file: { name: "a.csv", content: "Имя;Телефон\nТест;123" } })).status, 400);
});

test("отправка с общего ящика: шаблон с реквизитами, подстановки, вложение, ответ — автору, отчёт автору", async (t) => {
  const { app, smtp, U } = await стенд(t);
  const parsed = (await form(app, U, "/api/mailings/parse", { file: { name: "список.csv", content: LIST_CSV } })).json;
  const recipients = parsed.recipients.filter((x) => !x.problem && !x.duplicateOf);
  const r = await form(app, U, "/api/mailings", {
    payload: { subject: "Отчёт по форме {Форма}", body: "Напоминаем о сдаче формы {Форма}.", use_template: true, sender_mode: "shared", recipients },
    attachments: [{ name: "указания.txt", content: "Текст вложения" }],
  });
  assert.strictEqual(r.status, 201, r.text);
  const done = await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(done.campaign.sent, 2);

  const letters = smtp.messages.filter((m) => !m.subject.startsWith("Отчёт о рассылке"));
  assert.strictEqual(letters.length, 2);
  const first = letters.find((m) => m.to.includes("one@example.invalid"));
  assert.strictEqual(first.subject, "Отчёт по форме 1-Т");
  // Имя вложения по-русски уходит закодированным (RFC 2231), содержимое — base64.
  assert.match(first.raw, /Content-Disposition: attachment/);
  assert.ok(first.raw.includes(Buffer.from("указания.txt").toString("base64")), "имя вложения");
  assert.ok(first.raw.includes(Buffer.from("Текст вложения").toString("base64")), "содержимое вложения");
  assert.match(first.headers["reply-to"], /u1@example\.invalid/);
  const second = letters.find((m) => m.to.includes("two@example.invalid"));
  assert.deepStrictEqual(second.to.sort(), ["three@example.invalid", "two@example.invalid"]);

  const report = smtp.messages.find((m) => m.subject.startsWith("Отчёт о рассылке"));
  assert.ok(report, "отчёт ушёл");
  assert.deepStrictEqual(report.to, ["u1@example.invalid"]);
  assert.match(report.body, /Отправлено: 2 из 2/);
  // Текст письма с шаблоном — в предпросмотре карточки.
  assert.match(done.preview, /Здравствуйте, уважаемый респондент!\nОКПО: 01234567\nНаименование: ООО "Выдуманное"\n\nНапоминаем о сдаче формы 1-Т\.\n\nС уважением,\nВыдуманный статорган/);
});

test("отказ сервера по адресу — строка «не отправлено» с причиной; повтор неотправленных", async (t) => {
  const { app, smtp, U } = await стенд(t, { rejectRecipient: "two@example.invalid" });
  const recipients = [
    { row_no: 2, okpo: "1", name: "А", emails: ["one@example.invalid"] },
    { row_no: 3, okpo: "2", name: "Б", emails: ["two@example.invalid"] },
  ];
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Тема", body: "Текст", use_template: false, sender_mode: "shared", recipients } });
  const done = await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(done.campaign.sent, 1);
  assert.strictEqual(done.campaign.failed, 1);
  assert.match(done.recipients.find((x) => x.row_no === 3).error, /не принял адрес|550|mailbox/i);
  assert.match(smtp.messages.find((m) => m.subject.startsWith("Отчёт")).body, /Не отправлено:[\s\S]*two@example\.invalid/);

  const x = await fetch(app.url + `/api/mailings/${r.json.id}/report`, { headers: { Cookie: U.cookie } });
  const rows = readFirstSheet(Buffer.from(await x.arrayBuffer()));
  assert.ok(rows.some((row) => row.includes("two@example.invalid") && row.includes("не отправлено")));

  smtp.reset();
  assert.strictEqual((await U.post(`/api/mailings/${r.json.id}/retry`, {})).status, 200);
  await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(smtp.messages.filter((m) => !m.subject.startsWith("Отчёт")).length, 0, "отправленному повторно не уходит");
});

test("свой ящик: неверный пароль — сразу 400, верный — письмо уходит под своим логином, пароль нигде не хранится", async (t) => {
  const { app, db, smtp, U } = await стенд(t, { auth: { user: "u1@example.invalid", pass: "верный-пароль" } });
  const payload = {
    subject: "Тема", body: "Текст", sender_mode: "own", own_address: "u1@example.invalid",
    recipients: [{ row_no: 2, emails: ["one@example.invalid"] }],
  };
  const bad = await form(app, U, "/api/mailings", { payload: { ...payload, own_password: "неверный" } });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /Не удалось войти/);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM mail_campaigns").get().n, 0);

  const ok = await form(app, U, "/api/mailings", { payload: { ...payload, own_password: "верный-пароль" } });
  assert.strictEqual(ok.status, 201, ok.text);
  await дождаться(U, ok.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(smtp.messages[0].login, "u1@example.invalid");
  const dump = JSON.stringify(db.prepare("SELECT * FROM mail_campaigns").all()) + JSON.stringify(db.prepare("SELECT * FROM settings").all());
  assert.ok(!dump.includes("верный-пароль"), "пароль своего ящика в базу не попал");
});

test("чужую рассылку не видно и не остановить; администратор видит все", async (t) => {
  const { app, U, U2, Adm } = await стенд(t);
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Т", body: "Б", sender_mode: "shared", recipients: [{ row_no: 2, emails: ["one@example.invalid"] }] } });
  for (const [m, p] of [["get", ""], ["post", "/pause"], ["post", "/cancel"], ["post", "/retry"], ["delete", ""]]) {
    assert.strictEqual((await U2[m](`/api/mailings/${r.json.id}${p}`, {})).status, 403, `${m} ${p}`);
  }
  assert.strictEqual((await U2.get("/api/mailings")).json.campaigns.length, 0);
  assert.strictEqual((await Adm.get("/api/mailings")).json.campaigns.length, 1);
  assert.strictEqual((await Adm.get(`/api/mailings/${r.json.id}`)).status, 200);
});

test("проверки формы: пустой список, кривой адрес, слишком большие вложения, общий ящик не настроен", async (t) => {
  const { app, U, Adm } = await стенд(t);
  const base = { subject: "Т", body: "Б", sender_mode: "shared", recipients: [{ row_no: 2, emails: ["one@example.invalid"] }] };
  assert.strictEqual((await form(app, U, "/api/mailings", { payload: { ...base, recipients: [] } })).status, 400);
  assert.strictEqual((await form(app, U, "/api/mailings", { payload: { ...base, recipients: [{ emails: ["bad@"] }] } })).status, 400);
  assert.strictEqual((await form(app, U, "/api/mailings", { payload: { ...base, subject: "" } })).status, 400);
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const r = await form(app, U, "/api/mailings", { payload: base, attachments: [{ name: "a.bin", content: big }, { name: "b.bin", content: big }] });
  assert.strictEqual(r.status, 400);
  await Adm.put("/api/mailings/settings", { from: "" });
  assert.match((await form(app, U, "/api/mailings", { payload: base })).json.error, /Общий ящик не настроен/);
  // Сотруднику настройки видны без логина и пароля сервера.
  const s = (await U.get("/api/mailings/settings")).json;
  assert.strictEqual(s.host, undefined);
  assert.strictEqual(s.hasPassword, undefined);
});

test("пауза и продолжение: остановленная рассылка не шлёт, после продолжения досылает", async (t) => {
  const { app, smtp, U, Adm } = await стенд(t);
  await Adm.put("/api/mailings/settings", { delayMs: 150 });
  const recipients = Array.from({ length: 6 }, (_, i) => ({ row_no: i + 2, emails: [`r${i}@example.invalid`] }));
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Т", body: "Б", sender_mode: "shared", recipients } });
  await дождаться(U, r.json.id, (x) => x.campaign.sent >= 1);
  assert.strictEqual((await U.post(`/api/mailings/${r.json.id}/pause`, {})).status, 200);
  await new Promise((res) => setTimeout(res, 500));
  const paused = (await U.get(`/api/mailings/${r.json.id}`)).json.campaign;
  assert.strictEqual(paused.status, "paused");
  assert.ok(paused.sent < 6);
  const before = smtp.messages.length;
  await new Promise((res) => setTimeout(res, 400));
  assert.strictEqual(smtp.messages.length, before, "на паузе не отправляется");
  assert.strictEqual((await U.post(`/api/mailings/${r.json.id}/resume`, {})).status, 200);
  const done = await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(done.campaign.sent, 6);
  assert.strictEqual(new Set(smtp.messages.filter((m) => m.subject === "Т").map((m) => m.to[0])).size, 6, "каждому ровно одно");
});
