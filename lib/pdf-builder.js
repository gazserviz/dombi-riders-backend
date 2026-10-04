// ============================================================================
// lib/pdf-builder.js — генерира истински .pdf документи (протокол, договор)
// директно на сървъра, чрез npm пакетите `pdf-lib` (PDF контейнер/страници)
// и `sharp` (растеризиране на текста).
//
// ЗАЩО РАСТЕРИЗИРАН ТЕКСТ, А НЕ ВЕКТОРЕН PDF ТЕКСТ:
// Стандартните 14 "base PDF" шрифта (Helvetica и т.н.), които pdf-lib може
// да ползва без допълнителни библиотеки, НЯМАТ кирилски глифи — кирилски
// текст излиза като изтрити/грешни символи. За да вградим истински, различен
// TTF шрифт с кирилица в pdf-lib е нужен пакетът `fontkit`, който не е
// наличен в тази среда (npm registry е блокиран за инсталация тук) — затова
// вместо да заложим на нещо непроверимо, всеки ред текст се рисува веднъж
// като малко PNG изображение (чрез вградения в проекта шрифт DejaVu Sans,
// който е Unicode/кирилица-съвместим) и се поставя в PDF-a като картинка.
// Резултатът изглежда като нормален текст, но не е "селектируем" в PDF
// четец — приемлив компромис за протокол/договор за печат и подпис.
// Основният, напълно верен и селектируем текстов формат си остава .docx
// (виж lib/doc-builder.js). PDF пътят тук е допълнителна опция и буфер
// за изпращане към доставчик за електронно разписване (виж lib/esign.js).
//
// Тествано в тази среда: генериран е реален .pdf, после рендериран обратно
// в изображение (pdftoppm) и визуално проверен — кирилицата се вижда коректно.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_REGULAR_PATH = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

let FONT_REGULAR_B64 = null;
let FONT_BOLD_B64 = null;
function ensureFonts() {
  if (FONT_REGULAR_B64 && FONT_BOLD_B64) return true;
  try {
    FONT_REGULAR_B64 = fs.readFileSync(FONT_REGULAR_PATH).toString('base64');
    FONT_BOLD_B64 = fs.readFileSync(FONT_BOLD_PATH).toString('base64');
    return true;
  } catch (e) {
    return false;
  }
}

const PAGE_W = 595.28; // A4 at 72dpi (points)
const PAGE_H = 841.89;
const MARGIN = 50;
const MUTED = '#737785';
const DARK = '#15181f';
const ACCENT = '#15803d';
const LINE = rgb(0.6, 0.6, 0.6);
const ACCENT_LINE = rgb(0x15 / 255, 0x80 / 255, 0x3d / 255);
const SCALE = 3; // растеризираме на 3x за остри ръбове при печат/зуум

const COMPANY = {
  name: 'ДОМБИ РАЙДЪРС ЕООД',
  city: 'гр. София, България',
  phone: '0887 25 27 27',
  manager: 'Димчо Петров',
};
const FUEL_TYPE_LABELS = { petrol: 'Бензин', diesel: 'Дизел', gas_petrol: 'Газ + Бензин', electric: 'Електрическа', hybrid: 'Хибрид' };

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Растеризира един ред текст в PNG (RGBA, прозрачен фон), с фиксирана височина
// спрямо размера на шрифта (за да остане базовата линия еднаква на всички
// редове от един и същ размер), и ширина, изрязана плътно до реалното мастило
// (чрез сканиране на алфа канала), за да можем коректно да центрираме/подравняваме.
async function rasterizeLine(text, { size = 10, bold = false, color = DARK } = {}) {
  if (!sharp || !ensureFonts()) return null;
  const str = String(text == null ? '' : text);
  if (!str.trim()) return null;

  const fam = bold ? 'DVBold' : 'DVReg';
  const fontB64 = bold ? FONT_BOLD_B64 : FONT_REGULAR_B64;
  const px = Math.round(size * SCALE);
  const canvasH = Math.round(px * 1.6);
  const baselineY = Math.round(px * 1.18);
  const canvasW = Math.max(40, Math.round(str.length * px * 0.85) + 40);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">` +
    `<defs><style>@font-face{font-family:'${fam}';src:url(data:font/ttf;base64,${fontB64}) format('truetype');}</style></defs>` +
    `<text x="0" y="${baselineY}" font-family="${fam}" font-size="${px}" fill="${color}">${escapeXml(str)}</text>` +
    `</svg>`;

  const rawRes = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = rawRes;
  const { width, height, channels } = info;
  let maxX = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * channels;
    for (let x = width - 1; x > maxX; x--) {
      if (data[rowStart + x * channels + 3] > 10) { maxX = x; break; }
    }
  }
  const measuredW = Math.min(width, maxX + 4);
  if (measuredW < 2) return null;

  const cropped = await sharp(Buffer.from(svg))
    .extract({ left: 0, top: 0, width: measuredW, height })
    .png()
    .toBuffer();

  return {
    buffer: cropped,
    widthPt: measuredW / SCALE,
    heightPt: height / SCALE,
    baselinePt: baselineY / SCALE,
  };
}

// Грубо приблизително измерване на ширина на текст (без реално рендериране) —
// използва се само за пренасяне на текст на нов ред (word-wrap) и за
// центриране на кратки надписи; не изисква точност до пиксел.
function estimateWidth(text, size, bold) {
  const avg = bold ? 0.62 : 0.56; // усреднен коефициент спрямо размера, за DejaVu Sans
  return String(text).length * size * avg;
}

function wrapText(text, size, maxWidth, bold = false) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  words.forEach(w => {
    const test = cur ? cur + ' ' + w : w;
    if (estimateWidth(test, size, bold) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

class PageCursor {
  constructor(doc) {
    this.doc = doc;
    this.page = doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
    this._imgCache = new Map();
  }

  async _embedLine(text, opts) {
    if (!sharp) return null;
    const key = JSON.stringify([text, opts.size, opts.bold, opts.color]);
    if (this._imgCache.has(key)) return this._imgCache.get(key);
    const raster = await rasterizeLine(text, opts);
    if (!raster) return null;
    const png = await this.doc.embedPng(raster.buffer);
    const result = { png, ...raster };
    this._imgCache.set(key, result);
    return result;
  }

  ensureSpace(h) {
    if (this.y - h < MARGIN) {
      this.page = this.doc.addPage([PAGE_W, PAGE_H]);
      this.y = PAGE_H - MARGIN;
    }
  }

  async _drawText(text, x, size, bold, color) {
    const line = await this._embedLine(text, { size, bold, color });
    if (!line) return 0;
    this.page.drawImage(line.png, {
      x, y: this.y - line.baselinePt, width: line.widthPt, height: line.heightPt,
    });
    return line.widthPt;
  }

  async title(text) {
    this.ensureSpace(30);
    await this._drawText(text, MARGIN, 19, true, DARK);
    this.y -= 26;
  }
  async subtitle(text) {
    this.ensureSpace(18);
    await this._drawText(text, MARGIN, 10, false, MUTED);
    this.y -= 16;
  }
  hr() {
    this.ensureSpace(14);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1.2, color: LINE });
    this.y -= 20;
  }
  async heading(text) {
    this.ensureSpace(24);
    await this._drawText(text, MARGIN, 12.5, true, ACCENT);
    this.y -= 18;
  }
  // Фирмено заглавие ("letterhead"): име/град/телефон вляво, номер+дата на
  // документа вдясно, центрирано заглавие на документа, и акцентна черта.
  async letterhead(docTitle, docSubtitle, rightLines) {
    this.ensureSpace(70);
    const topY = this.y;
    await this._drawText(COMPANY.name, MARGIN, 13, true, DARK);
    this.y -= 15;
    await this._drawText(COMPANY.city, MARGIN, 9, false, MUTED);
    this.y -= 12;
    await this._drawText(`тел. ${COMPANY.phone}`, MARGIN, 9, false, MUTED);

    let ry = topY;
    for (const line of (rightLines || [])) {
      const w = await this._drawTextRightAligned(line, PAGE_W - MARGIN, 9, false, MUTED, ry);
      ry -= 12;
    }

    this.y = Math.min(this.y, ry) - 18;
    await this._centeredText(docTitle.toUpperCase(), 17, true, DARK);
    this.y -= 20;
    if (docSubtitle) {
      await this._centeredText(docSubtitle, 10, false, MUTED);
      this.y -= 16;
    }
    this.ensureSpace(10);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 2, color: ACCENT_LINE });
    this.y -= 22;
  }
  async _drawTextRightAligned(text, rightX, size, bold, color, y) {
    const line = await this._embedLine(text, { size, bold, color });
    if (!line) return 0;
    this.page.drawImage(line.png, { x: rightX - line.widthPt, y: y - line.baselinePt, width: line.widthPt, height: line.heightPt });
    return line.widthPt;
  }
  async _centeredText(text, size, bold, color) {
    const line = await this._embedLine(text, { size, bold, color });
    if (!line) return;
    const x = MARGIN + ((PAGE_W - MARGIN * 2) - line.widthPt) / 2;
    this.page.drawImage(line.png, { x, y: this.y - line.baselinePt, width: line.widthPt, height: line.heightPt });
  }
  // Номерирана клауза "Чл. N. ЗАГЛАВИЕ" + текст (низ или масив от редове).
  async clause(number, title, body) {
    this.ensureSpace(24);
    await this._drawText(`Чл. ${number}. ${title}`, MARGIN, 10.5, true, DARK);
    this.y -= 15;
    const lines = Array.isArray(body) ? body : [body];
    for (const line of lines) {
      await this.paragraph(line);
    }
  }
  async kv(label, value) {
    this.ensureSpace(16);
    const v = value == null || value === '' ? '—' : String(value);
    await this._drawText(label, MARGIN, 9.5, false, MUTED);
    await this._drawText(v, MARGIN + 180, 10.5, true, DARK);
    this.y -= 16;
  }
  async paragraph(text) {
    const lines = wrapText(text, 10, PAGE_W - MARGIN * 2, false);
    for (const line of lines) {
      this.ensureSpace(15);
      await this._drawText(line, MARGIN, 10, false, DARK);
      this.y -= 14;
    }
    this.y -= 4;
  }
  async signatureRow(leftLabel, rightLabel, opts = {}) {
    this.ensureSpace(60);
    this.y -= 30;
    const colW = (PAGE_W - MARGIN * 2) / 2;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + colW - 30, y: this.y }, thickness: 0.8, color: LINE });
    this.page.drawLine({ start: { x: MARGIN + colW + 20, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.8, color: LINE });
    this.y -= 12;
    await this._drawText(leftLabel, MARGIN, 8.5, false, MUTED);
    await this._drawText(rightLabel, MARGIN + colW + 20, 8.5, false, MUTED);
    if (opts.leftStamp) {
      this.y -= 13;
      await this._drawText('М.П.', MARGIN, 8.5, false, MUTED);
    }
  }
  // Вгражда РЕАЛНО извършените присъствени подписвания (име, роля, дата +
  // самата картинка на подписа, ако е качена) — без това документът изглежда
  // неподписан дори след успешно разписване в системата (вж. бележката за
  // loadSignedEvents в lib/doc-render.js).
  async signedStamp(events) {
    if (!events || !events.length) return;
    this.ensureSpace(20);
    this.y -= 6;
    this.hr();
    await this._drawText('ЕЛЕКТРОННО ПОДПИСАНО (присъствено)', MARGIN, 9, true, ACCENT);
    this.y -= 16;
    for (const ev of events) {
      this.ensureSpace(60);
      if (ev.imageBuffer) {
        try {
          const img = ev.imageMime === 'image/jpeg' ? await this.doc.embedJpg(ev.imageBuffer) : await this.doc.embedPng(ev.imageBuffer);
          const maxW = 140, maxH = 50;
          const scale = Math.min(maxW / img.width, maxH / img.height, 1);
          const w = img.width * scale, h = img.height * scale;
          this.ensureSpace(h + 4);
          this.page.drawImage(img, { x: MARGIN, y: this.y - h, width: w, height: h });
          this.y -= h + 4;
        } catch (e) { /* неподдържан формат за вграждане — показваме само текста по-долу */ }
      }
      const when = ev.completed_at ? new Date(ev.completed_at).toLocaleString('bg-BG') : '';
      const label = `✓ ${ev.signer_name}${ev.signer_role ? ' · ' + ev.signer_role : ''}${when ? ' · ' + when : ''}`;
      await this._drawText(label, MARGIN, 9, false, DARK);
      this.y -= 16;
    }
  }
}

async function newDoc() {
  const doc = await PDFDocument.create();
  return { doc, cursor: new PageCursor(doc) };
}

const PDF_FONTS_AVAILABLE = () => !!sharp && ensureFonts();

// ---------------------------------------------------------------------------
// Готови документи (огледални на buildProtocolDocx / buildContractDocx от
// lib/doc-builder.js), но като .pdf буфер.
// ---------------------------------------------------------------------------

async function buildProtocolPdf({ protocol, vehicle, driverLabel, termsText, signedEvents }) {
  const { doc, cursor: c } = await newDoc();

  await c.letterhead(
    'Приемо-предавателен протокол',
    protocol.type === 'handover' ? 'Предаване на автомобил' : 'Приемане на автомобил',
    [`№ ${protocol.protocol_number}`, new Date(protocol.date).toLocaleString('bg-BG')]
  );

  await c.heading('1. Данни за автомобила');
  await c.kv('Рег. номер', vehicle ? vehicle.plate_number : protocol.vehicle_id);
  await c.kv('Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—');
  await c.kv('VIN / Рама', vehicle ? vehicle.vin : '—');
  await c.kv('Година', vehicle ? vehicle.year : '—');

  await c.heading('2. Състояние при предаването');
  await c.kv('Пробег', protocol.odometer_km != null ? `${protocol.odometer_km} км` : '—');
  await c.kv('Вид гориво', FUEL_TYPE_LABELS[protocol.fuel_type] || '—');
  await c.kv(protocol.fuel_type === 'gas_petrol' ? 'Ниво на бензин' : 'Ниво на гориво', protocol.fuel_level_pct != null ? `${protocol.fuel_level_pct}%` : '—');
  if (protocol.fuel_type === 'gas_petrol') {
    await c.kv('Ниво на газ (доп.)', protocol.fuel_level_secondary_pct != null ? `${protocol.fuel_level_secondary_pct}%` : '—');
  }
  await c.kv('Шофьор / наемател', driverLabel || '—');

  await c.heading('3. Външен и вътрешен оглед');
  await c.kv('Външно състояние', protocol.exterior_notes || 'Без забележки');
  await c.kv('Вътрешно състояние', protocol.interior_notes || 'Без забележки');
  await c.kv('Приложени снимки', `${(protocol.photos || []).length} бр.`);

  await c.heading('4. Общи условия');
  await c.paragraph(termsText ||
    'Приемащата страна декларира, че е прегледала автомобила и е съгласна с описаното по-горе състояние. ' +
    'При установяване на нови повреди при връщането, различни от описаните в настоящия протокол, отговорност носи страната, ползвала автомобила през съответния период.'
  );

  await c.signatureRow('Предал (подпис)', 'Приел (подпис)');
  await c.signedStamp(signedEvents);

  return doc.save();
}

async function buildContractPdf({ contract, vehicle, renterName, termsText, signedEvents }) {
  const RATE_PERIOD_LABELS = { day: 'ден', week: 'седмица', month: 'месец' };
  const STATUS_LABELS = { draft: 'Чернова', active: 'Активен', completed: 'Приключен', terminated: 'Прекратен' };
  const RENTER_TYPE_LABELS = { dombi_courier: 'Куриер на Dombi Riders', other_platform: 'Друга платформа', personal_use: 'Лично ползване' };
  const { doc, cursor: c } = await newDoc();

  await c.letterhead(
    'Договор за наем на моторно превозно средство',
    `Статус: ${STATUS_LABELS[contract.status] || contract.status}`,
    [`№ ${contract.contract_number}`, `Дата: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
  );

  await c.paragraph(
    `Днес, ${new Date(contract.created_at).toLocaleDateString('bg-BG')}, в ${COMPANY.city}, между ${COMPANY.name}, ` +
    `представлявано от управителя ${COMPANY.manager}, наричано по-долу „НАЕМОДАТЕЛ“, и ${renterName}` +
    `${contract.renter_egn ? ', ЕГН ' + contract.renter_egn : ''}, наричан/а по-долу „НАЕМАТЕЛ“, се сключи настоящият договор за наем на моторно превозно средство при следните условия:`
  );

  await c.clause(1, 'ПРЕДМЕТ НА ДОГОВОРА',
    `Наемодателят предоставя на Наемателя, а Наемателят приема да ползва срещу възнаграждение лек автомобил ` +
    `${vehicle ? `марка/модел ${vehicle.make} ${vehicle.model}, рег. № ${vehicle.plate_number}${vehicle.vin ? ', VIN ' + vehicle.vin : ''}` : `с рег. № ${contract.vehicle_id}`}, ` +
    `предаден в изправно техническо и визуално състояние съгласно подписан приемо-предавателен протокол.`
  );
  await c.clause(2, 'СРОК НА ДОГОВОРА',
    `Договорът влиза в сила от ${contract.start_date}${contract.start_time ? `, ${contract.start_time} ч.` : ''} и е ` +
    `${contract.end_date ? `със срок до ${contract.end_date}${contract.end_time ? `, ${contract.end_time} ч.` : ''}` : 'безсрочен, до прекратяването му по реда на настоящия договор'}.`
  );
  await c.clause(3, 'НАЕМНА ЦЕНА И НАЧИН НА ПЛАЩАНЕ', [
    `Наемната цена е в размер на ${contract.rate_amount} € на ${RATE_PERIOD_LABELS[contract.rate_period] || contract.rate_period}, платима авансово.`,
    `Целта на ползване на автомобила е декларирана като: ${RENTER_TYPE_LABELS[contract.renter_type] || contract.renter_type}.`,
  ]);
  await c.clause(4, 'ДЕПОЗИТ',
    `Наемателят внася депозит в размер на ${contract.deposit_amount || 0} € като обезпечение по настоящия договор. ` +
    `Депозитът се възстановява при прекратяване на договора, след приспадане на евентуални дължими суми за щети, глоби или неплатен наем.`
  );
  await c.clause(5, 'ЗАДЪЛЖЕНИЯ НА НАЕМАТЕЛЯ', [
    'Да ползва автомобила грижливо, по предназначение и съгласно правилата за движение по пътищата.',
    'Да не преотстъпва автомобила на трети лица без писменото съгласие на Наемодателя.',
    'Да заплаща своевременно дължимите наемни вноски за периода на ползване.',
    'Да заплати на Наемодателя всички глоби, фишове и имуществени санкции за нарушения на Закона за движението по пътищата, ' +
      'настъпили през периода на наема, ведно с административна такса за обработка в размер на 20 лв. за всеки отделен случай, ' +
      'независимо дали нарушението е установено по време на наема или след връщането на автомобила.',
    'Да уведомява незабавно Наемодателя при ПТП, повреда или кражба на автомобила.',
  ]);
  await c.clause(6, 'ИЗПОЛЗВАНЕ НА АВТОМОБИЛА ЗА ПРЕВОЗ НА ПЪТНИЦИ', [
    'Наемателят може да използва автомобила за дейност по превоз на пътници и/или товари срещу възнаграждение единствено ' +
      'чрез лицензирани превозвачи и платформи, опериращи в съответствие със Закона за автомобилните превози.',
    'Забранено е използването на автомобила за нелицензирана таксиметрова дейност, включително чрез платформи и приложения, ' +
      'които към момента на ползването не разполагат с необходимия лиценз за таксиметров превоз на пътници по българското ' +
      'законодателство (напр. „Maxim“ и други сходни приложения, функциониращи без такъв лиценз).',
    'При установено нарушение на тази клауза Наемодателят има право незабавно да прекрати договора и да търси обезщетение ' +
      'за всички произтекли от това вреди, глоби и санкции.',
  ]);
  await c.clause(7, 'ЗАДЪЛЖЕНИЯ НА НАЕМОДАТЕЛЯ', [
    'Да предаде автомобила в изправно техническо състояние, с валидни документи и застраховки.',
    'Да осигурява своевременно техническо обслужване на автомобила извън случаите на повреда по вина на Наемателя.',
  ]);
  await c.clause(8, 'ОТГОВОРНОСТ ПРИ ЩЕТИ', [
    'Наемателят носи имуществена отговорност за щети по автомобила, настъпили през периода на ползване по негова вина, ' +
      'както и за всички глоби и санкции, наложени във връзка с управлението на автомобила през този период.',
    'Наемателят носи пълна имуществена отговорност за вреди, причинени умишлено, при груба небрежност, при управление след ' +
      'употреба на алкохол или наркотични вещества, или при извършване на престъпление с автомобила — независимо от размера ' +
      'на внесения депозит и независимо от наличие на застраховка „Каско“.',
    'Нормалното износване на автомобила вследствие на обичайната му употреба не се счита за щета по смисъла на този член.',
  ]);
  await c.clause(9, 'ПРЕКРАТЯВАНЕ',
    'Договорът може да бъде прекратен по взаимно съгласие, с едностранно писмено предизвестие от всяка от страните, ' +
    'или незабавно при съществено неизпълнение на задълженията по настоящия договор.'
  );

  await c.heading('10. Данни за автомобила и наемателя');
  await c.kv('Рег. номер', vehicle ? vehicle.plate_number : contract.vehicle_id);
  await c.kv('Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—');
  await c.kv('VIN / Рама', vehicle ? vehicle.vin : '—');
  await c.kv('Наемател', renterName);
  if (contract.renter_egn) await c.kv('ЕГН', contract.renter_egn);
  if (contract.renter_phone) await c.kv('Телефон', contract.renter_phone);
  if (contract.renter_license_number) await c.kv('№ на книжка', contract.renter_license_number);
  if (contract.start_odometer_km) await c.kv('Пробег при предаване', `${contract.start_odometer_km} км`);
  if (contract.end_odometer_km) await c.kv('Пробег при връщане', `${contract.end_odometer_km} км`);

  if (termsText) {
    await c.heading('11. Допълнителни условия');
    await c.paragraph(termsText);
  }

  await c.signatureRow('Наемодател (подпис)', 'Наемател (подпис)', { leftStamp: true });
  await c.signedStamp(signedEvents);

  return doc.save();
}

const EC_TYPE_LABELS = { labor: 'Трудов договор', civil: 'Граждански договор' };
const EC_STATUS_LABELS = { draft: 'Чернова', active: 'Активен', terminated: 'Прекратен' };

// огледално на buildEmploymentContractDocx — виж бележката за КЕП там
async function buildEmploymentContractPdf({ contract, profile, termsText, signedEvents }) {
  const isLabor = contract.contract_type === 'labor';
  const employeeName = profile ? profile.full_name : contract.profile_id;
  const { doc, cursor: c } = await newDoc();

  await c.letterhead(
    EC_TYPE_LABELS[contract.contract_type] || contract.contract_type,
    `Статус: ${EC_STATUS_LABELS[contract.status] || contract.status}`,
    [`№ ${contract.contract_number}`, `Дата: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
  );

  if (isLabor) {
    await c.paragraph('ВНИМАНИЕ: Чернова за преглед. Действителен трудов договор изисква квалифициран електронен подпис (КЕП) от работодателя по чл. 62 КТ — не е правен съвет, консултирайте се с адвокат/счетоводител.');
  }

  await c.paragraph(
    `Днес, ${new Date(contract.created_at).toLocaleDateString('bg-BG')}, в ${COMPANY.city}, между ${COMPANY.name}, ` +
    `представлявано от управителя ${COMPANY.manager}, наричано по-долу „${isLabor ? 'РАБОТОДАТЕЛ' : 'ВЪЗЛОЖИТЕЛ'}“, и ${employeeName}` +
    `${profile && profile.egn ? ', ЕГН ' + profile.egn : ''}, наричан/а по-долу „${isLabor ? 'РАБОТНИК/СЛУЖИТЕЛ' : 'ИЗПЪЛНИТЕЛ'}“, ` +
    `се сключи настоящият ${isLabor ? 'трудов договор на основание чл. 67 във вр. с чл. 70 от Кодекса на труда' : 'граждански договор на основание чл. 258 и сл. от Закона за задълженията и договорите'} при следните условия:`
  );

  if (isLabor) {
    await c.clause(1, 'ПРЕДМЕТ И ДЛЪЖНОСТ', 'Работодателят възлага, а Работникът/Служителят приема да изпълнява длъжността „Куриер“ в дейността на дружеството.');
    await c.clause(2, 'МЯСТО НА РАБОТА', `Работата се изпълнява на територията на ${COMPANY.city} и прилежащите райони на обслужване.`);
    await c.clause(3, 'РАБОТНО ВРЕМЕ', `Установява се непълно/пълно работно време от ${contract.hours_per_day || '—'} часа на ден, при 5-дневна работна седмица, съгласно утвърден график.`);
    await c.clause(4, 'ТРУДОВО ВЪЗНАГРАЖДЕНИЕ', `Седмичното възнаграждение/удръжка е в размер на ${contract.weekly_deduction_amount || 0} €, изплащано съгласно вътрешните правила на дружеството.`);
    await c.clause(5, 'СРОК НА ДОГОВОРА', `Договорът е сключен считано от ${contract.start_date} и е ${contract.end_date ? `срочен — до ${contract.end_date}` : 'безсрочен'}.`);
    await c.clause(6, 'ПРАВА И ЗАДЪЛЖЕНИЯ НА СТРАНИТЕ', [
      'Работникът/Служителят се задължава да изпълнява възложената работа добросъвестно, да спазва трудовата дисциплина и правилата за безопасност на движението.',
      'Работодателят се задължава да осигури условия за изпълнение на работата и да заплаща уговореното възнаграждение в срок.',
    ]);
    await c.clause(7, 'ПРЕКРАТЯВАНЕ', 'Договорът се прекратява при условията и по реда на Кодекса на труда.');
  } else {
    await c.clause(1, 'ПРЕДМЕТ НА ДОГОВОРА', 'Възложителят възлага, а Изпълнителят приема да извършва куриерски услуги за нуждите на Възложителя, съгласно неговите указания.');
    await c.clause(2, 'ВЪЗНАГРАЖДЕНИЕ', `Възнаграждението по настоящия договор е в размер на ${contract.weekly_deduction_amount || 0} € седмично, определено съобразно изпълнените поръчки.`);
    await c.clause(3, 'СРОК НА ДОГОВОРА', `Договорът е в сила от ${contract.start_date} и е ${contract.end_date ? `до ${contract.end_date}` : 'безсрочен'}.`);
    await c.clause(4, 'ПРАВА И ЗАДЪЛЖЕНИЯ НА СТРАНИТЕ', [
      'Изпълнителят извършва възложената работа лично, като организира сам работното си време, без да е обвързан с трудова дисциплина.',
      'Възложителят заплаща уговореното възнаграждение съобразно реално извършената работа.',
    ]);
    await c.clause(5, 'ОТГОВОРНОСТ', 'Изпълнителят носи отговорност за качественото и срочно изпълнение на възложената работа съгласно общите правила на гражданското право.');
    await c.clause(6, 'ПРЕКРАТЯВАНЕ', 'Договорът се прекратява с изтичане на срока, по взаимно съгласие или с писмено предизвестие от всяка от страните.');
  }

  await c.heading(`${isLabor ? '8' : '7'}. Данни за страните`);
  await c.kv('Име', employeeName);
  if (profile && profile.egn) await c.kv('ЕГН', profile.egn);
  if (profile && profile.address) await c.kv('Адрес', profile.address);
  if (profile && profile.phone) await c.kv('Телефон', profile.phone);
  if (profile && profile.email) await c.kv('Имейл', profile.email);

  if (termsText) {
    await c.heading(isLabor ? 'Допълнителни клаузи' : 'Допълнителни условия');
    await c.paragraph(termsText);
  }

  await c.signatureRow(isLabor ? 'Работодател (подпис)' : 'Възложител (подпис)', isLabor ? 'Работник (подпис)' : 'Изпълнител (подпис)');
  await c.signedStamp(signedEvents);

  return doc.save();
}

// ---------------------------------------------------------------------------
// ГРАЖДАНСКИ ДОГОВОР „ЗА РЕКЛАМА И ПРЕНОС НА СТОКА“ — реалният, използван на
// практика шаблон (изрично искане на потребителя за пълно внедряване, вкл.
// 4-те приложения, молбата и декларацията за осигуряване, по подаден от него
// реален подписан пример). Различен правно-търговски модел от краткия
// "граждански договор" по-горе: Изпълнителят носи реклама на автомобила си и
// получава възнаграждение на изминат километър/извършена доставка (а НЕ
// седмична удръжка) — затова ползва СЪВСЕМ отделни полета на договора
// (rate_per_km, rate_per_delivery, cap_km, cap_deliveries, equipment,
// own_vehicle, term_years, notice_period_months), без изобщо да пипа
// weekly_deduction_amount/deduction_type (те остават недокоснати за
// payroll-логиката другаде в системата — виж getDefaultPayrollDeductions).
// Данните за Приложение 1 (ГДПР) идват от профила (id_card_issue_date,
// id_card_issued_by — нови полета, вж. personnel-detail.html), а
// "Декларация за осигуряване" взима ТЕКУЩИЯ осигурителен статус от профила
// (insurance_status/insurance_gross_amount) към момента на генериране на
// файла — системата НЕ пази история по месеци (отделна, по-голяма задача,
// ако потрябва занапред).
// ---------------------------------------------------------------------------
const AD_COMPANY = {
  name: 'ДОМБИ РАЙДЪРС ЕООД',
  eik: '208513455',
  vat: 'BG208513455',
  address: 'гр. София (1233), р-н Сердика, жк. БАНИШОРА, бл. 27, вх. А, ет. 4, ап. 7',
  manager: 'Виктор Валериев Мишев',
};
const AD_DEFAULTS = {
  rate_per_km: 0.01,
  rate_per_delivery: 0.40,
  cap_km: 10000,
  cap_deliveries: 1000,
  term_years: 1,
  notice_period_months: 2,
  deposit_amount: 50,
};
const AD_DEFAULT_EQUIPMENT = [{ name: 'Раница', value: 50 }, { name: 'Рекламна табела', value: 1 }];
const VEHICLE_KIND_LABELS = { automobile: 'автомобил', bicycle: 'велосипед', scooter: 'скутер', motorcycle: 'мотор' };

function adNum(contract, key) {
  const v = contract[key];
  return v == null || v === '' ? AD_DEFAULTS[key] : v;
}

async function buildCivilAdContractPdf({ contract, profile, signedEvents, termsText }) {
  const equipment = Array.isArray(contract.equipment) && contract.equipment.length ? contract.equipment : AD_DEFAULT_EQUIPMENT;
  const ov = contract.own_vehicle || {};
  const employeeName = profile ? profile.full_name : contract.profile_id;
  const startDateFmt = contract.start_date ? new Date(contract.start_date).toLocaleDateString('bg-BG') : '—';
  const todayFmt = new Date().toLocaleDateString('bg-BG');
  const rateKm = adNum(contract, 'rate_per_km');
  const rateDelivery = adNum(contract, 'rate_per_delivery');
  const capKm = adNum(contract, 'cap_km');
  const capDeliveries = adNum(contract, 'cap_deliveries');
  const termYears = adNum(contract, 'term_years');
  const noticeMonths = adNum(contract, 'notice_period_months');
  const depositAmount = adNum(contract, 'deposit_amount');

  const { doc, cursor: c } = await newDoc();

  // --- Главен договор --------------------------------------------------
  await c.letterhead('Договор за реклама и пренос на стока', `Статус: ${EC_STATUS_LABELS[contract.status] || contract.status}`, [`№ ${contract.contract_number}`, `Дата: ${startDateFmt}`]);

  await c.paragraph(
    `Днес, ${startDateFmt}, в гр. София се сключи настоящият граждански договор между ${AD_COMPANY.name}, с ЕИК ${AD_COMPANY.eik}, ` +
    `със седалище и адрес на управление в ${AD_COMPANY.address}, представлявано от ${AD_COMPANY.manager}, наричано по-нататък в договора Възложител, и ${employeeName}` +
    `${profile && profile.egn ? ', ЕГН ' + profile.egn : ''}, наричан по-нататък в договора Изпълнител, за следното:`
  );
  await c.paragraph('Настоящият договор отменя всички предишни договори, сключени между дружеството и лицето ' + employeeName + '.');
  await c.paragraph(
    'Настоящият договор се сключва въз основа на предварително предоставени лични данни от Изпълнителя, чрез подписана Декларация ' +
    'за съгласие за обработка на лични данни (Приложение 1). Същата съдържа следните данни: три имена, ЕГН, адрес, данни от лична карта, ' +
    'телефон и имейл, и представлява неразделна част от този договор.'
  );
  await c.paragraph('Дефиниция: В настоящия договор всички платформи, с които Възложителят си партнира, се посочват под общото наименование „Платформата“.');

  await c.heading('I. ПРЕДМЕТ НА ДОГОВОРА');
  await c.paragraph(
    `1. С настоящия договор Възложителят възлага, а Изпълнителят се задължава да носи рекламно облекло и рекламна табела на автомобила, ` +
    `поставена на видно място, да извърши доставки на стоки до достигането на ${capKm} (${capKm.toLocaleString('bg-BG')}) км или ${capDeliveries} (${capDeliveries.toLocaleString('bg-BG')}) доставки ` +
    `(за всяка платформа отделно), което настъпи първо, използвайки пътя, маршрута, процедурата и транспортното средство, които счита за ` +
    `най-подходящи за възможно най-доброто изпълнение на поставената задача чрез приложението Платформата, инсталирано на личното си смарт устройство.`
  );
  await c.paragraph('2. Изпълнителят следва да използва за целите на настоящия договор моторно превозно средство или велосипед, подробно описани в Приложение 1 - Декларация за съгласие за обработка на лични данни.');

  await c.heading('II. ПРАВА И ЗАДЪЛЖЕНИЯ НА ИЗПЪЛНИТЕЛЯ');
  const IZP = [
    'Изпълнителят следва да извършва поетите по договора задължения добросъвестно и с висок професионализъм, като се задължава да спазва Приложение II – „Декларация за конфиденциалност и отговорност“ и Приложение III - „Изисквания за ползване на платформата Платформата“, представляващи неразделна част от договора.',
    'Табелата за автомобил да бъде поставена на видно място от вътрешната страна на прозорец по усмотрение на Изпълнителя, след одобрение от Възложителя.',
    'Изпълнителят подписва Приложение IV, неразделна част от договора, което представлява приемо-предавателен протокол, според който изпълнителят е материално отговорно лице за получените вещи и финансово отговорно - за получените оборотни пари, които събира, оперирайки чрез приложението Платформата.',
    'Да дава писмен ежеседмичен отчет за изминатите километри по образец на Възложителя, начален и краен километраж, както и да предава пътен лист за изминалата седмица.',
    'Да пази и да не сваля рекламната табела, с изключение на случаите, в които се сменя превозното средство, за което е длъжен да уведоми Възложителя.',
    'Да носи рекламно облекло винаги, когато извършва доставки към Платформата.',
    'Изпълнителят има право да поиска подмяна на рекламните материали, когато те вече не са в приличен вид.',
    'Изпълнителят има право да получи договореното възнаграждение.',
    'При изпълнение на възложеното, Изпълнителят трябва да се съобразява с допълнителните разпореждания на Възложителя, стига те да не го обременяват с нови задължения, излизащи извън рамките на възложеното.',
    'Изпълнителят се задължава да пази в строга тайна всичко по настоящия договор от трети лица и в случай на нарушаването ѝ, носи отговорност за вредите, причинени на Възложителя.',
    `В случай, че Изпълнителят не изпълни минимум 1/3 от заложените в договора ${capDeliveries} поръчки (${Math.round(capDeliveries / 3)} поръчки) в срок от 90 дни от датата на подписване на настоящия договор, същият дължи неустойка към Възложителя за направените от него разходи по обучение, амортизиране на зачисленото му оборудване и пропуснати ползи в размер на ${depositAmount} евро.`,
  ];
  IZP.forEach((t, i) => c._pending = c._pending); // no-op, keeps lint quiet about unused var patterns elsewhere
  for (let i = 0; i < IZP.length; i++) await c.paragraph(`${i + 1}. ${IZP[i]}`);

  await c.heading('III. ПРАВА И ЗАДЪЛЖЕНИЯ НА ВЪЗЛОЖИТЕЛЯ');
  const VZL = [
    'Възложителят е длъжен да заплати договореното възнаграждение в договорените срокове.',
    'Възложителят има право да заплаща стойността на изразходеното от Изпълнителя гориво срещу предоставени фактури и отчетени изминати километри по пътен лист.',
    'Възложителят има правото да заплаща текущи ремонти и поддръжка на МПС-то, които признава за амортизация на Изпълнителя и/или възникнали по време на изпълнението на настоящия договор, закупувайки нужните части и консумативи, както и заплащане на необходимия труд.',
    'Възложителят има правото да подменя и/или променя рекламните материали.',
    'Възложителят е длъжен да осигури на Изпълнителя условия за изпълнение на указанията и др., свързани с изпълнение на предмета на този договор.',
    'Възложителят е длъжен да заплаща всички дължими данъци и др. разходи съгласно българското законодателство и свързаните с договореностите с Платформата.',
    'Всички поръчки, които са били предназначени за Изпълнителя, след направена от него заявка за техния разнос и не са доставени поради негово неявяване, ще формират удръжка от възнаграждението му в размер на 3 евро всяка (като се взема средно по 2 бр. доставки на час).',
    `Възложителят има правото да задържи депозит от заработеното от Изпълнителя в размер на ${depositAmount} евро, който служи за гаранция на неговото коректно изпълнение на поетите ангажименти. Възложителят възстановява депозита на Изпълнителя при неговото изрично волеизявление, касаещо прекъсване на договорените отношения и след уреждане на всички негови задължения поети към Възложителя, включително връщане рекламно облекло и оборудване в изряден вид, и други.`,
  ];
  for (let i = 0; i < VZL.length; i++) await c.paragraph(`${i + 1}. ${VZL[i]}`);

  await c.heading('IV. ВЪЗНАГРАЖДЕНИЕ И НАЧИН НА ПЛАЩАНЕ');
  const PAY = [
    `За изпълнение предмета на този договор, Възложителят заплаща възнаграждение на Изпълнителя след успешно изминати ${capKm} км (${capKm.toLocaleString('bg-BG')} километра) или успешно изпълнени ${capDeliveries} (${capDeliveries.toLocaleString('bg-BG')}) доставки, което достигне първо, представяйки рекламираните брандове съответно чрез табела, поставена в автомобила и рекламно облекло и след предаден от страна на Изпълнителя и приет от страна на Възложителя приемо-предавателен протокол за извършената работа, както и попълнена от Изпълнителя декларация (по образец, изпратен от Възложителя) с информация за осигурителния си доход.`,
    `Възложителят заплаща на Изпълнителя възнаграждение в размер на ${rateKm} евро бруто за всеки изминат километър и/или ${rateDelivery} евро бруто за всяка успешно осъществена доставка. Изпълнителят прави и предава на Възложителя писмен отчет за успешно осъществени поръчки в платформата Платформата.`,
    'При изпълнение на условията в т.1 Възложителят осчетоводява положения от Изпълнителя труд на всяко тримесечие.',
    'Плащането се осъществява в срок от 3 дни от приемането от страна на Възложителя на приемо-предавателния протокол за извършена работа и попълнена от Изпълнителя декларация (по образец, изпратен от Възложителя) с информация за осигурителния си доход.',
    'Възнаграждението се заплаща в брой.',
  ];
  for (let i = 0; i < PAY.length; i++) await c.paragraph(`${i + 1}. ${PAY[i]}`);

  await c.heading('V. ЛИЧНИ ДАННИ');
  await c.paragraph(
    '1. С подписването на този договор Изпълнителят предоставя изричното си съгласие на Възложителя за събирането, организирането, ' +
    'обработването и предоставянето на трети лица, в това число едноличния собственик, счетоводни предприятия, и други контрагенти на ' +
    'Възложителя, със седалище в и извън държавите-членки на Европейския съюз, на личните данни на Изпълнителя, съгласно Закона за защита ' +
    'на личните данни, с цел надлежно изпълнение на задълженията на Страните по договора, управление на човешки ресурси, счетоводна ' +
    'отчетност или ако това се изисква от приложимото законодателство.'
  );

  await c.heading('VI. ВЛИЗАНЕ В СИЛА НА ДОГОВОРА. ПРЕКРАТЯВАНЕ');
  const TERM = [
    `Настоящият договор влиза в сила от датата на сключването му за срок от ${termYears} ${termYears === 1 ? 'година' : 'години'}.`,
    `Настоящият договор се преподновява автоматично след изпълнението му или след изтичането на срока, в случай, че някоя от страните не е заявила изрично писмено желание за прекратяване на договора най-малко една седмица преди изтичането му.`,
    `Настоящият договор се прекратява по взаимно съгласие на страните или с ${noticeMonths === 1 ? 'едномесечно' : noticeMonths + '-месечно'} писмено предизвестие, отправено от едната до другата страна, като Изпълнителят се задължава в срок от 3 последователни дни след прекратяването му да върне на Възложителя предоставеното му оборудването или неговата стойност в евро, подробно описани в Приложение IV - „Приемо-предавателен протокол за полученото оборудване“ за своя сметка, както и натрупания в резултат от извършвани бързи доставки оборот. При забава на връщането на оборудването или неговата парична равностойност, както и натрупания оборот, с повече от три последователни дни, Изпълнителят поема всички евентуални неблагоприятни последици от гражданско и наказателно-правен характер.`,
    'Възложителят има право да прекрати едностранно настоящия договор без предизвестие в случай на нарушаване от страна на Изпълнителя настоящия договор, ведно със съпътстващите го приложения, нарушаване от негова страна на морално-етични норми на поведение, като и приспадне от дължимото към него възнаграждение стойността на причинените от него вреди и щети.',
    'Възложителят има право да прекрати настоящия договор при прекъсване на дейността на Изпълнителя за период от над 10 (десет) календарни дни, без да уведоми Изпълнителя за такова прекъсване.',
  ];
  for (let i = 0; i < TERM.length; i++) await c.paragraph(`${i + 1}. ${TERM[i]}`);

  await c.heading('VII. ОБЩИ РАЗПОРЕДБИ');
  const GEN = [
    'За всичко неупоменато в този договор се прилагат разпоредбите на гражданското законодателство.',
    'Страните по договора ще пазят в тайна информацията, която ще постъпва при тях във връзка с изпълнението на този договор и няма да я правят достояние на трети лица за цялото време на същия и след неговото прекратяване.',
    'Никаква част от настоящия договор, както и от прилежащите му документи, подписани между Възложителя и Изпълнителя, не могат да бъдат използвани от Изпълнителя за каквито и да било други цели, нито да стават достояние на трети страни, без изричното съгласие от страна на Възложителя. При нарушение на горното Възложителят има право да изиска и получи възстановяване от Изпълнителят на всички суми, получени от Възложителя под формата на разходи за дейността, аванси, плащания и други, считано от датата на подписване на настоящия договор.',
    'Промени в договора се правят с анекси, подписани от страните по него и представляващи негова неразделна част.',
    'Възникналите спорове при изпълнение на договора ще се решават от страните доброволно, а в случай на несъгласие, споровете ще се отнасят за разрешаване от съда.',
    'Приложения – неразделни части от Договора:',
  ];
  for (let i = 0; i < GEN.length; i++) await c.paragraph(`${i + 1}. ${GEN[i]}`);
  await c.paragraph('6.1. Приложение 1 - Декларация за съгласие за обработка на лични данни;');
  await c.paragraph('6.2. Приложение 2 – Декларация за конфиденциалност и отговорност;');
  await c.paragraph('6.3. Приложение 3 – Изисквания на Платформата;');
  await c.paragraph('6.4. Приложение 4 – Приемо-предавателен протокол за полученото оборудване');
  await c.paragraph('Настоящият договор се състави и подписа в два еднообразни екземпляра – по един за всяка от страните.');

  if (termsText) {
    await c.heading('Допълнителни условия');
    await c.paragraph(termsText);
  }

  await c.signatureRow('Изпълнител (подпис)', 'Възложител (подпис)');

  // --- Приложение 1: ГДПР декларация -----------------------------------
  await c.heading('ПРИЛОЖЕНИЕ 1 — ДЕКЛАРАЦИЯ ЗА СЪГЛАСИЕ ЗА ОБРАБОТКА НА ЛИЧНИ ДАННИ');
  await c.paragraph('на основание чл. 6, ал. 1, б. „а“ и „б“ от Регламент (ЕС) 2016/679 (GDPR)');
  await c.paragraph('1. Долуподписаният:');
  await c.kv('Три имена', employeeName);
  await c.kv('ЕГН', profile && profile.egn);
  await c.kv('Адрес', profile && profile.address);
  await c.kv('Телефон', profile && profile.phone);
  await c.kv('Имейл', profile && profile.email);
  await c.kv('№ на лична карта', profile && profile.id_card_number);
  await c.kv('Дата на издаване', profile && profile.id_card_issue_date ? new Date(profile.id_card_issue_date).toLocaleDateString('bg-BG') : null);
  await c.kv('Издадена от (МВР – град)', profile && profile.id_card_issued_by);
  await c.paragraph('2. Данни за превозно средство:');
  await c.kv('Вид', VEHICLE_KIND_LABELS[ov.type] || ov.type || 'Автомобил');
  await c.kv('Електрическо ли е', ov.electric ? 'Да' : 'Не');
  await c.paragraph('3. Характеристики на превозното средство (ако е велосипед, не е приложимо):');
  await c.kv('Марка', ov.make);
  await c.kv('Модел', ov.model);
  await c.kv('Регистрационен номер', ov.plate);
  await c.kv('Дата на първа регистрация', ov.reg_year);
  await c.kv('Вид гориво', ov.fuel);
  await c.kv('Разход на 100 км', ov.consumption);
  await c.paragraph('Изпълнителят е длъжен за уведоми ДОМБИ РАЙДЪРС ЕООД при смяна на договореното МПС.');
  await c.paragraph(
    'С подписването на настоящата декларация давам доброволно съгласието си личните ми данни, изброени по-горе, както и всички други ' +
    'предоставени от мен данни, да бъдат събирани, обработвани, използвани, съхранявани и предавани от ДОМБИ РАЙДЪРС ЕООД за целите на ' +
    'изготвяне, сключване, администриране и изпълнение на договор(и) за предоставяне на услуги, водене на счетоводна и трудово-правна ' +
    'отчетност, комуникация, вкл. чрез електронни канали, и защита на законните интереси на фирмата при евентуални спорове. Запознат/а ' +
    'съм с правата си по GDPR, вкл. право на достъп, корекция, ограничаване на обработването, оттегляне на съгласието и право да подам ' +
    'жалба пред КЗЛД. Съгласявам се личните ми данни да се съхраняват за срок до 5 години от прекратяване на договорните отношения или ' +
    'по-дълъг срок, предвиден от закона.'
  );
  await c.paragraph(`Дата: ${startDateFmt}    Име: ${employeeName}`);

  // --- Приложение 2: Конфиденциалност -----------------------------------
  await c.heading('ПРИЛОЖЕНИЕ II — ДЕКЛАРАЦИЯ ЗА КОНФИДЕНЦИАЛНОСТ И ОТГОВОРНОСТ');
  await c.paragraph('към договор за реклама и пренос на стока');
  await c.paragraph(`Долуподписаният ${employeeName}, информиран съм, че от момента на получаването на този документ, нося отговорност за да опазя неговото съдържание в пълна конфиденциалност, да не запознавам с него трети лица и потвърждавам, че:`);
  const CONF = [
    'Безсрочно се ангажирам да не разпространявам каквато и да било информация, касаеща реда и условията по договора ми с ДОМБИ РАЙДЪРС ЕООД, GDPR политики, нито каквато и да било част от всички документи, с които съм бил запознат — имена, телефони, адреси на колеги и сътрудници на фирмата, информация станала ми достояние посредством Viber, WhatsApp, Telegram, Facebook и други подобни групи, телефонни разговори и други средства за комуникация, по време на моето сътрудничество и след това.',
    'Безсрочно се ангажирам да не агитирам други служители и сътрудници на фирмата към прекратяване на тяхното сътрудничество или преместването им към друга фирма и няма с каквито и да е думи, публикации, преки или косвени действия да уронвам доброто име на ДОМБИ РАЙДЪРС ЕООД.',
    'Декларирам, че по време на и след прекратяването на договора, сключен между мен и ДОМБИ РАЙДЪРС ЕООД няма да водя разговори за наемане, преговори с друга фирма подизпълнител или използваща бранда Платформата, нито директно с фирмата собственик на бранда Платформата, нито тяхно дъщерно или свързано дружество и няма да сключвам каквито и да е договори с такива в следващите 3 години. Приемам, че подобно действие би се считало за конфликт на интереси, нарушаване опазването на търговските тайни и нарушение на GDPR политиките, които се ангажирам да спазвам.',
    'Наясно съм, че неотчитането на каквато и да била сума, получена по време на изпълнението на микрозадачи, организирани чрез приложението Платформата Couriers, в срок най-късно до 24 часа от получаването ѝ, може да се приеме за нарушаване на договора с ДОМБИ РАЙДЪРС ЕООД, което да доведе до съответните неустойки.',
    'Приемам, че при приключване на договорните си отношения с ДОМБИ РАЙДЪРС ЕООД дължа връщането на предоставеното ми оборудване в срок от 3 (три дни) от извършване на последната доставка, като го предам лично според указанията. В случай, че не върна или представя същото в мръсно или увредено състояние, освен в случаите на обичайното изхабяване, дължа към ДОМБИ РАЙДЪРС ЕООД заплащане на неговата пълна стойност.',
  ];
  for (let i = 0; i < CONF.length; i++) await c.paragraph(`${i + 1}. ${CONF[i]}`);
  await c.paragraph('6. При поява на ситуация от гореописаните обстоятелства, решението на която не може да бъде уредена посредством преговори и споразумение, ДОМБИ РАЙДЪРС ЕООД ще бъде в правото си да не приеме за изпълнен в каквато и да било степен от моя страна сключения между нас договор, поради което в такъв случай се задължавам:');
  const CONF6 = [
    'Да възстановя полученото оборудване или неговата стойност, съгласно т.5.',
    'Да възстановя, ако има неотчетени от мен суми, получени по време на изпълнение на микрозадачи, организирани чрез приложението Платформата Couriers.',
    'Да възстановя направените от ДОМБИ РАЙДЪРС ЕООД разходи по създаването и поддръжката на акаунта ми в Платформата Couriers.',
    'Да възстановя на ДОМБИ РАЙДЪРС ЕООД всички суми, изплатени към мен в брой или по банков път като неустойка, поради нарушаване клаузите на договора.',
    'Да заплатя всички пропуснати ползи на ДОМБИ РАЙДЪРС ЕООД, произтичащи от незапочване, неизпълнение или виновно прекъсване на предоставения ми договор, като приема без протест калкулацията за тях.',
    'Да възстановя на ДОМБИ РАЙДЪРС ЕООД всички суми по събирането на вземанията, като възнаграждения на юрист, адвокатски хонорар, допълнителна комисионна към фирма за събиране на дългове и други.',
  ];
  for (let i = 0; i < CONF6.length; i++) await c.paragraph(`${i + 1}. ${CONF6[i]}`);
  await c.paragraph(
    'При игнориране на гореописаното от моя страна, ДОМБИ РАЙДЪРС ЕООД може без да ме уведомява допълнително да: сигнализира органите на ' +
    'МВР и Прокуратурата за извършено престъпление, кражба, незаконно задържане на вещи и пари, чужда собственост и да поиска образуването ' +
    'от страна на Прокуратурата на досъдебно производство; потърси правата си по съдебен ред, заедно с лихва за забава, равна на основния ' +
    'лихвен процент на БНБ плюс десет пункта наказателна лихва и направените от фирмата разходи, включително и адвокатски хонорар; използва ' +
    'правото си да издири и уведоми всички мои настоящи и бъдещи работодатели за моето поведение, водещо до нарушаване на ангажиментите ' +
    'поети по Договор, противозаконното задържане на вещи и пари, нарушаване на GDPR политики, изнасяне на фирмена информация и нарушаване ' +
    'на корпоративни тайни, уронване на престижа на компанията и други; продаде задължението ми на агенция за издирване на длъжници и ' +
    'изкупуване на дългове.'
  );
  await c.paragraph('Настоящото подписвам в електронен вариант и се счита за част от договорните ми отношения с ДОМБИ РАЙДЪРС ЕООД.');
  await c.paragraph(`Дата: ${startDateFmt}    Име: ${employeeName}`);

  // --- Приложение 3: Изисквания на Платформата ---------------------------
  await c.heading('ПРИЛОЖЕНИЕ III — ИЗИСКВАНИЯ НА ПЛАТФОРМАТА');
  await c.paragraph('чрез ДОМБИ РАЙДЪРС ЕООД, в качеството си на подизпълнител на Платформата');
  await c.paragraph('1. Доставчикът да притежава:');
  const REQ1 = [
    'заверена лична здравна книжка.',
    'МПС с валидни гражданска застраховка и технически преглед (не важи за доставчици, заявили, че ще извършват доставки с личен велосипед).',
    'Валидна шофьорска книжка.',
  ];
  for (let i = 0; i < REQ1.length; i++) await c.paragraph(`1.${i + 1}. ${REQ1[i]}`);
  await c.paragraph('2. Доставчикът се задължава да:');
  const REQ2 = [
    'носи отговорност за опазване на доброто име на Платформата и ДОМБИ РАЙДЪРС ЕООД.',
    'се грижи за собствената си безопасност и безопасността на лицата, които биха могли да пострадат при извършваната от него дейност.',
    'не посещава болнични заведения, изоставени сгради, строителни обекти и други опасни зони и при съмнение за такъв адрес да уведоми екипа по поддръжка на Платформата и ДОМБИ РАЙДЪРС ЕООД.',
    'се съобразява и изпълнява разпоредбите на поставените предупреждаващи, задължаващи, забраняващи и насочващи знаци, и сигнали на безопасност на труда, и противопожарна охрана.',
    'носи отговорност за законосъобразността и целесъобразността на взетите решения, при осъществяване на поставените от приложението Платформата задачи.',
    'носи предпазна маска, покриваща носа и устата при взимане и предаване на поръчката.',
    'да носи униформа и да бъде в чист и изряден външен вид, включително поверената му термочанта.',
    'прибира поръчките, които се затварят в термочантите при получаване и се изваждат от тях пред клиента.',
    'поддържа изправно и заредено смарт устройството, на което ще получава заявките чрез приложението на Платформата.',
    'поддържа изправно и чисто управляваното от него превозно средство, с което ще извършва доставките.',
    'съобщава своевременно за неизправности на превозното си средство и настъпилата необходимост от ремонт и профилактика на ДОМБИ РАЙДЪРС ЕООД.',
    'превежда на Платформата всички получени суми за платени от клиентите доставки. Подробна информация се съдържа в баланса в личния профил на доставчика в приложението на Платформата.',
    'съхранява отговорно трайните продукти до 24 часа, или до 30 минути за нетрайните продукти, след като е индикирал в приложението, че клиентът е отсъстващ, в случай, че доставчикът изпълни поръчката и/или микрозадачата и клиентът не може да бъде намерен на адреса за доставка.',
    'информира клиента и съпорта в приложението на Платформата в случай, че поръчаният продукт не е наличен в обекта и да му предложи възможните алтернативи.',
    'да изисква касов бон при получаването на всяка поръчка, да го съхранява и предава на клиента, заедно с нея.',
    'се обади на клиента за допълнителна информация с оглед по-добро изпълнение на поръчката, в случай на съмнение относно начина на изпълнението на поръчката.',
    'носи отговорност за всякакви загуби или щети, които могат да бъдат нанесени на стоките и продуктите по време на транспортирането им, освен в изключителни случаи, при които може да докаже, че те се дължат на трета страна, в случай на непреодолима сила или на каквото и да е друго обстоятелство извън неговия контрол. В случай, че само доставчикът бъде счетен за отговорен за загубата или увреждането или щетата на стоката, предмет на поръчката, клиентът може да поиска директно обезщетение за действителната стойност, която ще бъде за сметка на доставчика.',
    'при неизвършване на доставка в рамките на три последователни дни да преведе натрупаните служебни пари, получени от доставки, на Платформата или да ги предаде на ДОМБИ РАЙДЪРС ЕООД.',
  ];
  for (let i = 0; i < REQ2.length; i++) await c.paragraph(`2.${i + 1}. ${REQ2[i]}`);
  await c.paragraph('3. Доставчикът няма право да:');
  const REQ3 = [
    'влиза в словесна или физическа саморазправа, с каквито и да било лица по време на изпълнение на слот, взет през приложението Платформата или докато носи униформа и/или други отличителни характеристики на бранда.',
    'приема продукти и стоки от обекта, които не съответстват напълно на клиентската поръчка и/или са в неизряден търговски вид и/или опаковките не са подходящи за транспортиране, с цел избягване на неблагоприятни ситуации. Продуктите и стоките, заявени от клиента трябва да бъдат доставени в същото състояние, в което са били взети.',
    'отваря торбите, опаковките или контейнерите, съдържащи продуктите, нито да докосва или боравя с тях или храната по какъвто и да е начин.',
    'използва свои или на трети лица отличителни корпоративни изделия като тениски, бейзболни шапки и др. Единственото изключение от това ще бъдат материалите, които ще бъдат предоставени от Платформата.',
    'използва при никакви обстоятелства информацията във връзка с доставката, поръчката или каквато и да е информация за клиента (имена, адрес, телефонен номер и др.), видима в приложението на Платформата за каквито и да било цели, различни от най-добрия и успешен начин за извършване на доставката.',
    'използва или да се опитва да използва друг потребителски акаунт в Платформата.',
    'дублира, модифицира или създава производни на приложението или друга свързана технология.',
    'използва обратен инженеринг, преоборудване, разглобяване, декодиране или опит по друг начин да открие изходния код на приложението, или на която и да е свързана технология.',
    'събира, използва, дублира или споделя информация, получена от приложението, без одобрението на Платформата.',
    'използва роботизирани или други автоматизирани методи за използване на приложението.',
    'създава акаунт в Платформата, като използва фалшива самоличност или самоличност на друго лице.',
    'Личните данни на лицето, участващо в настоящия документ, са предварително предоставени чрез подписана Декларация за съгласие за обработка на лични данни (Приложение 1) и представляват неразделна част от този документ.',
    'Данните от Приложение 1 се прилагат към този документ със същата правна сила, без да се изписват повторно, съгласно чл. 6, ал. 1, букви „а“ и „б“ от Регламент (ЕС) 2016/679 (GDPR).',
  ];
  for (let i = 0; i < REQ3.length; i++) await c.paragraph(`3.${i + 1}. ${REQ3[i]}`);
  await c.paragraph('Прочетох и съм наясно с всичко описано.');
  await c.paragraph(`Дата: ${startDateFmt}    Име: ${employeeName}`);

  // --- Приложение 4: Приемо-предавателен протокол за оборудването --------
  await c.heading('ПРИЛОЖЕНИЕ IV — ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ');
  const equipmentTotal = equipment.reduce((s, e) => s + (Number(e.value) || 0), 0);
  await c.paragraph(
    `Днес, ${startDateFmt} г., гр. София, между ${AD_COMPANY.name}, вписано в Търговски регистър, с ЕИК ${AD_COMPANY.eik}, ДДС регистрация ${AD_COMPANY.vat}, ` +
    `със седалище и адрес на управление в ${AD_COMPANY.address}, представлявано от ${AD_COMPANY.manager} – управител, наричан по-долу Възложител и ${employeeName}, ` +
    `наричан по-долу Изпълнител, се подписа настоящия приемо-предавателен протокол, за следното:`
  );
  await c.paragraph('1. Във връзка със сключен между Възложителя и Изпълнителя настоящия граждански договор за реклама, извършвайки доставки чрез приложението Платформата от, на Изпълнителя се предоставя рекламно облекло, оборудване и пари за правилно изпълнение на възложената работа.');
  await c.paragraph(`2. Възложителят предаде на Изпълнителя в пълна изправност, следното облекло, оборудване на обща стойност ${equipmentTotal} евро, видими в персоналния акаунт на Работника в приложението Платформата, както следва:`);
  equipment.forEach((e, i) => { /* номерирани редове по-долу */ });
  for (let i = 0; i < equipment.length; i++) {
    await c.paragraph(`${i + 1}. ${equipment[i].name} – 1 бр., на стойност ${equipment[i].value} евро.`);
  }
  await c.paragraph(`${equipment.length + 1}. Оборотни пари, които се генерират чрез приложението Платформата, получавайки ги от клиенти.`);
  const PROT = [
    'Изпълнителят приема предадените му рекламно облекло и оборудване, без възражения и бележки. Приетото облекло и оборудване следва да се поддържа чисто през целия срок на експлоатацията му и да бъде върнато почистено.',
    'Изпълнителят приема да носи финансовата отговорност за получените оборотни пари, оперирайки с приложението Платформата и се задължава да ги отчита в цялостен размер чрез платформата на Изипей, чрез своя идентификационен номер всеки ден.',
    'В случай, че предоставеното на Изпълнителя рекламно облекло и оборудване погине, без значение по каква причина, Изпълнителят дължи на Възложителя неговата парична равностойност, посочена в т. 2.1; т. 2.2.; т. 2.3. и т. 2.4., в срок от пет работни дни от настъпване на събитието. В случай, че Договорът не е прекратен към момента на погиването, Възложителят има право да приспадне дължимата за облеклото и оборудването сума от възнаграждението на Изпълнителя по договор.',
    'При прекратяване на Договора Изпълнителят е длъжен да върне предоставените му рекламно облекло, оборудване и пари или документи, удостоверяващи отчитането на събраните оборотни пари към Платформата, в срок от три календарни дни от деня на прекратяването. За предаването да се подпише предавателно-приемателен протокол, в който се описва състоянието, в което се предават облеклото и оборудването. В случай на констатирани повреди, липса или замърсен външен вид на предаденото облекло и оборудване, се описва в предавателно-приемателен протокол и Изпълнителят се задължава незабавно да възстанови паричната равностойност на облеклото и оборудването съобразно т. 2 от настоящия приемо-предавателен протокол.',
    'В случай, че Изпълнителят не изпълни задължението си да върне предоставеното му във връзка със сключения с него Договор рекламно облекло, оборудване и пари или документи, удостоверяващи отчитането на събраните оборотни пари към Платформата, Възложителят има следните права: да се снабди с изпълнителен лист по реда на чл. 410 ГПК, без възражения от Изпълнителя, заедно със законна лихва за забава, начислена за всеки ден просрочие, след изтичане на срока по т. 3 от настоящия приемо-предавателен протокол, равна на основния лихвен процент на БНБ плюс 10 пункта наказателна лихва и разноските по делото, както и заплатените адвокатски хонорари; да сигнализира органите на МВР и Прокуратурата за невърнатото облекло, оборудване и пари от Изпълнителя; да търси правата си по съдебен ред, заедно с обезщетение за нанесени имуществени вреди и пропуснати ползи, законна лихва, равна на основния лихвен процент на БНБ плюс 10 пункта наказателна лихва, държавните такси, депозити за вещи лица, адвокатски хонорари; да уведоми работодателите, при които Изпълнителят постъпва на работа след прекратяването на сключения с него Договор за некоректното му поведение и присвояване на предоставеното му облекло, оборудване и пари.',
    'Настоящият приемо-предавателен протокол се състави и подписа в два еднообразни екземпляра – по един за всяка от страните и е неразделна част от Договора.',
  ];
  for (let i = 0; i < PROT.length; i++) await c.paragraph(`${i + 3}. ${PROT[i]}`);
  await c.signatureRow('Изпълнител (подпис)', 'Възложител (подпис)');

  // --- Молба --------------------------------------------------------------
  await c.heading('МОЛБА');
  await c.paragraph(`От ${employeeName},`);
  await c.paragraph('Уважаеми г-н Управител,');
  await c.paragraph(
    `С настоящата молба Ви моля за Вашето съгласие за извършването на рекламна дейност и доставки по заявка чрез приложението Платформата. ` +
    `Същите ще извършвам чрез личен ${VEHICLE_KIND_LABELS[ov.type] || 'автомобил/велосипед/скутер/мотор'}. Моля за целта броят поръчки да бъде фиксиран в граждански договор към ${AD_COMPANY.name}.`
  );
  await c.paragraph('Декларирам, че притежавам лична здравна книжка, застраховка Гражданска отговорност и преглед на МПС марка.');
  await c.paragraph(`Дата: ${startDateFmt}    Име: ${employeeName}`);

  // --- Декларация за осигуряване ------------------------------------------
  await c.heading('ДЕКЛАРАЦИЯ ЗА ОСИГУРЯВАНЕ');
  await c.paragraph(`Долуподписаният/ата ${employeeName}, с ЕГН/ЛНЧ: ${(profile && profile.egn) || '—'},`);
  await c.paragraph(`Декларирам, че за месец ${todayFmt.slice(3)} г.:`);
  await c.kv('Осигурителният ми статус е', (profile && profile.insurance_status) || '—');
  await c.kv('Брутна сума', profile && profile.insurance_gross_amount != null ? `${profile.insurance_gross_amount} €` : '—');
  await c.paragraph('Известно ми е, че за декларирани неверни данни нося наказателна отговорност по чл. 313 от Наказателния кодекс.');
  await c.paragraph(`Настоящата декларация да послужи пред ${AD_COMPANY.name} във връзка с изплащане на суми по договор на основание чл. 280 - 292 от Закона за задълженията и договорите.`);
  await c.paragraph(`Дата: ${todayFmt}    Име: ${employeeName}`);

  await c.signedStamp(signedEvents);

  return doc.save();
}

// ---------------------------------------------------------------------------
// Потвърждение за седмица (заплати) — ИЗРИЧНО САМО брой поръчки, НИКОГА сума
// (нито gross_earnings, нито net_amount, нито deduction_amount). Разписването
// на шофьора потвърждава единствено броя изпълнени поръчки за седмицата — не
// стойността им. Затова тук НЯМА параметър/поле за пари, и няма редактируем
// шаблон/токени (за да не може админ случайно да добави сума в текста).
async function buildPayrollConfirmationPdf({ entry, employeeName }) {
  const { doc, cursor: c } = await newDoc();

  await c.title('Потвърждение на брой поръчки за седмица');
  await c.subtitle(`Седмица: ${entry.week_start} — ${entry.week_end}`);
  await c.subtitle('Dombi Riders ЕООД');
  c.hr();

  await c.heading('Служител');
  await c.kv('Име', employeeName);

  await c.heading('Потвърждение');
  await c.kv('Брой изпълнени поръчки', entry.order_count);
  await c.paragraph('С полагането на подпис по-долу служителят потвърждава единствено броя изпълнени поръчки за посочената седмица. Този документ НЕ съдържа и не представлява потвърждение на паричната стойност/заплащане.');

  await c.signatureRow('Работодател (подпис)', 'Служител (подпис)');

  return doc.save();
}

module.exports = {
  newDoc, PageCursor, wrapText, rasterizeLine, PDF_FONTS_AVAILABLE,
  buildProtocolPdf, buildContractPdf, buildEmploymentContractPdf, buildCivilAdContractPdf, buildPayrollConfirmationPdf,
};
