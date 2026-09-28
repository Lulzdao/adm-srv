'use strict';

const test = require("node:test");
const assert = require("node:assert");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const config = require("../config/config");

// ============================================================================
//  Имена доменов
//
//  Раньше «Домен А» и «Домен Б» были вписаны прямо в разметку экрана входа и
//  раздела администрирования. Настоящие имена — rosstat.local и in.local, и
//  задаются они в .env (DOMAIN_A_LABEL / DOMAIN_B_LABEL). Значит, фронтенду их
//  обязан отдавать сервер: иначе при смене имени пришлось бы править разметку.
//
//  Ключи A и B в API остались — это ключи настроек, а не то, что видит
//  пользователь.
//
//  Учётные данные и имена здесь выдуманы.
// ============================================================================

async function stand(t) {
  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });
  return { db, app };
}

// На боевом сервере подписи задаются в .env, и жёстко сверяться с ними
// нельзя — тест упал бы у администратора, который их поменял. Проверяем
// умолчания только тогда, когда переменных нет.
test("значения по умолчанию — настоящие имена доменов", (t) => {
  if (process.env.DOMAIN_A_LABEL || process.env.DOMAIN_B_LABEL) {
    t.skip("подписи заданы в .env");
    return;
  }
  assert.strictEqual(config.domains.A.label, "rosstat.local");
  assert.strictEqual(config.domains.B.label, "in.local");
});

test("/auth/detect отдаёт подписи доменов вместе с режимом", async (t) => {
  const { app } = await stand(t);
  const кл = client(app.url);

  const r = await кл.get("/api/auth/detect");
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(
    { ...r.json.labels },
    { A: config.domains.A.label, B: config.domains.B.label },
    "без подписей на вкладках выбора сети было бы «undefined»"
  );
  assert.ok(r.json.labels.A && r.json.labels.B, "подпись домена не должна быть пустой");
});

test("/admin/settings отдаёт подписи доменов администратору", async (t) => {
  const { db, app } = await stand(t);
  await makeLocalUser(db, { login: "!админ", name: "Админ Тестовый", isAdmin: true });
  const кл = client(app.url);
  await кл.login("!админ");

  const r = await кл.get("/api/admin/settings");
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(
    { ...r.json.domainLabels },
    { A: config.domains.A.label, B: config.domains.B.label },
    "подписями подписаны поля групп АД и плашка последнего входа"
  );
});

test("в разметке фронтенда не осталось «Домен А» и «Домен Б»", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // Именно с большой буквы и с русской буквой домена — так была написана
  // прежняя подпись. Слово «домен» в обычном тексте и комментариях трогать
  // незачем.
  assert.strictEqual(/Домен\s+[АБ]/.test(app), false);
});
