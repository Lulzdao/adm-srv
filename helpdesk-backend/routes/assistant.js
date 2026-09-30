const express = require("express");
const multer = require("multer");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { setSetting, getSetting } = require("../services/settings");
const { checkTemplate } = require("../services/docx");
const { defaultTemplate } = require("../services/docxDefaults");
const departments = require("../config/departments");
const tickets = require("./tickets");
const A = require("../services/assistant");

// ============================================================================
//  Ассистент: заявка на доступ сотрудника, справочники и настройки
//
//  Заявка на доступ заводится с экрана «Новая заявка» (плитка «Доступ к
//  программам») и уходит обычной заявкой в отдел ИТ. Служебная записка по ней
//  адресована начальнику отдела ИТ; отделы и начальники — в Администрировании
//  заявок.
//
//  Настройки — только администраторы: проверка на каждом маршруте
//  (admin.use ниже), а не только на пункте меню.
// ============================================================================

class Invalid extends Error {}
const fail = (msg) => { throw new Invalid(msg); };

/** Обработчик, у которого ошибка проверки ввода становится ответом 400. */
const handle = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.catch === "function") out.catch((err) => (err instanceof Invalid ? res.status(400).json({ error: err.message }) : next(err)));
  } catch (err) {
    if (err instanceof Invalid) return res.status(400).json({ error: err.message });
    next(err);
  }
};

function str(value, { field, max = 200, required = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`Заполните поле «${field}»`);
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") fail(`Поле «${field}» должно быть текстом`);
  const v = String(value).trim();
  if (required && !v) fail(`Заполните поле «${field}»`);
  if (v.length > max) fail(`Поле «${field}» — не длиннее ${max} символов`);
  return v || null;
}

function int(value, { field, min = 0, max = 1e6, fallback = null }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`Поле «${field}» — целое число от ${min} до ${max}`);
  return n;
}

const parseId = (raw) => (/^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null);

// ---------------------------------------------------------------------------
//  Справочники: одна схема на четыре таблицы
// ---------------------------------------------------------------------------

// Кто подписывает акты. Начальник отдела ИТ сюда не входит: он берётся из
// справочника отделов (отдел ИТ выбирается в Администрировании заявок).
const ROLES = {
  boss: "Руководитель (утверждает акты)",
  responsible: "Составитель актов",
  chair: "Председатель комиссии по списанию",
  member: "Член комиссии по списанию",
};

const DICTS = {
  depts: {
    table: "asst_depts", order: "sort, name",
    fields: {
      name: { field: "Отдел", max: 150, required: true },
      chief_name: { field: "Начальник", max: 100 },
      chief_name_gen: { field: "Начальник (кого?)", max: 100 },
      chief_name_dat: { field: "Начальник (кому?)", max: 100 },
      sort: { field: "Порядок", int: true },
    },
  },
  people: {
    table: "asst_people", order: "role, sort, name",
    fields: {
      role: { field: "Роль", required: true, oneOf: Object.keys(ROLES) },
      name: { field: "Фамилия И.О.", max: 100, required: true },
      name_dat: { field: "Фамилия И.О. (кому?)", max: 100 },
      post: { field: "Должность", max: 150 },
      post_dat: { field: "Должность (кому?)", max: 150 },
      sort: { field: "Порядок", int: true },
    },
  },
  rules: {
    table: "asst_repair_rules", order: "sort, title",
    fields: {
      title: { field: "Вид неисправности", max: 100, required: true },
      defect: { field: "Неисправность", max: 500 },
      repair_works: { field: "Работы", max: 500 },
      remains: { field: "Что остаётся после ремонта", max: 300 },
      sort: { field: "Порядок", int: true },
    },
  },
  reasons: {
    table: "asst_writeoff_reasons", order: "title",
    fields: {
      title: { field: "Название", max: 100, required: true },
      reason: { field: "Текст для акта", max: 1000, required: true },
    },
  },
};

function dictValues(dict, body, partial) {
  const out = {};
  for (const [key, spec] of Object.entries(dict.fields)) {
    if (partial && !(key in (body || {}))) continue;
    const raw = (body || {})[key];
    if (spec.int) { out[key] = int(raw, { field: spec.field, fallback: 0 }); continue; }
    if (spec.oneOf) {
      if (!spec.oneOf.includes(raw)) fail(`Поле «${spec.field}»: недопустимое значение`);
      out[key] = raw;
      continue;
    }
    out[key] = str(raw, spec);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Загрузка файлов (шаблоны документов)
// ---------------------------------------------------------------------------

const uploadFile = (maxMb) => multer({
  storage: multer.memoryStorage(),
  defParamCharset: "utf8",
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
}).single("file");

/** multer с понятной ошибкой вместо 500 на слишком большом файле. */
const withUpload = (maxMb) => (req, res, next) => uploadFile(maxMb)(req, res, (err) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: `Файл больше ${maxMb} МБ` });
  return res.status(400).json({ error: err.message });
});

module.exports = function assistantRoutes(db) {
  const router = express.Router();
  const admin = express.Router();
  router.use(requireAuth);

  // -------------------------------------------------------------------------
  //  Для всех
  // -------------------------------------------------------------------------

  // Всё, что нужно формам: отделы, программы, должности, подписанты актов.
  router.get("/refs", (req, res) => {
    const s = A.settings(db);
    res.json({
      orgName: s.orgName,
      programs: s.programs,
      posts: s.posts,
      accessTypes: Object.entries(A.ACCESS_TYPES).map(([id, t]) => ({ id, label: t.label, short: t.short })),
      depts: db.prepare("SELECT name FROM asst_depts ORDER BY sort, name").all(),
      responsibles: db.prepare("SELECT id, name, post FROM asst_people WHERE role = 'responsible' ORDER BY sort, name").all(),
      reasons: db.prepare("SELECT id, title, reason FROM asst_writeoff_reasons ORDER BY title").all(),
      rules: db.prepare("SELECT id, title, defect, repair_works, remains FROM asst_repair_rules ORDER BY sort, title").all(),
      myDepartment: req.session.user.department || "",
    });
  });

  // -------------------------------------------------------------------------
  //  Заявка на доступ сотрудника -> заявка в отдел ИТ
  // -------------------------------------------------------------------------

  router.post("/access", handle((req, res) => {
    const b = req.body || {};
    const type = A.ACCESS_TYPES[b.type] ? b.type : fail("Выберите тип заявки");
    const last = str(b.last_name, { field: "Фамилия", max: 60, required: true });
    const first = str(b.first_name, { field: "Имя", max: 60, required: true });
    const middle = str(b.middle_name, { field: "Отчество", max: 60 });
    const department = str(b.department, { field: "Отдел", max: 150, required: true });
    const post = str(b.post, { field: "Должность", max: 150, required: type === "register" });
    const room = str(b.room, { field: "Кабинет", max: 20 });
    const phoneInt = str(b.phone_int, { field: "Внутренний телефон", max: 20 });
    const phoneExt = str(b.phone_ext, { field: "Внешний телефон", max: 30 });
    const phoneMobile = str(b.phone_mobile, { field: "Мобильный телефон", max: 30 });
    const csod = str(b.csod_forms, { field: "Формы ЦСОД", max: 1000 });
    const comment = str(b.comment, { field: "Комментарий", max: 1000 });
    const allowed = new Set(A.settings(db).programs);
    const programs = Array.isArray(b.programs) ? [...new Set(b.programs.map(String))] : [];
    if (programs.some((p) => !allowed.has(p))) fail("В списке программ есть незнакомая — обновите страницу");
    if (type === "register" && !programs.length && !csod) fail("Отметьте программы, к которым нужен доступ");

    const fio = [last, first, middle].filter(Boolean).join(" ");
    const kind = A.ACCESS_TYPES[type];
    const data = {
      type, typeLabel: kind.label, fio, last_name: last, first_name: first, middle_name: middle,
      post, department, room, phone_int: phoneInt, phone_ext: phoneExt, phone_mobile: phoneMobile,
      programs, csod_forms: csod, comment,
    };

    // Тема и описание заявки — короткие (у заявки пределы 50 и 140 знаков);
    // анкета целиком — в ticket_forms и видна в карточке.
    const title = `${kind.short}: ${A.shortName(fio)}`.slice(0, tickets.TITLE_MAX);
    let description = [department, programs.length ? `доступ: ${programs.join(", ")}` : null].filter(Boolean).join("; ");
    if (description.length > tickets.DESCRIPTION_MAX) description = description.slice(0, tickets.DESCRIPTION_MAX - 1) + "…";

    const category = A.settings(db).accessDept || departments[0].name;
    db.exec("BEGIN IMMEDIATE");
    let ticketId;
    try {
      ticketId = tickets.createTicket(db, req.session.user, {
        title, description, category, priority: type === "block" || type === "delete" ? "high" : "medium",
        room, extension: phoneInt,
      });
      db.prepare("INSERT INTO ticket_forms (ticket_id, kind, data) VALUES (?, 'access', ?)").run(ticketId, JSON.stringify(data));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    const t = db.prepare("SELECT id, display_id FROM tickets WHERE id = ?").get(ticketId);
    res.status(201).json({ ticket: t });
  }));

  // Служебная записка по анкете — тем, кто видит саму заявку. Адресована
  // начальнику отдела ИТ, подписывает начальник отдела сотрудника.
  router.get("/access/:ticketId/doc", handle((req, res) => {
    const id = parseId(req.params.ticketId);
    if (!id) return res.status(400).json({ error: "Некорректный номер заявки" });
    const ticket = db.prepare(`SELECT t.*, c.name AS category FROM tickets t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`).get(id);
    const form = ticket && db.prepare("SELECT data FROM ticket_forms WHERE ticket_id = ? AND kind = 'access'").get(id);
    if (!ticket || !form) return res.status(404).json({ error: "Анкета не найдена" });
    if (!tickets.canAccessTicket(req.session.user, ticket)) return res.status(403).json({ error: "Недостаточно прав" });

    const d = JSON.parse(form.data);
    const dep = A.dept(db, d.department) || {};
    const phones = [
      d.phone_int && `внутренний — ${d.phone_int}`, d.phone_ext && `внешний — ${d.phone_ext}`,
      d.phone_mobile && `мобильный — ${d.phone_mobile}`,
    ].filter(Boolean).join(", ");
    const apps = [...(d.programs || [])];
    if (d.csod_forms) apps.push(`формы ЦСОД: ${d.csod_forms}`);
    const it = A.itChief(db);
    const buf = A.renderDoc(db, "access", {
      ...A.commonFields(db),
      // Шапка «кому» — начальнику отдела ИТ, а не руководителю.
      bossPostD: it.postDat, bossFIOD: it.nameDat,
      TYPEREQUEST: d.typeLabel,
      FIO: d.fio, post: d.post || "", department: d.department, location: d.room || "",
      tel: phones, appList: apps.join(", "), comment: d.comment || "",
      chiefType: `${A.CHIEF.post} ${A.deptGen(d.department)}`,
      chiefFIO: dep.chief_name || "",
    });
    A.sendFile(res, buf, `${ticket.display_id} ${d.typeLabel}.docx`);
  }));

  // -------------------------------------------------------------------------
  //  Настройки — только администраторы
  // -------------------------------------------------------------------------

  admin.use(requireAdmin);

  admin.get("/general", (req, res) => {
    const s = A.settings(db);
    const year = new Date().getFullYear();
    res.json({
      ...s,
      accessDepts: departments.map((d) => d.name),
      orgDepts: db.prepare("SELECT name FROM asst_depts ORDER BY sort, name").all().map((r) => r.name),
      actStart: Number(getSetting(db, `asst_act_start_${year}`)) || 1,
      year,
      roles: ROLES,
    });
  });

  admin.put("/general", handle((req, res) => {
    const b = req.body || {};
    const list = (v, field) => {
      if (!Array.isArray(v)) fail(`«${field}» — список`);
      const clean = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
      if (clean.length > 100 || clean.some((x) => x.length > 150)) fail(`«${field}»: не больше 100 строк по 150 знаков`);
      return clean;
    };
    if (b.orgName !== undefined) setSetting(db, "asst_org_name", str(b.orgName, { field: "Организация", max: 100, required: true }));
    if (b.accessDept !== undefined) {
      if (b.accessDept && !departments.some((d) => d.name === b.accessDept)) fail("Такого отдела-исполнителя нет");
      setSetting(db, "asst_access_dept", b.accessDept || "");
    }
    if (b.itDept !== undefined) {
      if (b.itDept && !A.dept(db, b.itDept)) fail("Такого отдела нет в справочнике");
      setSetting(db, "asst_it_dept", b.itDept || "");
    }
    if (b.programs !== undefined) A.setJson(db, "asst_programs", list(b.programs, "Программы"));
    if (b.posts !== undefined) A.setJson(db, "asst_posts", list(b.posts, "Должности"));
    if (b.actStart !== undefined) {
      const n = int(b.actStart, { field: "Первый номер акта", min: 1, max: 99999 });
      setSetting(db, `asst_act_start_${new Date().getFullYear()}`, String(n));
    }
    res.json({ ok: true });
  }));

  // Справочники.
  const dictOf = (req, res) => {
    const d = DICTS[req.params.dict];
    if (!d) res.status(404).json({ error: "Нет такого справочника" });
    return d;
  };
  admin.get("/dict/:dict", (req, res) => {
    const d = dictOf(req, res); if (!d) return;
    res.json({ items: db.prepare(`SELECT * FROM ${d.table} ORDER BY ${d.order}`).all() });
  });
  admin.post("/dict/:dict", handle((req, res) => {
    const d = dictOf(req, res); if (!d) return;
    const v = dictValues(d, req.body, false);
    const keys = Object.keys(v);
    try {
      const info = db.prepare(`INSERT INTO ${d.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => v[k]));
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) fail("Такая запись уже есть");
      throw err;
    }
  }));
  admin.put("/dict/:dict/:id", handle((req, res) => {
    const d = dictOf(req, res); if (!d) return;
    const id = parseId(req.params.id);
    const before = id && db.prepare(`SELECT * FROM ${d.table} WHERE id = ?`).get(id);
    if (!before) return res.status(404).json({ error: "Запись не найдена" });
    const v = dictValues(d, req.body, true);
    const keys = Object.keys(v);
    if (keys.length) {
      try {
        db.prepare(`UPDATE ${d.table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => v[k]), id);
      } catch (err) {
        if (/UNIQUE/.test(err.message)) fail("Такая запись уже есть");
        throw err;
      }
    }
    // Переименовали отдел ИТ — настройка «кому адресована записка» идёт следом.
    if (d.table === "asst_depts" && v.name && getSetting(db, "asst_it_dept") === before.name) setSetting(db, "asst_it_dept", v.name);
    res.json({ ok: true });
  }));
  admin.delete("/dict/:dict/:id", (req, res) => {
    const d = dictOf(req, res); if (!d) return;
    const id = parseId(req.params.id);
    const info = id ? db.prepare(`DELETE FROM ${d.table} WHERE id = ?`).run(id) : { changes: 0 };
    if (!info.changes) return res.status(404).json({ error: "Запись не найдена" });
    res.json({ ok: true });
  });

  // Шаблоны документов.
  admin.get("/templates", (req, res) => {
    const custom = new Map(db.prepare("SELECT kind, filename, uploaded_by, uploaded_at FROM asst_templates").all().map((r) => [r.kind, r]));
    res.json({
      templates: Object.entries(A.TEMPLATES).map(([kind, t]) => ({ kind, ...t, custom: custom.get(kind) || null })),
    });
  });

  admin.get("/templates/:kind", (req, res) => {
    const t = A.TEMPLATES[req.params.kind];
    if (!t) return res.status(404).json({ error: "Нет такого шаблона" });
    const custom = db.prepare("SELECT filename FROM asst_templates WHERE kind = ?").get(req.params.kind);
    A.sendFile(res, A.templateOf(db, req.params.kind), custom ? custom.filename : `${t.label} (шаблон).docx`);
  });

  admin.get("/templates/:kind/default", (req, res) => {
    const t = A.TEMPLATES[req.params.kind];
    if (!t) return res.status(404).json({ error: "Нет такого шаблона" });
    A.sendFile(res, defaultTemplate(req.params.kind), `${t.label} (встроенный шаблон).docx`);
  });

  admin.post("/templates/:kind", withUpload(10), handle((req, res) => {
    const t = A.TEMPLATES[req.params.kind];
    if (!t) return res.status(404).json({ error: "Нет такого шаблона" });
    if (!req.file) fail("Выберите файл .docx");
    let tags;
    try { tags = checkTemplate(req.file.buffer); } catch (err) { fail(err.message); }
    db.prepare(`
      INSERT INTO asst_templates (kind, filename, data, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(kind) DO UPDATE SET filename = excluded.filename, data = excluded.data,
        uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at
    `).run(req.params.kind, req.file.originalname || `${req.params.kind}.docx`, req.file.buffer, req.session.user.full_name);
    res.json({ ok: true, tags });
  }));

  admin.delete("/templates/:kind", (req, res) => {
    if (!A.TEMPLATES[req.params.kind]) return res.status(404).json({ error: "Нет такого шаблона" });
    db.prepare("DELETE FROM asst_templates WHERE kind = ?").run(req.params.kind);
    res.json({ ok: true });
  });

  router.use("/settings", admin);
  return router;
};

module.exports.Invalid = Invalid;
module.exports.handle = handle;
module.exports.str = str;
module.exports.int = int;
