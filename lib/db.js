// ============================================================================
// lib/db.js — слой за достъп до данни.
//
// В момента чете/пише в data/db.json (файлова "база данни") — това е режим
// за локална разработка/демо, работещ без интернет и без инсталирани пакети.
//
// Когато Supabase бъде свързан, всяка функция тук трябва да се замени с
// реално REST извикване към Supabase (PostgREST) — интерфейсът (входове/
// изходи) на функциите е проектиран да съвпада 1:1 с таблиците в schema.sql,
// затова смяната на "мотора" не изисква промяна в server.js или public/*.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROLES, NAV_DEFAULTS, ACTION_MODULES } = require('./permissions-catalog');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

// ---------------------------------------------------------------------------
// ПАРОЛИ — хеширане с вградения в Node crypto.scrypt (без външен пакет, за да
// работи навсякъде без npm registry достъп). Формат: "scrypt$<сол>$<хеш>".
// Сравнението е с crypto.timingSafeEqual, за да не изтича информация през
// времето за отговор. Стари (демо) записи с чист текст се самолекуват еднократно
// при стартиране на сървъра (виж migratePlaintextPasswords по-долу).
// ---------------------------------------------------------------------------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (String(stored).startsWith('scrypt$')) {
    const parts = String(stored).split('$');
    if (parts.length !== 3) return false;
    const [, salt, hashHex] = parts;
    try {
      const hashBuf = Buffer.from(hashHex, 'hex');
      const testBuf = crypto.scryptSync(String(plain), salt, 64);
      if (hashBuf.length !== testBuf.length) return false;
      return crypto.timingSafeEqual(hashBuf, testBuf);
    } catch (e) {
      return false;
    }
  }
  // legacy демо seed с чист текст, преди да е минал през миграцията по-долу
  return stored === plain;
}

// еднократна самолечебна миграция — хешира всяка парола, която още е с чист
// текст (напр. демо потребителите admin123/manager123/driver123). Извиква се
// веднъж при стартиране на сървъра (server.js).
function migratePlaintextPasswords() {
  const db = readDb();
  let changed = false;
  (db.profiles || []).forEach(p => {
    if (p.password && !String(p.password).startsWith('scrypt$')) {
      p.password = hashPassword(p.password);
      changed = true;
    }
  });
  if (changed) writeDb(db);
  return changed;
}

// ---------------------------------------------------------------------------
// ПОСТОЯННОСТ НА ДАННИТЕ — Postgres (Supabase), с автоматичен fallback към
// локалния JSON файл.
//
// ЗАЩО ТАКА, А НЕ ПЪЛНА RELATIONAL МИГРАЦИЯ КЪМ schema.sql: цялото приложение
// (server.js + всяка функция тук) е писано синхронно, върху един голям JS
// обект. Пренаписването му ред по ред към async Postgres заявки за всяка
// таблица е огромна по обхват промяна с реален риск за реалните данни на
// шофьорите (виж DEPLOYMENT.md). Вместо това: пазим целия обект в паметта
// (CACHE) и го персистваме като ЕДИН JSON ред в таблицата kv_store (виж
// migration create_kv_store в Supabase проекта) — синхронният интерфейс на
// readDb()/writeDb() НЕ се променя за останалия код, само механизмът зад тях.
//
// Причина да е нужно: Render free tier (избран от собственика на бизнеса)
// НЯМА постоянен диск — локалният data/db.json се губи при всеки
// redeploy/рестарт на контейнера. kv_store в Supabase Postgres преживява
// рестарт на Render процеса.
//
// Ако DATABASE_URL не е зададен (локална разработка, или деплой с платен
// Render план + постоянен диск) — поведението е ТОЧНО както досега: чете/
// пише синхронно от data/db.json, без никаква разлика.
// ---------------------------------------------------------------------------
const KV_KEY = 'main_db';
let pgPool = null;
let CACHE = null; // != null само когато сме Postgres-backed (виж initDb)

function loadPg() {
  try { return require('pg'); } catch (e) { return null; }
}

function readDbFromFile() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDbToFile(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// Извиква се ЕДНОКРАТНО при стартиране на сървъра (виж server.js), ПРЕДИ
// server.listen(...). Ако DATABASE_URL липсва или пакетът "pg" не е наличен
// (напр. в среда без npm registry достъп), тихо остава на файловия режим.
async function initDb() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) return;
  const pg = loadPg();
  if (!pg) {
    console.error('DATABASE_URL е зададен, но пакетът "pg" липсва в тази среда — оставам на локалния файл data/db.json (виж package.json).');
    return;
  }
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query('select 1'); // проверка на връзката, преди да разчитаме на нея
    const { rows } = await pool.query('select value from kv_store where key = $1', [KV_KEY]);
    if (rows.length) {
      CACHE = rows[0].value;
      console.log('Заредена база от Postgres/Supabase (kv_store) — записи: '
        + `${(CACHE.profiles || []).length} профила, ${(CACHE.payroll_entries || []).length} заплати.`);
    } else {
      CACHE = readDbFromFile(); // първо стартиране: "засяваме" от локалния json (реалните данни от бекфила)
      await pool.query(
        'insert into kv_store (key, value) values ($1, $2::jsonb) on conflict (key) do nothing',
        [KV_KEY, JSON.stringify(CACHE)]
      );
      console.log('Postgres kv_store беше празна — заредена начална база от data/db.json и записана в Postgres.');
    }
    pgPool = pool;
  } catch (e) {
    console.error('Грешка при връзка с Postgres — оставам на локалния файл data/db.json:', e.message);
    pgPool = null;
    CACHE = null;
  }
}

function readDb() {
  if (CACHE) return CACHE;
  return readDbFromFile();
}

function writeDb(db) {
  if (pgPool) {
    CACHE = db;
    // асинхронен, best-effort запис — не блокира заявката; грешка тук се
    // логва, но не чупи текущия HTTP отговор (данните вече са в паметта)
    pgPool.query(
      'insert into kv_store (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()',
      [KV_KEY, JSON.stringify(db)]
    ).catch(e => console.error('Грешка при запис в Postgres kv_store:', e.message));
    return;
  }
  writeDbToFile(db);
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// PROFILES / AUTH
// ---------------------------------------------------------------------------
function findUserByEmail(email) {
  const db = readDb();
  return db.profiles.find(p => p.email.toLowerCase() === String(email).toLowerCase());
}

function findUserById(id) {
  const db = readDb();
  return db.profiles.find(p => p.id === id);
}

function listUsers() {
  const db = readDb();
  return db.profiles.map(({ password, ...rest }) => rest);
}

function createUser({ full_name, email, password, phone, role }) {
  const db = readDb();
  if (db.profiles.some(p => p.email.toLowerCase() === email.toLowerCase())) {
    throw new Error('Вече има потребител с този имейл');
  }
  const user = {
    id: uid('u'),
    full_name, email, password: hashPassword(password), phone: phone || '',
    role: role || 'driver',
    status: 'active',
    permissions: {},
    // всеки нов профил тръгва с временна парола (зададена от админ или
    // автогенерирана по шаблон "име123", виж generateTempPassword в
    // server.js) — служителят вижда подкана да я смени при първо влизане
    // (виж must_change_password в app.js/mountShell и PUT /api/me/password)
    must_change_password: true,
    created_at: nowIso(),
  };
  db.profiles.push(user);
  writeDb(db);
  const { password: _pw, ...safe } = user;
  return safe;
}

function updateUser(id, patch) {
  const db = readDb();
  const idx = db.profiles.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Потребителят не е намерен');
  const safePatch = patch.password ? { ...patch, password: hashPassword(patch.password) } : patch;
  db.profiles[idx] = { ...db.profiles[idx], ...safePatch };
  writeDb(db);
  const { password, ...safe } = db.profiles[idx];
  return safe;
}

// трайно изтрива служител — САМО ако няма никаква свързана история (трудови/
// граждански договори, договори за наем, зачисления, портфейл, ведомост).
// Ако има такава, изтриването се блокира с ясна грешка — вместо изтриване
// служителят трябва да бъде спрян (status='inactive') или вкаран в черен
// списък, за да не изчезне финансова/HR история по невнимание.
function deleteUser(id) {
  const db = readDb();
  const idx = db.profiles.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Служителят не е намерен');

  const hasContracts = (db.employment_contracts || []).some(c => c.profile_id === id);
  const hasRentals = (db.rental_contracts || []).some(c => c.renter_driver_id === id);
  const hasAssignments = (db.vehicle_assignments || []).some(a => a.driver_id === id);
  const hasWallet = (db.wallet_transactions || []).some(t => t.user_id === id);
  const hasTransfers = (db.wallet_transfers || []).some(t => t.from_user_id === id || t.to_user_id === id);
  const hasPayroll = (db.payroll_entries || []).some(p => p.profile_id === id);
  const hasLeave = (db.leave_requests || []).some(r => r.profile_id === id);
  if (hasContracts || hasRentals || hasAssignments || hasWallet || hasTransfers || hasPayroll || hasLeave) {
    const err = new Error(
      'Служителят има свързана история (договори, зачисления, портфейл или ведомост) и не може да бъде изтрит директно — ' +
      'спрете профила (статус „Спрян") или го вкарайте в черен списък вместо изтриване.'
    );
    err.code = 'EMPLOYEE_HAS_HISTORY';
    throw err;
  }

  const [removed] = db.profiles.splice(idx, 1);
  db.leave_balances = (db.leave_balances || []).filter(b => b.profile_id !== id);
  writeDb(db);
  const { password, ...safe } = removed;
  return safe;
}

// ---------------------------------------------------------------------------
// ЛИНК ЗА ДОПЪЛВАНЕ НА ДОСИЕ (СЪЩЕСТВУВАЩ СЛУЖИТЕЛ) — админ/мениджър генерира
// с 1 клик уникален линк (?token=), който изпраща сам на служителя (Viber/SMS/
// имейл). Служителят отваря /personnel-details.html?token=... и допълва/
// обновява собствените си ЛК/книжка/ЕГН/адрес/телефон данни — БЕЗ вход в
// системата — върху своя вече съществуващ запис (по token), без да пипа
// роля/имейл/статус/парола.
// ---------------------------------------------------------------------------
function generatePersonnelLink(id) {
  const db = readDb();
  const user = db.profiles.find(p => p.id === id);
  if (!user) throw new Error('Служителят не е намерен');
  user.personnel_token = crypto.randomBytes(24).toString('hex');
  user.personnel_token_created_at = nowIso();
  writeDb(db);
  const { password, ...safe } = user;
  return safe;
}

function getUserByPersonnelToken(token) {
  const db = readDb();
  const user = db.profiles.find(p => p.personnel_token === token);
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

function completePersonnelDetails(token, data) {
  const db = readDb();
  const user = db.profiles.find(p => p.personnel_token === token);
  if (!user) throw new Error('Невалиден линк.');
  const allowed = [
    'phone', 'egn', 'address',
    'id_card_number', 'id_card_expiry', 'id_card_photo_url', 'id_card_photo_back_url',
    'driver_license_number', 'driver_license_expiry', 'driver_license_photo_url', 'driver_license_photo_back_url',
    'selfie_photo_url',
  ];
  allowed.forEach(k => { if (k in data) user[k] = data[k]; });
  user.personnel_details_completed_at = nowIso();
  writeDb(db);
  const { password, ...safe } = user;
  return safe;
}

// черен списък — само админ. Пази кой/кога/защо е вкарал служителя, вместо
// просто булево поле, за да остане проследимо решението.
function setUserBlacklist(id, { blacklisted, reason, actor_id }) {
  const db = readDb();
  const idx = db.profiles.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Служителят не е намерен');
  db.profiles[idx].blacklisted = !!blacklisted;
  db.profiles[idx].blacklist_reason = blacklisted ? (reason || null) : null;
  db.profiles[idx].blacklisted_at = blacklisted ? nowIso() : null;
  db.profiles[idx].blacklisted_by = blacklisted ? actor_id : null;
  writeDb(db);
  const { password, ...safe } = db.profiles[idx];
  return safe;
}

// много прост session store (memory + файл), само за демо режим
const SESSIONS = new Map();
function createSession(userId) {
  const token = uid('sess');
  SESSIONS.set(token, { userId, createdAt: Date.now() });
  return token;
}
function getSession(token) {
  return SESSIONS.get(token) || null;
}
function destroySession(token) {
  SESSIONS.delete(token);
}

// ---------------------------------------------------------------------------
// VEHICLES
// ---------------------------------------------------------------------------
function listVehicles() {
  return readDb().vehicles.map(v => ({ ...v, current_odometer_km: getCurrentOdometer(v.id) }));
}

function getVehicle(id) {
  const v = readDb().vehicles.find(v => v.id === id);
  return v ? { ...v, current_odometer_km: getCurrentOdometer(id) } : null;
}

function createVehicle(data) {
  const db = readDb();
  const vehicle = {
    id: uid('v'),
    status: 'available',
    talon_data: {},
    talon_confirmed: false,
    initial_odometer_km: 0,
    service_interval_km: 10000,
    service_interval_months: 6,
    oil_interval_km: 10000,
    oil_interval_months: 12,
    timing_belt_interval_km: 90000,
    timing_belt_interval_months: 60,
    created_at: nowIso(),
    ...data,
  };
  db.vehicles.push(vehicle);
  writeDb(db);
  return vehicle;
}

// полета, които съществуват И в основния запис на колата, И в suровите
// talon_data (разчетени от AI) — при промяна на кое да е от тях по основния
// път (напр. формата "Редактиране" в vehicle-detail.html) огледално
// обновяваме и talon_data, за да не остават "разчетени от талона" таблици
// (public/talons.html, таб "Данни от талон") показващи стари/грешни
// AI-стойности, след като потребителят вече е коригирал истинските данни.
const TALON_SYNC_KEYS = ['plate_number', 'vin', 'make', 'model', 'year', 'color', 'fuel', 'seats', 'talon_number'];

// ---------------------------------------------------------------------------
// СОБСТВЕНИК (ФИРМА) в talon_data — почти всички коли в автопарка са
// регистрирани на фирмата собственик; AI разчитането от снимка на талон
// понякога леко изкривява изписването ѝ (напр. "ДОМИ РАЙХЪРС ЕООД",
// "ДОМБИ РАЙЛЪРС ЕООД", "ДОМЕЙН РАЙЪНС ЕООД" вместо истинското име). Вместо
// да разчитаме единствено на ръчна корекция всеки път, разпознаваме тези
// "близки" разчитания чрез разстояние на Левенщайн и ги привеждаме
// автоматично към точното изписване на фирмата.
const COMPANY_NAME = 'Домби Райдърс ЕООД';

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function normalizeCompareKey(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-ZА-Я0-9]/g, ''); // маха интервали, точки, "/", наклонени тирета и т.н.
}

// връща COMPANY_NAME, ако value изглежда като (леко изкривено) изписване на
// фирмата собственик, иначе връща value непроменено (за да не пипаме
// истински различни собственици — напр. лично притежавани коли на шофьори).
// Талоните понякога изписват фирмата двуезично, разделена с "/" (кирилица
// и транслитерация на латиница) — проверяваме всяка част поотделно, за да
// не удължи изкуствено сравнявания низ и да провали иначе точното
// съвпадение.
function normalizeOwnerName(value) {
  if (!value) return value;
  const canonicalKey = normalizeCompareKey(COMPANY_NAME);
  const segments = String(value).split('/').map(s => s.trim()).filter(Boolean);
  const candidates = segments.length ? segments : [value];
  for (const seg of candidates) {
    const key = normalizeCompareKey(seg);
    if (!key) continue;
    const distance = levenshteinDistance(key, canonicalKey);
    const threshold = Math.ceil(Math.max(key.length, canonicalKey.length) * 0.5);
    if (distance <= threshold) return COMPANY_NAME;
  }
  return value;
}

// еднократна миграция (виж модела на migratePlaintextPasswords по-горе):
// нормализира собственика във talon_data на всички коли — за случаите, в
// които вече е записано изкривено AI-разчитане, преди тази нормализация да
// съществуваше.
function normalizeAllTalonOwnerNames() {
  const db = readDb();
  let changed = 0;
  (db.vehicles || []).forEach(v => {
    if (!v.talon_data || !v.talon_data.owner_name) return;
    const fixed = normalizeOwnerName(v.talon_data.owner_name);
    if (fixed !== v.talon_data.owner_name) {
      v.talon_data = { ...v.talon_data, owner_name: fixed };
      changed++;
    }
  });
  if (changed) writeDb(db);
  return changed;
}

function updateVehicle(id, patch) {
  const db = readDb();
  const idx = db.vehicles.findIndex(v => v.id === id);
  if (idx === -1) throw new Error('Колата не е намерена');
  const current = db.vehicles[idx];
  const next = { ...current, ...patch, updated_at: nowIso() };
  // ако patch-ът пипа поле, което съществува и в talon_data, огледваме и там —
  // ОСВЕН когато самият patch вече изрично задава ново talon_data (напр.
  // потвърждаването на талона върши точно обратната синхронизация).
  if (!('talon_data' in patch) && current.talon_data) {
    const touched = TALON_SYNC_KEYS.filter(k => k in patch);
    if (touched.length) {
      const syncedTalonData = { ...current.talon_data };
      touched.forEach(k => { syncedTalonData[k] = patch[k]; });
      next.talon_data = syncedTalonData;
    }
  }
  db.vehicles[idx] = next;
  writeDb(db);
  return db.vehicles[idx];
}

// еднократна самолечебна миграция (виж migratePlaintextPasswords по-горе за
// същия модел): за коли, чийто талон вече Е потвърден, огледва основните
// полета на колата (истината СЛЕД потвърждаване/корекция) обратно в
// talon_data — за случаите, в които потребителят е коригирал данните през
// основната форма "Редактиране", ПРЕДИ да съществуваше огледалната
// синхронизация по-горе, и talon_data е останала със старите AI-стойности.
function syncConfirmedTalonData() {
  const db = readDb();
  let changed = 0;
  (db.vehicles || []).forEach(v => {
    if (!v.talon_confirmed || !v.talon_data) return;
    let touched = false;
    const syncedTalonData = { ...v.talon_data };
    TALON_SYNC_KEYS.forEach(k => {
      const vehicleVal = v[k];
      if (vehicleVal != null && vehicleVal !== '' && syncedTalonData[k] !== vehicleVal) {
        syncedTalonData[k] = vehicleVal;
        touched = true;
      }
    });
    if (touched) {
      v.talon_data = syncedTalonData;
      changed++;
    }
  });
  if (changed) writeDb(db);
  return changed;
}

// еднократна самолечебна миграция: премахва "паразитно" вградено поле
// vehicle.registration_expiry, което погрешно се е записало директно в
// основния запис на колата при потвърждаване на талон (грешка от по-стара
// версия — виж talon-confirm маршрута в server.js). Основното поле
// registration_expiry е ДРУГО нещо (реална дата "рег. до", въвеждана
// ръчно/през CSV импорт) и захранва таблото "Изтичащи документи" — AI
// разчетената "дата на следваща регистрация" от талона не бива да го пипа,
// защото понякога е грешно/нечетливо разчетена (напр. "0001-01-01"), което
// води до абсурдни аларми. Разпознаваме "паразитните" записи по това, че
// стойността в vehicle.registration_expiry СЪВПАДА точно с
// vehicle.talon_data.registration_expiry — това означава, че е дошла именно
// от талона, а не е била въведена ръчно/през CSV. Самото talon_data.
// registration_expiry НЕ се пипа — остава видимо в раздела за талона.
function cleanupStrayTalonRegistrationExpiry() {
  const db = readDb();
  let changed = 0;
  (db.vehicles || []).forEach(v => {
    if (!v.registration_expiry) return;
    const talonVal = v.talon_data && v.talon_data.registration_expiry;
    if (talonVal && talonVal === v.registration_expiry) {
      delete v.registration_expiry;
      changed++;
    }
  });
  if (changed) writeDb(db);
  return changed;
}

// изтрива кола заедно със собствената ѝ поддръжна история (оборудване,
// сервизна книжка, прегледи, повтарящи се разходи, пробег) — ТЕЗИ данни
// имат смисъл само за конкретната кола. НЕ пипа зачисления/договори/
// протоколи/плащания (финансова и HR история) — ако колата има такива
// записи, изтриването се блокира с ясна грешка, за да не изчезне по
// невнимание история, свързана с шофьор или наем.
function deleteVehicle(id) {
  const db = readDb();
  const idx = db.vehicles.findIndex(v => v.id === id);
  if (idx === -1) throw new Error('Колата не е намерена');

  const hasAssignments = db.vehicle_assignments.some(a => a.vehicle_id === id);
  const hasContracts = db.rental_contracts && db.rental_contracts.some(c => c.vehicle_id === id);
  const hasProtocols = db.handover_protocols && db.handover_protocols.some(p => p.vehicle_id === id);
  const hasPayments = db.vehicle_payments && db.vehicle_payments.some(p => p.vehicle_id === id);
  if (hasAssignments || hasContracts || hasProtocols || hasPayments) {
    const err = new Error(
      'Колата има свързана история (зачисления, договори, протоколи или плащания) и не може да бъде изтрита директно — ' +
      'за да запазим историята, първо трябва тя да бъде прехвърлена/архивирана ръчно.'
    );
    err.code = 'VEHICLE_HAS_HISTORY';
    throw err;
  }

  const [removed] = db.vehicles.splice(idx, 1);
  db.vehicle_equipment = db.vehicle_equipment.filter(e => e.vehicle_id !== id);
  db.service_records = db.service_records.filter(s => s.vehicle_id !== id);
  db.vehicle_inspections = (db.vehicle_inspections || []).filter(i => i.vehicle_id !== id);
  db.vehicle_recurring_costs = db.vehicle_recurring_costs.filter(c => c.vehicle_id !== id);
  db.odometer_logs = (db.odometer_logs || []).filter(o => o.vehicle_id !== id);
  writeDb(db);
  return removed;
}

// ---------------------------------------------------------------------------
// ВИТРИНА НА МАРКЕТИНГ САЙТА (dombi.bg — "Коли под наем")
// ---------------------------------------------------------------------------
// Публичният сайт (Render Static Site, отделен произход) вече НЕ съдържа
// статично написан списък с коли — той чете GET /api/public/fleet-showcase.
// Тук пазим показваните "модели коли" (карти на витрината) като отделни
// записи от реалния автопарк (vehicle records с рег. номера) — всеки запис
// на витрината може да е свързан с 0+ реални коли (linked_vehicle_ids).
// Наличността, показвана публично, се изчислява ВИНАГИ от текущия статус на
// свързаните реални коли (има ли поне една със статус 'available') — никога
// не се задава ръчно, за да не могат витрината и реалния автопарк да се
// разминат отново. Регистрационни номера НИКОГА не излизат в публичния API.
function listFleetShowcase() {
  const db = readDb();
  seedFleetShowcaseIfEmpty(db);
  return [...(db.fleet_showcase || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function getFleetShowcaseItem(id) {
  const db = readDb();
  return (db.fleet_showcase || []).find(c => c.id === id) || null;
}

function createFleetShowcaseItem(data) {
  const db = readDb();
  seedFleetShowcaseIfEmpty(db);
  const maxOrder = db.fleet_showcase.reduce((m, c) => Math.max(m, c.order || 0), 0);
  // ако администраторът не е избрал ръчно свързани коли, опитваме да
  // предположим по име (виж suggestLinkedVehicleIds) — само удобство,
  // винаги проверимо/коригируемо в панела
  const autoLinked = data.linked_vehicle_ids === undefined ? suggestLinkedVehicleIds(data.name || '') : undefined;
  const item = {
    id: uid('fsc'),
    name: '', category: 'economy', fuel: '', transmission: '', seats: 5,
    badge: null, includes: [], requirements: [], image_url: null, daily_rate: null,
    linked_vehicle_ids: autoLinked || [], active: true, order: maxOrder + 1,
    created_at: nowIso(),
    ...data,
  };
  db.fleet_showcase.push(item);
  writeDb(db);
  return item;
}

function updateFleetShowcaseItem(id, patch) {
  const db = readDb();
  const idx = (db.fleet_showcase || []).findIndex(c => c.id === id);
  if (idx === -1) throw new Error('Записът от витрината не е намерен');
  db.fleet_showcase[idx] = { ...db.fleet_showcase[idx], ...patch, updated_at: nowIso() };
  writeDb(db);
  return db.fleet_showcase[idx];
}

function deleteFleetShowcaseItem(id) {
  const db = readDb();
  const idx = (db.fleet_showcase || []).findIndex(c => c.id === id);
  if (idx === -1) throw new Error('Записът от витрината не е намерен');
  const [removed] = db.fleet_showcase.splice(idx, 1);
  writeDb(db);
  return removed;
}

function reorderFleetShowcase(orderedIds) {
  const db = readDb();
  (db.fleet_showcase || []).forEach(item => {
    const idx = orderedIds.indexOf(item.id);
    if (idx !== -1) item.order = idx + 1;
  });
  writeDb(db);
  return listFleetShowcase();
}

// нормализира за сравнение на имена — сваля диакритика (Š→S, ö→o и т.н.),
// прави с малки букви и мапва честите съкращения на марки
const MAKE_ALIASES = { vw: 'volkswagen', mb: 'mercedes-benz', merc: 'mercedes-benz' };
function normalizeMakeModel(str) {
  const base = String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // диакритика
    .toLowerCase().trim();
  return MAKE_ALIASES[base] || base;
}

// само за първоначално попълване на витрината: опитва се да свърже нов
// запис с реални коли от автопарка по съвпадение на марка+модел в името —
// винаги само предложение, администраторът вижда и коригира резултата
// ръчно в админ панела (виж public/fleet-showcase.html)
function suggestLinkedVehicleIds(name) {
  const db = readDb();
  const normName = normalizeMakeModel(name).split(/\s+/);
  return (db.vehicles || [])
    .filter(v => {
      const make = normalizeMakeModel(v.make);
      const model = normalizeMakeModel(v.model);
      const makeHit = make && normName.some(t => t === make || make.includes(t) || t.includes(make));
      const modelHit = model && normName.some(t => t === model || model.includes(t) || t.includes(model));
      return makeHit && modelHit;
    })
    .map(v => v.id);
}

const FUEL_LABELS = { petrol: 'Бензин', diesel: 'Дизел', hybrid: 'Хибрид', electric: 'Електрическа', lpg: 'Газ' };
const FLEET_SHOWCASE_CATEGORIES_SET = new Set(['economy', 'comfort', 'eco']);
function mostCommon(values) {
  const counts = new Map();
  values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  let best = null, bestCount = 0;
  counts.forEach((count, v) => { if (count > bestCount) { best = v; bestCount = count; } });
  return best;
}

// еднократно посяване на витрината — извиква се лениво при първо четене.
// НЕ ползва измислен демо списък: групира РЕАЛНИТЕ коли от автопарка по
// марка+модел и прави по една карта на витрината за всяка група, свързана
// автоматично с всички съответни реални коли — така витрината веднага
// показва точно това, което реално е налично (без администраторът да прави
// нищо), вместо непознати демо модели, каквито фирмата дори няма.
function seedFleetShowcaseIfEmpty(db) {
  if (db.fleet_showcase && db.fleet_showcase.length) return;
  const groups = new Map(); // ключ: нормализирано "марка модел" -> {make, model, vehicles:[]}
  (db.vehicles || []).forEach(v => {
    const key = normalizeMakeModel(`${v.make || ''} ${v.model || ''}`);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { make: v.make, model: v.model, vehicles: [] });
    groups.get(key).vehicles.push(v);
  });
  db.fleet_showcase = [...groups.values()].map((g, i) => {
    const cat = mostCommon(g.vehicles.map(v => v.category));
    const fuelKey = mostCommon(g.vehicles.map(v => v.fuel));
    const seats = mostCommon(g.vehicles.map(v => v.seats)) || 5;
    return {
      id: uid('fsc'),
      name: `${g.make || ''} ${g.model || ''}`.trim(),
      category: FLEET_SHOWCASE_CATEGORIES_SET.has(cat) ? cat : 'economy',
      fuel: FUEL_LABELS[fuelKey] || fuelKey || '',
      transmission: 'Ръчна', // автопаркът не пази скоростна кутия — по подразбиране, редактируемо в панела
      seats,
      badge: null,
      includes: ['Гражданска отговорност', 'Пътна помощ 24/7', 'Годишен технически преглед'],
      requirements: ['Мин. 21 години', 'Шофьорска книжка от 2+ години'],
      image_url: null,
      daily_rate: null,
      linked_vehicle_ids: g.vehicles.map(v => v.id),
      active: true,
      order: i + 1,
      created_at: nowIso(),
    };
  });
  writeDb(db);
}

// публичната проекция (за GET /api/public/fleet-showcase, БЕЗ сесия) —
// само каквото маркетинг сайтът реално ползва; регистрационни номера,
// linked_vehicle_ids и active никога не излизат оттук.
function getPublicFleetShowcase() {
  const db = readDb();
  seedFleetShowcaseIfEmpty(db);
  const vehiclesById = new Map((db.vehicles || []).map(v => [v.id, v]));
  return db.fleet_showcase
    .filter(c => c.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(c => {
      const linked = (c.linked_vehicle_ids || []).map(id => vehiclesById.get(id)).filter(Boolean);
      const available = linked.some(v => v.status === 'available');
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        fuel: c.fuel,
        transmission: c.transmission,
        seats: c.seats,
        badge: c.badge || null,
        includes: c.includes || [],
        requirements: c.requirements || [],
        image_url: c.image_url || null,
        daily_rate: c.daily_rate != null ? Number(c.daily_rate) : null,
        status: available ? 'available' : 'soon',
      };
    });
}

// ---------------------------------------------------------------------------
// РЕЗЕРВАЦИИ (нов сайт "рент-а-кар") — заявки за наем с конкретни дати,
// подадени публично през booking календара на новия клиентски сайт.
// Умишлено НЕ пазим отделна "инвентарна" таблица бройки коли — наличността
// се пресмята "на живо" спрямо реалните свързани коли на всяка витринна
// карта (fleet_showcase.linked_vehicle_ids), с колко от тях се застъпват
// вече съществуващи договори за наем (rental_contracts) или други чакащи/
// потвърдени резервации за същия период. Ако застъпванията са по-малко от
// броя свързани коли — има поне един свободен автомобил за периода.
// Реалното назначаване на КОНКРЕТНА кола става ръчно от администратор при
// потвърждаване (виж updateReservation), тъй като няколко коли от един и
// същи модел могат да се разменят помежду си.
// ---------------------------------------------------------------------------
function dateRangesOverlap(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}

function countOverlappingBlocks(item, pickupDate, returnDate, allReservations, db) {
  const linkedIds = new Set(item.linked_vehicle_ids || []);
  let count = 0;
  (db.rental_contracts || []).forEach(c => {
    if (c.status === 'terminated' || c.status === 'draft') return;
    if (!linkedIds.has(c.vehicle_id)) return;
    if (dateRangesOverlap(c.start_date, c.end_date || '9999-12-31', pickupDate, returnDate)) count++;
  });
  (allReservations || []).forEach(r => {
    if (!['pending', 'confirmed'].includes(r.status)) return;
    const belongsToItem = r.showcase_item_id === item.id
      || (r.assigned_vehicle_id && linkedIds.has(r.assigned_vehicle_id));
    if (!belongsToItem) return;
    if (dateRangesOverlap(r.pickup_date, r.return_date, pickupDate, returnDate)) count++;
  });
  return count;
}

// наличност на ВСИЧКИ активни витринни карти за даден период — за
// GET /api/public/availability (booking търсачката на новия сайт)
function getShowcaseAvailability(pickupDate, returnDate) {
  const db = readDb();
  seedFleetShowcaseIfEmpty(db);
  const reservations = db.reservations || [];
  return db.fleet_showcase
    .filter(c => c.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(item => {
      const fleetSize = (item.linked_vehicle_ids || []).length || 1;
      const blocked = countOverlappingBlocks(item, pickupDate, returnDate, reservations, db);
      return {
        id: item.id, name: item.name, category: item.category, fuel: item.fuel,
        transmission: item.transmission, seats: item.seats, badge: item.badge || null,
        includes: item.includes || [], requirements: item.requirements || [],
        image_url: item.image_url || null,
        daily_rate: item.daily_rate != null ? Number(item.daily_rate) : null,
        available: blocked < fleetSize,
      };
    });
}

// проверка за ЕДНА конкретна карта — ползва се за server-side превалидация
// при създаване на резервация (за да не се "надбронира" при състезание
// между две почти едновременни заявки за последната свободна кола)
function isShowcaseItemAvailable(showcaseItemId, pickupDate, returnDate) {
  const db = readDb();
  const item = (db.fleet_showcase || []).find(c => c.id === showcaseItemId);
  if (!item || item.active === false) return false;
  const fleetSize = (item.linked_vehicle_ids || []).length || 1;
  const blocked = countOverlappingBlocks(item, pickupDate, returnDate, db.reservations || [], db);
  return blocked < fleetSize;
}

function listReservations({ status, from, to } = {}) {
  const db = readDb();
  let rows = db.reservations || [];
  if (status) rows = rows.filter(r => r.status === status);
  if (from) rows = rows.filter(r => r.return_date >= from);
  if (to) rows = rows.filter(r => r.pickup_date <= to);
  return rows.sort((a, b) => (a.pickup_date < b.pickup_date ? -1 : 1));
}

function getReservation(id) {
  const db = readDb();
  return (db.reservations || []).find(r => r.id === id) || null;
}

function createReservation(data) {
  const db = readDb();
  db.reservations = db.reservations || [];
  const rec = {
    id: uid('rsv'),
    status: 'pending',
    assigned_vehicle_id: null,
    admin_notes: null,
    created_at: nowIso(),
    ...data,
  };
  db.reservations.push(rec);
  writeDb(db);
  return rec;
}

function updateReservation(id, patch) {
  const db = readDb();
  db.reservations = db.reservations || [];
  const idx = db.reservations.findIndex(r => r.id === id);
  if (idx === -1) throw new Error('Резервацията не е намерена');
  db.reservations[idx] = { ...db.reservations[idx], ...patch, updated_at: nowIso() };
  writeDb(db);
  return db.reservations[idx];
}

// ---------------------------------------------------------------------------
// СЪДЪРЖАНИЕ НА НАЧАЛНАТА СТРАНИЦА (dombi.bg — управлявано от админ панела
// „Начална страница (сайт)“, public/site-editor.html) — GET/PUT
// /api/site-content. Публичният сайт го чете БЕЗ сесия (CORS, отделен
// произход) и го ползва само за да замести стартовия резервен текст,
// вграден директно в index.html — затова тук пазим ЦЯЛАТА структура,
// винаги допълнена с DEFAULT_SITE_CONTENT, за да не липсва поле, дори
// ако е записана по-стара/непълна версия.
// ---------------------------------------------------------------------------
const DEFAULT_SITE_CONTENT = {
  hero: {
    eyebrow: 'Dombi Riders · Куриери и коли под наем',
    title_line1: 'Искаш ли',
    title_line2: 'повече свобода?',
    lead: 'Работи като куриер с Glovo и Bolt Food чрез Dombi Riders. Нямаш собствено превозно средство? Наеми кола направо от нашия автопарк и започни да караш още тази седмица.',
    cta_primary: 'Кандидатствай сега',
    cta_secondary: 'Виж колите под наем →',
    quick_list: ['Гъвкаво работно време', 'Плащане всяка седмица', 'Бърз старт', 'Подкрепа по всяко време'],
    phone_display: '0887 25 27 27',
    phone_tel: '+359887252727',
  },
  about: {
    eyebrow: 'За нас',
    title: 'Изградени да движим доставките в България',
    text: 'Dombi Riders ЕООД е компания с офис в София, работеща като партньор за куриерски доставки за водещи платформи — Glovo и Bolt Food — в няколко града в България. Освен подкрепа за райдъри със собствено превозно средство, разполагаме и със собствен автопарк за наем — за куриерска работа, за доставки с друг работодател или просто за лично ползване.',
    stats: [
      { title: 'Кола · Е-колело', sub: 'Скутер · Мотор' },
      { title: 'Няколко града', sub: 'Локална поддръжка навсякъде' },
      { title: 'Glovo · Bolt Food', sub: 'Партньорски платформи' },
      { title: 'Коли под наем', sub: 'За работа или лично ползване' },
    ],
    company_name: 'Dombi Riders ЕООД',
    eik: '208513455',
    office: 'гр. София, ул. Павел Красов 22',
    activity: 'Куриерски услуги и коли под наем',
    partners: 'Glovo, Bolt Food',
    phone: '0887 25 27 27',
  },
  services: {
    eyebrow: 'Услуги',
    title: 'Кандидатствай с превозното средство, с което разполагаш',
    subtitle: 'Работим с четири основни категории райдъри — или избери кола направо от нашия автопарк по-долу.',
    cards: [
      { title: 'С кола', desc: 'Собствена или наета от Dombi Riders — доставки на по-дълги разстояния.' },
      { title: 'С е-колело', desc: 'Идеално за централните градски части — бързо и без паркинг проблеми.' },
      { title: 'Със скутер', desc: 'Баланс между скорост и обхват на доставките в целия град.' },
      { title: 'С мотор', desc: 'За най-натоварените часове и по-големи разстояния между поръчките.' },
    ],
  },
  cars_section: {
    eyebrow: 'Автопарк · Rent-a-Car',
    title: 'Коли под наем',
    subtitle: 'Филтрирай по категория, сравни до 3 коли и избери период на наем — всичко се пренася автоматично в заявката за наем по-долу.',
  },
  rent_section: {
    eyebrow: 'Наем на автомобил',
    title: 'Заяви наем на кола',
    text: 'Автомобилите ни се отдават под наем и без да работиш с Dombi Riders — за доставки с друга платформа или работодател, както и за лично ползване.',
    bullets: ['Не е задължително да работиш с Dombi Riders', 'Застраховка и пътна помощ, включени в наема', 'Гъвкав период — от дни до месеци', 'Прозрачни условия, без скрити такси'],
  },
  how: {
    eyebrow: 'Как работим',
    title: 'Четири стъпки до първата ти доставка',
    subtitle: 'Целият процес от кандидатура до старт е изграден да бъде максимално бърз и ясен.',
    steps: [
      { title: 'Подаваш кандидатура', desc: 'Попълваш формата с данните си и превозното средство, с което разполагаш.' },
      { title: 'Свързваме се с теб', desc: 'Екипът ни се обажда за детайли и отговаря на въпроси.' },
      { title: 'Онбординг', desc: 'Кратко въвеждане в платформата и, при нужда, получаване на колата.' },
      { title: 'Започваш да караш', desc: 'Приемаш поръчки по собствен график и следиш приходите си.' },
    ],
  },
  benefits: {
    eyebrow: 'Защо Dombi Riders',
    title: 'Условия, изградени около теб',
    items: [
      { title: 'Гъвкаво работно време', desc: 'Работиш когато е удобно за теб — пълен или непълен работен ден.' },
      { title: 'Плащане всяка седмица', desc: 'Редовен и предвидим график за изплащане на приходите ти.' },
      { title: 'Бърз старт', desc: 'От кандидатура до първа доставка — без излишно чакане.' },
      { title: 'Подкрепа по всяко време', desc: 'Реален екип, който отговаря на въпроси и помага при проблем, където и да работиш.' },
      { title: 'Без скрити такси', desc: 'Кандидатстването и онбордингът не изискват такси от твоя страна.' },
      { title: 'Коли под наем', desc: 'Не разполагаш с кола? Наеми от нашия автопарк и започни веднага.' },
    ],
  },
  testimonials: {
    eyebrow: 'Отзиви',
    title: 'От нашите райдъри',
    items: [
      { quote: 'Процесът по кандидатстване беше бърз и ясен — само след няколко дни вече карах.', name: 'Райдър', sub: 'С е-колело · София' },
      { quote: 'Нямах кола, но наех от автопарка им и започнах веднага — много удобно.', name: 'Райдър', sub: 'С наета кола · Пловдив' },
      { quote: 'Екипът винаги вдига телефона, когато имам въпрос — усещането е за реална подкрепа.', name: 'Райдър', sub: 'Със скутер · Варна' },
    ],
  },
  apply_section: {
    eyebrow: 'Кандидатствай',
    title: 'Стани част от Dombi Riders',
    text: 'Попълни формата и екипът ни ще се свърже с теб в рамките на кратко време.',
    bullets: ['Отговор от екипа в рамките на 1–2 работни дни', 'Без такси за кандидатстване или онбординг', 'Работа с Glovo и Bolt Food чрез Dombi Riders'],
  },
  contact: {
    eyebrow: 'Контакти',
    title: 'Свържи се директно с нас',
    phone_display: '0887 25 27 27',
    phone_tel: '+359887252727',
    email: 'office@dombi.bg',
    office_address: 'гр. София, ул. Павел Красов 22',
    office_hours: 'Пон–Пет, 09:00–18:00',
  },
  footer: {
    tagline: 'Куриерски доставки и коли под наем в няколко града на България — партньор за Glovo и Bolt Food.',
    made_with_text: 'Изработено с грижа от екипа на Dombi Riders',
    social: { facebook: '', whatsapp: '', instagram: '' },
  },
};

function getSiteContent() {
  const db = readDb();
  const saved = db.site_content || {};
  // дълбоко допълваме с DEFAULT_SITE_CONTENT на ниво секция, за да не
  // липсва поле в по-стар запис след добавяне на нова секция занапред
  const merged = {};
  Object.keys(DEFAULT_SITE_CONTENT).forEach(section => {
    merged[section] = { ...DEFAULT_SITE_CONTENT[section], ...(saved[section] || {}) };
  });
  return merged;
}

function scStr(v, d, max = 500) {
  return typeof v === 'string' ? v.slice(0, max) : d;
}
function scStrArrayFixed(v, d, max = 300) {
  if (!Array.isArray(v)) return d;
  return d.map((def, i) => (typeof v[i] === 'string' ? v[i].slice(0, max) : def));
}
function scObjArrayFixed(v, d, keys) {
  if (!Array.isArray(v)) return d;
  return d.map((def, i) => {
    const item = v[i] && typeof v[i] === 'object' ? v[i] : {};
    const out = { ...def };
    keys.forEach(k => { if (typeof item[k] === 'string') out[k] = item[k].slice(0, 500); });
    return out;
  });
}
function scTestimonials(v, d) {
  if (!Array.isArray(v)) return d;
  return v.slice(0, 12).map(item => ({
    quote: typeof (item || {}).quote === 'string' ? item.quote.slice(0, 600) : '',
    name: typeof (item || {}).name === 'string' && item.name.trim() ? item.name.slice(0, 100) : 'Райдър',
    sub: typeof (item || {}).sub === 'string' ? item.sub.slice(0, 150) : '',
  })).filter(t => t.quote.trim());
}

// PUT приема ЦЯЛАТА структура (не частичен patch) — по-просто и по-безопасно
// от дълбок merge на произволни вложени масиви; всяко поле се проверява по
// тип/дължина спрямо DEFAULT_SITE_CONTENT (whitelist), непознати ключове се
// игнорират мълчаливо.
function updateSiteContent(patch) {
  const db = readDb();
  const current = getSiteContent();
  const p = patch && typeof patch === 'object' ? patch : {};
  const hero = p.hero || {}, about = p.about || {}, services = p.services || {},
    carsSection = p.cars_section || {}, rentSection = p.rent_section || {}, how = p.how || {},
    benefits = p.benefits || {}, testimonials = p.testimonials || {}, applySection = p.apply_section || {},
    contact = p.contact || {}, footer = p.footer || {}, social = footer.social || {};

  const next = {
    hero: {
      eyebrow: scStr(hero.eyebrow, current.hero.eyebrow, 120),
      title_line1: scStr(hero.title_line1, current.hero.title_line1, 60),
      title_line2: scStr(hero.title_line2, current.hero.title_line2, 60),
      lead: scStr(hero.lead, current.hero.lead, 500),
      cta_primary: scStr(hero.cta_primary, current.hero.cta_primary, 60),
      cta_secondary: scStr(hero.cta_secondary, current.hero.cta_secondary, 60),
      quick_list: scStrArrayFixed(hero.quick_list, current.hero.quick_list, 80),
      phone_display: scStr(hero.phone_display, current.hero.phone_display, 40),
      phone_tel: scStr(hero.phone_tel, current.hero.phone_tel, 40),
    },
    about: {
      eyebrow: scStr(about.eyebrow, current.about.eyebrow, 120),
      title: scStr(about.title, current.about.title, 200),
      text: scStr(about.text, current.about.text, 1500),
      stats: scObjArrayFixed(about.stats, current.about.stats, ['title', 'sub']),
      company_name: scStr(about.company_name, current.about.company_name, 150),
      eik: scStr(about.eik, current.about.eik, 40),
      office: scStr(about.office, current.about.office, 300),
      activity: scStr(about.activity, current.about.activity, 300),
      partners: scStr(about.partners, current.about.partners, 200),
      phone: scStr(about.phone, current.about.phone, 40),
    },
    services: {
      eyebrow: scStr(services.eyebrow, current.services.eyebrow, 120),
      title: scStr(services.title, current.services.title, 200),
      subtitle: scStr(services.subtitle, current.services.subtitle, 400),
      cards: scObjArrayFixed(services.cards, current.services.cards, ['title', 'desc']),
    },
    cars_section: {
      eyebrow: scStr(carsSection.eyebrow, current.cars_section.eyebrow, 120),
      title: scStr(carsSection.title, current.cars_section.title, 200),
      subtitle: scStr(carsSection.subtitle, current.cars_section.subtitle, 400),
    },
    rent_section: {
      eyebrow: scStr(rentSection.eyebrow, current.rent_section.eyebrow, 120),
      title: scStr(rentSection.title, current.rent_section.title, 200),
      text: scStr(rentSection.text, current.rent_section.text, 500),
      bullets: scStrArrayFixed(rentSection.bullets, current.rent_section.bullets, 150),
    },
    how: {
      eyebrow: scStr(how.eyebrow, current.how.eyebrow, 120),
      title: scStr(how.title, current.how.title, 200),
      subtitle: scStr(how.subtitle, current.how.subtitle, 400),
      steps: scObjArrayFixed(how.steps, current.how.steps, ['title', 'desc']),
    },
    benefits: {
      eyebrow: scStr(benefits.eyebrow, current.benefits.eyebrow, 120),
      title: scStr(benefits.title, current.benefits.title, 200),
      items: scObjArrayFixed(benefits.items, current.benefits.items, ['title', 'desc']),
    },
    testimonials: {
      eyebrow: scStr(testimonials.eyebrow, current.testimonials.eyebrow, 120),
      title: scStr(testimonials.title, current.testimonials.title, 200),
      items: scTestimonials(testimonials.items, current.testimonials.items),
    },
    apply_section: {
      eyebrow: scStr(applySection.eyebrow, current.apply_section.eyebrow, 120),
      title: scStr(applySection.title, current.apply_section.title, 200),
      text: scStr(applySection.text, current.apply_section.text, 500),
      bullets: scStrArrayFixed(applySection.bullets, current.apply_section.bullets, 150),
    },
    contact: {
      eyebrow: scStr(contact.eyebrow, current.contact.eyebrow, 120),
      title: scStr(contact.title, current.contact.title, 200),
      phone_display: scStr(contact.phone_display, current.contact.phone_display, 40),
      phone_tel: scStr(contact.phone_tel, current.contact.phone_tel, 40),
      email: scStr(contact.email, current.contact.email, 200),
      office_address: scStr(contact.office_address, current.contact.office_address, 300),
      office_hours: scStr(contact.office_hours, current.contact.office_hours, 150),
    },
    footer: {
      tagline: scStr(footer.tagline, current.footer.tagline, 400),
      made_with_text: scStr(footer.made_with_text, current.footer.made_with_text, 200),
      social: {
        facebook: scStr(social.facebook, current.footer.social.facebook, 300),
        whatsapp: scStr(social.whatsapp, current.footer.social.whatsapp, 300),
        instagram: scStr(social.instagram, current.footer.social.instagram, 300),
      },
    },
  };
  db.site_content = next;
  writeDb(db);
  return next;
}

// ---------------------------------------------------------------------------
// ЗАПИТВАНИЯ ЗА НАЕМ (dombi.bg, публична форма „Заяви наем на кола“) —
// POST /api/rent-requests (публично, CORS) записва тук + известява офиса по
// имейл (виж server.js); GET /api/rent-requests (админ/мениджър) ги листва.
// ---------------------------------------------------------------------------
function createRentRequest(data) {
  const db = readDb();
  db.rent_requests = db.rent_requests || [];
  const rec = { id: uid('rent'), created_at: nowIso(), status: 'new', ...data };
  db.rent_requests.unshift(rec);
  writeDb(db);
  return rec;
}

function listRentRequests() {
  const db = readDb();
  return [...(db.rent_requests || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// Трайно изтрива заявка за наем — прилага срока на съхранение по политиката
// за поверителност (т. 8.2: до 6 месеца за заявки, които не са довели до
// договор) и правото на изтриване (т. 10).
function deleteRentRequest(id) {
  const db = readDb();
  const list = db.rent_requests || [];
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) throw new Error('Заявката не е намерена');
  list.splice(idx, 1);
  writeDb(db);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// EQUIPMENT
// ---------------------------------------------------------------------------
function listEquipment(vehicleId) {
  return readDb().vehicle_equipment.filter(e => e.vehicle_id === vehicleId);
}

function addEquipment(vehicleId, data) {
  const db = readDb();
  const item = { id: uid('eq'), vehicle_id: vehicleId, added_at: nowIso().slice(0, 10), ...data };
  db.vehicle_equipment.push(item);
  writeDb(db);
  return item;
}

function updateEquipment(id, patch) {
  const db = readDb();
  const item = (db.vehicle_equipment || []).find(e => e.id === id);
  if (!item) throw new Error('Оборудването не е намерено');
  Object.assign(item, patch);
  writeDb(db);
  return item;
}

function deleteEquipment(id) {
  const db = readDb();
  const idx = (db.vehicle_equipment || []).findIndex(e => e.id === id);
  if (idx === -1) throw new Error('Оборудването не е намерено');
  db.vehicle_equipment.splice(idx, 1);
  writeDb(db);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// SERVICE RECORDS (сервизна книжка)
// ---------------------------------------------------------------------------
function listServiceRecords(vehicleId) {
  return readDb().service_records
    .filter(s => s.vehicle_id === vehicleId)
    .sort((a, b) => (a.service_date < b.service_date ? 1 : -1));
}

function addServiceRecord(vehicleId, data) {
  const db = readDb();
  const rec = { id: uid('sr'), vehicle_id: vehicleId, created_at: nowIso(), attachments: [], ...data };
  db.service_records.push(rec);
  writeDb(db);
  return rec;
}

// последен сервизен запис от даден тип (за overdue проверка на масло/ГРМ)
function lastServiceRecordOfType(vehicleId, type) {
  const records = (readDb().service_records || [])
    .filter(s => s.vehicle_id === vehicleId && s.type === type)
    .sort((a, b) => (a.service_date < b.service_date ? 1 : -1));
  return records[0] || null;
}

// ---------------------------------------------------------------------------
// МЕСЕЧЕН ПРЕГЛЕД (задължителен чек лист: външно/вътрешно/техническо
// състояние, всеки запис е обвързан с отговорник — inspector_id)
// ---------------------------------------------------------------------------
function listInspections(vehicleId) {
  return (readDb().vehicle_inspections || [])
    .filter(i => i.vehicle_id === vehicleId)
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

function currentMonthStr() { return nowIso().slice(0, 7); } // 'YYYY-MM'

function createInspection(vehicleId, data) {
  const db = readDb();
  if (!db.vehicle_inspections) db.vehicle_inspections = [];
  const month = data.month || currentMonthStr();
  const existing = db.vehicle_inspections.find(i => i.vehicle_id === vehicleId && i.month === month);
  if (existing) throw new Error(`Вече има месечен преглед за ${month} за тази кола.`);
  const rec = {
    id: uid('insp'),
    vehicle_id: vehicleId,
    month,
    inspection_date: nowIso().slice(0, 10),
    exterior_result: 'ok', interior_result: 'ok', technical_result: 'ok',
    created_at: nowIso(),
    ...data,
  };
  db.vehicle_inspections.push(rec);
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// RECURRING COSTS
// ---------------------------------------------------------------------------
function listRecurringCosts(vehicleId) {
  return readDb().vehicle_recurring_costs.filter(c => c.vehicle_id === vehicleId);
}

function addRecurringCost(vehicleId, data) {
  const db = readDb();
  const rec = { id: uid('rc'), vehicle_id: vehicleId, created_at: nowIso(), ...data };
  db.vehicle_recurring_costs.push(rec);
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// ASSIGNMENTS (зачисляване на шофьор — вътрешен от HR или външен)
// ---------------------------------------------------------------------------
function listAssignments({ vehicleId, driverId } = {}) {
  let rows = readDb().vehicle_assignments;
  if (vehicleId) rows = rows.filter(a => a.vehicle_id === vehicleId);
  if (driverId) rows = rows.filter(a => a.driver_id === driverId);
  return rows.sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
}

function createAssignment(data) {
  const db = readDb();
  // затваряме предходно активно зачисление на същата кола (ако има)
  db.vehicle_assignments.forEach(a => {
    if (a.vehicle_id === data.vehicle_id && a.status === 'active') {
      a.status = 'ended';
      a.end_date = a.end_date || nowIso().slice(0, 10);
    }
  });
  const rec = {
    id: uid('as'),
    status: 'active',
    start_date: nowIso().slice(0, 10),
    created_at: nowIso(),
    ...data,
  };
  db.vehicle_assignments.push(rec);
  // обновяваме статуса на колата
  const v = db.vehicles.find(v => v.id === data.vehicle_id);
  if (v) v.status = data.purpose === 'personal_use' || data.purpose === 'other_platform' ? 'rented' : 'assigned';
  writeDb(db);
  return rec;
}

function endAssignment(id, { end_date, end_odometer_km, notes } = {}) {
  const db = readDb();
  const rec = db.vehicle_assignments.find(a => a.id === id);
  if (!rec) throw new Error('Записът не е намерен');
  rec.status = 'ended';
  rec.end_date = end_date || nowIso().slice(0, 10);
  if (end_odometer_km != null) rec.end_odometer_km = end_odometer_km;
  if (notes) rec.notes = notes;
  const v = db.vehicles.find(v => v.id === rec.vehicle_id);
  if (v) v.status = 'available';
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// HANDOVER PROTOCOLS (приемо-предавателни протоколи със снимки)
// ---------------------------------------------------------------------------
function listProtocols({ vehicleId } = {}) {
  let rows = readDb().handover_protocols;
  if (vehicleId) rows = rows.filter(p => p.vehicle_id === vehicleId);
  return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function getProtocol(id) {
  return readDb().handover_protocols.find(p => p.id === id) || null;
}

function nextProtocolNumber(db) {
  const year = new Date().getFullYear();
  const count = db.handover_protocols.filter(p => p.protocol_number?.includes(String(year))).length + 1;
  return `HP-${year}-${String(count).padStart(4, '0')}`;
}

function createProtocol(data) {
  const db = readDb();
  const rec = {
    id: uid('hp'),
    protocol_number: nextProtocolNumber(db),
    date: nowIso(),
    damages: [],
    photos: [],
    created_at: nowIso(),
    ...data,
  };
  db.handover_protocols.push(rec);
  writeDb(db);
  return rec;
}

function updateProtocol(id, patch) {
  const db = readDb();
  const idx = db.handover_protocols.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Протоколът не е намерен');
  db.handover_protocols[idx] = { ...db.handover_protocols[idx], ...patch };
  writeDb(db);
  return db.handover_protocols[idx];
}

// ---------------------------------------------------------------------------
// RENTAL CONTRACTS (договори за наем)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// БАЛАНС ПО ДОГОВОР ЗА НАЕМ (кой е длъжник, с колко) — само за наематели,
// които НЕ са куриери на Dombi Riders (renter_type !== 'dombi_courier').
// За куриерите наемът се удържа автоматично от заработката всяка седмица
// (payroll_entries.car_rent_amount) — за външни наематели (друга платформа /
// лично ползване) няма заработка, от която да удържим, затова трябва да
// "стоят" като длъжници: сумата се трупа за всеки изминал ден по
// договорената ставка, докато не постъпи плащане (vehicle_payments с
// contract_id = този договор). Пресмята се "на живо" при всяко четене —
// никъде не се пази готово число, за да не се разминава с датата.
// Ако платеното покрива начисленото, връщаме "платено до" дата вместо дълг.
// ---------------------------------------------------------------------------
const RATE_PERIOD_DAYS = { day: 1, week: 7, month: 30 };

function contractDailyRate(contract) {
  const days = RATE_PERIOD_DAYS[contract.rate_period] || 7;
  return Number(contract.rate_amount || 0) / days;
}

function computeContractBalance(contract, allPayments) {
  if (!contract || contract.renter_type === 'dombi_courier') return null;
  if (contract.status === 'draft') return null;
  const dailyRate = contractDailyRate(contract);
  if (!dailyRate) return null;
  const start = new Date(contract.start_date);
  if (isNaN(start)) return null;
  // ако договорът вече не е активен и има зададена крайна дата — спираме
  // начисляването там; иначе продължаваме да трупаме до днес.
  const endBound = (contract.status !== 'active' && contract.end_date) ? new Date(contract.end_date) : new Date();
  const daysElapsed = Math.max(1, Math.floor((endBound - start) / 86400000) + 1);
  const accrued = dailyRate * daysElapsed;
  const paid = (allPayments || [])
    .filter(p => p.contract_id === contract.id && p.direction === 'income')
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const balance = Math.round((accrued - paid) * 100) / 100;
  let paidThroughDate = null;
  if (balance <= 0) {
    const coveredDays = paid / dailyRate;
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + Math.max(0, Math.floor(coveredDays) - 1));
    paidThroughDate = d.toISOString().slice(0, 10);
  }
  return {
    daily_rate: Math.round(dailyRate * 100) / 100,
    accrued: Math.round(accrued * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    balance,
    paid_through_date: paidThroughDate,
  };
}

function listContracts({ vehicleId } = {}) {
  const db = readDb();
  let rows = db.rental_contracts;
  if (vehicleId) rows = rows.filter(c => c.vehicle_id === vehicleId);
  rows = rows.sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  return rows.map(c => ({ ...c, balance: computeContractBalance(c, db.vehicle_payments) }));
}

function getContract(id) {
  const db = readDb();
  const c = db.rental_contracts.find(c => c.id === id) || null;
  if (!c) return null;
  return { ...c, balance: computeContractBalance(c, db.vehicle_payments) };
}

function nextContractNumber(db) {
  const year = new Date().getFullYear();
  const count = db.rental_contracts.filter(c => c.contract_number?.includes(String(year))).length + 1;
  return `DR-${year}-${String(count).padStart(4, '0')}`;
}

function createContract(data) {
  const db = readDb();
  const rec = {
    id: uid('ct'),
    contract_number: nextContractNumber(db),
    status: 'draft',
    created_at: nowIso(),
    ...data,
  };
  db.rental_contracts.push(rec);
  writeDb(db);
  return rec;
}

function updateContract(id, patch) {
  const db = readDb();
  const idx = db.rental_contracts.findIndex(c => c.id === id);
  if (idx === -1) throw new Error('Договорът не е намерен');
  db.rental_contracts[idx] = { ...db.rental_contracts[idx], ...patch, updated_at: nowIso() };
  writeDb(db);
  return db.rental_contracts[idx];
}

// ---------------------------------------------------------------------------
// PAYMENTS (приходи/разходи по кола)
// ---------------------------------------------------------------------------
function listPayments({ vehicleId } = {}) {
  let rows = readDb().vehicle_payments;
  if (vehicleId) rows = rows.filter(p => p.vehicle_id === vehicleId);
  return rows.sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1));
}

function addPayment(data) {
  const db = readDb();
  const rec = { id: uid('pm'), created_at: nowIso(), ...data };
  db.vehicle_payments.push(rec);
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// СТАТИСТИКИ: себестойност, заетост, печалба
// ---------------------------------------------------------------------------
function monthsBetween(d1, d2) {
  return Math.max(1, (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()));
}

function getFleetStats() {
  const db = readDb();
  const today = new Date();

  const perVehicle = db.vehicles.map(v => {
    const serviceCost = db.service_records
      .filter(s => s.vehicle_id === v.id)
      .reduce((sum, s) => sum + Number(s.cost || 0), 0);
    const recurringCost = db.vehicle_recurring_costs
      .filter(c => c.vehicle_id === v.id)
      .reduce((sum, c) => sum + Number(c.amount || 0), 0);
    const purchasePrice = Number(v.purchase_price || 0);
    const totalCost = purchasePrice + serviceCost + recurringCost;

    const directIncome = db.vehicle_payments
      .filter(p => p.vehicle_id === v.id && p.direction === 'income')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const expensePayments = db.vehicle_payments
      .filter(p => p.vehicle_id === v.id && p.direction === 'expense')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const assignments = db.vehicle_assignments.filter(a => a.vehicle_id === v.id);
    // реалният приход от КОНКРЕТНАТА кола идва от наема, удържан всяка седмица
    // от заработката на назначения шофьор (payroll_entries.car_rent_amount —
    // ОТДЕЛНО от удръжката по трудов договор, виж upsertPayrollEntry). Тук
    // приписваме наема към колата, ако профилът на шофьора е бил зачислен на
    // нея през седмицата на записа — иначе самото зачисляване никога не мести
    // стойностите в статистиката, докато не бъде въведена седмица в "Заплати".
    const rentIncome = (db.payroll_entries || []).reduce((sum, e) => {
      if (!e.car_rent_amount) return sum;
      const matches = assignments.some(a => {
        if (a.driver_id !== e.profile_id) return false;
        const aEnd = a.end_date || '9999-12-31';
        return e.week_start <= aEnd && e.week_end >= a.start_date;
      });
      return matches ? sum + Number(e.car_rent_amount || 0) : sum;
    }, 0);
    const income = directIncome + rentIncome;
    const netProfit = income - expensePayments - serviceCost - recurringCost;
    const daysAssigned = assignments.reduce((sum, a) => {
      const start = new Date(a.start_date);
      const end = a.end_date ? new Date(a.end_date) : today;
      return sum + Math.max(0, Math.round((end - start) / 86400000));
    }, 0);
    const daysOwned = v.purchase_date
      ? Math.max(1, Math.round((today - new Date(v.purchase_date)) / 86400000))
      : 1;
    const utilizationPct = Math.min(100, Math.round((daysAssigned / daysOwned) * 1000) / 10);

    // проста линейна амортизация -> текуща балансова стойност
    const ageMonths = v.purchase_date ? monthsBetween(new Date(v.purchase_date), today) : 0;
    const depMonths = v.depreciation_months || 60;
    const residual = Number(v.residual_value || 0);
    const depreciable = Math.max(0, purchasePrice - residual);
    const bookValue = Math.max(
      residual,
      purchasePrice - depreciable * Math.min(1, ageMonths / depMonths)
    );

    return {
      vehicle_id: v.id,
      plate_number: v.plate_number,
      make: v.make,
      model: v.model,
      status: v.status,
      purchase_price: purchasePrice,
      service_cost: serviceCost,
      recurring_cost: recurringCost,
      total_cost: totalCost,
      book_value: Math.round(bookValue),
      income,
      expense: expensePayments + serviceCost + recurringCost,
      net_profit: netProfit,
      days_assigned: daysAssigned,
      days_owned: daysOwned,
      utilization_pct: utilizationPct,
    };
  });

  const fleet = {
    vehicle_count: db.vehicles.length,
    available: db.vehicles.filter(v => v.status === 'available').length,
    assigned: db.vehicles.filter(v => v.status === 'assigned').length,
    rented: db.vehicles.filter(v => v.status === 'rented').length,
    in_service: db.vehicles.filter(v => v.status === 'in_service').length,
    total_purchase_value: perVehicle.reduce((s, v) => s + v.purchase_price, 0),
    total_book_value: perVehicle.reduce((s, v) => s + v.book_value, 0),
    total_cost: perVehicle.reduce((s, v) => s + v.total_cost, 0),
    total_income: perVehicle.reduce((s, v) => s + v.income, 0),
    total_net_profit: perVehicle.reduce((s, v) => s + v.net_profit, 0),
    avg_utilization_pct:
      perVehicle.length === 0
        ? 0
        : Math.round((perVehicle.reduce((s, v) => s + v.utilization_pct, 0) / perVehicle.length) * 10) / 10,
  };

  return { fleet, vehicles: perVehicle };
}

// ---------------------------------------------------------------------------
// ПРОБЕГ: обединява показания от всички източници (ръчно въведени, протоколи,
// сервизи, зачисления, договори) в една хронологична история. "Текущ пробег"
// е най-високата стойност — одометрите не намаляват, затова max() е сигурен
// начин да игнорираме случайно въведени в грешен ред записи.
// ---------------------------------------------------------------------------
const ODOMETER_SOURCE_LABELS = {
  initial: 'Начален пробег',
  manual: 'Ръчно въведено',
  service: 'Сервизна книжка',
  protocol: 'Приемо-предавателен протокол',
  assignment: 'Зачисляване',
  contract: 'Договор за наем',
};

function getOdometerReadings(vehicleId) {
  const db = readDb();
  const readings = [];

  const v = db.vehicles.find(v => v.id === vehicleId);
  if (v && v.initial_odometer_km != null) {
    readings.push({
      km: Number(v.initial_odometer_km) || 0,
      date: v.created_at || nowIso(),
      source: 'initial',
      note: null,
    });
  }

  (db.odometer_logs || [])
    .filter(l => l.vehicle_id === vehicleId)
    .forEach(l => readings.push({ id: l.id, km: Number(l.km), date: l.recorded_at, source: 'manual', note: l.note || null }));

  db.service_records
    .filter(s => s.vehicle_id === vehicleId && s.odometer_km)
    .forEach(s => readings.push({ id: s.id, km: Number(s.odometer_km), date: s.service_date, source: 'service', note: s.description || null }));

  db.handover_protocols
    .filter(p => p.vehicle_id === vehicleId && p.odometer_km)
    .forEach(p => readings.push({ id: p.id, km: Number(p.odometer_km), date: p.date, source: 'protocol', note: `Протокол ${p.protocol_number}` }));

  db.vehicle_assignments
    .filter(a => a.vehicle_id === vehicleId)
    .forEach(a => {
      if (a.start_odometer_km) readings.push({ id: a.id, km: Number(a.start_odometer_km), date: a.start_date, source: 'assignment', note: 'Начало на зачисляване' });
      if (a.end_odometer_km) readings.push({ id: a.id, km: Number(a.end_odometer_km), date: a.end_date || a.start_date, source: 'assignment', note: 'Край на зачисляване' });
    });

  db.rental_contracts
    .filter(c => c.vehicle_id === vehicleId)
    .forEach(c => {
      if (c.start_odometer_km) readings.push({ id: c.id, km: Number(c.start_odometer_km), date: c.start_date, source: 'contract', note: `Договор ${c.contract_number} — начало` });
      if (c.end_odometer_km) readings.push({ id: c.id, km: Number(c.end_odometer_km), date: c.end_date || c.start_date, source: 'contract', note: `Договор ${c.contract_number} — край` });
    });

  return readings;
}

function getCurrentOdometer(vehicleId) {
  const readings = getOdometerReadings(vehicleId);
  if (!readings.length) return 0;
  return Math.max(...readings.map(r => r.km));
}

function getLastServiceOdometer(vehicleId) {
  const db = readDb();
  const withKm = db.service_records.filter(s => s.vehicle_id === vehicleId && s.odometer_km);
  if (!withKm.length) return null;
  return Math.max(...withKm.map(s => Number(s.odometer_km)));
}

function listOdometerLogs(vehicleId) {
  return getOdometerReadings(vehicleId)
    .map(r => ({ ...r, source_label: ODOMETER_SOURCE_LABELS[r.source] || r.source }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function addOdometerLog(vehicleId, data) {
  const db = readDb();
  if (!db.odometer_logs) db.odometer_logs = [];
  const rec = { id: uid('od'), vehicle_id: vehicleId, source: 'manual', recorded_at: nowIso(), ...data };
  db.odometer_logs.push(rec);
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// РЕДАКТИРУЕМИ ШАБЛОНИ НА БЛАНКИ (протокол / договор)
// ---------------------------------------------------------------------------
function getDocumentTemplate(docType) {
  const db = readDb();
  const rec = (db.document_templates || []).find(t => t.doc_type === docType);
  return rec || { doc_type: docType, source: 'builtin', content: null, file_url: null, file_name: null, updated_at: null };
}

function setDocumentTemplate(docType, patch) {
  const db = readDb();
  if (!db.document_templates) db.document_templates = [];
  const idx = db.document_templates.findIndex(t => t.doc_type === docType);
  const base = idx !== -1 ? db.document_templates[idx] : { doc_type: docType, source: 'builtin', content: null, file_url: null, file_name: null };
  const rec = { ...base, ...patch, updated_at: nowIso() };
  if (idx !== -1) db.document_templates[idx] = rec; else db.document_templates.push(rec);
  writeDb(db);
  return rec;
}

// проста {{token}} замяна — HTML-escape-ва стойностите по подразбиране, за
// да е безопасно да се вкарва потребителски текст в отпечатваните страници
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderTemplate(str, data, { html = true } = {}) {
  if (!str) return '';
  return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const val = key.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    return html ? escapeHtml(val) : String(val == null ? '' : val);
  });
}

// ---------------------------------------------------------------------------
// ЕЛЕКТРОННО РАЗПИСВАНЕ: одиторски запис + статус върху протокол/договор
// ---------------------------------------------------------------------------
function addEsignEvent(data) {
  const db = readDb();
  if (!db.esign_events) db.esign_events = [];
  const rec = { id: uid('es'), created_at: nowIso(), status: 'pending', ...data };
  db.esign_events.push(rec);
  writeDb(db);
  return rec;
}

function updateEsignEvent(id, patch) {
  const db = readDb();
  if (!db.esign_events) db.esign_events = [];
  const idx = db.esign_events.findIndex(e => e.id === id);
  if (idx === -1) throw new Error('Записът не е намерен');
  db.esign_events[idx] = { ...db.esign_events[idx], ...patch };
  writeDb(db);
  return db.esign_events[idx];
}

function listEsignEvents(documentType, documentId) {
  const db = readDb();
  return (db.esign_events || [])
    .filter(e => e.document_type === documentType && e.document_id === documentId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// ============================================================================
// HR МОДУЛ
// ============================================================================

// ---------------------------------------------------------------------------
// ПОРТФЕЙЛИ — вътрешна счетоводна книга (НЕ истински банкови/платежни
// преводи). Балансът винаги се смята от wallet_transactions — никога не се
// пази отделно поле, за да не се разсинхронизира.
// ---------------------------------------------------------------------------
function canApproveTransfers(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'super_admin') return true;
  return !!(user.permissions && user.permissions.can_approve_transfers);
}

// делегиран флаг (profiles.permissions.can_view_earnings) — по подразбиране
// шофьорът вижда САМО броя си поръчки по седмица, не и заработката/сумите,
// освен ако админ изрично не разреши това за него (изрично изискване на
// потребителя: "ако админ позволи да се вижда")
function canViewEarnings(user) {
  if (!user) return false;
  if (['admin', 'manager', 'super_admin'].includes(user.role)) return true;
  return !!(user.permissions && user.permissions.can_view_earnings);
}

// ============================================================================
// СУПЕР АДМИНИСТРАТОР / КОНФИГУРИРУЕМА МАТРИЦА ЗА ДОСТЪП
//
// Матрицата се пази в db.permissions_matrix = { nav: {...}, actions: {...} }
// и се "засява" при първо четене от lib/permissions-catalog.js (виж
// defaultPermissionsMatrix) — така поведението остава ТОЧНО каквото е било
// преди тази система, докато супер администраторът не промени нещо изрично
// от новата страница /permissions.html.
//
// super_admin винаги минава навсякъде (implicit — не се пази в матрицата, за
// да не може супер администраторът случайно да заключи сам себе си).
//
// Освен ролевата матрица, всеки потребител може да има индивидуално
// изключение в profiles.permissions по ключ "nav:<href>" или
// "<module>.<action>" (true/false) — задава се от супер администратора за
// конкретен човек, независимо от неговата роля (напр. точно този мениджър да
// НЕ вижда счетоводството, или точно този шофьор да вижда портфейли).
// ============================================================================
function defaultPermissionsMatrix() {
  const nav = {};
  Object.keys(NAV_DEFAULTS).forEach(href => { nav[href] = [...NAV_DEFAULTS[href]]; });
  const actions = {};
  ACTION_MODULES.forEach(mod => {
    actions[mod.key] = {};
    mod.actions.forEach(a => { actions[mod.key][a.key] = [...a.defaultRoles]; });
  });
  return { nav, actions };
}

// вътрешна помощна ф-я — приема вече прочетена db (за да не удвоява четенето
// при getPermissionsMatrix), "досява" липсващи страници/модули, добавени в
// кода след последния запис на матрицата от админ, без да губи вече
// направените промени. Връща true, ако db е била променена (нужен запис).
function seedOrMigratePermissionsMatrix(db) {
  const defaults = defaultPermissionsMatrix();
  if (!db.permissions_matrix || typeof db.permissions_matrix !== 'object') {
    db.permissions_matrix = defaults;
    return true;
  }
  let changed = false;
  if (!db.permissions_matrix.nav || typeof db.permissions_matrix.nav !== 'object') {
    db.permissions_matrix.nav = {};
    changed = true;
  }
  Object.keys(defaults.nav).forEach(href => {
    if (!Array.isArray(db.permissions_matrix.nav[href])) {
      db.permissions_matrix.nav[href] = defaults.nav[href];
      changed = true;
    }
  });
  if (!db.permissions_matrix.actions || typeof db.permissions_matrix.actions !== 'object') {
    db.permissions_matrix.actions = {};
    changed = true;
  }
  Object.keys(defaults.actions).forEach(moduleKey => {
    if (!db.permissions_matrix.actions[moduleKey] || typeof db.permissions_matrix.actions[moduleKey] !== 'object') {
      db.permissions_matrix.actions[moduleKey] = defaults.actions[moduleKey];
      changed = true;
      return;
    }
    Object.keys(defaults.actions[moduleKey]).forEach(actionKey => {
      if (!Array.isArray(db.permissions_matrix.actions[moduleKey][actionKey])) {
        db.permissions_matrix.actions[moduleKey][actionKey] = defaults.actions[moduleKey][actionKey];
        changed = true;
      }
    });
  });
  return changed;
}

function getPermissionsMatrix() {
  const db = readDb();
  if (seedOrMigratePermissionsMatrix(db)) writeDb(db);
  return db.permissions_matrix;
}

// заменя матрицата с валидирано подмножество на подадената — приема се само
// познати href/модул/действие от каталога и само познати роли, за да не може
// повредена заявка да "счупи" достъпа до самата система.
function savePermissionsMatrix(patch) {
  const db = readDb();
  seedOrMigratePermissionsMatrix(db);
  const matrix = db.permissions_matrix;
  const cleanRoles = (arr) => Array.isArray(arr) ? arr.filter(r => ROLES.includes(r)) : null;

  if (patch && typeof patch.nav === 'object' && patch.nav) {
    Object.keys(matrix.nav).forEach(href => {
      const val = cleanRoles(patch.nav[href]);
      if (val) matrix.nav[href] = val;
    });
  }
  if (patch && typeof patch.actions === 'object' && patch.actions) {
    Object.keys(matrix.actions).forEach(moduleKey => {
      const patchModule = patch.actions[moduleKey];
      if (!patchModule || typeof patchModule !== 'object') return;
      Object.keys(matrix.actions[moduleKey]).forEach(actionKey => {
        const val = cleanRoles(patchModule[actionKey]);
        if (val) matrix.actions[moduleKey][actionKey] = val;
      });
    });
  }
  writeDb(db);
  return matrix;
}

function getPermissionsCatalog() {
  return { roles: ROLES, navDefaults: NAV_DEFAULTS, actionModules: ACTION_MODULES };
}

// достъп до страница от менюто (виж NAV_DEFAULTS) — истинската защита на
// данните е canAccessAction()/hasPermission() по-долу; тази функция управлява
// само видимостта на страницата/линка.
function canAccessNav(user, href) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  const override = user.permissions && user.permissions[`nav:${href}`];
  if (override === true || override === false) return override;
  const matrix = getPermissionsMatrix();
  const roles = matrix.nav[href];
  if (!roles) return true; // непозната страница — не блокираме по подразбиране
  return roles.includes(user.role);
}

function getNavAccessMap(user) {
  const map = {};
  Object.keys(NAV_DEFAULTS).forEach(href => { map[href] = canAccessNav(user, href); });
  return map;
}

// главната проверка за API действия — заменя старото requireRole(['admin'])
// / requireRole(['admin','manager']) с конфигурируема по роля проверка (виж
// server.js: requirePermission).
function hasPermission(user, moduleKey, actionKey) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  const override = user.permissions && user.permissions[`${moduleKey}.${actionKey}`];
  if (override === true || override === false) return override;
  const matrix = getPermissionsMatrix();
  const roles = matrix.actions[moduleKey] && matrix.actions[moduleKey][actionKey];
  if (!roles) return false; // непознат модул/действие — отказваме по подразбиране
  return roles.includes(user.role);
}

function countSuperAdmins(db) {
  return (db.profiles || []).filter(p => p.role === 'super_admin').length;
}

// еднократна миграция при стартиране на сървъра (виж server.js) — ако в
// системата няма нито един супер администратор, повишава акаунта
// admin@dombi.bg (собственика на системата) до super_admin. Не прави нищо,
// ако вече има поне един супер администратор — безопасна за многократно
// извикване при всеки рестарт.
function migrateSuperAdmin() {
  const db = readDb();
  if (countSuperAdmins(db) > 0) return null;
  const owner = db.profiles.find(p => p.email && p.email.toLowerCase() === 'admin@dombi.bg');
  const target = owner || db.profiles.find(p => p.role === 'admin');
  if (!target) return null;
  target.role = 'super_admin';
  writeDb(db);
  return target.id;
}

function getWalletBalance(userId) {
  const db = readDb();
  return (db.wallet_transactions || [])
    .filter(t => t.user_id === userId)
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
}

function listWalletTransactions(userId) {
  const db = readDb();
  return (db.wallet_transactions || [])
    .filter(t => t.user_id === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function listWalletTransfers({ userId, status } = {}) {
  const db = readDb();
  let rows = db.wallet_transfers || [];
  if (userId) rows = rows.filter(t => t.from_user_id === userId || t.to_user_id === userId);
  if (status) rows = rows.filter(t => t.status === status);
  return rows.sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
}

function createWalletTransfer({ from_user_id, to_user_id, amount, note, requested_by }) {
  if (from_user_id === to_user_id) throw new Error('Не можете да превеждате към себе си');
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new Error('Невалидна сума');
  const db = readDb();
  if (!db.wallet_transfers) db.wallet_transfers = [];
  const rec = {
    id: uid('wt'), from_user_id, to_user_id, amount: amt, note: note || null,
    status: 'pending', requested_by, requested_at: nowIso(),
    decided_by: null, decided_at: null, decision_note: null,
  };
  db.wallet_transfers.push(rec);
  writeDb(db);
  return rec;
}

function decideWalletTransfer(id, { approve, decided_by, decision_note } = {}) {
  const db = readDb();
  const rec = (db.wallet_transfers || []).find(t => t.id === id);
  if (!rec) throw new Error('Заявката не е намерена');
  if (rec.status !== 'pending') throw new Error('Заявката вече е решена');
  rec.status = approve ? 'approved' : 'rejected';
  rec.decided_by = decided_by;
  rec.decided_at = nowIso();
  rec.decision_note = decision_note || null;
  if (approve) {
    if (!db.wallet_transactions) db.wallet_transactions = [];
    db.wallet_transactions.push(
      { id: uid('wtx'), user_id: rec.from_user_id, amount: -rec.amount, type: 'transfer', related_transfer_id: rec.id, note: rec.note, created_by: decided_by, created_at: nowIso() },
      { id: uid('wtx'), user_id: rec.to_user_id, amount: rec.amount, type: 'transfer', related_transfer_id: rec.id, note: rec.note, created_by: decided_by, created_at: nowIso() },
    );
  }
  writeDb(db);
  return rec;
}

function cancelWalletTransfer(id, userId) {
  const db = readDb();
  const rec = (db.wallet_transfers || []).find(t => t.id === id);
  if (!rec) throw new Error('Заявката не е намерена');
  if (rec.status !== 'pending') throw new Error('Заявката вече е решена');
  if (rec.requested_by !== userId) throw new Error('Само подателят може да отмени заявката');
  rec.status = 'cancelled';
  writeDb(db);
  return rec;
}

function addWalletAdjustment({ user_id, amount, type, note, created_by }) {
  const db = readDb();
  if (!db.wallet_transactions) db.wallet_transactions = [];
  const rec = { id: uid('wtx'), user_id, amount: Number(amount), type: type || 'admin_adjustment', related_transfer_id: null, note: note || null, created_by, created_at: nowIso() };
  db.wallet_transactions.push(rec);
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// ОТПУСКИ — годишен баланс + заявки (одобрява прекият мениджър или админ)
// ---------------------------------------------------------------------------
const DEFAULT_ANNUAL_LEAVE_DAYS = 20; // чл. 155 КТ — минимум; НЕ е правен съвет, проверете при счетоводител/юрист

function getLeaveBalance(profileId, year) {
  const db = readDb();
  const rec = (db.leave_balances || []).find(b => b.profile_id === profileId && b.year === year);
  return rec || { profile_id: profileId, year, entitled_days: DEFAULT_ANNUAL_LEAVE_DAYS, carried_over_days: 0, notes: null };
}

function setLeaveBalance(profileId, year, patch) {
  const db = readDb();
  if (!db.leave_balances) db.leave_balances = [];
  const idx = db.leave_balances.findIndex(b => b.profile_id === profileId && b.year === year);
  const base = idx !== -1 ? db.leave_balances[idx] : { id: uid('lb'), profile_id: profileId, year, entitled_days: DEFAULT_ANNUAL_LEAVE_DAYS, carried_over_days: 0 };
  const rec = { ...base, ...patch };
  if (idx !== -1) db.leave_balances[idx] = rec; else db.leave_balances.push(rec);
  writeDb(db);
  return rec;
}

function getLeaveRequest(id) {
  const db = readDb();
  return (db.leave_requests || []).find(r => r.id === id) || null;
}

function listLeaveRequests({ profileId, managerId, status } = {}) {
  const db = readDb();
  let rows = db.leave_requests || [];
  if (profileId) rows = rows.filter(r => r.profile_id === profileId);
  if (status) rows = rows.filter(r => r.status === status);
  if (managerId) {
    const teamIds = new Set(db.profiles.filter(p => p.manager_id === managerId).map(p => p.id));
    rows = rows.filter(r => teamIds.has(r.profile_id));
  }
  return rows.sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
}

function getUsedLeaveDays(profileId, year, type = 'annual') {
  const db = readDb();
  return (db.leave_requests || [])
    .filter(r => r.profile_id === profileId && r.type === type && r.status === 'approved' && new Date(r.start_date).getFullYear() === year)
    .reduce((sum, r) => sum + Number(r.days || 0), 0);
}

function createLeaveRequest(data) {
  const db = readDb();
  if (!db.leave_requests) db.leave_requests = [];
  const rec = {
    id: uid('lr'), status: 'pending', requested_at: nowIso(),
    decided_by: null, decided_at: null, decision_note: null,
    ...data,
  };
  db.leave_requests.push(rec);
  writeDb(db);
  return rec;
}

function decideLeaveRequest(id, { approve, decided_by, decision_note } = {}) {
  const db = readDb();
  const rec = (db.leave_requests || []).find(r => r.id === id);
  if (!rec) throw new Error('Заявката не е намерена');
  rec.status = approve ? 'approved' : 'rejected';
  rec.decided_by = decided_by;
  rec.decided_at = nowIso();
  rec.decision_note = decision_note || null;
  writeDb(db);
  return rec;
}

function cancelLeaveRequest(id, userId) {
  const db = readDb();
  const rec = (db.leave_requests || []).find(r => r.id === id);
  if (!rec) throw new Error('Заявката не е намерена');
  if (rec.profile_id !== userId) throw new Error('Само служителят може да отмени своята заявка');
  if (rec.status === 'approved') throw new Error('Одобрена заявка не може да се отменя оттук — свържете се с мениджър/админ');
  rec.status = 'cancelled';
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// ТРУДОВИ / ГРАЖДАНСКИ ДОГОВОРИ
// ---------------------------------------------------------------------------
// подразбиращи се седмични удръжки по тип договор — НУЛА докато админ не ги
// зададе с реални стойности (виж настройки в HR модула); никога не гадаем.
function getDeductionDefaults() {
  const db = readDb();
  return db.hr_settings?.deduction_defaults || { labor_2: 0, labor_4: 0, labor_6: 0, labor_8: 0, civil: 0 };
}
function setDeductionDefaults(patch) {
  const db = readDb();
  if (!db.hr_settings) db.hr_settings = {};
  db.hr_settings.deduction_defaults = { ...getDeductionDefaults(), ...patch };
  writeDb(db);
  return db.hr_settings.deduction_defaults;
}
function deductionKeyFor(contractType, hoursPerDay) {
  return contractType === 'labor' ? `labor_${hoursPerDay}` : 'civil';
}

// ---------------------------------------------------------------------------
// НАСТРОЙКИ НА ЛЯВОТО МЕНЮ (навигация) — админ може да преименува елементи/
// групи и да ги пренарежда. Пазим САМО label + ред, по href/group като ключ —
// href, икона и roles винаги идват от кода (NAV масива във фронтенда), за да
// не може конфигурацията да бъде използвана за ескалиране на видимост.
function getNavConfig() {
  const db = readDb();
  return db.nav_config || null;
}
function setNavConfig(config) {
  const db = readDb();
  db.nav_config = config;
  writeDb(db);
  return db.nav_config;
}
function resetNavConfig() {
  const db = readDb();
  db.nav_config = null;
  writeDb(db);
  return null;
}

function listEmploymentContracts(profileId) {
  const db = readDb();
  return (db.employment_contracts || [])
    .filter(c => c.profile_id === profileId)
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
}

function getEmploymentContract(id) {
  const db = readDb();
  return (db.employment_contracts || []).find(c => c.id === id) || null;
}

function nextHrContractNumber(db, prefix) {
  const year = new Date().getFullYear();
  const count = (db.employment_contracts || []).filter(c => c.contract_number?.startsWith(`${prefix}-${year}`)).length + 1;
  return `${prefix}-${year}-${String(count).padStart(4, '0')}`;
}

function createEmploymentContract(data) {
  const db = readDb();
  if (!db.employment_contracts) db.employment_contracts = [];
  const defaults = getDeductionDefaults();
  const key = deductionKeyFor(data.contract_type, data.hours_per_day);
  const prefix = data.contract_type === 'labor' ? 'TD' : 'GD';
  const rec = {
    id: uid('ec'),
    contract_number: nextHrContractNumber(db, prefix),
    status: 'draft',
    signature_status: 'none',
    weekly_deduction_amount: defaults[key] ?? 0,
    created_at: nowIso(),
    ...data,
  };
  db.employment_contracts.push(rec);
  writeDb(db);
  return rec;
}

function updateEmploymentContract(id, patch) {
  const db = readDb();
  const idx = (db.employment_contracts || []).findIndex(c => c.id === id);
  if (idx === -1) throw new Error('Договорът не е намерен');
  db.employment_contracts[idx] = { ...db.employment_contracts[idx], ...patch, updated_at: nowIso() };
  writeDb(db);
  return db.employment_contracts[idx];
}

// ---------------------------------------------------------------------------
// САМОКАНДИДАТСТВАНЕ — публична форма (без вход)
// ---------------------------------------------------------------------------
function listJobApplications({ status } = {}) {
  const db = readDb();
  let rows = db.job_applications || [];
  if (status) rows = rows.filter(a => a.status === status);
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function getJobApplication(id) {
  const db = readDb();
  return (db.job_applications || []).find(a => a.id === id) || null;
}

function createJobApplication(data) {
  const db = readDb();
  if (!db.job_applications) db.job_applications = [];
  const rec = { id: uid('app'), status: 'pending', created_at: nowIso(), ...data };
  db.job_applications.push(rec);
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// ЛИНК ЗА ДОВЪРШВАНЕ НА КАНДИДАТУРАТА — от кратката форма (маркетинг сайт:
// само име/телефон/имейл/бележка) администраторът генерира с 1 клик уникален
// линк (?token=), който изпраща на кандидата сам (Viber/SMS/имейл — системата
// няма собствен пращач на имейли, затова само генерира линка за копиране).
// Кандидатът отваря линка → вижда СЪЩАТА подробна форма като /apply.html
// (лична карта + книжка със снимка/AI разчитане, ЕГН, адрес, избор на вид
// договор), но тя ДОПЪЛВА неговия вече съществуващ запис (по token), вместо
// да създава нов ред в job_applications.
// ---------------------------------------------------------------------------
function generateApplicationLink(id) {
  const db = readDb();
  const app = (db.job_applications || []).find(a => a.id === id);
  if (!app) throw new Error('Кандидатурата не е намерена');
  if (!['pending', 'link_sent'].includes(app.status)) {
    throw new Error('Линк може да се генерира само за кандидатури, чакащи преглед.');
  }
  app.application_token = crypto.randomBytes(24).toString('hex');
  app.token_created_at = nowIso();
  app.status = 'link_sent';
  writeDb(db);
  return app;
}

function getJobApplicationByToken(token) {
  const db = readDb();
  const app = (db.job_applications || []).find(a => a.application_token === token);
  if (!app) return null;
  if (!['link_sent', 'details_completed'].includes(app.status)) return null; // вече одобрена/отхвърлена — поканата не важи
  return app;
}

// кандидатът допълва своя ВЕЧЕ СЪЩЕСТВУВАЩ запис (по token) с ЛК/книжка/ЕГН/
// адрес/избран вид договор — не създава нов ред в job_applications.
function completeApplicationDetails(token, data) {
  const db = readDb();
  const app = (db.job_applications || []).find(a => a.application_token === token);
  if (!app) throw new Error('Невалиден или изтекъл линк.');
  if (!['link_sent', 'details_completed'].includes(app.status)) {
    throw new Error('Тази покана вече не е активна.');
  }
  const allowed = [
    'egn', 'address', 'id_card_number', 'id_card_expiry',
    'id_card_photo_front_url', 'id_card_photo_back_url', 'selfie_photo_url',
    'driver_license_number', 'driver_license_expiry',
    'driver_license_photo_front_url', 'driver_license_photo_back_url',
    'desired_contract_type', 'desired_hours_per_day', 'notes',
    'had_glovo_bolt_account', 'glovo_bolt_platform',
    'city', 'work_vehicle_type',
    'nationality', 'nationality_other',
    'protection_status_photo_url', 'residence_permit_photo_url', 'nap_certificate_photo_url',
  ];
  allowed.forEach(k => { if (k in data) app[k] = data[k]; });
  app.status = 'details_completed';
  app.details_completed_at = nowIso();
  writeDb(db);
  return app;
}

// одобрение: превръща кандидатурата в profiles (role='driver') +
// чернова на employment_contracts, готова за подпис
function approveJobApplication(id, { reviewed_by, email, temp_password, manager_id } = {}) {
  const db = readDb();
  const app = (db.job_applications || []).find(a => a.id === id);
  if (!app) throw new Error('Кандидатурата не е намерена');
  if (!['pending', 'link_sent', 'details_completed'].includes(app.status)) {
    throw new Error('Кандидатурата вече е разгледана');
  }
  if (!email) throw new Error('Нужен е имейл за новия профил');
  if (db.profiles.some(p => p.email.toLowerCase() === email.toLowerCase())) {
    throw new Error('Вече има потребител с този имейл');
  }

  const profile = {
    id: uid('u'),
    full_name: app.full_name,
    email,
    password: hashPassword(temp_password || crypto.randomBytes(6).toString('hex')),
    phone: app.phone || '',
    role: 'driver',
    status: 'active',
    permissions: {},
    must_change_password: true,
    manager_id: manager_id || null,
    egn: app.egn || null,
    address: app.address || null,
    id_card_number: app.id_card_number || null,
    id_card_expiry: app.id_card_expiry || null,
    id_card_photo_url: app.id_card_photo_front_url || null,
    id_card_photo_back_url: app.id_card_photo_back_url || null,
    selfie_photo_url: app.selfie_photo_url || null,
    driver_license_number: app.driver_license_number || null,
    driver_license_expiry: app.driver_license_expiry || null,
    driver_license_photo_url: app.driver_license_photo_front_url || null,
    driver_license_photo_back_url: app.driver_license_photo_back_url || null,
    had_glovo_bolt_account: app.had_glovo_bolt_account || null,
    glovo_bolt_platform: app.glovo_bolt_platform || null,
    city: app.city || null,
    work_vehicle_type: app.work_vehicle_type || null,
    nationality: app.nationality || null,
    nationality_other: app.nationality_other || null,
    protection_status_photo_url: app.protection_status_photo_url || null,
    residence_permit_photo_url: app.residence_permit_photo_url || null,
    nap_certificate_photo_url: app.nap_certificate_photo_url || null,
    created_at: nowIso(),
  };
  db.profiles.push(profile);

  if (!db.employment_contracts) db.employment_contracts = [];
  const defaults = getDeductionDefaults();
  const key = deductionKeyFor(app.desired_contract_type, app.desired_hours_per_day);
  const prefix = app.desired_contract_type === 'labor' ? 'TD' : 'GD';
  const contract = {
    id: uid('ec'),
    profile_id: profile.id,
    contract_type: app.desired_contract_type,
    hours_per_day: app.desired_contract_type === 'labor' ? app.desired_hours_per_day : null,
    contract_number: nextHrContractNumber(db, prefix),
    start_date: nowIso().slice(0, 10),
    end_date: null,
    weekly_deduction_amount: defaults[key] ?? 0,
    status: 'draft',
    signature_status: 'none',
    created_by: reviewed_by,
    created_at: nowIso(),
  };
  db.employment_contracts.push(contract);

  app.status = 'approved';
  app.reviewed_by = reviewed_by;
  app.reviewed_at = nowIso();
  app.created_profile_id = profile.id;
  writeDb(db);

  const { password, ...safeProfile } = profile;
  return { profile: safeProfile, contract, application: app };
}

// определя кой мениджър/админ отговаря за дадена кандидатура — от този
// момент нататък само той (плюс всеки админ) я вижда и оправлява в
// „Кандидатури“ (виж requireApplicationAccess в server.js). null = без
// назначение (видима само за администратори).
function assignApplicationManager(id, managerId) {
  const db = readDb();
  const app = (db.job_applications || []).find(a => a.id === id);
  if (!app) throw new Error('Кандидатурата не е намерена');
  app.manager_id = managerId || null;
  writeDb(db);
  return app;
}

function rejectJobApplication(id, { reviewed_by, decision_note } = {}) {
  const db = readDb();
  const app = (db.job_applications || []).find(a => a.id === id);
  if (!app) throw new Error('Кандидатурата не е намерена');
  app.status = 'rejected';
  app.reviewed_by = reviewed_by;
  app.reviewed_at = nowIso();
  app.decision_note = decision_note || null;
  writeDb(db);
  return app;
}

// Трайно изтрива кандидатура (и личните данни в нея — ЕГН, снимки на
// документи и т.н.) — прилага декларираните в политиката за поверителност
// срокове на съхранение (т. 8.1: до 6 месеца за неодобрени кандидатури) и
// правото на изтриване (т. 10). Връща изтрития запис, за да могат
// извикващите (server.js) да изтрият и прикачените файлове от /uploads.
// Само за администратор — виж requireRole(['admin']) в server.js.
function deleteJobApplication(id) {
  const db = readDb();
  const list = db.job_applications || [];
  const idx = list.findIndex(a => a.id === id);
  if (idx === -1) throw new Error('Кандидатурата не е намерена');
  const [removed] = list.splice(idx, 1);
  writeDb(db);
  return removed;
}

// ---------------------------------------------------------------------------
// СЕДМИЧНИ ЗАПЛАТИ — брой поръчки + заработка (внасят се ръчно, докато няма
// пряк импорт от Glovo/Bolt). Разписването потвърждава САМО броя поръчки.
// ---------------------------------------------------------------------------
function listPayrollEntries({ profileId, weekStart } = {}) {
  const db = readDb();
  let rows = db.payroll_entries || [];
  if (profileId) rows = rows.filter(p => p.profile_id === profileId);
  if (weekStart) rows = rows.filter(p => p.week_start === weekStart);
  return rows.sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}

function getPayrollEntry(id) {
  const db = readDb();
  return (db.payroll_entries || []).find(p => p.id === id) || null;
}

// "Наем на кола" (payroll_entries.car_rent_amount) е ОТДЕЛНА седмична удръжка
// от заработката на шофьора, различна от удръжката по трудов/граждански
// договор (deduction_amount) — двете се удържат заедно (виж нето по-долу), но
// представляват различни приходи за фирмата: удръжката по договор е чиста
// такса на фирмата, докато наемът на колата е приход, който трябва (а) да се
// вижда като приход на КОНКРЕТНАТА кола в статистиката (виж getFleetStats) и
// (б) автоматично да постъпва в "общата каса" (виж syncCarRentKasaEntry).
function upsertPayrollEntry(data) {
  const db = readDb();
  if (!db.payroll_entries) db.payroll_entries = [];
  const idx = db.payroll_entries.findIndex(p => p.profile_id === data.profile_id && p.week_start === data.week_start);
  let rec;
  if (idx !== -1) {
    const merged = { ...db.payroll_entries[idx], ...data };
    merged.net_amount = Number(merged.gross_earnings || 0) - Number(merged.deduction_amount || 0) - Number(merged.car_rent_amount || 0);
    db.payroll_entries[idx] = merged;
    rec = merged;
  } else {
    rec = {
      id: uid('pr'), order_count: 0, gross_earnings: 0, deduction_amount: 0, car_rent_amount: 0, source: 'manual',
      paid: false, paid_at: null, signature_status: 'none', signed_at: null, signed_by_name: null,
      created_at: nowIso(),
      ...data,
    };
    rec.net_amount = Number(rec.gross_earnings || 0) - Number(rec.deduction_amount || 0) - Number(rec.car_rent_amount || 0);
    db.payroll_entries.push(rec);
  }
  writeDb(db);
  syncCarRentKasaEntry(rec);
  return rec;
}

// -----------------------------------------------------------------------
// ОБЩА КАСА — един избран профил (обикновено мениджър), чийто портфейл служи
// за общата фирмена каса (виж getWalletBalance/listWalletTransactions за
// самия портфейл). Наемите от коли се вливат автоматично тук при всяко
// въвеждане/редакция на седмичен запис в "Заплати"; ръчните движения по
// касата остават заключени само за super_admin (виж requireSuperAdmin в
// server.js — нарочно НЕ минава през configurable permissions matrix).
// -----------------------------------------------------------------------
function getCashierProfileId() {
  const db = readDb();
  return db.hr_settings?.cashier_profile_id || null;
}

function setCashierProfileId(profileId) {
  const db = readDb();
  if (profileId) {
    const target = db.profiles.find(p => p.id === profileId);
    if (!target) throw new Error('Служителят не е намерен');
  }
  if (!db.hr_settings) db.hr_settings = {};
  db.hr_settings.cashier_profile_id = profileId || null;
  writeDb(db);
  return db.hr_settings.cashier_profile_id;
}

// поддържа ИДЕМПОТЕНТНО записа за наем на кола в касата, свързан с точно този
// payroll_entries запис (related_payroll_entry_id) — при редакция на вече
// въведена седмица премахва стария запис в касата и (ако наемът е > 0) слага
// нов с актуалната сума, вместо да трупа дубликати.
function syncCarRentKasaEntry(entry) {
  const db = readDb();
  if (!db.wallet_transactions) db.wallet_transactions = [];
  db.wallet_transactions = db.wallet_transactions.filter(t => t.related_payroll_entry_id !== entry.id);
  const cashierId = db.hr_settings?.cashier_profile_id;
  const amount = Number(entry.car_rent_amount || 0);
  if (cashierId && amount > 0) {
    const driver = db.profiles.find(p => p.id === entry.profile_id);
    db.wallet_transactions.push({
      id: uid('wtx'), user_id: cashierId, amount,
      type: 'car_rent_income', related_payroll_entry_id: entry.id,
      note: `Наем на кола — ${driver ? driver.full_name : entry.profile_id} — седмица ${entry.week_start}`,
      created_by: entry.created_by || null, created_at: nowIso(),
    });
  }
  writeDb(db);
}

// потвърждение от шофьора — записва се САМО броят поръчки в одиторския
// esign запис (виж server.js), никога сумата
function signPayrollEntry(id, { signed_by_name } = {}) {
  const db = readDb();
  const rec = (db.payroll_entries || []).find(p => p.id === id);
  if (!rec) throw new Error('Записът не е намерен');
  rec.signature_status = 'signed_in_person';
  rec.signed_at = nowIso();
  rec.signed_by_name = signed_by_name;
  writeDb(db);
  return rec;
}

function markPayrollPaid(id, paid = true) {
  const db = readDb();
  const rec = (db.payroll_entries || []).find(p => p.id === id);
  if (!rec) throw new Error('Записът не е намерен');
  rec.paid = paid;
  rec.paid_at = paid ? nowIso() : null;
  writeDb(db);
  return rec;
}

// ---------------------------------------------------------------------------
// РЕФЕРАЛНИ/ПОСРЕДНИЧЕСКИ ПАРТНЬОРИ (мениджъри с комисионна)
// ---------------------------------------------------------------------------
function getPartnerCommissionProfile(profileId) {
  const db = readDb();
  return (db.partner_commission_profiles || []).find(p => p.profile_id === profileId) || null;
}

function listPartnerCommissionProfiles() {
  const db = readDb();
  return db.partner_commission_profiles || [];
}

function setPartnerCommissionProfile(profileId, patch) {
  const db = readDb();
  if (!db.partner_commission_profiles) db.partner_commission_profiles = [];
  const idx = db.partner_commission_profiles.findIndex(p => p.profile_id === profileId);
  const base = idx !== -1 ? db.partner_commission_profiles[idx] : {
    id: uid('pc'), profile_id: profileId, comp_type: 'percentage', percentage: null,
    fixed_amount: null, fixed_period: 'month', comp_base: 'net_revenue_after_platform_fee',
    per_driver_amount: null, qualifying_threshold: 30,
    active: true, notes: null, created_at: nowIso(),
  };
  const rec = { ...base, ...patch, updated_at: nowIso() };
  if (idx !== -1) db.partner_commission_profiles[idx] = rec; else db.partner_commission_profiles.push(rec);
  writeDb(db);
  return rec;
}

// екипът (шофьорите), зачислени към конкретен мениджър/партньор — виж
// manager_id в profiles (йерархия мениджър → шофьори, изискване (к))
function listTeamProfiles(managerId) {
  const db = readDb();
  return db.profiles
    .filter(p => p.manager_id === managerId)
    .map(p => { const { password: _p, ...safe } = p; return safe; });
}

// Статистика "пари, донесени на компанията" за партньор/посредник за период.
// ЗАБЕЛЕЖКА: от импорта на реални данни от Bolt/Glovo (виж DEPLOYMENT.md)
// payroll_entries вече съдържа РЕАЛНИ седмични заработки, не демо данни.
// Базата за изчисление (comp_base) тук обаче е сборът от gross_earnings
// (изплатено НА ШОФЬОРА) на екипа на партньора — а не действителния нетен
// приход НА ФИРМАТА след платформена такса (comp_base:
// 'net_revenue_after_platform_fee' по подразбиране в профила на партньора,
// виж по-долу). Тези две бази НЕ са едно и също число, а системата все още
// не пресмята истински фирмен приход отделно — затова базата остава
// ПРИБЛИЗИТЕЛНА, изрично маркирана като такава навсякъде, където се
// показва (виж partners.html), докато не бъде изградена реална сметка на
// фирмения приход/разход.
function getPartnerStats(profileId, { from, to } = {}) {
  const db = readDb();
  const commission = getPartnerCommissionProfile(profileId) || {
    id: null, profile_id: profileId, comp_type: 'percentage', percentage: null,
    fixed_amount: null, fixed_period: 'month', comp_base: 'net_revenue_after_platform_fee',
    active: false, notes: null,
  };
  const teamIds = new Set(db.profiles.filter(p => p.manager_id === profileId).map(p => p.id));
  let entries = (db.payroll_entries || []).filter(e => teamIds.has(e.profile_id));
  if (from) entries = entries.filter(e => e.week_start >= from);
  if (to) entries = entries.filter(e => e.week_start <= to);

  const totalOrders = entries.reduce((s, e) => s + Number(e.order_count || 0), 0);
  const totalGrossEarnings = entries.reduce((s, e) => s + Number(e.gross_earnings || 0), 0);
  const weeksCovered = new Set(entries.map(e => e.week_start)).size;
  const monthsCovered = new Set(entries.map(e => (e.week_start || '').slice(0, 7))).size;

  // "per_active_driver": комисионна за всеки шофьор от екипа, направил
  // ПОВЕЧЕ ОТ прага (qualifying_threshold, по подразбиране 30 €) за дадена
  // седмица — брои се ОТДЕЛНО за всяка седмица в периода (един и същ
  // шофьор може да "класира" партньора многократно за различни седмици).
  const byWeek = new Map();
  entries.forEach(e => {
    if (!e.week_start) return;
    if (!byWeek.has(e.week_start)) byWeek.set(e.week_start, []);
    byWeek.get(e.week_start).push(e);
  });
  const threshold = Number(commission.qualifying_threshold != null ? commission.qualifying_threshold : 30);
  const perActiveDriverBreakdown = [...byWeek.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([week_start, weekEntries]) => {
      const qualifyingIds = new Set(
        weekEntries.filter(e => Number(e.gross_earnings || 0) > threshold).map(e => e.profile_id)
      );
      return { week_start, qualifying_count: qualifyingIds.size, team_size_that_week: new Set(weekEntries.map(e => e.profile_id)).size };
    });
  const totalQualifyingDriverWeeks = perActiveDriverBreakdown.reduce((s, w) => s + w.qualifying_count, 0);

  let commissionOwed = 0;
  if (commission.active !== false) {
    if (commission.comp_type === 'fixed' && commission.fixed_amount) {
      const periods = commission.fixed_period === 'week' ? weeksCovered : monthsCovered;
      commissionOwed = Number(commission.fixed_amount) * periods;
    } else if (commission.comp_type === 'percentage' && commission.percentage) {
      commissionOwed = totalGrossEarnings * (Number(commission.percentage) / 100);
    } else if (commission.comp_type === 'per_active_driver' && commission.per_driver_amount) {
      commissionOwed = totalQualifyingDriverWeeks * Number(commission.per_driver_amount);
    }
  }

  return {
    commission,
    team_size: teamIds.size,
    weeks_covered: weeksCovered,
    total_orders: totalOrders,
    total_gross_earnings: totalGrossEarnings,
    qualifying_threshold: threshold,
    total_qualifying_driver_weeks: totalQualifyingDriverWeeks,
    per_active_driver_breakdown: perActiveDriverBreakdown,
    commission_owed: commissionOwed,
    data_source: 'demo_payroll_proxy', // маркер: не са реални приходи от поръчки, виж коментара по-горе
  };
}

// ---------------------------------------------------------------------------
// СЧЕТОВОДСТВО: общ финансов отчет за фирмата (приходи/разходи/печалба) +
// ръчна счетоводна книга за движения, които нямат друго специализирано място
// (наем офис, комунални, реклама, заплати офис персонал и т.н.).
//
// Реалният приход от шофьорите е СЕДМИЧНАТА УДРЪЖКА/ТАКСА (deduction_amount
// от payroll_entries) — не gross_earnings (това са парите на шофьора от
// платформата, не на фирмата) — виж коментара в getPartnerStats() по-горе и
// изричното уточнение на потребителя при партньорските комисионни ("който ще
// са част от парите за седмичните удръжки/таксата").
// ---------------------------------------------------------------------------
const FINANCE_COST_TYPE_LABELS = {
  insurance_civil: 'Гражданска отговорност', insurance_casco: 'Каско', vignette: 'Винетка',
  tax: 'Данък', parking: 'Паркинг', fine: 'Глоба', other_recurring: 'Друго',
};

function listFinanceEntries({ from, to } = {}) {
  const db = readDb();
  let rows = db.finance_entries || [];
  if (from) rows = rows.filter(e => e.entry_date >= from);
  if (to) rows = rows.filter(e => e.entry_date <= to);
  return rows.sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1));
}

function addFinanceEntry({ entry_date, direction, category, amount, note, created_by }) {
  if (!entry_date) throw new Error('Нужна е дата');
  if (!['income', 'expense'].includes(direction)) throw new Error('Невалиден тип (приход/разход)');
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new Error('Невалидна сума');
  const db = readDb();
  if (!db.finance_entries) db.finance_entries = [];
  const rec = {
    id: uid('fe'), entry_date, direction, category: category ? String(category).slice(0, 100) : 'Друго',
    amount: amt, note: note || null, created_by, created_at: nowIso(),
  };
  db.finance_entries.push(rec);
  writeDb(db);
  return rec;
}

function deleteFinanceEntry(id) {
  const db = readDb();
  const idx = (db.finance_entries || []).findIndex(e => e.id === id);
  if (idx === -1) throw new Error('Записът не е намерен');
  db.finance_entries.splice(idx, 1);
  writeDb(db);
  return true;
}

// изчислява партньорските комисионни (разход) за периода — преизползва
// СЪЩАТА логика като getPartnerStats(), за да няма разминаване между
// таблото на партньорите и общия счетоводен отчет
function getPartnerCommissionExpenseEntries({ from, to }) {
  const db = readDb();
  const partners = db.profiles.filter(p => p.role === 'manager');
  const entries = [];
  partners.forEach(p => {
    const commission = getPartnerCommissionProfile(p.id);
    if (!commission || commission.active === false) return;
    const stats = getPartnerStats(p.id, { from, to });
    if (stats.commission_owed > 0) {
      entries.push({
        date: to || nowIso().slice(0, 10),
        direction: 'expense',
        amount: stats.commission_owed,
        category: 'Партньорски комисионни',
        note: `${p.full_name} — изчислена комисионна за периода`,
        source: 'partner_commission',
      });
    }
  });
  return entries;
}

function getCompanyFinanceReport({ from, to } = {}) {
  const db = readDb();
  const entries = [];

  // 1. Приходи/разходи по кола (наем, продажби, ремонти и др. еднократни пера)
  (db.vehicle_payments || []).forEach(p => {
    if (from && p.payment_date < from) return;
    if (to && p.payment_date > to) return;
    const vehicle = db.vehicles.find(v => v.id === p.vehicle_id);
    entries.push({
      date: p.payment_date,
      direction: p.direction,
      amount: Number(p.amount || 0),
      category: p.direction === 'income' ? 'Наем на кола' : 'Разход по кола',
      note: [p.description, vehicle ? vehicle.plate_number : null].filter(Boolean).join(' · ') || null,
      source: 'vehicle_payment',
    });
  });

  // 2. Сервизни разходи по кола
  (db.service_records || []).forEach(s => {
    if (!s.cost) return;
    if (from && s.service_date < from) return;
    if (to && s.service_date > to) return;
    const vehicle = db.vehicles.find(v => v.id === s.vehicle_id);
    entries.push({
      date: s.service_date,
      direction: 'expense',
      amount: Number(s.cost || 0),
      category: 'Сервиз',
      note: [s.description, vehicle ? vehicle.plate_number : null].filter(Boolean).join(' · ') || null,
      source: 'service_record',
    });
  });

  // 3. Периодични разходи по кола (застраховки, винетки, данъци...) — записани
  // на датата, на която е започнал периодът им (period_start)
  (db.vehicle_recurring_costs || []).forEach(c => {
    if (from && c.period_start < from) return;
    if (to && c.period_start > to) return;
    const vehicle = db.vehicles.find(v => v.id === c.vehicle_id);
    entries.push({
      date: c.period_start,
      direction: 'expense',
      amount: Number(c.amount || 0),
      category: FINANCE_COST_TYPE_LABELS[c.type] || c.type || 'Периодичен разход',
      note: [c.notes, vehicle ? vehicle.plate_number : null].filter(Boolean).join(' · ') || null,
      source: 'recurring_cost',
    });
  });

  // 4. Седмични такси/удръжки от шофьорите — реалният приход на фирмата
  (db.payroll_entries || []).forEach(e => {
    if (!e.deduction_amount) return;
    if (from && e.week_start < from) return;
    if (to && e.week_start > to) return;
    const driver = findUserById(e.profile_id);
    entries.push({
      date: e.week_start,
      direction: 'income',
      amount: Number(e.deduction_amount || 0),
      category: 'Седмични такси от шофьори',
      note: [driver ? driver.full_name : null, `седмица ${e.week_start}`].filter(Boolean).join(' · '),
      source: 'payroll_deduction',
    });
  });

  // 4б. Наем на коли, удържан седмично от заработката — ОТДЕЛЕН приход от
  // удръжката по договор по-горе (виж upsertPayrollEntry); същата сума се
  // приписва и на конкретната кола в getFleetStats() и постъпва автоматично
  // в общата каса (виж syncCarRentKasaEntry).
  (db.payroll_entries || []).forEach(e => {
    if (!e.car_rent_amount) return;
    if (from && e.week_start < from) return;
    if (to && e.week_start > to) return;
    const driver = findUserById(e.profile_id);
    entries.push({
      date: e.week_start,
      direction: 'income',
      amount: Number(e.car_rent_amount || 0),
      category: 'Наем на коли',
      note: [driver ? driver.full_name : null, `седмица ${e.week_start}`].filter(Boolean).join(' · '),
      source: 'car_rent',
    });
  });

  // 5. Ръчно въведени пера (наем офис, комунални, реклама, заплати и т.н.)
  listFinanceEntries({ from, to }).forEach(e => {
    entries.push({
      date: e.entry_date, direction: e.direction, amount: Number(e.amount || 0),
      category: e.category, note: e.note, source: 'manual',
    });
  });

  // 6. Партньорски комисионни (разход) за периода
  entries.push(...getPartnerCommissionExpenseEntries({ from, to }));

  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const totalIncome = entries.filter(e => e.direction === 'income').reduce((s, e) => s + e.amount, 0);
  const totalExpense = entries.filter(e => e.direction === 'expense').reduce((s, e) => s + e.amount, 0);

  const byCategoryMap = new Map();
  entries.forEach(e => {
    const key = `${e.direction}::${e.category}`;
    byCategoryMap.set(key, (byCategoryMap.get(key) || 0) + e.amount);
  });
  const byCategory = [...byCategoryMap.entries()]
    .map(([key, amount]) => {
      const [direction, category] = key.split('::');
      return { direction, category, amount };
    })
    .sort((a, b) => b.amount - a.amount);

  return {
    from: from || null,
    to: to || null,
    entries,
    totals: { income: totalIncome, expense: totalExpense, profit: totalIncome - totalExpense },
    by_category: byCategory,
  };
}

// ---------------------------------------------------------------------------
// ЕДИН КЛИК: зачисляване на кола под наем към шофьор + автоматично съставяне
// на договор за наем и приемо-предавателен протокол (готови за разписване)
// ---------------------------------------------------------------------------
function oneClickAssignVehicle({ vehicleId, driverId, rateAmount, ratePeriod, depositAmount, createdBy }) {
  const driver = findUserById(driverId);
  if (!driver) throw new Error('Шофьорът не е намерен');
  const vehicle = readDb().vehicles.find(v => v.id === vehicleId);
  if (!vehicle) throw new Error('Колата не е намерена');
  const currentKm = getCurrentOdometer(vehicleId);

  const assignment = createAssignment({
    vehicle_id: vehicleId, driver_id: driverId, purpose: 'dombi_courier',
    start_odometer_km: currentKm, created_by: createdBy,
  });

  const contract = createContract({
    vehicle_id: vehicleId, assignment_id: assignment.id,
    renter_type: 'dombi_courier', renter_driver_id: driverId, renter_name: driver.full_name,
    start_date: nowIso().slice(0, 10),
    rate_amount: Number(rateAmount) || 0, rate_period: ratePeriod || 'week',
    deposit_amount: Number(depositAmount) || 0,
    start_odometer_km: currentKm, status: 'active',
    created_by: createdBy,
  });

  const protocol = createProtocol({
    vehicle_id: vehicleId, assignment_id: assignment.id, type: 'handover',
    odometer_km: currentKm, fuel_level_pct: null, photos: [],
    created_by: createdBy,
  });

  return { assignment, contract, protocol };
}

// ---------------------------------------------------------------------------
// ЗАДЪЛЖИТЕЛНА ХАРТИЯ ПРИ ЗАЧИСЛЯВАНЕ: общ вариант на oneClickAssignVehicle
// по-горе, но за ВСЯКА цел на зачисляване (вътрешен шофьор, друга платформа,
// лично ползване, външен наемател) — не само за куриери на Dombi Riders.
// Регулярният път за зачисляване (public/assignments.html → POST
// /api/assignments) минава през тази функция, за да не може да се създаде
// зачисляване без договор за наем и приемо-предавателен протокол.
// ---------------------------------------------------------------------------
function createAssignmentWithPaperwork(data) {
  const vehicle = readDb().vehicles.find(v => v.id === data.vehicle_id);
  if (!vehicle) throw new Error('Колата не е намерена');
  if (data.rate_amount == null || isNaN(Number(data.rate_amount))) {
    throw new Error('Наемната вноска е задължителна за договора за наем.');
  }
  if (data.start_odometer_km == null || isNaN(Number(data.start_odometer_km))) {
    throw new Error('Пробегът при предаване е задължителен за протокола.');
  }

  let renterName = data.external_name || null;
  if (data.driver_id) {
    const driver = findUserById(data.driver_id);
    if (!driver) throw new Error('Шофьорът не е намерен');
    renterName = driver.full_name;
  }
  if (!renterName) throw new Error('Липсва наемател — изберете шофьор или въведете данни за външен наемател.');

  const assignment = createAssignment({
    vehicle_id: data.vehicle_id,
    driver_id: data.driver_id || null,
    external_name: data.driver_id ? null : data.external_name,
    external_phone: data.driver_id ? null : (data.external_phone || null),
    external_egn: data.driver_id ? null : (data.external_egn || null),
    external_license_number: data.driver_id ? null : (data.external_license_number || null),
    purpose: data.purpose || 'dombi_courier',
    start_date: data.start_date || nowIso().slice(0, 10),
    start_odometer_km: Number(data.start_odometer_km),
    notes: data.notes || null,
    created_by: data.created_by,
  });

  const contract = createContract({
    vehicle_id: data.vehicle_id, assignment_id: assignment.id,
    renter_type: assignment.purpose,
    renter_driver_id: data.driver_id || null,
    renter_name: renterName,
    renter_egn: data.driver_id ? null : (data.external_egn || null),
    renter_phone: data.driver_id ? null : (data.external_phone || null),
    renter_license_number: data.driver_id ? null : (data.external_license_number || null),
    start_date: assignment.start_date,
    rate_amount: Number(data.rate_amount) || 0,
    rate_period: data.rate_period || 'week',
    deposit_amount: Number(data.deposit_amount) || 0,
    start_odometer_km: Number(data.start_odometer_km),
    status: 'active',
    created_by: data.created_by,
  });

  const protocol = createProtocol({
    vehicle_id: data.vehicle_id, assignment_id: assignment.id, type: 'handover',
    odometer_km: Number(data.start_odometer_km),
    fuel_type: data.fuel_type || null,
    fuel_level_pct: data.fuel_level_pct != null ? Number(data.fuel_level_pct) : null,
    fuel_level_secondary_pct: data.fuel_level_secondary_pct != null ? Number(data.fuel_level_secondary_pct) : null,
    photos: [],
    created_by: data.created_by,
  });

  return { assignment, contract, protocol };
}

// ---------------------------------------------------------------------------
// ЛИЧНО ДОСИЕ НА СЛУЖИТЕЛ — картотека на документите (лична карта, шофьорска
// книжка, трудов/граждански договор, договори за наеми, протоколи), обединена
// на едно място + изтичащи документи (огледало на алармата за коли).
// ---------------------------------------------------------------------------
function listContractsByDriver(driverId) {
  const db = readDb();
  return (db.rental_contracts || [])
    .filter(c => c.renter_driver_id === driverId)
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
}

function listProtocolsByDriver(driverId) {
  const db = readDb();
  const assignmentIds = new Set((db.vehicle_assignments || []).filter(a => a.driver_id === driverId).map(a => a.id));
  return (db.handover_protocols || [])
    .filter(p => assignmentIds.has(p.assignment_id))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function getPersonnelFile(profileId) {
  const profile = findUserById(profileId);
  if (!profile) throw new Error('Служителят не е намерен');
  const { password, ...safeProfile } = profile;
  return {
    profile: safeProfile,
    manager: profile.manager_id ? (() => { const m = findUserById(profile.manager_id); if (!m) return null; const { password: _p, ...safe } = m; return safe; })() : null,
    employment_contracts: listEmploymentContracts(profileId),
    rental_contracts: listContractsByDriver(profileId),
    protocols: listProtocolsByDriver(profileId),
    assignments: listAssignments({ driverId: profileId }),
  };
}

// изтичащи лични документи + трудови/граждански договори + договори за наем
// на всички служители — огледало на getDashboardData()-ната аларма за коли
function getEmployeeDocumentAlerts() {
  const db = readDb();
  const today = new Date();
  const soonMs = 30 * 86400000;
  const alerts = [];

  (db.profiles || []).forEach(p => {
    [
      ['id_card_expiry', 'Лична карта'],
      ['driver_license_expiry', 'Шофьорска книжка'],
    ].forEach(([field, label]) => {
      const val = p[field];
      if (!val) return;
      const diff = new Date(val) - today;
      if (diff < soonMs) {
        alerts.push({
          profile_id: p.id, full_name: p.full_name, kind: 'personal_document',
          field, label, date: val, days_left: Math.round(diff / 86400000),
        });
      }
    });
  });

  (db.employment_contracts || []).forEach(c => {
    if (!c.end_date || c.status === 'terminated') return;
    const diff = new Date(c.end_date) - today;
    if (diff < soonMs) {
      const p = findUserById(c.profile_id);
      alerts.push({
        profile_id: c.profile_id, full_name: p ? p.full_name : c.profile_id, kind: 'employment_contract',
        field: 'end_date', label: c.contract_type === 'labor' ? 'Трудов договор' : 'Граждански договор',
        contract_number: c.contract_number, date: c.end_date, days_left: Math.round(diff / 86400000),
      });
    }
  });

  (db.rental_contracts || []).forEach(c => {
    if (!c.renter_driver_id || !c.end_date || c.status === 'terminated') return;
    const diff = new Date(c.end_date) - today;
    if (diff < soonMs) {
      const p = findUserById(c.renter_driver_id);
      alerts.push({
        profile_id: c.renter_driver_id, full_name: p ? p.full_name : c.renter_driver_id, kind: 'rental_contract',
        field: 'end_date', label: 'Договор за наем на кола', contract_number: c.contract_number,
        date: c.end_date, days_left: Math.round(diff / 86400000),
      });
    }
  });

  alerts.sort((a, b) => a.days_left - b.days_left);
  return alerts;
}

// ---------------------------------------------------------------------------
// ДАШБОРД: изтичащи документи + предстоящ сервиз + бърз преглед на флота
// ---------------------------------------------------------------------------
function getDashboardData() {
  const db = readDb();
  const today = new Date();
  const soonMs = 30 * 86400000;

  const DOC_FIELDS = [
    ['registration_expiry', 'Годна регистрация'],
    ['insurance_expiry', 'Гражданска отговорност'],
    ['casco_expiry', 'Каско'],
    ['vignette_expiry', 'Винетка'],
    ['inspection_expiry', 'Технически преглед'],
  ];

  const expiringDocs = [];
  db.vehicles.forEach(v => {
    DOC_FIELDS.forEach(([field, label]) => {
      const val = v[field];
      if (!val) return;
      const diff = new Date(val) - today;
      if (diff < soonMs) {
        expiringDocs.push({
          vehicle_id: v.id,
          plate_number: v.plate_number,
          make: v.make,
          model: v.model,
          field,
          label,
          date: val,
          days_left: Math.round(diff / 86400000),
        });
      }
    });
  });
  expiringDocs.sort((a, b) => a.days_left - b.days_left);

  // "предстоящ сервиз" — по дни (от последен сервиз) И по километри (от
  // последния сервиз с отчетен пробег), спрямо интервала, зададен за всяка
  // кола (service_interval_months / service_interval_km, с разумни стойности
  // по подразбиране). Дължимо е, ако е изтекъл ПОНЕ единия критерий.
  const lastServiceByVehicle = {};
  db.service_records.forEach(s => {
    const t = new Date(s.service_date).getTime();
    if (!Number.isFinite(t)) return;
    if (!lastServiceByVehicle[s.vehicle_id] || t > lastServiceByVehicle[s.vehicle_id]) {
      lastServiceByVehicle[s.vehicle_id] = t;
    }
  });
  const serviceDue = db.vehicles
    .filter(v => v.status !== 'inactive')
    .map(v => {
      const last = lastServiceByVehicle[v.id];
      const daysSince = last ? Math.round((today - last) / 86400000) : null;
      const intervalMonths = v.service_interval_months || 6;
      const intervalKm = v.service_interval_km || 10000;
      const currentKm = getCurrentOdometer(v.id);
      const lastServiceKm = getLastServiceOdometer(v.id);
      const kmSinceService = lastServiceKm != null ? currentKm - lastServiceKm : null;
      const dueByDays = daysSince == null || daysSince > intervalMonths * 30;
      const dueByKm = kmSinceService != null && kmSinceService >= intervalKm;
      return {
        vehicle_id: v.id,
        plate_number: v.plate_number,
        make: v.make,
        model: v.model,
        days_since_service: daysSince,
        km_since_service: kmSinceService,
        due_by_days: dueByDays,
        due_by_km: dueByKm,
      };
    })
    .filter(v => v.due_by_days || v.due_by_km)
    .sort((a, b) => (b.days_since_service ?? 999999) - (a.days_since_service ?? 999999));

  // масло / ГРМ (ангренажен ремък) — самостоятелни интервали от общия
  // сервизен интервал по-горе, защото периодите им са несравнимо различни
  const TYPE_LABELS = { oil_change: 'Масло', timing_belt: 'Ангренажен ремък (ГРМ)' };
  const typeServiceDue = [];
  db.vehicles.filter(v => v.status !== 'inactive').forEach(v => {
    const currentKm = getCurrentOdometer(v.id);
    [['oil_change', 'oil_interval_km', 'oil_interval_months', 10000, 12],
     ['timing_belt', 'timing_belt_interval_km', 'timing_belt_interval_months', 90000, 60]]
      .forEach(([type, kmField, monthsField, defKm, defMonths]) => {
        const last = lastServiceRecordOfType(v.id, type);
        const intervalKm = v[kmField] || defKm;
        const intervalMonths = v[monthsField] || defMonths;
        const daysSince = last ? Math.round((today - new Date(last.service_date)) / 86400000) : null;
        const kmSince = last && last.odometer_km != null ? currentKm - last.odometer_km : null;
        const dueByDays = daysSince == null || daysSince > intervalMonths * 30;
        const dueByKm = kmSince != null && kmSince >= intervalKm;
        if (dueByDays || dueByKm) {
          typeServiceDue.push({
            vehicle_id: v.id, plate_number: v.plate_number, make: v.make, model: v.model,
            type, label: TYPE_LABELS[type],
            days_since_service: daysSince, km_since_service: kmSince,
            due_by_days: dueByDays, due_by_km: dueByKm,
          });
        }
      });
  });

  // задължителен месечен преглед — липсва ли запис за текущия календарен месец
  const thisMonth = currentMonthStr();
  const inspectedThisMonth = new Set(
    (db.vehicle_inspections || []).filter(i => i.month === thisMonth).map(i => i.vehicle_id)
  );
  const missingInspections = db.vehicles
    .filter(v => v.status !== 'inactive' && !inspectedThisMonth.has(v.id))
    .map(v => ({ vehicle_id: v.id, plate_number: v.plate_number, make: v.make, model: v.model, month: thisMonth }));

  const employeeDocAlerts = getEmployeeDocumentAlerts();

  return {
    fleet_count: db.vehicles.length,
    available: db.vehicles.filter(v => v.status === 'available').length,
    assigned: db.vehicles.filter(v => v.status === 'assigned').length,
    rented: db.vehicles.filter(v => v.status === 'rented').length,
    in_service: db.vehicles.filter(v => v.status === 'in_service').length,
    active_assignments: db.vehicle_assignments.filter(a => a.status === 'active').length,
    active_contracts: db.rental_contracts.filter(c => c.status === 'active').length,
    expiring_docs: expiringDocs.slice(0, 15),
    expiring_docs_total: expiringDocs.length,
    service_due: serviceDue.slice(0, 10),
    service_due_total: serviceDue.length,
    type_service_due: typeServiceDue.slice(0, 10),
    type_service_due_total: typeServiceDue.length,
    missing_inspections: missingInspections.slice(0, 10),
    missing_inspections_total: missingInspections.length,
    expiring_employee_docs: employeeDocAlerts.slice(0, 15),
    expiring_employee_docs_total: employeeDocAlerts.length,
  };
}

// ---------------------------------------------------------------------------
// ДНЕВНИК НА АКТИВНОСТТА: обединен поток от последните действия в системата
// ---------------------------------------------------------------------------
function getActivityFeed(limit = 50, filters = {}) {
  const db = readDb();
  const usersById = Object.fromEntries(db.profiles.map(p => [p.id, p.full_name]));
  const cityById = Object.fromEntries(db.profiles.map(p => [p.id, p.city || null]));
  const vehiclesById = Object.fromEntries(db.vehicles.map(v => [v.id, v]));
  const plate = (vehicleId) => (vehiclesById[vehicleId] ? vehiclesById[vehicleId].plate_number : vehicleId);
  const items = [];

  // помощник: съставя елемент от дневника, включително actor_id/град,
  // изведен от профила на действащото лице (или null, ако е системно/анонимно)
  const push = (type, at, actorId, text, link) => {
    items.push({
      type, at,
      actor: actorId ? (usersById[actorId] || null) : null,
      actor_id: actorId || null,
      city: actorId ? (cityById[actorId] || null) : null,
      text, link,
    });
  };

  db.vehicles.forEach(v => {
    push('vehicle', v.created_at, v.created_by,
      `Добавена нова кола ${v.plate_number} — ${v.make} ${v.model}`,
      `/vehicle-detail.html?id=${v.id}`);
  });
  db.service_records.forEach(s => {
    push('service', s.created_at, s.created_by,
      `Сервизен запис за ${plate(s.vehicle_id)}: ${s.description || '—'} (${Number(s.cost || 0)} €)`,
      `/vehicle-detail.html?id=${s.vehicle_id}#service`);
  });
  db.vehicle_recurring_costs.forEach(c => {
    push('recurring_cost', c.created_at, c.created_by || null,
      `Добавен периодичен разход за ${plate(c.vehicle_id)}: ${c.type} — ${Number(c.amount || 0)} €`,
      `/vehicle-detail.html?id=${c.vehicle_id}#overview`);
  });
  db.vehicle_assignments.forEach(a => {
    const who = a.driver_id ? (usersById[a.driver_id] || 'вътрешен шофьор') : `${a.external_name || 'външен'} (външен)`;
    push('assignment', a.created_at, a.created_by,
      `Зачисляване на ${plate(a.vehicle_id)} към ${who}`,
      `/vehicle-detail.html?id=${a.vehicle_id}#assignments`);
  });
  db.handover_protocols.forEach(p => {
    push('protocol', p.created_at, p.created_by,
      `Нов протокол ${p.protocol_number} (${p.type === 'handover' ? 'предаване' : 'приемане'}) за ${plate(p.vehicle_id)}`,
      `/protocol-print.html?id=${p.id}`);
  });
  db.rental_contracts.forEach(c => {
    push('contract', c.created_at, c.created_by,
      `Нов договор ${c.contract_number} за ${plate(c.vehicle_id)} (${c.renter_name || 'вътрешен'})`,
      `/contract-print.html?id=${c.id}`);
  });
  db.vehicle_payments.forEach(p => {
    push('payment', p.created_at, p.created_by || null,
      `${p.direction === 'income' ? 'Приход' : 'Разход'} ${Number(p.amount || 0)} € за ${plate(p.vehicle_id)}`,
      `/vehicle-detail.html?id=${p.vehicle_id}`);
  });

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  let filtered = items;
  const { from, to, actorId, city, type } = filters;
  if (from) filtered = filtered.filter(it => it.at && it.at.slice(0, 10) >= from);
  if (to) filtered = filtered.filter(it => it.at && it.at.slice(0, 10) <= to);
  if (actorId) filtered = filtered.filter(it => it.actor_id === actorId);
  if (city) filtered = filtered.filter(it => it.city === city);
  if (type) filtered = filtered.filter(it => it.type === type);

  return filtered.slice(0, limit);
}

module.exports = {
  readDb, writeDb, initDb, uid, nowIso,
  hashPassword, verifyPassword, migratePlaintextPasswords, syncConfirmedTalonData,
  cleanupStrayTalonRegistrationExpiry,
  normalizeOwnerName, normalizeAllTalonOwnerNames,
  findUserByEmail, findUserById, listUsers, createUser, updateUser, deleteUser,
  generatePersonnelLink, getUserByPersonnelToken, completePersonnelDetails, setUserBlacklist,
  createSession, getSession, destroySession,
  listVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle,
  listEquipment, addEquipment, updateEquipment, deleteEquipment,
  listServiceRecords, addServiceRecord,
  listInspections, createInspection,
  listRecurringCosts, addRecurringCost,
  listAssignments, createAssignment, endAssignment,
  listProtocols, getProtocol, createProtocol, updateProtocol,
  listContracts, getContract, createContract, updateContract,
  listPayments, addPayment,
  getFleetStats,
  getDashboardData,
  getActivityFeed,
  getCurrentOdometer, getLastServiceOdometer, listOdometerLogs, addOdometerLog,
  getDocumentTemplate, setDocumentTemplate, renderTemplate,
  addEsignEvent, updateEsignEvent, listEsignEvents,
  // --- Супер администратор / права ---
  ROLES, getPermissionsMatrix, savePermissionsMatrix, getPermissionsCatalog,
  canAccessNav, getNavAccessMap, hasPermission, countSuperAdmins, migrateSuperAdmin,
  // --- HR модул ---
  canApproveTransfers, canViewEarnings, getWalletBalance, listWalletTransactions, listWalletTransfers,
  createWalletTransfer, decideWalletTransfer, cancelWalletTransfer, addWalletAdjustment,
  getCashierProfileId, setCashierProfileId,
  DEFAULT_ANNUAL_LEAVE_DAYS, getLeaveBalance, setLeaveBalance, listLeaveRequests, getLeaveRequest,
  getUsedLeaveDays, createLeaveRequest, decideLeaveRequest, cancelLeaveRequest,
  getDeductionDefaults, setDeductionDefaults, deductionKeyFor,
  getNavConfig, setNavConfig, resetNavConfig,
  listFleetShowcase, getFleetShowcaseItem, createFleetShowcaseItem, updateFleetShowcaseItem,
  deleteFleetShowcaseItem, reorderFleetShowcase, suggestLinkedVehicleIds, getPublicFleetShowcase,
  getShowcaseAvailability, isShowcaseItemAvailable,
  listReservations, getReservation, createReservation, updateReservation,
  getSiteContent, updateSiteContent, createRentRequest, listRentRequests, deleteRentRequest,
  listEmploymentContracts, getEmploymentContract, createEmploymentContract, updateEmploymentContract,
  listJobApplications, getJobApplication, createJobApplication, approveJobApplication, rejectJobApplication,
  deleteJobApplication,
  generateApplicationLink, getJobApplicationByToken, completeApplicationDetails, assignApplicationManager,
  listPayrollEntries, getPayrollEntry, upsertPayrollEntry, signPayrollEntry, markPayrollPaid,
  getPartnerCommissionProfile, listPartnerCommissionProfiles, setPartnerCommissionProfile,
  listTeamProfiles, getPartnerStats,
  listFinanceEntries, addFinanceEntry, deleteFinanceEntry, getCompanyFinanceReport,
  oneClickAssignVehicle, createAssignmentWithPaperwork,
  listContractsByDriver, listProtocolsByDriver, getPersonnelFile, getEmployeeDocumentAlerts,
};
