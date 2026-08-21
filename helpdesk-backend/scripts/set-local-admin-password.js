// Использование: node scripts/set-local-admin-password.js "МойНадёжныйПароль"
// Выведет хэш — вставьте его в .env как LOCAL_ADMIN_PASSWORD_HASH и перезапустите сервер.
const bcrypt = require("bcrypt");

const password = process.argv[2];
if (!password) {
  console.error("Укажите пароль первым аргументом");
  process.exit(1);
}

bcrypt.hash(password, 12).then((hash) => {
  console.log("\nLOCAL_ADMIN_PASSWORD_HASH=" + hash + "\n");
});
