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

// Администратор платформы. Отдельная проверка, а не requireRole("it"):
// администратор — это признак, выданный группой из .env, а роль отвечает лишь
// за то, в каком отделе человек исполнитель. Совмещать их в одной проверке
// значит выдавать права администратора всем исполнителям отдела ИТ.
function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Требуется вход в систему" });
  }
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireAdmin };
