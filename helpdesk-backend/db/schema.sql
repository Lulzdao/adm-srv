-- Пользователи. Один аккаунт на сотрудника независимо от домена входа:
-- логины зеркальные в обоих доменах, поэтому идентичность — по ad_login,
-- домен последнего входа фиксируем отдельно (для аудита и LDAP-обращений).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_login TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  department TEXT,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- допустимые значения см. config/departments.js + 'user'
  -- Администратор — НЕ роль, а отдельный признак.
  --
  -- Роль отвечает на вопрос «в каком отделе человек исполнитель», и она одна:
  -- совместить «исполнитель ИТ» и «администратор платформы» в одном поле
  -- нельзя, а настоящий администратор обычно и то и другое. Кроме того,
  -- источники у них разные: роль настраивается из панели, а признак
  -- администратора выводится ТОЛЬКО из группы в .env и из панели недостижим.
  is_admin INTEGER NOT NULL DEFAULT 0,
  -- Отделов у исполнителя может быть НЕСКОЛЬКО: человек состоит и в группе ИТ,
  -- и в группе ХОЗ — значит видит очереди обоих. Колонка role хранит лишь
  -- первый по порядку (для подписи и совместимости), а полный список живёт
  -- здесь в виде ",it,hoz," — с запятыми по краям, чтобы точное совпадение
  -- искалось простым LIKE '%,it,%' и не цеплялось за похожие имена.
  -- Отдельная таблица связей была бы правильнее по форме, но на трёх отделах
  -- и двух сотнях сотрудников она даёт только лишние соединения.
  roles TEXT NOT NULL DEFAULT '',
  -- Все группы AD по имени, строчными: ",группа1,группа2,". Снимок на момент
  -- последнего входа — по нему, например, решается, кому доступен общий ящик
  -- рассылок Ассистента.
  ad_groups TEXT NOT NULL DEFAULT '',
  auth_type TEXT NOT NULL DEFAULT 'ad' CHECK (auth_type IN ('ad', 'local')),
  local_password_hash TEXT,
  last_domain TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  default_assignee_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_id TEXT NOT NULL UNIQUE,      -- напр. ЛСТ-0148, для показа пользователю
  title TEXT NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'progress', 'closed')),
  room TEXT,                            -- номер кабинета заявителя
  extension TEXT,                       -- внутренний номер телефона
  created_by INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  due_at TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0, -- 1 = заметка для IT, не видна заявителю
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL,
  filesize INTEGER,
  mime_type TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- new_ticket | new_comment | status_changed
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);
-- Карточка заявки читает историю и вложения по ticket_id. Индекса на них не было,
-- и каждое открытие карточки перебирало обе таблицы целиком. Замер на 20 000
-- заявок (60 000 строк истории): история 2,44 -> 0,02 мс, вложения 0,23 -> 0,012 мс.
CREATE INDEX IF NOT EXISTS idx_status_history_ticket ON status_history(ticket_id);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);

-- Отделы-исполнители (ИТ/ХОЗ/ЕГРПО и то, что вы добавите) заполняются
-- из config/departments.js при каждом старте сервера — см. db/init.js.

-- ============================================================================
--  Оповещения
--
--  Факт и доставка разнесены намеренно. Одно событие («истекает сертификат»)
--  уезжает стольким людям, сколько адресов в списке; если хранить это одной
--  таблицей, как делала старая notifications, то на семь адресов в ленте
--  окажется семь строк об одном и том же сертификате.
--
--  Старая таблица notifications оставлена в схеме: db/init.js переносит из неё
--  строки в новую пару и больше в неё не пишет.
-- ============================================================================

-- Что произошло. Одна строка на факт.
CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- ключ из config/notifications.js
  source TEXT NOT NULL,         -- helpdesk | certs | smdr
  subject TEXT,                 -- человекочитаемо: «ИТ-0148 — не работает принтер»
  -- Заявка, если событие про заявку. ИМЕННО NULLABLE: у оповещения про
  -- сертификат заявки нет и быть не может, а прежняя таблица требовала
  -- ticket_id NOT NULL — из-за этого в неё нечего было писать, кроме заявок.
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  subject_ref TEXT,             -- id внутри источника для не-заявок: uuid МЧД, отпечаток серта
  -- Гарантия «ровно один раз». Планировщик обходит сроки хоть каждый час;
  -- вставка идёт как ON CONFLICT DO NOTHING, поэтому повторное событие по тому
  -- же порогу того же документа просто не создаётся.
  dedup_key TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'crit')),
  payload TEXT,                 -- JSON с подстановками для шаблона
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Куда ушло. Одна строка на каждый адрес и каждый канал.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('inapp', 'email', 'iskra')),
  user_id INTEGER REFERENCES users(id),  -- канал inapp: чей бейдж; iskra: кому
  address TEXT,                          -- канал email: куда слали; iskra: ФИО получателя
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,                            -- ответ SMTP, если не ушло
  is_read INTEGER NOT NULL DEFAULT 0,    -- только для inapp
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  sent_at TEXT
);

-- Настройки категории. Здесь только то, что настраивается; сам перечень
-- категорий живёт в config/notifications.js и в базе не дублируется.
CREATE TABLE IF NOT EXISTS notification_settings (
  kind TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  emails TEXT,        -- адреса, по одному на строку; пусто у категорий author/borrow
  thresholds TEXT,    -- «30,20,10,5» — только у категорий со сроками
  subject_tpl TEXT,
  body_tpl TEXT,
  -- Каналы через запятую: «email,inapp,iskra». NULL — как задано по умолчанию
  -- в config/notifications.js. Есть не у всех категорий: у заявок и сроков
  -- сертификатов каналы фиксированы, выбор появился вместе с задачами.
  channels TEXT,
  updated_at TEXT,
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_notif_events_created ON notification_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_events_ticket ON notification_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_notif_deliv_event ON notification_deliveries(event_id);
-- Бейдж «непрочитанные» спрашивает ровно это: свои непрочитанные в ленте.
CREATE INDEX IF NOT EXISTS idx_notif_deliv_inapp ON notification_deliveries(user_id, is_read) WHERE channel = 'inapp';
-- Повтор неудачных отправок на следующем тике планировщика.
CREATE INDEX IF NOT EXISTS idx_notif_deliv_pending ON notification_deliveries(status) WHERE status = 'pending';
-- Бейдж «непрочитанные» берёт последние 50 отметок пользователя. Существующий
-- индекс (user_id, is_read) годится для отбора, но не для сортировки: порядок
-- строился временной таблицей по ВСЕЙ переписке человека. Этот индекс даёт и
-- отбор, и порядок сразу — но работает только в паре с ORDER BY d.id DESC
-- (см. routes/notifications.js). Замер при 20 000 отметок: 8,16 -> 0,11 мс.
CREATE INDEX IF NOT EXISTS idx_notif_deliv_inapp_id ON notification_deliveries(user_id, id DESC) WHERE channel = 'inapp';

-- ============================================================================
--  Задачи администраторов (раздел «Задачи»)
--
--  Отдельно от заявок: заявка — просьба сотрудника к отделу, у неё есть
--  заявитель и очередь; задача — внутренняя работа администраторов, у неё есть
--  срок и ответственные. Смешивать их в одной таблице значило бы ослабить
--  проверки обеих: у заявки обязательны кабинет и телефон, у задачи — нет.
-- ============================================================================
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'progress', 'done')),
  -- Срок — день и, по желанию, время. Раздельно, а не одной отметкой: у
  -- большинства задач времени нет вовсе («до пятницы»), и хранить для них
  -- выдуманные 00:00 значило бы показывать их просроченными с самого утра.
  due_date TEXT,        -- YYYY-MM-DD
  due_time TEXT,        -- HH:MM или NULL
  tags TEXT NOT NULL DEFAULT '',   -- метки через запятую: «Лицензии,Оборудование»
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  -- Отметки времени — в UTC, как у заявок: фронтенд (fmtDate) так их и читает.
  -- Сроки выше — наоборот, местные: их вводит человек как «2 октября, 18:00».
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT,
  done_by INTEGER REFERENCES users(id)
);

-- Ответственные. seen_event_id — последнее событие истории, которое человек
-- видел, открыв задачу: всё, что другие сделали позже (назначили, написали),
-- для него «новое» и считается в счётчике у пункта меню. Номер события, а не
-- время: у отметок времени точность в секунду, и назначение с открытием в одну
-- секунду выглядели бы как «уже видел».
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  seen_event_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER REFERENCES users(id),
  done_at TEXT
);

-- История задачи: кто, что и когда поменял, плюс комментарии. Одна лента, а не
-- две таблицы: в карточке их всё равно показывают вперемешку по времени, а
-- «срок сдвинули, потом написали почему» читается только вместе.
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),   -- NULL — действие платформы (напоминание)
  kind TEXT NOT NULL,                     -- created | comment | status | due | ... (см. routes/tasks.js)
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_task_checklist_task ON task_checklist(task_id, position);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);

-- ============================================================================
--  Ассистент: акты, рассылки; справочники для заявки на доступ
--
--  Замена прежнему отдельному «Ассистенту» и «Почтальону». Всё с префиксом
--  asst_ / mail_, чтобы в базе было видно, чьи это таблицы.
-- ============================================================================

-- Отделы и их начальники — с падежами: в документах пишется «прошу передать
-- начальнику отдела … Иванову И.И. от начальника отдела … Петрова П.П.».
CREATE TABLE IF NOT EXISTS asst_depts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,       -- «Отдел статистики цен»; склоняется само
  chief_name TEXT,                 -- «Иванов И.И.»
  chief_name_dat TEXT,             -- «Иванову И.И.»: нужно только отделу ИТ
  sort INTEGER NOT NULL DEFAULT 0
);

-- Люди, которые появляются в документах: руководитель, заместитель,
-- начальник ОИРиТ (утверждает акты), составители актов, комиссия по списанию.
CREATE TABLE IF NOT EXISTS asst_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('boss', 'deputy', 'it_chief', 'responsible', 'chair', 'member')),
  name TEXT NOT NULL,              -- «Иванов И.И.»
  name_dat TEXT,                   -- «Иванову И.И.» — нужен руководителю в шапке «кому»
  post TEXT,
  post_dat TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Загруженные администратором шаблоны. Нет строки — действует встроенный.
CREATE TABLE IF NOT EXISTS asst_templates (
  kind TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  data BLOB NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Типовые неисправности: готовые тексты для акта на ремонт — выбрал вид
-- неисправности, и в форму подставились описание, работы и остатки.
CREATE TABLE IF NOT EXISTS asst_repair_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  defect TEXT,
  repair_works TEXT,
  remains TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS asst_writeoff_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  reason TEXT NOT NULL
);

-- Анкета, из которой создана заявка (сейчас — заявка на доступ сотрудника).
-- Отдельно от tickets: у обычной заявки анкеты нет, и сорок пустых колонок
-- ради одного вида заявок в основной таблице ни к чему.
CREATE TABLE IF NOT EXISTS ticket_forms (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Реестр актов: номер в пределах года, вид и данные, по которым акт собран, —
-- чтобы его можно было скачать ещё раз ровно таким же.
CREATE TABLE IF NOT EXISTS asst_acts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  num INTEGER NOT NULL,
  type TEXT NOT NULL,              -- repair | writeoff | cartridges | parts_memo
  date TEXT NOT NULL,              -- YYYY-MM-DD
  title TEXT NOT NULL,
  data TEXT NOT NULL,              -- JSON
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asst_acts_year ON asst_acts(year, num);

-- Общие ящики рассылок: у каждого отдела свой. Логин — сам адрес; пароль —
-- пароль приложения (почта не пускает программы по обычному). ad_group —
-- группа домена, участникам которой ящик виден; пусто — виден всем.
CREATE TABLE IF NOT EXISTS mail_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL DEFAULT '',
  ad_group TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Рассылки респондентам (бывший «Почтальон»).
CREATE TABLE IF NOT EXISTS mail_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  use_template INTEGER NOT NULL DEFAULT 1,
  sender_mode TEXT NOT NULL CHECK (sender_mode IN ('shared', 'own')),
  sender_address TEXT,             -- с какого адреса ушло: общий ящик или свой
  sender_login TEXT,               -- логин своего ящика; пароль не хранится нигде
  mailbox_id INTEGER REFERENCES mail_boxes(id) ON DELETE SET NULL, -- общий ящик, с которого идёт рассылка
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'paused', 'done', 'cancelled')),
  paused_reason TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS mail_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,
  okpo TEXT,
  name TEXT,
  emails TEXT NOT NULL,            -- через запятую
  fields TEXT,                     -- JSON: все колонки строки — для подстановок {Колонка}
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_recipients_campaign ON mail_recipients(campaign_id, status);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL
);

-- Сеансы входа (services/sessionStore.js). Раньше express-session держал их в памяти процесса,
-- и любой перезапуск платформы — обновление, перезапуск службы, переход на https из панели —
-- выкидывал из системы всех сразу, хотя вход обещан на 30 дней.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL  -- мс от эпохи; просроченные удаляются раз в час
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
