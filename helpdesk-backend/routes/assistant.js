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
//  Ассистент: системы отдела, заявки на доступ, передача оборудования,
//  справочники и настройки
//
//  Раздел видят все сотрудники; настройки (справочники, шаблоны, выгрузки из
//  1С) — только администраторы. Проверка прав — на каждом маршруте настроек
//  (router.use ниже), а не только на пункте меню.
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
//  Справочники: одна схема на пять таблиц
// ---------------------------------------------------------------------------

const ROLES = {
  boss: "Руководитель",
  deputy: "Заместитель руководителя (согласует)",
  it_chief: "Начальник ОИРиТ (подписывает акты)",
  responsible: "Составитель актов",
  chair: "Председатель комиссии по списанию",
  member: "Член комиссии по списанию",
};

const DICTS = {
  links: {
    table: "asst_links", order: "sort, title",
    fields: {
      title: { field: "Название", max: 80, required: true },
      url: { field: "Адрес", max: 500, required: true, url: true },
      hint: { field: "Подпись", max: 160 },
      departments: { field: "Отделы", max: 4000, empty: "" },
      sort: { field: "Порядок", int: true },
    },
  },
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
      title: { field: "Вид техники", max: 100, required: true },
      keywords: { field: "Слова в названии", max: 300, empty: "" },
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
    const v = str(raw, spec);
    // Ссылка — только http(s): в плитку попадает href, и «javascript:» в нём
    // выполнился бы у каждого, кто на плитку нажмёт.
    if (spec.url && v && !/^https?:\/\/[^\s]+$/i.test(v)) fail("Адрес — ссылка, начинающаяся с http:// или https://");
    // У части колонок NOT NULL DEFAULT '' — пустое поле там пустая строка.
    out[key] = v === null && spec.empty !== undefined ? spec.empty : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Загрузка файлов
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

  // Всё, что нужно формам: списки отделов, программ, должностей и т.п.
  router.get("/refs", (req, res) => {
    const s = A.settings(db);
    res.json({
      orgName: s.orgName,
      programs: s.programs,
      posts: s.posts,
      accessTypes: Object.entries(A.ACCESS_TYPES).map(([id, t]) => ({ id, label: t.label, short: t.short })),
      depts: db.prepare("SELECT name, (chief_name IS NOT NULL AND chief_name != '') AS has_chief FROM asst_depts ORDER BY sort, name").all(),
      responsibles: db.prepare("SELECT id, name, post FROM asst_people WHERE role = 'responsible' ORDER BY sort, name").all(),
      reasons: db.prepare("SELECT id, title, reason FROM asst_writeoff_reasons ORDER BY title").all(),
      rules: db.prepare("SELECT id, title, keywords, defect, repair_works, remains FROM asst_repair_rules ORDER BY sort, title").all(),
      myDepartment: req.session.user.department || "",
    });
  });

  // Плитки систем: свои отделу сотрудника и общие. Администратор может
  // посмотреть все сразу (?all=1) — чтобы проверить, кому что видно.
  router.get("/links", (req, res) => {
    const rows = db.prepare("SELECT id, title, url, hint, departments FROM asst_links ORDER BY sort, title").all();
    const mine = String(req.session.user.department || "").trim().toLowerCase();
    const all = req.query.all === "1" && req.session.user.is_admin;
    const list = rows.filter((l) => {
      if (all) return true;
      const deps = l.departments.split(/\r?\n/).map((d) => d.trim().toLowerCase()).filter(Boolean);
      return !deps.length || deps.includes(mine);
    });
    res.json({ links: list.map(({ departments: d, ...l }) => ({ ...l, shared: !d.trim() })) });
  });

  // Поиск по базе техники и по базе запчастей — для форм передачи и журнала.
  function search(table, q, cartridgeOnly) {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return [];
    const words = needle.split(/\s+/).slice(0, 5);
    const where = words.map(() => "search LIKE ?").join(" AND ") + (cartridgeOnly === undefined ? "" : " AND cartridge = ?");
    const params = words.map((w) => `%${w.replace(/[%_]/g, "")}%`);
    if (cartridgeOnly !== undefined) params.push(cartridgeOnly ? 1 : 0);
    return db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY name LIMIT 30`).all(...params)
      .map(({ search: _, ...row }) => row);
  }
  router.get("/equipment", (req, res) => res.json({ items: search("asst_equipment", req.query.q) }));
  router.get("/parts", (req, res) => {
    const kind = req.query.kind === "cartridge" ? true : req.query.kind === "part" ? false : undefined;
    res.json({ items: search("asst_parts", req.query.q, kind) });
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

  // Служебная записка по анкете — тем, кто видит саму заявку.
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
    const buf = A.renderDoc(db, "access", {
      ...A.commonFields(db),
      TYPEREQUEST: d.typeLabel,
      FIO: d.fio, post: d.post || "", department: d.department, location: d.room || "",
      tel: phones, appList: apps.join(", "), comment: d.comment || "",
      chiefType: `${A.CHIEF.post} ${A.deptGen(d.department)}`,
      chiefFIO: dep.chief_name || "",
    });
    A.sendFile(res, buf, `${ticket.display_id} ${d.typeLabel}.docx`);
  }));

  // -------------------------------------------------------------------------
  //  Передача оборудования между отделами
  // -------------------------------------------------------------------------

  const ITEMS_MAX = 50;

  router.get("/transfers", (req, res) => {
    const rows = db.prepare(`
      SELECT t.id, t.year, t.num, t.from_dept, t.to_dept, t.items, t.created_at, t.created_by, u.full_name AS author
      FROM asst_transfers t JOIN users u ON u.id = t.created_by
      ORDER BY t.id DESC LIMIT 200
    `).all();
    res.json({ transfers: rows.map((r) => ({ ...r, items: JSON.parse(r.items) })) });
  });

  router.post("/transfers", handle((req, res) => {
    const b = req.body || {};
    const from = str(b.from_dept, { field: "От кого", max: 150, required: true });
    const to = str(b.to_dept, { field: "Кому", max: 150, required: true });
    if (from === to) fail("Отдел-получатель совпадает с отделом-отправителем");
    for (const name of [from, to]) if (!A.dept(db, name)) fail(`Отдела «${name}» нет в справочнике`);
    if (!Array.isArray(b.items) || !b.items.length) fail("Добавьте оборудование на передачу");
    if (b.items.length > ITEMS_MAX) fail(`Не больше ${ITEMS_MAX} позиций в одной заявке`);
    const items = b.items.map((it) => ({
      name: str(it && it.name, { field: "Наименование", max: 300, required: true }),
      inv: str(it && it.inv, { field: "Инвентарный номер", max: 60 }),
      count: int(it && it.count, { field: "Количество", min: 1, max: 9999, fallback: 1 }),
    }));
    const invs = items.map((i) => i.inv).filter(Boolean);
    if (new Set(invs).size !== invs.length) fail("Одна и та же позиция внесена в список дважды");

    const year = new Date().getFullYear();
    const num = A.nextNumber(db, "asst_transfers", year);
    const info = db.prepare(`
      INSERT INTO asst_transfers (year, num, from_dept, to_dept, items, created_by) VALUES (?, ?, ?, ?, ?, ?)
    `).run(year, num, from, to, JSON.stringify(items), req.session.user.id);
    res.status(201).json({ id: Number(info.lastInsertRowid), num });
  }));

  router.delete("/transfers/:id", (req, res) => {
    const id = parseId(req.params.id);
    const row = id && db.prepare("SELECT created_by FROM asst_transfers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "Заявка не найдена" });
    if (row.created_by !== req.session.user.id && !req.session.user.is_admin) {
      return res.status(403).json({ error: "Удалить может только автор или администратор" });
    }
    db.prepare("DELETE FROM asst_transfers WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  router.get("/transfers/:id/doc", handle((req, res) => {
    const id = parseId(req.params.id);
    const t = id && db.prepare("SELECT * FROM asst_transfers WHERE id = ?").get(id);
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    const from = A.dept(db, t.from_dept) || {};
    const to = A.dept(db, t.to_dept) || {};
    const items = JSON.parse(t.items).map((it, i) => ({ num: i + 1, ...it, inv: it.inv || "" }));
    const buf = A.renderDoc(db, "transfer", {
      ...A.commonFields(db, new Date(t.created_at.replace(" ", "T") + "Z")),
      num: `${t.num}`,
      postFrom: A.CHIEF.gen, depFrom: A.deptGen(t.from_dept), FIOFrom: from.chief_name_gen || "",
      postTo: A.CHIEF.dat, depTo: A.deptGen(t.to_dept), FIOTo: to.chief_name_dat || "",
      postFromI: A.CHIEF.post, FIOFromI: from.chief_name || "",
      postToI: A.CHIEF.post, FIOToI: to.chief_name || "",
      tec: items,
    });
    A.sendFile(res, buf, `${A.ruDate(t.created_at.slice(0, 10))} заявка на передачу оборудования № ${t.num}.docx`);
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
      actStart: Number(getSetting(db, `asst_act_start_${year}`)) || 1,
      year,
      // Отделы из AD, которые уже встречались у сотрудников, — подсказка для
      // поля «кому видна плитка»: название должно совпасть буква в букву.
      adDepartments: db.prepare("SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department != '' ORDER BY department").all().map((r) => r.department),
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
    if (!id || !db.prepare(`SELECT id FROM ${d.table} WHERE id = ?`).get(id)) return res.status(404).json({ error: "Запись не найдена" });
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
    res.json({ ok: true });
  }));
  admin.delete("/dict/:dict/:id", (req, res) => {
    const d = dictOf(req, res); if (!d) return;
    const id = parseId(req.params.id);
    const info = id ? db.prepare(`DELETE FROM ${d.table} WHERE id = ?`).run(id) : { changes: 0 };
    if (!info.changes) return res.status(404).json({ error: "Запись не найдена" });
    res.json({ ok: true });
  });

  // Выгрузки из 1С: база техники (tec.txt) и база запчастей (rep.txt).
  const IMPORTS = {
    equipment: {
      table: "asst_equipment", parse: A.parseEquipment, cols: ["name", "inv", "commissioned", "count"],
      search: (r) => `${r.name} ${r.inv || ""}`,
    },
    parts: {
      table: "asst_parts", parse: A.parseParts, cols: ["name", "location", "nomenclature", "count", "cartridge"],
      search: (r) => `${r.name} ${r.nomenclature || ""}`,
    },
  };

  admin.get("/imports", (req, res) => {
    const info = (key, table) => ({
      count: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      at: getSetting(db, `asst_${key}_imported_at`),
      by: getSetting(db, `asst_${key}_imported_by`),
      file: getSetting(db, `asst_${key}_imported_file`),
    });
    res.json({ equipment: info("equipment", "asst_equipment"), parts: info("parts", "asst_parts") });
  });

  admin.post("/imports/:kind", withUpload(30), handle((req, res) => {
    const imp = IMPORTS[req.params.kind];
    if (!imp) return res.status(404).json({ error: "Нет такой базы" });
    if (!req.file) fail("Выберите файл выгрузки");
    let rows;
    const text = require("../services/tables").decodeText(req.file.buffer);
    try { rows = imp.parse(text); } catch (err) { fail(err.message); }
    const cols = [...imp.cols, "search"];
    const insert = db.prepare(`INSERT INTO ${imp.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`DELETE FROM ${imp.table}`);
      for (const r of rows) insert.run(...imp.cols.map((c) => r[c] ?? null), imp.search(r).toLowerCase());
      setSetting(db, `asst_${req.params.kind}_imported_at`, new Date().toISOString());
      setSetting(db, `asst_${req.params.kind}_imported_by`, req.session.user.full_name);
      setSetting(db, `asst_${req.params.kind}_imported_file`, req.file.originalname || "");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    res.json({ ok: true, count: rows.length });
  }));

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
module.exports.withUpload = withUpload;
