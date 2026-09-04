'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const departments = require("../config/departments");

// ============================================================================
//  Экран «Новая заявка»
//
//  Отдел выбирается плитками, и всё, что на плитке написано, приезжает с
//  сервера из config/departments.js. Проверяем именно стык: если поля перестанут
//  доходить до фронтенда, плитки молча станут одинаковыми серыми коробками с
//  одним названием — сломается не приложение, а способность человека понять,
//  куда он отправляет заявку.
//
//  Учётные данные и имена здесь выдуманы.
// ============================================================================

async function stand(t) {
  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });
  await makeLocalUser(db, { login: "!сотрудник", name: "Сотрудник Тестовый", role: "user" });
  const кл = client(app.url);
  await кл.login("!сотрудник");
  return { db, app, кл };
}

test("/departments отдаёт подпись, значок и цвет каждого отдела", async (t) => {
  const { кл } = await stand(t);

  const r = await кл.get("/api/departments");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.departments.length, departments.length);

  for (const d of departments) {
    const пришло = r.json.departments.find((x) => x.name === d.name);
    assert.ok(пришло, `отдел ${d.name} не пришёл на фронтенд`);
    assert.strictEqual(пришло.hint, d.hint || "");
    assert.strictEqual(пришло.icon, d.icon || "");
    assert.strictEqual(пришло.color, d.color || "");
  }
});

test("у каждого отдела есть подпись — без неё плитка ничего не объясняет", () => {
  for (const d of departments) {
    assert.ok(d.hint && d.hint.trim(),
      `у отдела ${d.name} не заполнен hint в config/departments.js: `
      + "«ЕГРПО» или «ХОЗ» человеку со стороны ни о чём не говорят");
  }
});

test("значок отдела есть в наборе значков фронтенда", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const блок = src.slice(src.indexOf("const ICON_PATHS"), src.indexOf("function icon("));
  for (const d of departments) {
    if (!d.icon) continue;
    // Имя значка может быть в кавычках ('chevron-left') или без.
    const есть = new RegExp(`(^|\\n)\\s*'?${d.icon}'?:`).test(блок);
    assert.ok(есть, `значок «${d.icon}» отдела ${d.name} не найден в ICON_PATHS — плитка нарисуется пустой`);
  }
});

// ---------------------------------------------------------------------------
//  Обязательные поля
//
//  Форма не даёт отправить заявку с пустыми полями, и это проверяется в
//  браузере. Здесь закрепляем то, ради чего проверка вообще существует:
//  список полей и то, что каждое из них действительно доезжает до базы.
// ---------------------------------------------------------------------------

test("заполненная заявка сохраняет все поля формы", async (t) => {
  const { кл } = await stand(t);

  const r = await кл.post("/api/tickets", {
    title: "Не открывается сетевой диск",
    description: "С утра просит пароль и не подключается. Перезагрузка не помогла.",
    category: departments[1].name,
    priority: "high",
    room: "214",
    extension: "4417",
  });
  assert.strictEqual(r.status, 201);

  const { json } = await кл.get(`/api/tickets/${r.json.id}`);
  const t2 = json.ticket;
  assert.strictEqual(t2.title, "Не открывается сетевой диск");
  assert.strictEqual(t2.description, "С утра просит пароль и не подключается. Перезагрузка не помогла.");
  assert.strictEqual(t2.category, departments[1].name);
  assert.strictEqual(t2.priority, "high");
  assert.strictEqual(t2.room, "214");
  assert.strictEqual(t2.extension, "4417");
});

test("во фронтенде обязательными помечены все поля, кроме вложений", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const блок = src.slice(src.indexOf("const ОБЯЗАТЕЛЬНЫЕ"), src.indexOf("ОБЯЗАТЕЛЬНЫЕ.forEach"));
  for (const поле of ["titleEl", "descEl", "roomEl", "extEl"]) {
    assert.ok(блок.includes(поле), `поле ${поле} выпало из списка обязательных`);
  }
  // Вложения обязательными не делаем сознательно: к заявке «не открывается
  // диск» прикладывать нечего, и требование файла заставило бы людей
  // прикладывать что попало.
  assert.ok(!блок.includes("fileList") && !блок.includes("files"),
    "вложения не должны быть в списке обязательных полей");
});
