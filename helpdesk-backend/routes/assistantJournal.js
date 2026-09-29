const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { getSetting } = require("../services/settings");
const { buildXlsx, XLSX_TYPE } = require("../services/xlsx");
const { ZipBuilder } = require("../services/zip");
const { handle, str, int, Invalid } = require("./assistant");
const A = require("../services/assistant");

// ============================================================================
//  Журнал техники и акты
//
//  Журнал — что из расходников и запчастей куда поставлено: картридж в
//  принтер отдела, фьюзер в МФУ. Из записей журнала собираются документы:
//
//    • акты на ремонт — акт о неисправностях и акт о ремонте (по желанию ещё
//      служебная записка на запчасти) по выбранным записям с запчастями;
//    • ведомость на списание картриджей — по картриджам за месяц;
//    • акт на списание оборудования — по технике из базы, без журнала.
//
//  Все акты идут в реестр с номером в пределах года. В реестре хранятся данные,
//  по которым акт собран, — скачать его ещё раз можно в любой момент, и он
//  выйдет таким же (кроме бланка: действует тот шаблон, что загружен сейчас).
// ============================================================================

const fail = (msg) => { throw new Invalid(msg); };
const parseId = (raw) => (/^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null);

const KINDS = { cartridge: "Картридж / расходник", part: "Запчасть" };

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

function canEdit(user, row) {
  return user.is_admin || row.created_by === user.id;
}

function entryValues(b) {
  const date = A.isIsoDate(b.date) ? b.date : fail("Дата — в виде ГГГГ-ММ-ДД");
  if (!KINDS[b.kind]) fail("Выберите, что поставлено: картридж или запчасть");
  return {
    date,
    kind: b.kind,
    part_name: str(b.part_name, { field: "Что поставлено", max: 300, required: true }),
    nomenclature: str(b.nomenclature, { field: "Номенклатурный номер", max: 60 }),
    count: int(b.count, { field: "Количество", min: 1, max: 9999, fallback: 1 }),
    equipment: str(b.equipment, { field: "Куда (техника)", max: 300 }),
    inv: str(b.inv, { field: "Инвентарный номер", max: 60 }),
    location: str(b.location, { field: "Отдел / кабинет", max: 150 }),
    note: str(b.note, { field: "Примечание", max: 500 }),
  };
}

/** Подходящее правило из справочника «типовые неисправности» по названию техники. */
function ruleFor(db, equipmentName) {
  const name = String(equipmentName || "").toLowerCase();
  const rules = db.prepare("SELECT * FROM asst_repair_rules ORDER BY sort, title").all();
  return rules.find((r) => r.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean).some((k) => name.includes(k))) || null;
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

module.exports = function journalRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);

  // -------------------------------------------------------------------------
  //  Журнал
  // -------------------------------------------------------------------------

  function filtered(q) {
    const where = [];
    const params = [];
    if (A.isIsoDate(q.from)) { where.push("j.date >= ?"); params.push(q.from); }
    if (A.isIsoDate(q.to)) { where.push("j.date <= ?"); params.push(q.to); }
    if (KINDS[q.kind]) { where.push("j.kind = ?"); params.push(q.kind); }
    if (q.free === "1") where.push("j.act_id IS NULL");
    const rows = db.prepare(`
      SELECT j.*, u.full_name AS author, a.num AS act_num, a.year AS act_year, a.type AS act_type
      FROM asst_journal j JOIN users u ON u.id = j.created_by LEFT JOIN asst_acts a ON a.id = j.act_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY j.date DESC, j.id DESC LIMIT 2000
    `).all(...params);
    const needle = String(q.q || "").trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => [r.part_name, r.nomenclature, r.equipment, r.inv, r.location, r.note, r.author]
      .some((v) => v && String(v).toLowerCase().includes(needle)));
  }

  router.get("/journal", (req, res) => {
    const rows = filtered(req.query);
    res.json({ entries: rows.slice(0, 500), total: rows.length, kinds: KINDS });
  });

  router.get("/journal/export", (req, res) => {
    const rows = filtered(req.query);
    const buf = buildXlsx([{
      name: "Журнал техники",
      title: "Журнал техники",
      subtitle: [req.query.from && `с ${A.ruDate(req.query.from)}`, req.query.to && `по ${A.ruDate(req.query.to)}`].filter(Boolean).join(" ") || null,
      columns: [
        { title: "Дата", width: 11 }, { title: "Что", width: 14 }, { title: "Наименование", width: 50 },
        { title: "Номенклатурный №", width: 18 }, { title: "Кол-во", width: 8 }, { title: "Куда", width: 40 },
        { title: "Инв. №", width: 16 }, { title: "Отдел / кабинет", width: 26 }, { title: "Примечание", width: 30 },
        { title: "Акт", width: 10 }, { title: "Записал", width: 28 },
      ],
      rows: rows.map((r) => [
        A.ruDate(r.date), KINDS[r.kind], r.part_name, r.nomenclature, r.count, r.equipment, r.inv, r.location, r.note,
        r.act_num ? `№ ${r.act_num}/${r.act_year}` : "", r.author,
      ]),
    }]);
    A.sendFile(res, buf, `журнал техники ${A.today()}.xlsx`, XLSX_TYPE);
  });

  router.post("/journal", handle((req, res) => {
    const v = entryValues(req.body || {});
    const keys = Object.keys(v);
    const info = db.prepare(`INSERT INTO asst_journal (${keys.join(", ")}, created_by) VALUES (${keys.map(() => "?").join(", ")}, ?)`)
      .run(...keys.map((k) => v[k]), req.session.user.id);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  function entryFromParams(req, res) {
    const id = parseId(req.params.id);
    const row = id && db.prepare("SELECT * FROM asst_journal WHERE id = ?").get(id);
    if (!row) { res.status(404).json({ error: "Запись не найдена" }); return null; }
    if (!canEdit(req.session.user, row)) { res.status(403).json({ error: "Править запись может её автор или администратор" }); return null; }
    // Запись, по которой уже есть акт, не меняется: акт в реестре хранит
    // данные на момент составления, и журнал разошёлся бы с документом.
    if (row.act_id) { res.status(409).json({ error: "По записи уже составлен акт — сначала удалите акт из реестра" }); return null; }
    return row;
  }

  router.put("/journal/:id", handle((req, res) => {
    const row = entryFromParams(req, res); if (!row) return;
    const v = entryValues(req.body || {});
    const keys = Object.keys(v);
    db.prepare(`UPDATE asst_journal SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => v[k]), row.id);
    res.json({ ok: true });
  }));

  router.delete("/journal/:id", (req, res) => {
    const row = entryFromParams(req, res); if (!row) return;
    db.prepare("DELETE FROM asst_journal WHERE id = ?").run(row.id);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  //  Остатки: выгрузка из 1С минус то, что поставлено после неё
  // -------------------------------------------------------------------------

  function stock(until) {
    const at = getSetting(db, "asst_parts_imported_at");
    const since = at ? A.today(new Date(at)) : "0000-00-00";
    const used = new Map(db.prepare(`
      SELECT nomenclature, SUM(count) AS n FROM asst_journal
      WHERE nomenclature IS NOT NULL AND date >= ? AND date <= ? GROUP BY nomenclature
    `).all(since, until || "9999-12-31").map((r) => [r.nomenclature, r.n]));
    return {
      since,
      items: db.prepare("SELECT id, name, location, nomenclature, count, cartridge FROM asst_parts ORDER BY name").all()
        .map((p) => ({ ...p, used: used.get(p.nomenclature) || 0, left: (p.count || 0) - (used.get(p.nomenclature) || 0) })),
    };
  }

  router.get("/stock", (req, res) => {
    const s = stock();
    const needle = String(req.query.q || "").trim().toLowerCase();
    const items = needle ? s.items.filter((p) => `${p.name} ${p.nomenclature || ""}`.toLowerCase().includes(needle)) : s.items;
    res.json({ since: s.since, items: items.slice(0, 500), total: items.length });
  });

  // Отчёт об использовании материалов за месяц.
  router.get("/stock/report", handle((req, res) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ""));
    if (!m) fail("Месяц — в виде ГГГГ-ММ");
    const from = `${m[1]}-${m[2]}-01`;
    const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
    const to = `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`;
    const month = A.MONTHS[Number(m[2]) - 1];
    const used = db.prepare(`
      SELECT nomenclature, MAX(part_name) AS name, SUM(count) AS n FROM asst_journal
      WHERE date >= ? AND date <= ? GROUP BY COALESCE(nomenclature, part_name) ORDER BY name
    `).all(from, to);
    const left = new Map(stock(to).items.map((p) => [p.nomenclature, p.left]));
    const buf = buildXlsx([{
      name: "Отчёт",
      title: "Отчёт об использовании материалов",
      subtitle: `за ${month} ${m[1]} года`,
      columns: [
        { title: "Номенклатурный №", width: 20 }, { title: "Наименование", width: 60 },
        { title: "Израсходовано", width: 14 }, { title: `Остаток на ${A.ruDate(to)}`, width: 16 },
      ],
      rows: used.map((r) => [r.nomenclature, r.name, r.n, left.has(r.nomenclature) ? left.get(r.nomenclature) : ""]),
    }]);
    A.sendFile(res, buf, `отчёт об использовании материалов ${m[1]}-${m[2]}.xlsx`, XLSX_TYPE);
  }));

  // -------------------------------------------------------------------------
  //  Акты
  // -------------------------------------------------------------------------

  router.get("/acts", (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const rows = db.prepare(`
      SELECT a.id, a.year, a.num, a.type, a.date, a.title, a.created_by, a.created_at, u.full_name AS author,
             (SELECT COUNT(*) FROM asst_journal j WHERE j.act_id = a.id) AS entries
      FROM asst_acts a JOIN users u ON u.id = a.created_by WHERE a.year = ? ORDER BY a.num DESC
    `).all(year);
    const years = db.prepare("SELECT DISTINCT year FROM asst_acts ORDER BY year DESC").all().map((r) => r.year);
    res.json({ acts: rows.map((r) => ({ ...r, typeLabel: ACT_TYPES[r.type].label })), year, years, types: ACT_TYPES });
  });

  // Подсказка для диалога «Составить акты»: что написать о неисправности и
  // работах по каждой технике — из справочника типовых неисправностей.
  router.post("/acts/repair/preview", handle((req, res) => {
    const entries = selectedEntries(req.body && req.body.entry_ids, "part");
    const groups = groupByEquipment(entries).map((g) => {
      const rule = ruleFor(db, g.name);
      return { ...g, rule: rule ? rule.title : null, defect: rule ? rule.defect || "" : "", repair_works: rule ? rule.repair_works || "" : "", remains: rule ? rule.remains || "" : "" };
    });
    res.json({ groups });
  }));

  function selectedEntries(ids, kind) {
    if (!Array.isArray(ids) || !ids.length) fail("Отметьте записи журнала");
    if (ids.length > 200) fail("Не больше 200 записей в одном акте");
    const clean = [...new Set(ids.map(parseId))];
    if (clean.some((x) => !x)) fail("Некорректный номер записи");
    const rows = db.prepare(`SELECT * FROM asst_journal WHERE id IN (${clean.map(() => "?").join(",")}) ORDER BY date, id`).all(...clean);
    if (rows.length !== clean.length) fail("Часть записей не найдена — обновите страницу");
    if (rows.some((r) => r.act_id)) fail("По части записей акт уже составлен");
    if (kind && rows.some((r) => r.kind !== kind)) fail(kind === "part" ? "Акты на ремонт — только по запчастям; картриджи идут в ведомость" : "Отметьте только картриджи");
    return rows;
  }

  function groupByEquipment(entries) {
    const map = new Map();
    for (const e of entries) {
      const key = e.inv || e.equipment || "—";
      if (!map.has(key)) map.set(key, { key, name: e.equipment || "", inv: e.inv || "", location: e.location || "", entries: [] });
      map.get(key).entries.push(e);
    }
    return [...map.values()];
  }

  function saveAct(type, date, title, data, userId, entryIds = []) {
    const year = Number(date.slice(0, 4));
    db.exec("BEGIN IMMEDIATE");
    try {
      const num = A.nextNumber(db, "asst_acts", year);
      data.actNumber = String(num);
      const info = db.prepare("INSERT INTO asst_acts (year, num, type, date, title, data, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(year, num, type, date, title, JSON.stringify(data), userId);
      const id = Number(info.lastInsertRowid);
      const link = db.prepare("UPDATE asst_journal SET act_id = ? WHERE id = ?");
      for (const e of entryIds) link.run(id, e);
      db.exec("COMMIT");
      return { id, num, year };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const actDate = (v) => (v === undefined || v === null || v === "" ? A.today() : A.isIsoDate(v) ? v : fail("Дата акта — в виде ГГГГ-ММ-ДД"));

  router.post("/acts/repair", handle((req, res) => {
    const b = req.body || {};
    const entries = selectedEntries(b.entry_ids, "part");
    const date = actDate(b.date);
    const groups = groupByEquipment(entries);
    const texts = new Map((Array.isArray(b.groups) ? b.groups : []).map((g) => [String(g && g.key), g]));
    const text = (g, key, field) => str((texts.get(g.key) || {})[key], { field, max: 1000 }) || "";

    const tecToRepair = groups.map((g) => ({ name: g.name, inventoryNum: g.inv, location: g.location }));
    const defects = [], defectRepair = [], repair = [], remains = [];
    for (const g of groups) {
      const defect = text(g, "defect", "Неисправность");
      const works = text(g, "repair_works", "Работы");
      if (!defect) fail(`Опишите неисправность: ${g.name || g.inv || "техника без названия"}`);
      if (!works) fail(`Опишите работы: ${g.name || g.inv || "техника без названия"}`);
      defects.push({ defectsName: groups.length > 1 ? `${g.name} (инв. № ${g.inv}): ${defect}` : defect, count: 1 });
      defectRepair.push({ repairWorks: works, count: 1 });
      for (const e of g.entries) repair.push({ repairWorks: works, name: e.part_name, nomenclature: e.nomenclature || "", count: e.count });
      const rest = text(g, "remains", "Что остаётся");
      if (rest) remains.push(rest);
    }
    const docs = b.with_memo ? ["defect", "repair", "parts_memo"] : ["defect", "repair"];
    const data = {
      ...A.commonFields(db, new Date(date + "T12:00:00")),
      ...A.responsible(db, b.responsible_id),
      date: A.ruDate(date), docs, tecToRepair, defects, defectRepair, repair,
      parts: repair.map((r) => ({ name: r.name, nomenclature: r.nomenclature, count: r.count })),
      remains: remains.join("; ") || "не образовались",
    };
    const title = groups.map((g) => [g.name, g.inv && `инв. № ${g.inv}`].filter(Boolean).join(", ")).join("; ").slice(0, 300);
    const act = saveAct("repair", date, title, data, req.session.user.id, entries.map((e) => e.id));
    res.status(201).json(act);
  }));

  router.post("/acts/cartridges", handle((req, res) => {
    const b = req.body || {};
    const m = /^(\d{4})-(\d{2})$/.exec(String(b.month || ""));
    if (!m) fail("Месяц — в виде ГГГГ-ММ");
    const from = `${m[1]}-${m[2]}-01`;
    const to = `${m[1]}-${m[2]}-31`;
    const entries = db.prepare(`
      SELECT * FROM asst_journal WHERE kind = 'cartridge' AND act_id IS NULL AND date >= ? AND date <= ? ORDER BY date, id
    `).all(from, to);
    if (!entries.length) fail("За этот месяц нет картриджей без ведомости");
    const last = new Date(Number(m[1]), Number(m[2]), 0);
    const date = A.today() < A.today(last) ? A.today() : A.today(last);
    const rows = entries.map((e, i) => ({
      num: i + 1, nomenclature: e.nomenclature || "", name: e.part_name, count: e.count,
      location: [e.location, e.equipment && `${e.equipment}${e.inv ? `, инв. № ${e.inv}` : ""}`].filter(Boolean).join(" — "),
    }));
    const data = {
      ...A.commonFields(db, new Date(date + "T12:00:00")),
      ...A.responsible(db, b.responsible_id),
      date: A.ruDate(date), month: A.MONTHS[Number(m[2]) - 1], year: m[1],
      repairCartridges: rows, total: rows.reduce((s, r) => s + r.count, 0),
    };
    const act = saveAct("cartridges", date, `Картриджи за ${data.month} ${data.year}`, data, req.session.user.id, entries.map((e) => e.id));
    res.status(201).json(act);
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
      ...A.commonFields(db, new Date(date + "T12:00:00")),
      ...A.responsible(db, b.responsible_id),
      date: A.ruDate(date), tecName, tecInventory, tecDate, tecDefect,
      chairPost: chair.post || "", chairName: chair.name || "",
      members, membersLine: members.map((p) => [p.post, p.name].filter(Boolean).join(" ")).join(", "),
    };
    const act = saveAct("writeoff", date, `${tecName}, инв. № ${tecInventory}`.slice(0, 300), data, req.session.user.id);
    res.status(201).json(act);
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

  // Несколько актов одним архивом — как «Составить акты» в прежнем Ассистенте.
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
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE asst_journal SET act_id = NULL WHERE act_id = ?").run(act.id);
      db.prepare("DELETE FROM asst_acts WHERE id = ?").run(act.id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    res.json({ ok: true });
  });

  return router;
};

module.exports.ACT_TYPES = ACT_TYPES;
