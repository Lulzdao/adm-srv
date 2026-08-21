function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Требуется вход в систему" });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Требуется вход в систему" });
    }
    if (req.session.user.role !== role) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
