const express = require("express");
const { requireAdmin } = require("../middleware/auth");
const { getSetting, setSetting } = require("../services/settings");
const { unpackRoles } = require("../services/userStore");
const config = require("../config/config");
const departments = require("../config/departments");

module.exports = function adminRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  // Настройки AD-групп по отделу — состав отделов берётся из
  // config/departments.js, поэтому добавление нового отдела туда сразу
  // добавляет для него блок настроек здесь, без правок этого файла.
  router.get("/settings", (req, res) => {
    const result = departments.map((dept) => ({
      role: dept.role,
      name: dept.name,
      groupA: getSetting(db, `${dept.role}_group_A`) || "",
      groupB: getSetting(db, `${dept.role}_group_B`) || "",
    }));

    // Группа администраторов показывается ТОЛЬКО для справки и правится в .env.
    // Раньше она подставлялась в поле отдела ИТ как значение по умолчанию, и
    // из-за этого путались две разные вещи: сохранённая здесь группа замещала
    // её (стоял ||), то есть добавление исполнителей ИТ могло разом лишить
    // прав настоящих администраторов.
    res.json({
      departments: result,
      adminGroups: {
        A: config.domains.A.adminGroup || "",
        B: config.domains.B.adminGroup || "",
      },
      domainLabels: {
        A: config.domains.A.label,
        B: config.domains.B.label,
      },
    });
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
      SELECT ad_login, full_name, role, roles, is_admin, last_domain, last_login_at
      FROM users WHERE roles != '' OR is_admin = 1
      ORDER BY is_admin DESC, role, last_login_at DESC
    `).all();
    // Отдаём двумя списками: администратор и исполнитель — разные вещи, и
    // видеть их вперемешку значит снова их путать. Человек может быть и тем и
    // другим — тогда он попадёт в оба списка, и это правда.
    res.json({
      admins: rows.filter((r) => r.is_admin),
      executors: rows.filter((r) => r.roles).map((r) => ({ ...r, roles: unpackRoles(r.roles) })),
    });
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

    // Сводка для дашборда. Раньше он скачивал ВЕСЬ список заявок
    // (1,87 МБ при 5000 заявок), чтобы посчитать в браузере шесть чисел и
    // гистограмму по отделам. Те же числа SQL отдаёт одним проходом, а ответ
    // весит полторы сотни байт вместо почти двух мегабайт.
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status != 'closed' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN priority = 'critical' AND status != 'closed' THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closedTotal
      FROM tickets
    `).get();

    // Счётчик по отделам отдаём картой «имя -> число»: порядок и полный состав
    // отделов фронтенд берёт из своего справочника, поэтому отдел без единой
    // заявки на гистограмме остаётся видимым.
    const byCategory = Object.fromEntries(
      db.prepare(`
        SELECT c.name, COUNT(t.id) AS n
        FROM categories c LEFT JOIN tickets t ON t.category_id = c.id
        GROUP BY c.id
      `).all().map((r) => [r.name, r.n])
    );

    res.json({
      closed7, closed30,
      topWeek: topByWindow(7),
      topMonth: topByWindow(30),
      total: totals.total,
      open: totals.open,
      critical: totals.critical,
      closedTotal: totals.closedTotal,
      byCategory,
    });
  });

  return router;
};
