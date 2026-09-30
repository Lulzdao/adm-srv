const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { buildXlsx, XLSX_TYPE } = require("../services/xlsx");
const { ZipBuilder } = require("../services/zip");
const { handle, str, int, Invalid } = require("./assistant");
const A = require("../services/assistant");

// ============================================================================
//  Акты — заполняются вручную
//
//    • акты на ремонт — акт о неисправностях и акт о ремонте (по желанию ещё
//      служебная записка на запчасти): техника, неисправности, работы,
//      запчасти; тексты можно взять из справочника «Типовые неисправности»;
//    • акт на списание оборудования;
//    • ведомость на списание картриджей за месяц — Word и Excel.
//
//  Все акты идут в реестр с номером в пределах года. В реестре хранятся данные,
//  по которым акт собран, — скачать его ещё раз можно в любой момент, и он
//  выйдет таким же (кроме бланка: действует тот шаблон, что загружен сейчас).
// ============================================================================

const fail = (msg) => { throw new Invalid(msg); };
const parseId = (raw) => (/^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null);

// Какие документы входят в акт каждого вида.
const ACT_TYPES = {
  repair: { label: "Акты на ремонт", docs: ["defect", "repair"] },
  writeoff: { label: "Акт на списание оборудования", docs: ["writeoff"] },
  cartridges: { label: "Ведомость на списание картриджей", docs: ["cartridges"] },
};

const DOC_NAMES = {
  defect: "Акт о неисправностях",
  repair: "Акт о ремонте",
  parts_memo: "Служебная записка на запчасти",
  writeoff: "Акт на списание",
  cartridges: "Ведомость на списание картриджей",
};

const canEdit = (user, row) => user.is_admin || row.created_by === user.id;

/** Строки многострочного поля: по одной неисправности (работе) на строку. */
const lines = (text) => String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** Список строк таблицы из формы: не массив, пусто или слишком много — 400. */
function rowsOf(value, { field, min = 0, max }) {
  const list = Array.isArray(value) ? value : [];
  if (list.length < min) fail(min === 1 ? `Добавьте хотя бы одну строку: ${field}` : `${field}: не меньше ${min}`);
  if (list.length > max) fail(`${field}: не больше ${max} строк`);
  return list.map((r) => (r && typeof r === "object" ? r : {}));
}

/** Документы акта: [{kind, name, buf}]. */
function actDocuments(db, act) {
  const data = JSON.parse(act.data);
  const docs = data.docs || ACT_TYPES[act.type].docs;
  const out = docs.map((kind) => ({
    kind,
    name: `${act.num}. ${DOC_NAMES[kind]} от ${A.ruDate(act.date)}.docx`,
    buf: A.renderDoc(db, kind, data),
  }));
  // К ведомости по картриджам — та же таблица в Excel: её удобно сверять и
  // пересылать в бухгалтерию.
  if (act.type === "cartridges") {
    out.push({
      kind: "cartridges_xlsx",
      name: `${act.num}. Ведомость картриджей за ${data.month} ${data.year}.xlsx`,
      buf: buildXlsx([{
        name: "Ведомость",
        title: "Ведомость на списание картриджей и расходных материалов",
        subtitle: `за ${data.month} ${data.year} года`,
        columns: [
          { title: "№", width: 5 }, { title: "Номенклатурный номер", width: 22 }, { title: "Наименование", width: 60 },
          { title: "Кол-во", width: 9 }, { title: "Где установлен", width: 30 },
        ],
        rows: data.repairCartridges.map((r) => [r.num, r.nomenclature, r.name, r.count, r.location]),
        footer: [[], ["", "", "Итого", data.total]],
      }]),
    });
  }
  return out;
}

module.exports = function actRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/acts", (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const rows = db.prepare(`
      SELECT a.id, a.year, a.num, a.type, a.date, a.title, a.created_by, a.created_at, u.full_name AS author
      FROM asst_acts a JOIN users u ON u.id = a.created_by WHERE a.year = ? ORDER BY a.num DESC
    `).all(year);
    const years = db.prepare("SELECT DISTINCT year FROM asst_acts ORDER BY year DESC").all().map((r) => r.year);
    res.json({ acts: rows.map((r) => ({ ...r, typeLabel: ACT_TYPES[r.type].label })), year, years, types: ACT_TYPES });
  });

  function saveAct(type, date, title, data, userId) {
    const year = Number(date.slice(0, 4));
    db.exec("BEGIN IMMEDIATE");
    try {
      const num = A.nextActNumber(db, year);
      data.actNumber = String(num);
      const info = db.prepare("INSERT INTO asst_acts (year, num, type, date, title, data, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(year, num, type, date, title, JSON.stringify(data), userId);
      db.exec("COMMIT");
      return { id: Number(info.lastInsertRowid), num, year };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const actDate = (v) => (v === undefined || v === null || v === "" ? A.today() : A.isIsoDate(v) ? v : fail("Дата акта — в виде ГГГГ-ММ-ДД"));
  const common = (b, date) => ({
    ...A.commonFields(db, new Date(date + "T12:00:00")),
    ...A.responsible(db, b.responsible_id),
    date: A.ruDate(date),
  });

  router.post("/acts/repair", handle((req, res) => {
    const b = req.body || {};
    const date = actDate(b.date);
    const tecToRepair = rowsOf(b.equipment, { field: "техника", min: 1, max: 20 }).map((e) => ({
      name: str(e.name, { field: "Наименование техники", max: 300, required: true }),
      inventoryNum: str(e.inv, { field: "Инвентарный номер", max: 60 }) || "",
      location: str(e.location, { field: "Местонахождение", max: 150 }) || "",
    }));
    const defectLines = lines(str(b.defects, { field: "Неисправности", max: 2000, required: true }));
    const workLines = lines(str(b.works, { field: "Работы", max: 2000, required: true }));
    const parts = rowsOf(b.parts, { field: "запчасти", max: 50 }).map((p) => ({
      work: str(p.work, { field: "Работа", max: 300 }) || workLines[0],
      name: str(p.name, { field: "Запасная часть", max: 300, required: true }),
      nomenclature: str(p.nomenclature, { field: "Номенклатурный номер", max: 60 }) || "",
      count: int(p.count, { field: "Количество", min: 1, max: 9999, fallback: 1 }),
    }));
    const remains = str(b.remains, { field: "Что остаётся после ремонта", max: 300 }) || "не образовались";

    // В акте о ремонте — строка на каждую запчасть; без запчастей — строка на
    // каждую работу, иначе таблица работ в акте осталась бы пустой.
    const repair = parts.length
      ? parts.map((p) => ({ repairWorks: p.work, name: p.name, nomenclature: p.nomenclature, count: p.count }))
      : workLines.map((w) => ({ repairWorks: w, name: "", nomenclature: "", count: "" }));
    const data = {
      ...common(b, date),
      docs: b.with_memo && parts.length ? ["defect", "repair", "parts_memo"] : ["defect", "repair"],
      tecToRepair,
      defects: defectLines.map((d) => ({ defectsName: d, count: 1 })),
      defectRepair: workLines.map((w) => ({ repairWorks: w, count: 1 })),
      repair,
      parts: parts.map((p) => ({ name: p.name, nomenclature: p.nomenclature, count: p.count })),
      remains,
    };
    const title = tecToRepair.map((t) => [t.name, t.inventoryNum && `инв. № ${t.inventoryNum}`].filter(Boolean).join(", ")).join("; ").slice(0, 300);
    res.status(201).json(saveAct("repair", date, title, data, req.session.user.id));
  }));

  router.post("/acts/cartridges", handle((req, res) => {
    const b = req.body || {};
    const m = /^(\d{4})-(\d{2})$/.exec(String(b.month || ""));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) fail("Месяц — в виде ГГГГ-ММ");
    const rows = rowsOf(b.rows, { field: "картриджи", min: 1, max: 200 }).map((r, i) => ({
      num: i + 1,
      name: str(r.name, { field: "Наименование", max: 300, required: true }),
      nomenclature: str(r.nomenclature, { field: "Номенклатурный номер", max: 60 }) || "",
      count: int(r.count, { field: "Количество", min: 1, max: 9999, fallback: 1 }),
      location: str(r.location, { field: "Где установлен", max: 300 }) || "",
    }));
    // Дата ведомости — последний день месяца, если он уже прошёл, иначе сегодня.
    const last = A.today(new Date(Number(m[1]), Number(m[2]), 0));
    const date = b.date ? actDate(b.date) : (A.today() < last ? A.today() : last);
    const data = {
      ...common(b, date),
      month: A.MONTHS[Number(m[2]) - 1], year: m[1],
      repairCartridges: rows, total: rows.reduce((s, r) => s + r.count, 0),
    };
    res.status(201).json(saveAct("cartridges", date, `Картриджи за ${data.month} ${data.year}`, data, req.session.user.id));
  }));

  router.post("/acts/writeoff", handle((req, res) => {
    const b = req.body || {};
    const date = actDate(b.date);
    const tecName = str(b.name, { field: "Оборудование", max: 300, required: true });
    const tecInventory = str(b.inv, { field: "Инвентарный номер", max: 60, required: true });
    const tecDate = str(b.commissioned, { field: "Дата ввода в эксплуатацию", max: 30 }) || "";
    const tecDefect = str(b.reason, { field: "Недостатки", max: 2000, required: true });
    const chair = A.person(db, "chair") || {};
    const members = A.people(db, "member").map((p) => ({ post: p.post || "", name: p.name }));
    const data = {
      ...common(b, date),
      tecName, tecInventory, tecDate, tecDefect,
      chairPost: chair.post || "", chairName: chair.name || "",
      members, membersLine: members.map((p) => [p.post, p.name].filter(Boolean).join(" ")).join(", "),
    };
    res.status(201).json(saveAct("writeoff", date, `${tecName}, инв. № ${tecInventory}`.slice(0, 300), data, req.session.user.id));
  }));

  function actFromParams(req, res) {
    const id = parseId(req.params.id);
    const act = id && db.prepare("SELECT * FROM asst_acts WHERE id = ?").get(id);
    if (!act) { res.status(404).json({ error: "Акт не найден" }); return null; }
    return act;
  }

  router.get("/acts/:id/download", handle((req, res) => {
    const act = actFromParams(req, res); if (!act) return;
    const docs = actDocuments(db, act);
    const pick = docs.find((d) => d.kind === req.query.doc);
    if (pick) return A.sendFile(res, pick.buf, pick.name, pick.kind.endsWith("xlsx") ? XLSX_TYPE : undefined);
    if (docs.length === 1) return A.sendFile(res, docs[0].buf, docs[0].name);
    const zip = new ZipBuilder();
    for (const d of docs) zip.add(d.name, d.buf);
    A.sendFile(res, zip.finish(), `Акт № ${act.num} от ${A.ruDate(act.date)}.zip`, "application/zip");
  }));

  // Несколько актов одним архивом.
  router.get("/acts/zip", handle((req, res) => {
    const ids = String(req.query.ids || "").split(",").map(parseId).filter(Boolean).slice(0, 100);
    if (!ids.length) fail("Не выбраны акты");
    const acts = db.prepare(`SELECT * FROM asst_acts WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY year, num`).all(...ids);
    const zip = new ZipBuilder();
    for (const act of acts) for (const d of actDocuments(db, act)) zip.add(d.name, d.buf);
    A.sendFile(res, zip.finish(), `акты ${A.today()}.zip`, "application/zip");
  }));

  router.get("/acts/:id", (req, res) => {
    const act = actFromParams(req, res); if (!act) return;
    const docs = (JSON.parse(act.data).docs || ACT_TYPES[act.type].docs).map((k) => ({ kind: k, name: DOC_NAMES[k] }));
    if (act.type === "cartridges") docs.push({ kind: "cartridges_xlsx", name: "Ведомость в Excel" });
    res.json({ act: { ...act, data: undefined, typeLabel: ACT_TYPES[act.type].label, docs } });
  });

  router.delete("/acts/:id", (req, res) => {
    const act = actFromParams(req, res); if (!act) return;
    if (!canEdit(req.session.user, act)) return res.status(403).json({ error: "Удалить акт может его автор или администратор" });
    db.prepare("DELETE FROM asst_acts WHERE id = ?").run(act.id);
    res.json({ ok: true });
  });

  return router;
};

module.exports.ACT_TYPES = ACT_TYPES;
