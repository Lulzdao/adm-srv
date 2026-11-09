'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// zip.js — один файл на три службы: services/zip.js здесь, SMDR/web-node/zip.js у журнала
// звонков и CERTVIEWER/zip.js у Сертвивера. Общей папки у служб нет, поэтому это копии;
// тест не даёт копиям разойтись. Такой же тест лежит у обеих служб (test/zipShared.test.js).
for (const [label, rel] of [["журнала звонков", ["SMDR", "web-node", "zip.js"]], ["Сертвивера", ["CERTVIEWER", "zip.js"]]]) {
  test(`zip.js платформы и ${label} совпадают байт в байт`, (t) => {
    const mine = path.join(__dirname, "..", "services", "zip.js");
    const other = path.join(__dirname, "..", "..", ...rel);
    if (!fs.existsSync(other)) return t.skip("служба стоит отдельно — сверить не с чем");
    const norm = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    assert.strictEqual(norm(mine), norm(other),
      `файлы разошлись: правку zip.js нужно скопировать (cp helpdesk-backend/services/zip.js ${rel.join("/")})`);
  });
}

test("запись из сжатых кусков читается обратно; crc32 считается и по кускам", () => {
  const zlib = require("node:zlib");
  const { ZipBuilder, readZip, crc32 } = require("../services/zip");
  const data = Buffer.from("Привет, журнал! ".repeat(500), "utf8");
  const z = new ZipBuilder(new Date(2026, 9, 1, 12, 0, 0));
  z.add("обычная.txt", "текст");
  // Как при потоковой выгрузке: сжато двумя кусками, crc набран по частям.
  const half = Math.floor(data.length / 2);
  const packed = zlib.deflateRawSync(data);
  z.addCompressed("поток.xml", [packed.subarray(0, 100), packed.subarray(100)], crc32(data.subarray(half), crc32(data.subarray(0, half))), data.length);
  const files = readZip(z.finish());
  assert.deepStrictEqual([...files.keys()], ["обычная.txt", "поток.xml"]);
  assert.ok(files.get("поток.xml").equals(data));
  assert.strictEqual(crc32(data), zlib.crc32(data));
});
