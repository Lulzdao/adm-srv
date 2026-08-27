// Единый справочник типов оповещений.
//
// Устроен так же, как config/departments.js: добавили строку — категория сама
// появилась в панели «Оповещения», в ленте и в рассылке. Возвращаться в
// services/, routes/ и во фронтенд для этого не нужно.
//
// recipients — откуда берутся адреса получателей:
//
//   list     свой список адресов, заполняется вручную в панели. В базе лежит
//            в notification_settings.emails.
//   borrow   список другой категории (см. borrowFrom). Своего поля в панели у
//            такой категории нет — заводить второй список тем же людям незачем.
//   author   автор заявки. Адрес берётся из users.email, а он перезаписывается
//            из домена при КАЖДОМ входе (services/userStore.js), поэтому всегда
//            свежий. Никаких списков здесь не участвует.
//
// В borrowFrom подстановка @department заменяется на роль отдела, к которому
// относится заявка: комментарий заявителя уходит ровно тем людям, которые
// получили саму заявку.
//
// trigger — кто порождает событие:
//   event    код платформы в момент действия (создали заявку, написали комментарий)
//   daily    ежедневный обход планировщика
//   monthly  ежемесячный обход планировщика
//
// vars — какие подстановки доступны в шаблоне. Списком пользуется не рассылка
// (она подставляет всё, что нашла в payload), а редактор шаблонов: он должен
// показывать, что вообще можно вставить, иначе шаблон правится наугад.

const departments = require("./departments");

const RECIPIENTS = { LIST: "list", BORROW: "borrow", AUTHOR: "author" };

// Поля заявки, доступные в шаблоне любого «заявочного» письма.
const TICKET_VARS = ["номер", "тема", "автор", "кабинет", "важность", "отдел"];

// Категории «новая заявка» — по одной на отдел-исполнитель. Не перечисляем
// руками: справочник отделов один, и он лежит в departments.js.
const ticketNew = departments.map((dept) => ({
  kind: `ticket_new:${dept.role}`,
  label: `Новая заявка — ${dept.name}`,
  hint: `Заявка поступила в очередь отдела «${dept.name}».`,
  source: "helpdesk",
  severity: "info",
  recipients: RECIPIENTS.LIST,
  trigger: "event",
  vars: [...TICKET_VARS, "описание"],
  defaultSubject: "[{{номер}}] Новая заявка: {{тема}}",
  defaultBody:
    "Поступила новая заявка.\n\n" +
    "Номер:     {{номер}}\n" +
    "Тема:      {{тема}}\n" +
    "Заявитель: {{автор}}\n" +
    "Кабинет:   {{кабинет}}\n" +
    "Важность:  {{важность}}\n\n" +
    "{{описание}}",
}));

const rest = [
  {
    kind: "ticket_comment_in",
    label: "Комментарий заявителя",
    hint:
      "Автор заявки что-то дописал. Уходит тем же людям, что получили саму " +
      "заявку, — включая случай, когда исполнитель ещё не назначен.",
    source: "helpdesk",
    severity: "info",
    recipients: RECIPIENTS.BORROW,
    borrowFrom: "ticket_new:@department",
    trigger: "event",
    vars: [...TICKET_VARS, "текст"],
    defaultSubject: "[{{номер}}] Комментарий заявителя",
    defaultBody: "{{автор}} добавил комментарий к заявке {{номер}} «{{тема}}»:\n\n{{текст}}",
  },
  {
    kind: "ticket_status",
    label: "Статус заявки изменён",
    hint: "Уходит автору заявки. Переход в «выполнена» и «закрыта» — отдельная категория ниже.",
    source: "helpdesk",
    severity: "info",
    recipients: RECIPIENTS.AUTHOR,
    trigger: "event",
    vars: [...TICKET_VARS, "статус", "исполнитель"],
    defaultSubject: "[{{номер}}] Статус заявки изменён: {{статус}}",
    defaultBody:
      "Ваша заявка {{номер}} «{{тема}}» перешла в статус «{{статус}}».\n\n" +
      "Исполнитель: {{исполнитель}}",
  },
  {
    kind: "ticket_resolved",
    label: "Заявка выполнена или закрыта",
    hint: "Отдельно от смены статуса: письмо «заявка выполнена» читается совсем иначе.",
    source: "helpdesk",
    severity: "info",
    recipients: RECIPIENTS.AUTHOR,
    trigger: "event",
    vars: [...TICKET_VARS, "статус", "исполнитель"],
    defaultSubject: "[{{номер}}] Заявка выполнена",
    defaultBody:
      "Ваша заявка {{номер}} «{{тема}}» выполнена.\n\n" +
      "Исполнитель: {{исполнитель}}\n\n" +
      "Если вопрос решён не полностью — откройте заявку и напишите комментарий.",
  },
  {
    kind: "ticket_comment_out",
    label: "Ответ по заявке",
    hint: "Комментарий написал не автор заявки — письмо уходит автору.",
    source: "helpdesk",
    severity: "info",
    recipients: RECIPIENTS.AUTHOR,
    trigger: "event",
    vars: [...TICKET_VARS, "текст", "автор_комментария"],
    defaultSubject: "[{{номер}}] Ответ по заявке",
    defaultBody: "{{автор_комментария}} ответил по заявке {{номер}} «{{тема}}»:\n\n{{текст}}",
  },
  {
    kind: "expiry",
    label: "Истекает срок действия",
    hint: "Сертификаты и машиночитаемые доверенности вместе — пороги у них общие.",
    source: "certs",
    severity: "warn",
    recipients: RECIPIENTS.LIST,
    trigger: "daily",
    thresholds: "30,20,10,5",
    vars: ["вид", "фио", "срок", "осталось_дней", "номер_документа"],
    defaultSubject: "Истекает срок: {{вид}} — {{фио}}",
    defaultBody:
      "{{вид}} на {{фио}} истекает {{срок}}.\n" +
      "Осталось дней: {{осталось_дней}}\n\n" +
      "Пора готовить перевыпуск.",
  },
  {
    kind: "expired",
    label: "Срок действия истёк",
    hint: "Одно письмо в день истечения. Список получателей тот же, что у «Истекает срок».",
    source: "certs",
    severity: "crit",
    recipients: RECIPIENTS.BORROW,
    borrowFrom: "expiry",
    trigger: "daily",
    vars: ["вид", "фио", "срок", "номер_документа"],
    defaultSubject: "Срок истёк: {{вид}} — {{фио}}",
    defaultBody: "{{вид}} на {{фио}} истёк {{срок}}.\n\nТребуется срочно выпустить новый.",
  },
  {
    kind: "minutes_monthly",
    label: "Исходящие минуты за месяц",
    hint: "Первого числа за прошлый месяц, одной цифрой по организации.",
    source: "smdr",
    severity: "info",
    recipients: RECIPIENTS.LIST,
    trigger: "monthly",
    vars: ["период", "минуты", "звонков"],
    defaultSubject: "Исходящие минуты за {{период}}",
    defaultBody:
      "За {{период}} израсходовано {{минуты}} исходящих минут.\n" +
      "Всего звонков: {{звонков}}",
  },
];

const KINDS = [...ticketNew, ...rest];
const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));

function byKind(kind) {
  return BY_KIND.get(kind) || null;
}

/**
 * Ключ категории «новая заявка» для отдела. Одно место, где собирается это
 * имя, — чтобы оно не разъехалось между справочником, рассылкой и панелью.
 */
function ticketNewKind(role) {
  return `ticket_new:${role}`;
}

module.exports = { KINDS, RECIPIENTS, byKind, ticketNewKind };
