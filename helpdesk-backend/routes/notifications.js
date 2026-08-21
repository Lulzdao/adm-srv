const express = require("express");
const { requireAuth } = require("../middleware/auth");

module.exports = function notificationRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", (req, res) => {
    const rows = db.prepare(`
      SELECT n.id, n.ticket_id, n.type, n.is_read, n.created_at, t.display_id, t.title, t.status
      FROM notifications n JOIN tickets t ON t.id = n.ticket_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50
    `).all(req.session.user.id);
    res.json({ notifications: rows });
  });

  router.patch("/:id/read", (req, res) => {
    db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?")
      .run(req.params.id, req.session.user.id);
    res.json({ ok: true });
  });

  // Открыли заявку — считаем все уведомления по ней прочитанными разом,
  // а не по одному. Раньше это было единственной причиной, по которой
  // счётчик на "Заявки" не спадал после прочтения комментариев.
  router.patch("/ticket/:ticketId/read", (req, res) => {
    db.prepare("UPDATE notifications SET is_read = 1 WHERE ticket_id = ? AND user_id = ?")
      .run(req.params.ticketId, req.session.user.id);
    res.json({ ok: true });
  });

  return router;
};
