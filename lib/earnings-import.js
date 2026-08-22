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
//  3 Courier ID, 5 Name, 6 First Name, 7 Email, 8 Phone,
//  10 Orders, 15 Total earned, 16 Tips
// Забележка: в реални файлове са наблюдавани (а) редове с ПОВЕЧЕ ОТ ЕДИН
// запис за един и същ Courier ID в рамките на седмицата (отделни партиди на
// плащане - СЪБИРАТ СЕ), и (б) "опашкови" редове с чисто числов (не низов)
// Courier ID, при които всички други полета (Orders/Total earned/Tips/
// Email/Phone) са празни - това са нетранзакционни редове от друга таблица
// (по всичко личи - RiderID справка), НЕ носят приходи и се ПРОПУСКАТ.
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
  const byId = new Map();
  const errors = [];
  for (let i = 9; i < rows.length; i++) { // ред 10 (индекс 9) = първи ред данни
    const row = rows[i];
    if (!row || row[3] === null || row[3] === undefined || row[3] === '') continue;
    if (typeof row[3] !== 'string') continue; // нетранзакционен "опашков" ред, виж бележката горе
    const cid = row[3];
    const totalR = toNum(row[15]);
    const tipsR = toNum(row[16]);
    const needsReview = !totalR.ok || !tipsR.ok;
    if (needsReview) errors.push({ row: i + 1, courier_id: cid, issue: 'Нечислова стойност в "Total earned" или "Tips"' });
    const gross = Math.round((totalR.value + tipsR.value) * 100) / 100;
    if (!byId.has(cid)) {
      byId.set(cid, {
        platform: 'glovo', courier_id: cid,
        name: row[5] || '', first_name: row[6] || '',
        email: (row[7] || '').toString().trim(), phone_raw: row[8], phone: normPhone(row[8]),
        order_count: 0, gross_earnings: 0, needs_review: false, row_count: 0,
      });
    }
    const rec = byId.get(cid);
    rec.order_count += Number(row[10] || 0);
    rec.gross_earnings = Math.round((rec.gross_earnings + gross) * 100) / 100;
    rec.needs_review = rec.needs_review || needsReview;
    rec.row_count += 1;
  }
  return {
    sheet: sheetName,
    week_start: period ? isoDate(period.start) : null,
    week_end: period ? isoDate(period.end) : null,
    records: Array.from(byId.values()),
    errors,
  };
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
