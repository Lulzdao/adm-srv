// Есть ли у пользователя права администратора (elevation.js) — от этого зависит, закрываться ли
// клиенту ради обновления. Имена и номера учётных записей выдуманы.
//
// Запуск:  node --test  (из папки desktop-client)

const test = require('node:test');
const assert = require('node:assert');
const { hasAdminGroup, detectCanElevate } = require('./elevation');

const ADMIN = [
  '"Все","Хорошо известная группа","S-1-1-0","Обязательная группа, Включены по умолчанию, Включенная группа"',
  '"BUILTIN\\Администраторы","Псевдоним","S-1-5-32-544","Обязательная группа, Включены по умолчанию, Включенная группа, Владелец группы"',
  '"BUILTIN\\Пользователи","Псевдоним","S-1-5-32-545","Обязательная группа, Включены по умолчанию, Включенная группа"',
].join('\r\n');
// Администратор без повышения прав: группа есть, но помечена «только для запрета».
const ADMIN_FILTERED = ADMIN.replace('Обязательная группа, Включены по умолчанию, Включенная группа, Владелец группы', 'Группа, используемая только для запрета');
const USER = [
  '"Все","Хорошо известная группа","S-1-1-0","Обязательная группа, Включены по умолчанию, Включенная группа"',
  '"BUILTIN\\Пользователи","Псевдоним","S-1-5-32-545","Обязательная группа, Включены по умолчанию, Включенная группа"',
  '"TEST\\Группа-5440","Группа","S-1-5-21-1111111111-222222222-333333333-5440","Обязательная группа"',
  '"TEST\\Otdel","Группа","S-1-5-21-1-5-32-5441","Обязательная группа"',
].join('\r\n');

test('группа «Администраторы» ищется по номеру, а не по имени', () => {
  assert.strictEqual(hasAdminGroup(ADMIN), true);
  assert.strictEqual(hasAdminGroup(ADMIN_FILTERED), true, 'администратор без повышения прав — права есть');
  assert.strictEqual(hasAdminGroup('"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group"'), true, 'английская Windows');
  assert.strictEqual(hasAdminGroup(USER), false, 'похожие номера других групп не считаются');
  assert.strictEqual(hasAdminGroup(''), false);
  assert.strictEqual(hasAdminGroup(undefined), false);
});

test('не Windows или whoami не выполнился — «неизвестно», а не «прав нет»', () => {
  assert.strictEqual(detectCanElevate('win32', () => ADMIN), true);
  assert.strictEqual(detectCanElevate('win32', () => USER), false);
  assert.strictEqual(detectCanElevate('linux', () => ADMIN), null);
  assert.strictEqual(detectCanElevate('win32', () => { throw new Error('whoami не найден'); }), null);
  assert.strictEqual(detectCanElevate('win32', () => ''), null, 'пустой вывод — не ответ');
});
