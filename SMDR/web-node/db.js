const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'smdr.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    ext TEXT PRIMARY KEY,
    fio TEXT
  )
`);

// Встроенный LOWER() в SQLite понимает только латиницу.
// Регистрируем свою функцию на JS — toLowerCase() корректно работает с кириллицей.
db.function('lower_ru', { deterministic: true }, (str) => {
  if (str === null || str === undefined) return null;
  return String(str).toLowerCase();
});

module.exports = db;
