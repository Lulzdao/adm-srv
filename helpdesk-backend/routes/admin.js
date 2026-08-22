const express = require("express");
const { requireRole } = require("../middleware/auth");
const { getSetting, setSetting } = require("../services/settings");
const config = require("../config/config");
const departments = require("../config/departments");

module.exports = function adminRoutes(db) {
  const router = express.Router();
  router.use(requireRole("it"));

  // Настройки AD-групп по отделу — состав отделов берётся из
  // config/departments.js, поэтому добавление нового отдела туда сразу
  // добавляет для него блок настроек здесь, без правок этого файла.
  router.get("/settings", (req, res) => {
    const result = departments.map((dept) => ({
      role: dept.role,
      name: dept.name,
      groupA: getSetting(db, `${dept.role}_group_A`) || (dept.role === "it" ? config.domains.A.adminGroup : "") || "",
      groupB: getSetting(db, `${dept.role}_group_B`) || (dept.role === "it" ? config.domains.B.adminGroup : "") || "",
    }));
    res.json({ departments: result });
  });

  // Роль в ключе настройки берём только из справочника отделов, а не из тела
  // запроса: иначе через это поле можно было записать любой ключ в settings
  // (в т.ч. перетереть чужую настройку) — ключ подставлялся в строку как есть.
  const KNOWN_ROLES = new Set(departments.map((d) => d.role));
  const GROUP_NAME_MAX = 256;

  router.put("/settings", (req, res) => {
    const { departments: incoming } = req.body || {};
    if (!Array.isArray(incoming)) return res.status(400).json({ error: "Ожидался список отделов" });

    for (const dept of incoming) {
      if (!dept || !KNOWN_ROLES.has(dept.role)) continue;
      for (const [field, domain] of [["groupA", "A"], ["groupB", "B"]]) {
        const value = dept[field];
        if (value === undefined) continue;
        if (typeof value !== "string" || value.length > GROUP_NAME_MAX) {
          return res.status(400).json({ error: "Имя группы должно быть строкой до 256 символов" });
        }
        setSetting(db, `${dept.role}_group_${domain}`, value.trim());
      }
    }
    res.json({ ok: true });
  });

  // Список тех, у кого сейчас есть повышенная роль (любая, кроме 'user') —
  // это отражение членства в соответствующей группе на момент последнего
  // входа, а не редактируемый вручную список.
  router.get("/admins", (req, res) => {
    const rows = db.prepare(`
      SELECT ad_login, full_name, role, last_domain, last_login_at
      FROM users WHERE role != 'user' ORDER BY role, last_login_at DESC
    `).all();
    res.json({ admins: rows });
  });

  router.get("/stats", (req, res) => {
    const closed7 = db.prepare(
      "SELECT COUNT(*) n FROM tickets WHERE status = 'closed' AND closed_at >= datetime('now', '-7 days')"
    ).get().n;
    const closed30 = db.prepare(
      "SELECT COUNT(*) n FROM tickets WHERE status = 'closed' AND closed_at >= datetime('now', '-30 days')"
    ).get().n;

    const topByWindow = (days) => db.prepare(`
      SELECT u.full_name, COUNT(*) n
      FROM tickets t JOIN users u ON u.id = t.assigned_to
      WHERE t.status = 'closed' AND t.closed_at >= datetime('now', '-' || ? || ' days')
      GROUP BY t.assigned_to ORDER BY n DESC LIMIT 5
    `).all(days);

    res.json({
      closed7, closed30,
      topWeek: topByWindow(7),
      topMonth: topByWindow(30),
    });
  });

  return router;
};
