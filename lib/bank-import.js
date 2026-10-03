// ============================================================================
// lib/bank-import.js — импорт на банково извлечение (засега: Пощенска банка,
// CSV или Excel експорт) — preview → apply, по същия модел като Bolt/Glovo
// импорта на заработки (виж lib/earnings-import.js и /api/hr/payroll/import/*
// в server.js).
//
// Понеже НЯМАМЕ реален примерен файл от Пощенска банка към момента на
// писане, РАЗПОЗНАВАНЕТО НА КОЛОНИ Е АВТОМАТИЧНО по името на заглавния ред
// (на български и английски — виж HEADER_PATTERNS), а не твърдо закодирано
// за конкретен формат. Ако автоматичното разпознаване не намери нужните
// колони (или ги сбърка), администраторът може да подаде columnMap ръчно
// (виж parseBankStatementFile) — интерфейсът в cashier.html показва кои
// колони са разпознати, преди да се запише нищо (preview стъпка).
//
// Поддържа:
//   - .xlsx/.xls (през пакета "xlsx", вече наличен в package.json — вижте
//     коментара в lib/earnings-import.js за "лениво" зареждане/тестване)
//   - .csv текст (UTF-8, с автоматично откриване на разделител , ; или Tab)
// ============================================================================

function loadXlsx() {
  try {
    return require('xlsx');
  } catch (e) {
    return null;
  }
}

const HEADER_PATTERNS = {
  date: [/дата/i, /value date/i, /^date$/i, /транзакц/i],
  amount: [/^сума$/i, /^amount$/i, /стойност/i],
  debit: [/дебит/i, /^debit$/i, /разход/i],
  credit: [/кредит/i, /^credit$/i, /приход/i],
  description: [/описание/i, /основание/i, /description/i, /назначение/i, /детайли/i, /контрагент|наредител|получател/i],
  reference: [/референц/i, /reference/i, /документ/i, /№/, /номер на дв/i],
  balance: [/наличност/i, /баланс/i, /balance/i],
};

function detectColumnIndex(headers, kind) {
  const patterns = HEADER_PATTERNS[kind] || [];
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim();
    if (patterns.some((re) => re.test(h))) return i;
  }
  return -1;
}

function parseAmount(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  const hasComma = s.includes(','), hasDot = s.includes('.');
  // европейски формат (1.234,56) срещу американски (1,234.56) — приемаме, че
  // ПОСЛЕДНИЯТ разделител в низа е десетичната запетая/точка
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma && !hasDot) {
    s = s.replace(/\s/g, '').replace(',', '.');
  }
  s = s.replace(/[^\d.\-]/g, '');
  if (!s || s === '-') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === 'number') {
    // Excel серийна дата (дни от 1899-12-30) — xlsx с cellDates:true обикновено
    // вече го връща като Date, но пазим и този случай за по-стари експорти.
    const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd.mm.yyyy / dd/mm/yyyy (стандартният европейски формат, който ползват
  // българските банки) — m[1]=ден, m[2]=месец, m[3]=година
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}

function splitCsvLine(line, delimiter) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function detectDelimiter(line) {
  const counts = {
    ',': (line.match(/,/g) || []).length,
    ';': (line.match(/;/g) || []).length,
    '\t': (line.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function rowsFromCsvText(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);
  return lines.map((l) => splitCsvLine(l, delimiter));
}

function rowsFromBuffer(buffer) {
  // .xlsx/.xls (ZIP контейнер) файловете започват с "PK"
  if (buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const xlsx = loadXlsx();
    if (!xlsx) {
      const err = new Error('Файлът изглежда е Excel (.xlsx), но пакетът "xlsx" не е наличен в тази среда.');
      err.code = 'MODULE_NOT_AVAILABLE';
      throw err;
    }
    const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  }
  let text = buffer.toString('utf8').replace(/^﻿/, '');
  const suspicious = (text.match(/�/g) || []).length;
  if (suspicious > 3) {
    const err = new Error(
      'Файлът не изглежда да е в UTF-8 кодировка (възможно Windows-1251) — запазете извлечението като ' +
      '"CSV UTF-8" от банката, или го качете като Excel (.xlsx).'
    );
    err.code = 'ENCODING_UNSUPPORTED';
    throw err;
  }
  return rowsFromCsvText(text);
}

function detectColumns(headerRow) {
  return {
    date: detectColumnIndex(headerRow, 'date'),
    amount: detectColumnIndex(headerRow, 'amount'),
    debit: detectColumnIndex(headerRow, 'debit'),
    credit: detectColumnIndex(headerRow, 'credit'),
    description: detectColumnIndex(headerRow, 'description'),
    reference: detectColumnIndex(headerRow, 'reference'),
    balance: detectColumnIndex(headerRow, 'balance'),
  };
}

// columnMap (по избор): { date, amount, debit, credit, description, reference,
// balance } — индекси на колони (0-based), с които администраторът РЪЧНО
// презаписва автоматичното разпознаване, ако то не уцели конкретния файл.
function parseBankStatementFile(buffer, columnMap) {
  const allRows = rowsFromBuffer(buffer);
  if (!allRows.length) return { headers: [], rows: [], errors: ['Празен файл'], detected: {} };
  const headerRow = allRows[0].map((h) => String(h || '').trim());
  const auto = detectColumns(headerRow);
  const detected = { ...auto };
  if (columnMap) {
    Object.keys(columnMap).forEach((k) => {
      if (columnMap[k] !== '' && columnMap[k] != null) detected[k] = Number(columnMap[k]);
    });
  }

  const errors = [];
  if (detected.date == null || detected.date < 0) errors.push('Не можах да намеря колона с дата — посочете я ръчно.');
  const hasAmountCol = detected.amount != null && detected.amount >= 0;
  const hasDebitCredit = (detected.debit != null && detected.debit >= 0) || (detected.credit != null && detected.credit >= 0);
  if (!hasAmountCol && !hasDebitCredit) errors.push('Не можах да намеря колона със сума (или дебит/кредит) — посочете я ръчно.');

  const records = [];
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || !row.length || row.every((c) => c === '' || c == null)) continue;
    const dateRaw = detected.date != null && detected.date >= 0 ? row[detected.date] : null;
    const date = parseDate(dateRaw);
    let amount = null, direction = null;
    if (hasAmountCol) {
      const raw = parseAmount(row[detected.amount]);
      if (raw != null && raw !== 0) { amount = Math.abs(raw); direction = raw >= 0 ? 'income' : 'expense'; }
    } else {
      const debitVal = detected.debit != null && detected.debit >= 0 ? parseAmount(row[detected.debit]) : null;
      const creditVal = detected.credit != null && detected.credit >= 0 ? parseAmount(row[detected.credit]) : null;
      if (creditVal) { amount = Math.abs(creditVal); direction = 'income'; }
      else if (debitVal) { amount = Math.abs(debitVal); direction = 'expense'; }
    }
    const description = detected.description != null && detected.description >= 0 ? String(row[detected.description] || '').trim() : '';
    const reference = detected.reference != null && detected.reference >= 0 ? String(row[detected.reference] || '').trim() || null : null;
    const balanceAfter = detected.balance != null && detected.balance >= 0 ? parseAmount(row[detected.balance]) : null;

    if (!date || !amount || !direction) {
      records.push({
        row_index: i, raw: row, error: 'Редът не съдържа разпознаваема дата/сума/посока',
        date, amount, direction, description, external_ref: reference,
      });
      continue;
    }
    records.push({ row_index: i, date, amount, direction, description, external_ref: reference, balance_after: balanceAfter });
  }
  return { headers: headerRow, rows: records, errors, detected };
}

module.exports = { parseBankStatementFile, parseAmount, parseDate, detectColumns, isAvailable: () => !!loadXlsx() };
