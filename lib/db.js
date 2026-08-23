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

function updateVehicle(id, patch) {
  const db = readDb();
  const idx = db.vehicles.findIndex(v => v.id === id);
  if (idx === -1) throw new Error('Колата не е намерена');
  db.vehicles[idx] = { ...db.vehicles[idx], ...patch, updated_at: nowIso() };
  writeDb(db);
  return db.vehicles[idx];
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
function listContracts({ vehicleId } = {}) {
  let rows = readDb().rental_contracts;
  if (vehicleId) rows = rows.filter(c => c.vehicle_id === vehicleId);
  return rows.sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
}

function getContract(id) {
  return readDb().rental_contracts.find(c => c.id === id) || null;
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

    const income = db.vehicle_payments
      .filter(p => p.vehicle_id === v.id && p.direction === 'income')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const expensePayments = db.vehicle_payments
      .filter(p => p.vehicle_id === v.id && p.direction === 'expense')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const netProfit = income - expensePayments - serviceCost - recurringCost;

    const assignments = db.vehicle_assignments.filter(a => a.vehicle_id === v.id);
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
  if (user.role === 'admin') return true;
  return !!(user.permissions && user.permissions.can_approve_transfers);
}

// делегиран флаг (profiles.permissions.can_view_earnings) — по подразбиране
// шофьорът вижда САМО броя си поръчки по седмица, не и заработката/сумите,
// освен ако админ изрично не разреши това за него (изрично изискване на
// потребителя: "ако админ позволи да се вижда")
function canViewEarnings(user) {
  if (!user) return false;
  if (['admin', 'manager'].includes(user.role)) return true;
  return !!(user.permissions && user.permissions.can_view_earnings);
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
    'egn', 'address', 'id_card_number', 'id_card_expiry', 'id_card_photo_url',
    'driver_license_number', 'driver_license_expiry', 'driver_license_photo_url',
    'desired_contract_type', 'desired_hours_per_day', 'notes',
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
    manager_id: manager_id || null,
    egn: app.egn || null,
    address: app.address || null,
    id_card_number: app.id_card_number || null,
    id_card_expiry: app.id_card_expiry || null,
    id_card_photo_url: app.id_card_photo_url || null,
    driver_license_number: app.driver_license_number || null,
    driver_license_expiry: app.driver_license_expiry || null,
    driver_license_photo_url: app.driver_license_photo_url || null,
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

function upsertPayrollEntry(data) {
  const db = readDb();
  if (!db.payroll_entries) db.payroll_entries = [];
  const idx = db.payroll_entries.findIndex(p => p.profile_id === data.profile_id && p.week_start === data.week_start);
  if (idx !== -1) {
    db.payroll_entries[idx] = {
      ...db.payroll_entries[idx], ...data,
      net_amount: Number(data.gross_earnings ?? db.payroll_entries[idx].gross_earnings ?? 0) - Number(data.deduction_amount ?? db.payroll_entries[idx].deduction_amount ?? 0),
    };
    writeDb(db);
    return db.payroll_entries[idx];
  }
  const rec = {
    id: uid('pr'), order_count: 0, gross_earnings: 0, deduction_amount: 0, source: 'manual',
    paid: false, paid_at: null, signature_status: 'none', signed_at: null, signed_by_name: null,
    created_at: nowIso(),
    ...data,
  };
  rec.net_amount = Number(rec.gross_earnings || 0) - Number(rec.deduction_amount || 0);
  db.payroll_entries.push(rec);
  writeDb(db);
  return rec;
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
function getActivityFeed(limit = 50) {
  const db = readDb();
  const usersById = Object.fromEntries(db.profiles.map(p => [p.id, p.full_name]));
  const vehiclesById = Object.fromEntries(db.vehicles.map(v => [v.id, v]));
  const plate = (vehicleId) => (vehiclesById[vehicleId] ? vehiclesById[vehicleId].plate_number : vehicleId);
  const items = [];

  db.vehicles.forEach(v => {
    items.push({
      type: 'vehicle',
      at: v.created_at,
      actor: usersById[v.created_by] || null,
      text: `Добавена нова кола ${v.plate_number} — ${v.make} ${v.model}`,
      link: `/vehicle-detail.html?id=${v.id}`,
    });
  });
  db.service_records.forEach(s => {
    items.push({
      type: 'service',
      at: s.created_at,
      actor: usersById[s.created_by] || null,
      text: `Сервизен запис за ${plate(s.vehicle_id)}: ${s.description || '—'} (${Number(s.cost || 0)} €)`,
      link: `/vehicle-detail.html?id=${s.vehicle_id}#service`,
    });
  });
  db.vehicle_recurring_costs.forEach(c => {
    items.push({
      type: 'recurring_cost',
      at: c.created_at,
      actor: null,
      text: `Добавен периодичен разход за ${plate(c.vehicle_id)}: ${c.type} — ${Number(c.amount || 0)} €`,
      link: `/vehicle-detail.html?id=${c.vehicle_id}#overview`,
    });
  });
  db.vehicle_assignments.forEach(a => {
    const who = a.driver_id ? (usersById[a.driver_id] || 'вътрешен шофьор') : `${a.external_name || 'външен'} (външен)`;
    items.push({
      type: 'assignment',
      at: a.created_at,
      actor: usersById[a.created_by] || null,
      text: `Зачисляване на ${plate(a.vehicle_id)} към ${who}`,
      link: `/vehicle-detail.html?id=${a.vehicle_id}#assignments`,
    });
  });
  db.handover_protocols.forEach(p => {
    items.push({
      type: 'protocol',
      at: p.created_at,
      actor: usersById[p.created_by] || null,
      text: `Нов протокол ${p.protocol_number} (${p.type === 'handover' ? 'предаване' : 'приемане'}) за ${plate(p.vehicle_id)}`,
      link: `/protocol-print.html?id=${p.id}`,
    });
  });
  db.rental_contracts.forEach(c => {
    items.push({
      type: 'contract',
      at: c.created_at,
      actor: usersById[c.created_by] || null,
      text: `Нов договор ${c.contract_number} за ${plate(c.vehicle_id)} (${c.renter_name || 'вътрешен'})`,
      link: `/contract-print.html?id=${c.id}`,
    });
  });
  db.vehicle_payments.forEach(p => {
    items.push({
      type: 'payment',
      at: p.created_at,
      actor: null,
      text: `${p.direction === 'income' ? 'Приход' : 'Разход'} ${Number(p.amount || 0)} € за ${plate(p.vehicle_id)}`,
      link: `/vehicle-detail.html?id=${p.vehicle_id}`,
    });
  });

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, limit);
}

module.exports = {
  readDb, writeDb, initDb, uid, nowIso,
  hashPassword, verifyPassword, migratePlaintextPasswords,
  findUserByEmail, findUserById, listUsers, createUser, updateUser,
  createSession, getSession, destroySession,
  listVehicles, getVehicle, createVehicle, updateVehicle,
  listEquipment, addEquipment,
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
  // --- HR модул ---
  canApproveTransfers, canViewEarnings, getWalletBalance, listWalletTransactions, listWalletTransfers,
  createWalletTransfer, decideWalletTransfer, cancelWalletTransfer, addWalletAdjustment,
  DEFAULT_ANNUAL_LEAVE_DAYS, getLeaveBalance, setLeaveBalance, listLeaveRequests, getLeaveRequest,
  getUsedLeaveDays, createLeaveRequest, decideLeaveRequest, cancelLeaveRequest,
  getDeductionDefaults, setDeductionDefaults, deductionKeyFor,
  listEmploymentContracts, getEmploymentContract, createEmploymentContract, updateEmploymentContract,
  listJobApplications, getJobApplication, createJobApplication, approveJobApplication, rejectJobApplication,
  generateApplicationLink, getJobApplicationByToken, completeApplicationDetails,
  listPayrollEntries, getPayrollEntry, upsertPayrollEntry, signPayrollEntry, markPayrollPaid,
  getPartnerCommissionProfile, listPartnerCommissionProfiles, setPartnerCommissionProfile,
  listTeamProfiles, getPartnerStats,
  oneClickAssignVehicle, createAssignmentWithPaperwork,
  listContractsByDriver, listProtocolsByDriver, getPersonnelFile, getEmployeeDocumentAlerts,
};
