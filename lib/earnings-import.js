// ============================================================================
// lib/earnings-import.js — импорт на седмични заработки от реални Bolt Food /
// Glovo (Freestreets BG) Excel експорти, качени от администратор в UI-то на
// "Заплати" (виж POST /api/hr/payroll/import в server.js).
//
// Използва пакета `xlsx` (SheetJS), добавен в package.json. ⚠️ Пакетът НЕ
// може да бъде инсталиран/тестван в средата, в която е разработена тази
// система (npm registry е недостъпен там) — затова, по същия начин както
// docxtemplater/pizzip в lib/doc-templates.js, се зарежда "лениво" (require
// вътре във функция, с try/catch). При липса, функциите тук хвърлят грешка с
// код MODULE_NOT_AVAILABLE, вместо да съборят сървъра.
//
// ЛОГИКАТА ТУК Е ИЗВЛЕЧЕНА И ПРОВЕРЕНА РЪЧНО върху два РЕАЛНИ файла:
//   fleet_courier_earnings_and_balances_2026_W27.xlsx  (Bolt Food)
//   PAYMENT_DOMBI.xlsx                                  (Glovo, чрез Freestreets BG)
// (виж еднократния бекфил, който вкара 15-те седмици история в системата —
// същите правила за колони/формула за заработка се прилагат и тук, за да
// може администраторът да качва бъдещи седмични файлове по същия начин).
//
// ФОРМУЛА ЗА "ЗАРАБОТКА" (изрично указание на собственика на бизнеса):
//   сумата, изкарана от шофьора, ВКЛЮЧИТЕЛНО бакшишите, БЕЗ ДДС — от нея
//   после се правят седмичните удръжки.
//   - Bolt: колона "Adjusted Earnings with Courier Tips (Without VAT)".
//   - Glovo: "Total earned" + "Tips" (в експорта на Glovo няма отделна колона
//     без ДДС на ниво куриер — ДДС е само на ниво обобщена фактура).
// ============================================================================

function loadXlsx() {
  try {
    return require('xlsx');
  } catch (e) {
    return null;
  }
}

function isAvailable() {
  return !!loadXlsx();
}

function notAvailableError() {
  const err = new Error(
    'Пакетът "xlsx" не е наличен в тази среда (не можа да бъде инсталиран/тестван при разработката). ' +
    'При реален деплой в Render той се инсталира от package.json — но задължително тествайте с реален файл преди да разчитате на този път.'
  );
  err.code = 'MODULE_NOT_AVAILABLE';
  return err;
}

function normPhone(v) {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('359') && digits.length >= 12) digits = digits.slice(3);
  else if (digits.startsWith('0') && digits.length === 10) digits = digits.slice(1);
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

function fmtPhone(last9) {
  return last9 ? ('+359' + last9) : '';
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return { value: 0, ok: true };
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v, ok: true };
  const n = Number(v);
  if (Number.isFinite(n)) return { value: n, ok: true };
  return { value: 0, ok: false }; // повредена/нечислова клетка (виждано е в реални Glovo файлове)
}

// --- Bolt Food ---------------------------------------------------------
// Очаквани колони (индекс от 0, ред 1 = хедър, данни от ред 2):
//  1 Courier UID, 2 First Name, 3 Last Name, 4 Phone, 5 Email, 6 Personal Code,
//  18 Adjusted Earnings with Courier Tips (Without VAT)
function parseBoltWorkbook(buffer) {
  const XLSX = loadXlsx();
  if (!XLSX) throw notAvailableError();
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const records = [];
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row[0] === null || row[0] === undefined || row[0] === '') continue;
    const uidCourier = row[1];
    if (!uidCourier) continue;
    const gross = toNum(row[18]);
    if (!gross.ok) errors.push({ row: i + 1, courier_uid: uidCourier, issue: 'Нечислова стойност в "Adjusted Earnings with Courier Tips (Without VAT)"' });
    records.push({
      platform: 'bolt',
      courier_uid: String(uidCourier),
      first_name: row[2] || '',
      last_name: row[3] || '',
      phone_raw: row[4],
      phone: normPhone(row[4]),
      email: (row[5] || '').toString().trim(),
      egn: row[6] !== null && row[6] !== undefined ? String(row[6]).trim() : '',
      order_count: null, // Bolt експортът НЕ съдържа брой поръчки
      order_count_unknown: true,
      gross_earnings: Math.round(gross.value * 100) / 100,
      needs_review: !gross.ok,
    });
  }
  return { records, errors, sheet_name: sheetName };
}

// --- Glovo (Freestreets BG) --------------------------------------------
// Всеки лист = 1 седмица; B1 съдържа "Период:" текст "DD.MM-DD.MM.YYYY"
// (с известен случай на печатна грешка в месеца на края — коригира се, ако
// изчисленият край е ПРЕДИ началото). Хедър на ред 9, данни от ред 10.
//
// ⚠️ ВАЖНО: форматът на колоните на Glovo се сменя почти всяка седмица
// (проверено ръчно на 20+ реални седмични листа, май—септември 2026 г.) —
// броят и редът на колоните варират, затова НЕ разчитаме на фиксирани
// индекси, а разпознаваме хедър реда (клетка, равна на "Courier ID" без
// значение на главни/малки букви) и картографираме нужните полета по ИМЕ
// на колоната (виж GLOVO_FIELD_ALIASES по-долу). Наблюдавани варианти:
//   стар формат (05–08.2026): Courier ID, Name, First Name, Email, Phone,
//     Orders, "Total earned", Tips
//   нов формат (от 08.2026 насам): RIDER ID, COURIER ID, COMPLETE NAME,
//     ..., TIPS, ..., "TOTAL COURIER EARNINGS" (плюс по избор: CITY, EMAIL,
//     PHONE, DELIVERED ORDERS, COMMISSION, NET PARTNER EARNINGS...)
// И в двата формата "Total earned"/"TOTAL COURIER EARNINGS" Е БЕЗ бакшиши
// (кръстосано проверено срещу вътрешната аритметика на самите листове:
// NET PARTNER EARNINGS = TOTAL COURIER EARNINGS − COMMISSION, без TIPS) —
// затова формулата остава: заработка = тази колона + колоната TIPS.
// Колоната COMMISSION/PLATFORM FEE е такса на Glovo към фирмата (Freestreets
// BG/Dombi), НЕ удръжка от шофьора — нарочно НЕ се чете тук.
//
// Забележка: в реални файлове са наблюдавани (а) редове с ПОВЕЧЕ ОТ ЕДИН
// запис за един и същ Courier ID в рамките на седмицата (отделни партиди на
// плащане — СЪБИРАТ СЕ), и (б) редове за куриери БЕЗ никаква активност през
// седмицата — за тях Glovo изобщо няма отделен "Courier ID" (G...), а
// повтаря числовия RIDER ID в колоната COURIER ID, и всички други полета
// (Orders/Total earned/Tips/Email/Phone) са празни. Такива редове нямат
// нито поръчки, нито заработка — ПРОПУСКАТ се (виж филтъра накрая на
// parseGlovoSheet), за да не се трупат безсмислени записи с 0.00 € в
// прегледа за импорт.
const GLOVO_FIELD_ALIASES = {
  courierId: ['courier id'],
  name: ['complete name', 'name'],
  firstName: ['first name'],
  email: ['email'],
  phone: ['phone'],
  orders: ['delivered orders', 'orders'],
  totalEarnings: ['total courier earnings', 'total earned'],
  tips: ['tips'],
};

function findGlovoHeaderRowIndex(rows) {
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.some(c => typeof c === 'string' && c.trim().toLowerCase() === 'courier id')) return i;
  }
  return -1;
}

function buildGlovoColumnMap(headerRow) {
  const map = {};
  headerRow.forEach((cell, idx) => {
    if (typeof cell !== 'string') return;
    const key = cell.trim().toLowerCase();
    if (!key) return;
    for (const field of Object.keys(GLOVO_FIELD_ALIASES)) {
      if (map[field] !== undefined) continue; // първото съвпадение печели
      if (GLOVO_FIELD_ALIASES[field].includes(key)) map[field] = idx;
    }
  });
  return map;
}

function parsePeriod(text) {
  if (!text) return null;
  const m = String(text).replace(/\s+/g, '').match(/^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, d1, m1, d2, m2, y] = m.map(Number);
  let start = new Date(Date.UTC(y, m1 - 1, d1));
  let end = new Date(Date.UTC(y, m2 - 1, d2));
  if (end < start) end = new Date(Date.UTC(y, m1 - 1, d2)); // известна печатна грешка в месеца
  return { start, end };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function parseGlovoSheet(XLSX, ws, sheetName) {
  const b1 = ws['B1'] ? ws['B1'].w || ws['B1'].v : null; // "Период:" клетка, напр. "29.06-05.07.2026"
  const period = parsePeriod(b1);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const weekStart = period ? isoDate(period.start) : null;
  const weekEnd = period ? isoDate(period.end) : null;

  const headerIdx = findGlovoHeaderRowIndex(rows);
  if (headerIdx === -1) {
    // няма разпознаваема таблица в тоя лист (напр. празен помощен лист като
    // "Sheet1"/"Sheet2" в реалния работен файл) — пропускаме го тихо, вместо
    // да съборим целия импорт заради един празен лист
    return { sheet: sheetName, week_start: weekStart, week_end: weekEnd, records: [], errors: [] };
  }
  const cols = buildGlovoColumnMap(rows[headerIdx]);
  if (cols.courierId === undefined) {
    return {
      sheet: sheetName, week_start: weekStart, week_end: weekEnd, records: [],
      errors: [{ row: headerIdx + 1, issue: 'Не е открита колона "Courier ID" в хедъра на листа — пропуснат.' }],
    };
  }

  const byId = new Map();
  const errors = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rawId = row[cols.courierId];
    if (rawId === null || rawId === undefined || rawId === '') continue; // празен/несъществен ред
    const cid = String(rawId).trim();
    const totalR = toNum(cols.totalEarnings !== undefined ? row[cols.totalEarnings] : 0);
    const tipsR = toNum(cols.tips !== undefined ? row[cols.tips] : 0);
    const needsReview = !totalR.ok || !tipsR.ok;
    if (needsReview) errors.push({ row: i + 1, courier_id: cid, issue: 'Нечислова стойност в "Total Courier Earnings"/"Total earned" или "Tips"' });
    const gross = Math.round((totalR.value + tipsR.value) * 100) / 100;
    if (!byId.has(cid)) {
      byId.set(cid, {
        platform: 'glovo', courier_id: cid,
        name: (cols.name !== undefined ? row[cols.name] : '') || '',
        first_name: (cols.firstName !== undefined ? row[cols.firstName] : '') || '',
        email: ((cols.email !== undefined ? row[cols.email] : '') || '').toString().trim(),
        phone_raw: cols.phone !== undefined ? row[cols.phone] : null,
        phone: normPhone(cols.phone !== undefined ? row[cols.phone] : null),
        order_count: 0, gross_earnings: 0, needs_review: false, row_count: 0,
      });
    }
    const rec = byId.get(cid);
    rec.order_count += Number((cols.orders !== undefined ? row[cols.orders] : 0) || 0);
    rec.gross_earnings = Math.round((rec.gross_earnings + gross) * 100) / 100;
    rec.needs_review = rec.needs_review || needsReview;
    rec.row_count += 1;
  }

  // куриери без никаква активност (0 поръчки и 0.00 € заработка за седмицата
  // — виж бележката над GLOVO_FIELD_ALIASES) не носят полезна информация за
  // импорта на заплати и само биха заредили прегледа с "непотвърдени" записи
  const records = Array.from(byId.values()).filter(r => r.order_count > 0 || r.gross_earnings !== 0);

  return { sheet: sheetName, week_start: weekStart, week_end: weekEnd, records, errors };
}

// Връща масив от седмици (обикновено 1, ако администраторът качва по един
// файл на седмица за в бъдеще — но поддържа и работни книги с няколко листа,
// каквато е формата на историческия Glovo файл).
function parseGlovoWorkbook(buffer) {
  const XLSX = loadXlsx();
  if (!XLSX) throw notAvailableError();
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const dataSheets = wb.SheetNames.filter((n, idx) => idx > 0 || wb.SheetNames.length === 1);
  return dataSheets.map(sn => parseGlovoSheet(XLSX, wb.Sheets[sn], sn));
}

module.exports = {
  isAvailable, normPhone, fmtPhone, parseBoltWorkbook, parseGlovoWorkbook,
};
