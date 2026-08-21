const nodemailer = require("nodemailer");
const config = require("../config/config");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtp.host) return null; // почта не настроена — работаем только с уведомлениями в интерфейсе
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
  });
  return transporter;
}

const LABELS = {
  new_ticket: "Новая заявка",
  new_comment: "Новый комментарий",
  status_changed: "Изменён статус заявки",
};

/**
 * Создаёт уведомления в БД (мгновенно видно в интерфейсе) и асинхронно
 * пытается отправить email-дубль. Отправка почты НЕ блокирует основной
 * поток и не роняет запрос, если SMTP недоступен — только пишет в лог.
 */
function notify(db, { ticketId, type, toUserId, toRole, excludeUserId }) {
  const recipients = toUserId
    ? [db.prepare("SELECT * FROM users WHERE id = ?").get(toUserId)].filter(Boolean)
    : db.prepare("SELECT * FROM users WHERE role = ?").all(toRole);

  for (const user of recipients) {
    if (excludeUserId && user.id === excludeUserId) continue;

    db.prepare("INSERT INTO notifications (user_id, ticket_id, type) VALUES (?, ?, ?)").run(user.id, ticketId, type);

    if (user.email) {
      sendEmailAsync(user.email, ticketId, type).catch((err) => {
        console.error(`Не удалось отправить email-уведомление на ${user.email}:`, err.message);
      });
    }
  }
}

async function sendEmailAsync(to, ticketId, type) {
  const t = getTransporter();
  if (!t) return; // SMTP не настроен — тихо пропускаем, в интерфейсе уведомление уже создано
  await t.sendMail({
    from: config.smtp.from,
    to,
    subject: `[Служба заявок] ${LABELS[type] || "Обновление"} — заявка #${ticketId}`,
    text: `По заявке #${ticketId} есть обновление: ${LABELS[type] || type}. Откройте систему заявок для подробностей.`,
  });
}

module.exports = { notify };
