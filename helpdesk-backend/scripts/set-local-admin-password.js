// Хэш пароля локальной учётки для .env платформы.
//   node scripts/set-local-admin-password.js "Пароль"          → LOCAL_ADMIN_PASSWORD_HASH (аварийный администратор, !admin)
//   node scripts/set-local-admin-password.js --user "Пароль"   → LOCAL_USER_PASSWORD_HASH (общая аварийная учётка, !user)
// Вставьте строку в .env и перезапустите платформу. Пустой хэш выключает учётку.
const bcrypt = require("bcrypt");

const args = process.argv.slice(2);
const forUser = args[0] === "--user";
const password = forUser ? args[1] : args[0];
if (!password) {
  console.error("Укажите пароль: node scripts/set-local-admin-password.js [--user] \"Пароль\"");
  process.exit(1);
}

bcrypt.hash(password, 12).then((hash) => {
  console.log(`\n${forUser ? "LOCAL_USER_PASSWORD_HASH" : "LOCAL_ADMIN_PASSWORD_HASH"}=${hash}\n`);
});
