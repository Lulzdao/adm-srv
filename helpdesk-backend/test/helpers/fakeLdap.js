'use strict';

// ============================================================================
//  Поддельный контроллер домена
//
//  services/ldapAuth.js ходит в AD через Client из ldapts. Настоящего сервера LDAP
//  в тестах нет и тянуть его пакетом на закрытый контур незачем — поэтому модуль
//  ldapts подменяется в кэше require ДО загрузки ldapAuth: тот получает этот
//  Client и работает с ним ровно так же, как с настоящим (bind сервисной учёткой,
//  поиск по sAMAccountName, bind под пользователем).
//
//  Подменяется только сетевой клиент — вся логика входа (группы, отделы, права,
//  ошибки, запись в базу, сессия) проверяется настоящая, через HTTP-маршрут.
//  resetModuleCache в tempDb.js модули из node_modules не трогает, так что подмена
//  переживает пересборку приложения между тестами.
//
//  Имена, логины и группы выдуманы.
// ============================================================================

const directory = {
  svc: { dn: "", password: "" },
  users: new Map(),   // sAMAccountName -> { dn, password, attrs }
  down: false,        // контроллер недоступен: bind сервисной учётки падает
  searchFails: false, // поиск падает (например, referral на свежую учётку)
  filters: [],        // какие фильтры поиска реально ушли в «домен»
};

class FakeClient {
  constructor(options) {
    this.options = options;
  }

  async bind(dn, password) {
    if (directory.down) throw new Error("connect ECONNREFUSED (контроллер недоступен)");
    if (dn === directory.svc.dn && password === directory.svc.password) return;
    for (const u of directory.users.values()) {
      if (u.dn === dn && u.password === password) return;
    }
    throw new Error("InvalidCredentialsError: 80090308");
  }

  async search(base, { filter }) {
    directory.filters.push(filter);
    if (directory.searchFails) throw new Error("referral");
    const m = /^\(sAMAccountName=(.*)\)$/.exec(filter);
    const u = m && directory.users.get(m[1]);
    return { searchEntries: u ? [{ dn: u.dn, ...u.attrs }] : [], searchReferences: [] };
  }

  async unbind() {}
}

require.cache[require.resolve("ldapts")] = {
  id: require.resolve("ldapts"),
  filename: require.resolve("ldapts"),
  loaded: true,
  exports: { Client: FakeClient },
};

/** Пользователь в «домене». memberOf — полные DN групп. */
function addUser(login, { password, displayName, mail, department, phone, memberOf = [], userAccountControl = 512 }) {
  directory.users.set(login, {
    dn: `CN=${displayName || login},OU=Сотрудники,DC=test,DC=local`,
    password,
    attrs: { displayName, mail, department, telephoneNumber: phone, memberOf, userAccountControl: String(userAccountControl) },
  });
}

function reset() {
  directory.users.clear();
  directory.down = false;
  directory.searchFails = false;
  directory.filters.length = 0;
}

const group = (name) => `CN=${name},OU=Группы,DC=test,DC=local`;

module.exports = { directory, addUser, reset, group };
