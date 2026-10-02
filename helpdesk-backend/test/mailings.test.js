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
    host: "127.0.0.1", port: smtp.port, secure: false, delayMs: 0, signature: "Выдуманный статорган",
  });
  assert.strictEqual(r.status, 200, r.text);
  // Общий ящик без пароля: поддельный приёмник принимает письма без входа.
  const box = await Adm.post("/api/mailings/settings/mailboxes", { address: "rassylka@example.invalid" });
  assert.strictEqual(box.status, 201, box.text);
  t.after(async () => { await app.close(); await smtp.close(); cleanup(); });
  return { db, app, smtp, Adm, U, U2, box: box.json.id };
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

const LIST_CSV = "ОКПО;Наименование;Почта;Форма\r\n01234567;ООО \"Выдуманное\";one@example.invalid;1-Т\r\n12345678;АО Пробное;\"two@example.invalid; three@example.invalid\";П-1\r\n23456789;ИП Без адреса;;П-4\r\n34567890;ЗАО Опечатка;bad@;1-Т\r\n45678901;ООО Повтор;one@example.invalid;1-Т\r\n";

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
    payload: { subject: "Отчёт по форме {Форма}", body: "Напоминаем о сдаче формы {Форма}.", use_template: true, sender_mode: "shared", mailbox_id: 1, recipients },
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

test("несколько адресов в ячейке — через «; »: письмо уходит на все, в списке и отчёте они через «; »", async (t) => {
  const { app, smtp, U } = await стенд(t);
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Тема", body: "Текст", use_template: false, sender_mode: "shared", mailbox_id: 1,
    recipients: [{ row_no: 2, okpo: "1", name: "А", emails: ["one@example.invalid", "two@example.invalid"] }] } });
  assert.strictEqual(r.status, 201, r.text);
  const done = await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(done.recipients[0].emails, "one@example.invalid; two@example.invalid");
  const sent = smtp.messages.find((m) => m.subject === "Тема");
  assert.deepStrictEqual([...sent.to].sort(), ["one@example.invalid", "two@example.invalid"]);
});

test("оформленный текст: письмо уходит в HTML и текстом, опасное вырезано, значения из таблицы экранированы", async (t) => {
  const { app, smtp, U } = await стенд(t);
  const html = `<p><b>Жирный</b> <i>курсив</i> <span style="font-size: 18px; font-family: 'Times New Roman'; color: rgb(192, 0, 0); position: fixed">крупный</span></p>`
    + `<p onclick="x()">Для {Наименование}</p><script>alert(1)</script><img src="http://example.invalid/t.png"><a href="javascript:alert(1)">плохая</a> <a href="https://example.invalid/">хорошая</a>`;
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Тема", body: "", body_html: html, use_template: true, sender_mode: "shared", mailbox_id: 1,
    recipients: [{ row_no: 2, okpo: "1", name: "ООО <Выдуманное>", emails: ["one@example.invalid"] }] } });
  assert.strictEqual(r.status, 201, r.text);
  const done = await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  const msg = smtp.messages.find((m) => m.subject === "Тема");
  const raw = msg.raw;
  assert.match(raw, /Content-Type: text\/html/i, "есть оформленная часть");
  assert.match(raw, /Content-Type: text\/plain/i, "есть и текстовая — для программ без HTML");
  const htmlPart = done.preview_html;
  assert.match(htmlPart, /<b>Жирный<\/b> <i>курсив<\/i> <span style="font-size: 18px; font-family: 'Times New Roman'; color: rgb\(192, 0, 0\)">крупный<\/span>/);
  assert.match(htmlPart, /Для ООО &lt;Выдуманное&gt;/, "значение из таблицы экранировано");
  assert.match(htmlPart, /Здравствуйте, уважаемый респондент!<br>ОКПО: 1<br>Наименование: ООО &lt;Выдуманное&gt;/);
  for (const bad of ["<script", "onclick", "<img", "javascript:", "position"]) assert.ok(!htmlPart.includes(bad), `вырезано: ${bad}`);
  assert.match(htmlPart, /<a href="https:\/\/example\.invalid\/" target="_blank" rel="noopener">хорошая<\/a>/);
  assert.match(done.preview, /Жирный курсив крупный\n\nДля ООО <Выдуманное>/, "текстовая версия — без разметки");
});

test("отказ сервера по адресу — строка «не отправлено» с причиной; повтор неотправленных", async (t) => {
  const { app, smtp, U } = await стенд(t, { rejectRecipient: "two@example.invalid" });
  const recipients = [
    { row_no: 2, okpo: "1", name: "А", emails: ["one@example.invalid"] },
    { row_no: 3, okpo: "2", name: "Б", emails: ["two@example.invalid"] },
  ];
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Тема", body: "Текст", use_template: false, sender_mode: "shared", mailbox_id: 1, recipients } });
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
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Т", body: "Б", sender_mode: "shared", mailbox_id: 1, recipients: [{ row_no: 2, emails: ["one@example.invalid"] }] } });
  for (const [m, p] of [["get", ""], ["post", "/pause"], ["post", "/cancel"], ["post", "/retry"], ["delete", ""]]) {
    assert.strictEqual((await U2[m](`/api/mailings/${r.json.id}${p}`, {})).status, 403, `${m} ${p}`);
  }
  assert.strictEqual((await U2.get("/api/mailings")).json.campaigns.length, 0);
  assert.strictEqual((await Adm.get("/api/mailings")).json.campaigns.length, 1);
  assert.strictEqual((await Adm.get(`/api/mailings/${r.json.id}`)).status, 200);
});

test("проверки формы: пустой список, кривой адрес, слишком большие вложения, общий ящик не настроен", async (t) => {
  const { app, U, Adm } = await стенд(t);
  const base = { subject: "Т", body: "Б", sender_mode: "shared", mailbox_id: 1, recipients: [{ row_no: 2, emails: ["one@example.invalid"] }] };
  assert.strictEqual((await form(app, U, "/api/mailings", { payload: { ...base, recipients: [] } })).status, 400);
  assert.strictEqual((await form(app, U, "/api/mailings", { payload: { ...base, recipients: [{ emails: ["bad@"] }] } })).status, 400);
  assert.strictEqual((await form(app, U, "/api/mailings", { payload: { ...base, subject: "" } })).status, 400);
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const r = await form(app, U, "/api/mailings", { payload: base, attachments: [{ name: "a.bin", content: big }, { name: "b.bin", content: big }] });
  assert.strictEqual(r.status, 400);
  assert.match((await form(app, U, "/api/mailings", { payload: { ...base, mailbox_id: 999 } })).json.error, /Выберите общий ящик/);
  // Сотруднику настройки видны без логина и пароля сервера.
  const s = (await U.get("/api/mailings/settings")).json;
  assert.strictEqual(s.host, undefined);
  assert.strictEqual(s.hasPassword, undefined);
});

test("пауза и продолжение: остановленная рассылка не шлёт, после продолжения досылает", async (t) => {
  const { app, smtp, U, Adm } = await стенд(t);
  await Adm.put("/api/mailings/settings", { delayMs: 150 });
  const recipients = Array.from({ length: 6 }, (_, i) => ({ row_no: i + 2, emails: [`r${i}@example.invalid`] }));
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Т", body: "Б", sender_mode: "shared", mailbox_id: 1, recipients } });
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

test("общие ящики отделов: каждый видят участники своей группы, ящик без группы — все", async (t) => {
  const { app, db, U, U2, Adm } = await стенд(t);
  const { packGroups } = require("../services/userStore");
  // Группы кладём, как их записал бы вход через домен (см. domainLogin.test.js).
  db.prepare("UPDATE users SET ad_groups = ? WHERE ad_login = 'u1'").run(packGroups(["Рассылка-Цены", "Прочая"]));
  db.prepare("UPDATE users SET ad_groups = ? WHERE ad_login = 'u2'").run(packGroups(["Рассылка-Сводный"]));
  const prices = (await Adm.post("/api/mailings/settings/mailboxes", { address: "ceny@example.invalid", ad_group: "рассылка-цены" })).json.id;
  const svod = (await Adm.post("/api/mailings/settings/mailboxes", { address: "svod@example.invalid", ad_group: "Рассылка-Сводный" })).json.id;
  assert.strictEqual((await Adm.post("/api/mailings/settings/mailboxes", { address: "ceny@example.invalid" })).status, 400, "повтор адреса");
  assert.strictEqual((await Adm.post("/api/mailings/settings/mailboxes", { address: "не адрес" })).status, 400);

  const addr = async (C) => (await C.get("/api/mailings/settings")).json.mailboxes.map((b) => b.address).sort();
  assert.deepStrictEqual(await addr(U), ["ceny@example.invalid", "rassylka@example.invalid"]);
  assert.deepStrictEqual(await addr(U2), ["rassylka@example.invalid", "svod@example.invalid"]);

  const base = { subject: "Т", body: "Б", sender_mode: "shared", recipients: [{ row_no: 2, emails: ["one@example.invalid"] }] };
  const denied = await form(app, U2, "/api/mailings", { payload: { ...base, mailbox_id: prices } });
  assert.strictEqual(denied.status, 400);
  assert.match(denied.json.error, /только участникам его группы/);
  const ok = await form(app, U2, "/api/mailings", { payload: { ...base, mailbox_id: svod } });
  assert.strictEqual(ok.status, 201, ok.text);
  assert.strictEqual(db.prepare("SELECT sender_address FROM mail_campaigns WHERE id = ?").get(ok.json.id).sender_address, "svod@example.invalid");

  // Администратор видит все ящики с группами, но не пароли.
  const s = (await Adm.get("/api/mailings/settings")).json;
  assert.deepStrictEqual(s.allMailboxes.map((b) => [b.address, b.ad_group]).sort(),
    [["ceny@example.invalid", "рассылка-цены"], ["rassylka@example.invalid", ""], ["svod@example.invalid", "Рассылка-Сводный"]]);
  assert.ok(!JSON.stringify(s).includes("password\":\""));
  // Группу у ящика убрали — он виден всем.
  assert.strictEqual((await Adm.put(`/api/mailings/settings/mailboxes/${prices}`, { ad_group: "" })).status, 200);
  assert.ok((await addr(U2)).includes("ceny@example.invalid"));
  // Сотруднику управлять ящиками нельзя.
  assert.strictEqual((await U.post("/api/mailings/settings/mailboxes", { address: "x@example.invalid" })).status, 403);
  assert.strictEqual((await U.delete(`/api/mailings/settings/mailboxes/${svod}`)).status, 403);
});

test("ящик сменил пароль — новый действует сразу; ящик удалили — рассылка встаёт на паузу", async (t) => {
  const smtpAuth = { user: "otdel@example.invalid", pass: "пароль-приложения-2" };
  const { app, U, Adm, smtp } = await стенд(t, { auth: smtpAuth });
  const id = (await Adm.post("/api/mailings/settings/mailboxes", { address: "otdel@example.invalid", password: "старый" })).json.id;
  const bad = (await Adm.post(`/api/mailings/settings/mailboxes/${id}/verify`, {})).json;
  assert.strictEqual(bad.ok, false);
  await Adm.put(`/api/mailings/settings/mailboxes/${id}`, { password: "пароль-приложения-2" });
  assert.deepStrictEqual((await Adm.post(`/api/mailings/settings/mailboxes/${id}/verify`, {})).json, { ok: true });
  // Пустой пароль при правке — «не менять».
  await Adm.put(`/api/mailings/settings/mailboxes/${id}`, { password: "", ad_group: "" });
  assert.strictEqual((await Adm.post(`/api/mailings/settings/mailboxes/${id}/verify`, {})).json.ok, true);

  await Adm.put("/api/mailings/settings", { delayMs: 300 });
  const recipients = Array.from({ length: 5 }, (_, i) => ({ row_no: i + 2, emails: [`r${i}@example.invalid`] }));
  const r = await form(app, U, "/api/mailings", { payload: { subject: "Т", body: "Б", sender_mode: "shared", mailbox_id: id, recipients } });
  assert.strictEqual(r.status, 201, r.text);
  await дождаться(U, r.json.id, (x) => x.campaign.sent >= 1);
  assert.strictEqual(smtp.messages[0].login, "otdel@example.invalid", "логин — адрес ящика");
  await Adm.delete(`/api/mailings/settings/mailboxes/${id}`);
  const paused = await дождаться(U, r.json.id, (x) => x.campaign.status === "paused");
  assert.match(paused.campaign.paused_reason, /удалён из настроек/);
});

test("сервер требует пароль приложения — так и написано по-русски, а не транслитом сервера", () => {
  const { describeError } = require("../services/mailer");
  for (const text of [
    "Invalid login: 535 5.7.0 NEOBHODIM parol prilozheniya / Application password is REQUIRED",
    "Invalid login: 535 5.7.8 Error: authentication failed: This user does not have access rights to this service or app password required",
  ]) assert.match(describeError({ code: "EAUTH", message: text }), /требует пароль приложения/);
  assert.match(describeError({ code: "EAUTH", message: "535 5.7.8 Authentication failed" }), /отверг логин или пароль/);
});

test("повтор со своего ящика после завершения: сначала просит пароль, с паролем — отправляет", async (t) => {
  // Раньше повтор сначала возвращал неотправленные в очередь, а потом отказывал
  // «Введите пароль» — и следующая попытка уже с паролем отвечала «неотправленных нет».
  const { app, smtp, U } = await стенд(t, { rejectRecipient: "two@example.invalid", auth: { user: "u1@example.invalid", pass: "верный-пароль" } });
  const r = await form(app, U, "/api/mailings", { payload: {
    subject: "Т", body: "Б", sender_mode: "own", own_address: "u1@example.invalid", own_password: "верный-пароль",
    recipients: [{ row_no: 2, emails: ["one@example.invalid"] }, { row_no: 3, emails: ["two@example.invalid"] }],
  } });
  assert.strictEqual(r.status, 201, r.text);
  const done = await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(done.campaign.failed, 1);

  const noPass = await U.post(`/api/mailings/${r.json.id}/retry`, {});
  assert.strictEqual(noPass.status, 400);
  assert.match(noPass.json.error, /Введите пароль/);
  assert.strictEqual((await U.get(`/api/mailings/${r.json.id}`)).json.campaign.failed, 1, "отказ ничего не поменял");

  smtp.reset();
  const withPass = await U.post(`/api/mailings/${r.json.id}/retry`, { password: "верный-пароль" });
  assert.strictEqual(withPass.status, 200, withPass.text);
  const again = await дождаться(U, r.json.id, (x) => x.campaign.status === "done");
  assert.strictEqual(again.campaign.failed, 1, "адрес по-прежнему отклоняется — но попытка была");
  assert.ok(smtp.messages.some((m) => m.subject.startsWith("Отчёт")), "повтор прошёл до конца");
});
