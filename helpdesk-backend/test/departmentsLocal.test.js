'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// ============================================================================
//  Свой список отделов: config/departments.local.js
//
//  Встроенный departments.js обновление перезаписывает — на сервере так и
//  пропали дописанные отделы. Свой список живёт в .local.js, и если он есть,
//  платформа берёт отделы из него. Проверяем на копии файла во временной
//  папке, чтобы не трогать config/ рабочей копии.
// ============================================================================

const SRC = path.join(__dirname, "..", "config", "departments.js");

function names(localContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "depts-"));
  try {
    fs.copyFileSync(SRC, path.join(dir, "departments.js"));
    if (localContent !== undefined) fs.writeFileSync(path.join(dir, "departments.local.js"), localContent);
    return execFileSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(path.join(dir, "departments.js"))}).map((d) => d.name)))`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("без departments.local.js — встроенный список", () => {
  assert.deepEqual(JSON.parse(names()), ["ИТ", "ХОЗ", "ЕГРПО"]);
});

test("departments.local.js есть — список целиком из него (так переживает обновление)", () => {
  const local = `module.exports = [
    { name: "ИТ", prefix: "ИТ", role: "it" },
    { name: "БУХ", prefix: "БУХ", role: "buh" },
  ];`;
  assert.deepEqual(JSON.parse(names(local)), ["ИТ", "БУХ"]);
});

test("битый departments.local.js — запуск падает с понятной причиной, а не молча берёт встроенный", () => {
  for (const bad of ["module.exports = [];", "module.exports = [{ name: \"БУХ\" }];", "module.exports = [{ name: \"Б\", prefix: \"Б\", role: \"бух\" }];"]) {
    assert.throws(() => names(bad), (err) => /departments\.local\.js: нужен непустой список/.test(String(err.stderr)), bad);
  }
});

test("обновление не трогает *.local.js: он в защищённом списке update.ps1 и в .gitignore", () => {
  const ps = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "update.ps1"), "utf8");
  const block = ps.slice(ps.indexOf("$Protected = @("), ps.indexOf("$NoRestart"));
  assert.ok(block.includes(String.raw`'(^|\\)[^\\]*\.local\.js$'`), "шаблон *.local.js в $Protected");
  assert.match(fs.readFileSync(path.join(__dirname, "..", "..", ".gitignore"), "utf8"), /^\*\.local\.js$/m);
});
