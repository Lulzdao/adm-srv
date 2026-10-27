const express = require("express");
const multer = require("multer");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendFile } = require("../services/assistant");
const { DOCX_TYPE } = require("../services/docx");
const { parseLogins } = require("../services/executorGroups");
const B = require("../services/bulletins");

// ============================================================================
//  Бюллетени
//
//  Сотрудник группы загружает таблицу из ЦСОД, выбирает форму (или она
//  определяется по заголовку таблицы) и получает готовый документ Word.
//  Формы правят группы с правом управления — только формы своей группы;
//  группы и их наборы форм заводит администратор платформы.
//
//  Права — на каждом маршруте по базе, а не по пункту меню: скрытая кнопка
//  защитой не считается.
// ============================================================================

const handle = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.catch === "function") out.catch((err) => (err instanceof B.BulletinError ? res.status(400).json({ error: err.message }) : next(err)));
  } catch (err) {
    if (err instanceof B.BulletinError) return res.status(400).json({ error: err.message });
    next(err);
  }
};
const fail = (msg) => { throw new B.BulletinError(msg); };
const parseId = (raw) => (/^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null);

const MAX_MB = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: "utf8",
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 10 },
}).single("file");
const withUpload = (req, res, next) => upload(req, res, (err) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: `Файл больше ${MAX_MB} МБ` });
  return res.status(400).json({ error: err.message });
});

/** Поле payload из multipart — JSON с остальными данными формы. */
function payloadOf(req) {
  if (typeof req.body.payload !== "string") return {};
  try { return JSON.parse(req.body.payload) || {}; } catch { fail("Данные формы повреждены — обновите страницу"); }
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,()«»"№-]{0,79}$/u;
function checkName(name, what) {
  const v = typeof name === "string" ? name.trim() : "";
  if (!NAME_RE.test(v)) fail(`${what} — от 1 до 80 знаков: буквы, цифры, пробел и знаки . , ( ) « » № -`);
  return v;
}

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
function checkDate(raw) {
  if (raw === undefined || raw === null || raw === "") {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  }
  const m = DATE_RE.exec(String(raw).trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 31 || Number(m[2]) < 1 || Number(m[2]) > 12) fail("Дата документа — в виде ДД.ММ.ГГГГ");
  return m[0];
}

const isDocx = (file) => file && file.buffer.length > 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;

module.exports = function bulletinRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);

  const formRow = db.prepare("SELECT * FROM bulletin_forms WHERE id = ?");
  const loadForm = (id) => {
    const row = formRow.get(id);
    // node:sqlite отдаёт BLOB как Uint8Array, а разбор zip ждёт Buffer.
    return row ? { ...row, template: Buffer.from(row.template), settings: B.parseSettings(row.settings) } : null;
  };
  const formGroups = db.prepare("SELECT group_id FROM bulletin_group_forms WHERE form_id = ?");

  /** Форма, которой человек может управлять, — иначе 404 (не выдаём, что она есть). */
  function managedForm(req) {
    const id = parseId(req.params.id);
    const a = B.access(db, req.session.user);
    const form = id && a.manageIds.includes(id) ? loadForm(id) : null;
    return { form, a };
  }

  // -------------------------------------------------------------------------
  //  Для сотрудников групп
  // -------------------------------------------------------------------------

  router.get("/", (req, res) => {
    const a = B.access(db, req.session.user);
    const rows = a.formIds.length
      ? db.prepare(`SELECT id, name, settings, updated_by, updated_at FROM bulletin_forms WHERE id IN (${a.formIds.map(() => "?").join(",")}) ORDER BY name`).all(...a.formIds)
      : [];
    res.json({
      forms: rows.map((f) => ({
        id: f.id, name: f.name, sign: B.parseSettings(f.settings).sign,
        canEdit: a.manageIds.includes(f.id), updated_by: f.updated_by, updated_at: f.updated_at,
      })),
      groups: a.groups,
      canManage: B.canManageAny(a),
      manageGroups: a.manageGroups,
      admin: a.admin,
    });
  });

  router.post("/make", withUpload, handle((req, res) => {
    if (!req.file) fail("Выберите файл таблицы из ЦСОД (.xlsx или .xls)");
    const a = B.access(db, req.session.user);
    const date = checkDate(req.body.date);
    let form;
    const wanted = parseId(req.body.form_id);
    if (wanted) {
      form = a.formIds.includes(wanted) ? loadForm(wanted) : null;
      if (!form) fail("Эта форма вам недоступна");
    } else {
      const mine = a.formIds.map(loadForm).filter(Boolean);
      const found = B.matchingForms(req.file.buffer, mine);
      if (found.length !== 1) {
        fail(found.length
          ? `Таблица подходит к нескольким формам (${found.map((f) => `«${f.name}»`).join(", ")}) — выберите форму сами`
          : "Не удалось определить форму по заголовку таблицы — выберите её сами");
      }
      form = found[0];
    }
    const out = B.makeDocument({ table: req.file.buffer, template: form.template, settings: form.settings, date });
    sendFile(res, out.docx, B.outputName(form, out.period), DOCX_TYPE);
  }));

  // -------------------------------------------------------------------------
  //  Управление формами — группам с правом управления и администраторам
  // -------------------------------------------------------------------------

  router.get("/forms/:id", handle((req, res) => {
    const { form, a } = managedForm(req);
    if (!form) return res.status(404).json({ error: "Нет такой формы" });
    res.json({
      id: form.id, name: form.name, settings: form.settings, filename: form.filename,
      updated_by: form.updated_by, updated_at: form.updated_at,
      groups: formGroups.all(form.id).map((r) => r.group_id),
      warnings: B.checkFormTemplate(form.template, form.settings),
      admin: a.admin,
    });
  }));

  router.get("/forms/:id/template", handle((req, res) => {
    const { form } = managedForm(req);
    if (!form) return res.status(404).json({ error: "Нет такой формы" });
    sendFile(res, form.template, form.filename, DOCX_TYPE);
  }));

  // Новая форма: шаблон обязателен. Кто управляет не всеми формами, кладёт её
  // в одну из своих групп — иначе после сохранения он бы её больше не увидел.
  router.post("/forms", withUpload, handle((req, res) => {
    const a = B.access(db, req.session.user);
    if (!B.canManageAny(a)) return res.status(403).json({ error: "Недостаточно прав" });
    const p = payloadOf(req);
    const name = checkName(p.name, "Название формы");
    const settings = B.normalizeSettings(p.settings);
    if (!isDocx(req.file)) fail("Выберите шаблон Word (.docx)");
    const warnings = B.checkFormTemplate(req.file.buffer, settings);
    let groupId = parseId(p.group_id);
    if (!a.admin) {
      if (!groupId && a.manageGroups.length === 1) groupId = a.manageGroups[0].id;
      if (!groupId || !a.manageGroups.some((g) => g.id === groupId)) fail("Выберите группу, в которую добавить форму");
    } else if (groupId && !db.prepare("SELECT 1 FROM bulletin_groups WHERE id = ?").get(groupId)) fail("Нет такой группы");
    if (db.prepare("SELECT 1 FROM bulletin_forms WHERE name = ? COLLATE NOCASE").get(name)) fail(`Форма «${name}» уже есть`);
    const info = db.prepare("INSERT INTO bulletin_forms (name, settings, filename, template, updated_by) VALUES (?, ?, ?, ?, ?)")
      .run(name, JSON.stringify(settings), req.file.originalname || `${name}.docx`, req.file.buffer, req.session.user.full_name);
    const id = Number(info.lastInsertRowid);
    if (groupId) db.prepare("INSERT INTO bulletin_group_forms (group_id, form_id) VALUES (?, ?)").run(groupId, id);
    res.status(201).json({ id, warnings });
  }));

  // Правка: название и правила; шаблон — только если приложен новый.
  router.put("/forms/:id", withUpload, handle((req, res) => {
    const { form } = managedForm(req);
    if (!form) return res.status(404).json({ error: "Нет такой формы" });
    const p = payloadOf(req);
    const name = checkName(p.name, "Название формы");
    const settings = B.normalizeSettings(p.settings);
    if (req.file && !isDocx(req.file)) fail("Шаблон — документ Word (.docx)");
    const template = req.file ? req.file.buffer : form.template;
    const warnings = B.checkFormTemplate(template, settings);
    if (db.prepare("SELECT 1 FROM bulletin_forms WHERE name = ? COLLATE NOCASE AND id != ?").get(name, form.id)) fail(`Форма «${name}» уже есть`);
    db.prepare(`UPDATE bulletin_forms SET name = ?, settings = ?, filename = ?, template = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, JSON.stringify(settings), req.file ? (req.file.originalname || form.filename) : form.filename, template, req.session.user.full_name, form.id);
    res.json({ ok: true, warnings });
  }));

  router.delete("/forms/:id", handle((req, res) => {
    const { form } = managedForm(req);
    if (!form) return res.status(404).json({ error: "Нет такой формы" });
    db.prepare("DELETE FROM bulletin_forms WHERE id = ?").run(form.id);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  //  Группы — только администраторы платформы
  // -------------------------------------------------------------------------

  const groups = express.Router();
  groups.use(requireAdmin);

  const known = db.prepare("SELECT full_name FROM users WHERE ad_login = ? COLLATE NOCASE");
  groups.get("/", (req, res) => {
    const links = db.prepare("SELECT group_id, form_id FROM bulletin_group_forms").all();
    res.json({
      groups: db.prepare("SELECT * FROM bulletin_groups ORDER BY name").all().map((g) => ({
        id: g.id, name: g.name, ad_groups: B.lines(g.ad_groups), can_manage: Boolean(g.can_manage),
        // Логин и ФИО, если человек уже входил: так видно опечатку в логине.
        logins: parseLogins(g.logins).map((login) => ({ login, name: (known.get(login) || {}).full_name || null })),
        forms: links.filter((l) => l.group_id === g.id).map((l) => l.form_id),
      })),
      forms: db.prepare("SELECT id, name FROM bulletin_forms ORDER BY name").all(),
    });
  });

  function groupFields(body) {
    const name = checkName(body.name, "Название группы");
    const adGroups = typeof body.ad_groups === "string" ? B.lines(body.ad_groups) : fail("Группы домена — текстом, по одной на строку");
    if (adGroups.length > 20 || adGroups.some((g) => g.length > 100)) fail("Групп домена — не больше 20, каждая до 100 знаков");
    if (typeof body.logins !== "string" || body.logins.length > 5000) fail("Логины — текстом, до 5000 знаков");
    const logins = parseLogins(body.logins);
    if (logins.length > 200 || logins.some((l) => l.length > 64 || !/^[\p{L}\p{N}._$-]+$/u.test(l))) {
      fail("В списке логинов есть недопустимый — пишите логины домена, по одному на строку");
    }
    const forms = Array.isArray(body.forms) ? body.forms.map(parseId) : fail("Формы группы — списком");
    if (forms.some((id) => !id || !formRow.get(id))) fail("В списке форм есть несуществующая");
    return { name, adGroups, logins, canManage: Boolean(body.can_manage), forms: [...new Set(forms)] };
  }

  function saveForms(groupId, forms) {
    db.prepare("DELETE FROM bulletin_group_forms WHERE group_id = ?").run(groupId);
    const add = db.prepare("INSERT INTO bulletin_group_forms (group_id, form_id) VALUES (?, ?)");
    for (const f of forms) add.run(groupId, f);
  }

  groups.post("/", handle((req, res) => {
    const g = groupFields(req.body || {});
    if (db.prepare("SELECT 1 FROM bulletin_groups WHERE name = ? COLLATE NOCASE").get(g.name)) fail(`Группа «${g.name}» уже есть`);
    db.exec("BEGIN");
    try {
      const info = db.prepare("INSERT INTO bulletin_groups (name, ad_groups, logins, can_manage) VALUES (?, ?, ?, ?)")
        .run(g.name, g.adGroups.join("\n"), g.logins.join("\n"), g.canManage ? 1 : 0);
      saveForms(Number(info.lastInsertRowid), g.forms);
      db.exec("COMMIT");
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (err) { db.exec("ROLLBACK"); throw err; }
  }));

  groups.put("/:id", handle((req, res) => {
    const id = parseId(req.params.id);
    if (!id || !db.prepare("SELECT 1 FROM bulletin_groups WHERE id = ?").get(id)) return res.status(404).json({ error: "Нет такой группы" });
    const g = groupFields(req.body || {});
    if (db.prepare("SELECT 1 FROM bulletin_groups WHERE name = ? COLLATE NOCASE AND id != ?").get(g.name, id)) fail(`Группа «${g.name}» уже есть`);
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE bulletin_groups SET name = ?, ad_groups = ?, logins = ?, can_manage = ? WHERE id = ?")
        .run(g.name, g.adGroups.join("\n"), g.logins.join("\n"), g.canManage ? 1 : 0, id);
      saveForms(id, g.forms);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    res.json({ ok: true });
  }));

  groups.delete("/:id", (req, res) => {
    const id = parseId(req.params.id);
    const info = id ? db.prepare("DELETE FROM bulletin_groups WHERE id = ?").run(id) : { changes: 0 };
    if (!info.changes) return res.status(404).json({ error: "Нет такой группы" });
    res.json({ ok: true });
  });

  router.use("/groups", groups);
  return router;
};
