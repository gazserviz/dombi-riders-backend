// ============================================================================
// lib/permissions-catalog.js — каталог на всички модули/действия и страници
// от менюто, върху които СУПЕР АДМИНИСТРАТОРЪТ може да конфигурира достъп по
// роля (виж lib/db.js: getPermissionsMatrix/hasPermission/canAccessNav и
// server.js: requirePermission/requireSuperAdmin).
//
// defaultRoles / NAV_DEFAULTS отразяват ТОЧНОТО поведение на системата отпреди
// въвеждането на тази конфигурируема матрица — при първо стартиране с новия
// код матрицата се "засява" точно с тези стойности, така че НИЩО не се
// променя автоматично за никого; само става конфигурируемо от супер админа.
//
// Само чисти данни тук — файлът НЕ зависи от db.js (за да няма кръгови
// require), db.js го изисква и го ползва.
// ============================================================================

// Йерархия на ролите (за информация в UI и валидация на вход) — super_admin
// винаги има пълен достъп навсякъде, независимо от матрицата (виж db.js).
const ROLES = ['driver', 'manager', 'admin', 'super_admin'];

const ROLE_LABELS = {
  driver: 'Шофьор',
  manager: 'Мениджър',
  admin: 'Администратор',
  super_admin: 'Супер администратор',
};

// ---------------------------------------------------------------------------
// Видимост на страниците от менюто (sidebar) — ключът е href-ът точно както
// е в NAV масива в public/js/app.js. Управлява КОИ страници вижда всяка роля;
// реалната защита на данните/действията е през ACTION_MODULES по-долу и
// съответните API проверки в server.js — тази матрица е "кой какво вижда".
// ---------------------------------------------------------------------------
const NAV_DEFAULTS = {
  '/home.html': ['admin', 'manager'],
  '/vehicles.html': ['admin', 'manager', 'driver'],
  '/talons.html': ['admin', 'manager'],
  '/assignments.html': ['admin', 'manager', 'driver'],
  '/protocol-new.html': ['admin', 'manager'],
  '/contracts.html': ['admin', 'manager'],
  '/templates.html': ['admin', 'manager'],
  '/stats.html': ['admin', 'manager'],
  '/fleet-showcase.html': ['admin', 'manager'],
  '/site-editor.html': ['admin', 'manager'],
  '/wallet.html': ['admin', 'manager', 'driver'],
  '/personnel.html': ['admin', 'manager'],
  '/personnel-detail.html': ['driver'],
  '/applications.html': ['admin', 'manager'],
  '/payroll.html': ['admin', 'manager', 'driver'],
  '/leave.html': ['admin', 'manager', 'driver'],
  '/partners.html': ['admin'],
  '/finance.html': ['admin', 'manager'],
  '/cashier.html': ['admin', 'manager'],
  '/mail.html': ['admin'],
  'https://mail.zoho.eu': ['admin'],
  '/users.html': ['admin'],
  '/activity.html': ['admin'],
  '/backups.html': ['admin'],
  '/nav-settings.html': ['admin'],
  // нова страница — само супер администраторът я вижда/използва по подразбиране
  // (и без значение какво реши да сложи тук, самото API остава заключено само
  // за super_admin — виж requireSuperAdmin в server.js)
  '/permissions.html': ['super_admin'],
};

// ---------------------------------------------------------------------------
// API/действия — "кой какво може да пипа" (създава/редактира/трие/одобрява).
// Групирани по логически модул (не 1:1 с NAV страница — напр.талони и
// трудови договори са част от по-широки модули). defaultRoles е ТОЧНОТО
// изискване, което съответният endpoint е имал преди тази система (виж
// requireRole() извикванията в server.js, вече заменени с requirePermission).
// ---------------------------------------------------------------------------
const ACTION_MODULES = [
  {
    key: 'site_editor',
    label: 'Начална страница и витрина на сайта',
    actions: [
      { key: 'view', label: 'Преглед на заявки/съдържание', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Редакция на съдържание и витрина', defaultRoles: ['admin', 'manager'] },
    ],
  },
  {
    key: 'nav_settings',
    label: 'Навигация на менюто (имена/ред)',
    actions: [
      { key: 'manage', label: 'Редакция на менюто', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'users',
    label: 'Потребители и роли',
    actions: [
      { key: 'view', label: 'Преглед на списъка с потребители', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Създаване/редакция/нова парола', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'vehicles',
    label: 'Коли и талони',
    actions: [
      { key: 'view', label: 'Преглед на сервизни/периодични разходи', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Добавяне/редакция, талони, пробег, огледи', defaultRoles: ['admin', 'manager'] },
      { key: 'delete', label: 'Изтриване на кола', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'assignments',
    label: 'Зачисления на коли',
    actions: [
      { key: 'manage', label: 'Зачисляване/освобождаване', defaultRoles: ['admin', 'manager'] },
    ],
  },
  {
    key: 'protocols',
    label: 'Протоколи',
    actions: [
      { key: 'manage', label: 'Нов протокол / редакция', defaultRoles: ['admin', 'manager'] },
    ],
  },
  {
    key: 'contracts',
    label: 'Договори за наем и плащания',
    actions: [
      { key: 'view', label: 'Преглед на договори и плащания', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Нов договор / редакция / плащане', defaultRoles: ['admin', 'manager'] },
    ],
  },
  {
    key: 'wallet',
    label: 'Портфейли',
    actions: [
      { key: 'view', label: 'Преглед на всички портфейли', defaultRoles: ['admin', 'manager'] },
      { key: 'adjust', label: 'Ръчна корекция по портфейл', defaultRoles: ['admin'] },
    ],
  },
  {
    // "Обща каса" = портфейлът на ЕДИН избран служител (обикновено мениджър),
    // определен от супер администратора, който служи за общата фирмена каса —
    // наемите от коли (виж payroll_entries.car_rent_amount) се вливат в него
    // автоматично. Прегледът е конфигурируем оттук, но РЪЧНИТЕ движения по
    // касата остават ЗАКЛЮЧЕНИ само за super_admin директно в кода (виж
    // requireSuperAdmin в server.js) — нарочно НЕ е действие в тази матрица,
    // за да не може дори супер администраторът случайно да го отвори за други.
    key: 'cashier',
    label: 'Обща каса',
    actions: [
      { key: 'view', label: 'Преглед на баланс и движения', defaultRoles: ['admin', 'manager'] },
    ],
  },
  {
    key: 'finance',
    label: 'Счетоводство',
    actions: [
      { key: 'view', label: 'Преглед на отчет и записи', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Добавяне/изтриване на запис', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'backups',
    label: 'Резервни копия',
    actions: [
      { key: 'view', label: 'Преглед/изтегляне', defaultRoles: ['admin'] },
      { key: 'manage', label: 'Ръчен бекъп / възстановяване', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'mail',
    label: 'Пощенска кутия',
    actions: [
      { key: 'view', label: 'Преглед на входяща/изходяща поща', defaultRoles: ['admin'] },
      { key: 'manage', label: 'Изпращане на писма', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'hr_personnel',
    label: 'Досиета на служители и трудови договори',
    actions: [
      { key: 'view', label: 'Преглед на досие', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Редакция, снимки, линкове, трудов договор', defaultRoles: ['admin', 'manager'] },
      { key: 'delete', label: 'Изтриване / черен списък', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'payroll',
    label: 'Заплати',
    actions: [
      { key: 'view', label: 'Преглед на импорт статус/удръжки', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Въвеждане на седмица / импорт', defaultRoles: ['admin', 'manager'] },
      { key: 'finalize', label: 'Маркиране като платено / настройки на удръжки', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'leave',
    label: 'Отпуски',
    actions: [
      { key: 'decide', label: 'Одобряване/отказ на заявка', defaultRoles: ['admin', 'manager'] },
      { key: 'manage_balance', label: 'Редакция на баланс дни отпуск', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'partners',
    label: 'Партньорски комисионни',
    actions: [
      { key: 'view', label: 'Преглед', defaultRoles: ['admin'] },
      { key: 'manage', label: 'Редакция на профил на комисионна', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'applications',
    label: 'Кандидатури',
    actions: [
      { key: 'view', label: 'Преглед на кандидатури', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Отказ / изпращане на линк', defaultRoles: ['admin', 'manager'] },
      { key: 'edit', label: 'Редакция/изтриване на кандидатура', defaultRoles: ['admin'] },
      { key: 'approve', label: 'Одобряване (превръща в служител)', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'templates',
    label: 'Бланки и шаблони',
    actions: [
      { key: 'view', label: 'Преглед', defaultRoles: ['admin', 'manager'] },
      { key: 'manage', label: 'Редакция / качване на шаблон', defaultRoles: ['admin'] },
    ],
  },
  {
    key: 'esign',
    label: 'Електронно подписване',
    actions: [
      { key: 'manage', label: 'Подписване на място / изпращане за отдалечено подписване', defaultRoles: ['admin', 'manager'] },
    ],
  },
  {
    key: 'stats',
    label: 'Статистики и начален изглед',
    actions: [
      { key: 'view', label: 'Преглед', defaultRoles: ['admin', 'manager'] },
    ],
  },
  {
    key: 'activity_log',
    label: 'Дневник на активността',
    actions: [
      { key: 'view', label: 'Преглед', defaultRoles: ['admin'] },
    ],
  },
];

module.exports = { ROLES, ROLE_LABELS, NAV_DEFAULTS, ACTION_MODULES };
