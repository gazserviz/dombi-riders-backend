// ============================================================================
// lib/doc-builder.js — генерира истински .docx документи (протокол за
// предаване/приемане, договор за наем) от данните в системата, чрез npm
// пакета `docx` (https://docx.js.org). Работи директно, без качен Word
// шаблон — взима предвид редактируемия текст на клаузите/бележките от
// document_templates (виж lib/db.js), ако администраторът го е сменил.
//
// Тествано в тази среда (пакетът `docx` е наличен и се изисква директно).
// ============================================================================

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, VerticalAlign,
} = require('docx');

const NO_BORDERS = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
};

function kvTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: rows.map(([k, v]) => new TableRow({
      children: [
        new TableCell({
          width: { size: 35, type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.TOP,
          children: [new Paragraph({ children: [new TextRun({ text: k, color: '667085', size: 19 })] })],
        }),
        new TableCell({
          width: { size: 65, type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.TOP,
          children: [new Paragraph({ children: [new TextRun({ text: String(v == null || v === '' ? '—' : v), bold: true, size: 21 })] })],
        }),
      ],
    })),
  });
}

function signatureRow(leftLabel, rightLabel) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [leftLabel, rightLabel].map(label => new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        children: [
          new Paragraph({ text: '' }),
          new Paragraph({ text: '____________________', alignment: AlignmentType.CENTER }),
          new Paragraph({ children: [new TextRun({ text: label, color: '667085', size: 18 })], alignment: AlignmentType.CENTER }),
        ],
      })),
    })],
  });
}

function heading(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } });
}
function titleBlock(title, subtitle, rightLines) {
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { after: 60 } }),
    new Paragraph({ children: [new TextRun({ text: subtitle, color: '667085' })], spacing: { after: 100 } }),
  ];
  (rightLines || []).forEach(l => children.push(new Paragraph({ children: [new TextRun({ text: l, color: '667085', size: 18 })] })));
  children.push(new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999' } }, spacing: { after: 200 } }));
  return children;
}
function textParagraph(text) {
  return String(text).split(/\n+/).map(line => new Paragraph({ text: line, spacing: { after: 100 } }));
}

async function buildProtocolDocx({ protocol, vehicle, driverLabel, termsText }) {
  const children = [
    ...titleBlock(
      'Приемо-предавателен протокол',
      `№ ${protocol.protocol_number} · ${protocol.type === 'handover' ? 'Предаване на автомобил' : 'Приемане на автомобил'}`,
      ['Dombi Riders ЕООД', new Date(protocol.date).toLocaleString('bg-BG')]
    ),
    heading('Автомобил'),
    kvTable([
      ['Рег. номер', vehicle ? vehicle.plate_number : protocol.vehicle_id],
      ['Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—'],
      ['VIN / Рама', vehicle ? vehicle.vin : '—'],
      ['Година', vehicle ? vehicle.year : '—'],
    ]),
    heading('Състояние при предаването'),
    kvTable([
      ['Пробег', protocol.odometer_km != null ? `${protocol.odometer_km} км` : '—'],
      ['Ниво на гориво', protocol.fuel_level_pct != null ? `${protocol.fuel_level_pct}%` : '—'],
      ['Шофьор / наемател', driverLabel || '—'],
    ]),
  ];

  if (protocol.exterior_notes) {
    children.push(heading('Външно състояние — забележки'));
    children.push(...textParagraph(protocol.exterior_notes));
  }
  if (protocol.interior_notes) {
    children.push(heading('Вътрешно състояние — забележки'));
    children.push(...textParagraph(protocol.interior_notes));
  }
  if (termsText) {
    children.push(heading('Общи условия'));
    children.push(...textParagraph(termsText));
  }

  children.push(new Paragraph({ text: '', spacing: { before: 500 } }));
  children.push(signatureRow('Предал (подпис)', 'Приел (подпис)'));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function buildContractDocx({ contract, vehicle, renterName, termsText }) {
  const RATE_PERIOD_LABELS = { day: 'ден', week: 'седмица', month: 'месец' };
  const STATUS_LABELS = { draft: 'Чернова', active: 'Активен', completed: 'Приключен', terminated: 'Прекратен' };

  const children = [
    ...titleBlock(
      'Договор за наем на автомобил',
      `№ ${contract.contract_number} · Статус: ${STATUS_LABELS[contract.status] || contract.status}`,
      ['Dombi Riders ЕООД', `Дата на съставяне: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
    ),
    heading('Наемодател'),
    ...textParagraph('Dombi Riders ЕООД, гр. София, действащ чрез оправомощен представител.'),
    heading('Наемател'),
    kvTable([
      ['Име', renterName],
      ['Тип', contract.renter_type === 'dombi_courier' ? 'Куриер на Dombi Riders' : contract.renter_type === 'other_platform' ? 'Друга платформа' : 'Лично ползване'],
      ...(contract.renter_egn ? [['ЕГН', contract.renter_egn]] : []),
      ...(contract.renter_phone ? [['Телефон', contract.renter_phone]] : []),
      ...(contract.renter_email ? [['Имейл', contract.renter_email]] : []),
      ...(contract.renter_address ? [['Адрес', contract.renter_address]] : []),
    ]),
    heading('Предмет на договора'),
    kvTable([
      ['Рег. номер', vehicle ? vehicle.plate_number : contract.vehicle_id],
      ['Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—'],
      ['VIN / Рама', vehicle ? vehicle.vin : '—'],
    ]),
    heading('Условия на наема'),
    kvTable([
      ['Начална дата', contract.start_date],
      ['Крайна дата', contract.end_date || 'безсрочен'],
      ['Наемна цена', `${contract.rate_amount} € / ${RATE_PERIOD_LABELS[contract.rate_period] || contract.rate_period}`],
      ['Депозит', `${contract.deposit_amount || 0} €`],
      ...(contract.start_odometer_km ? [['Пробег при предаване', `${contract.start_odometer_km} км`]] : []),
      ...(contract.end_odometer_km ? [['Пробег при връщане', `${contract.end_odometer_km} км`]] : []),
    ]),
  ];

  if (termsText) {
    children.push(heading('Общи условия'));
    children.push(...textParagraph(termsText));
  }

  children.push(new Paragraph({ text: '', spacing: { before: 500 } }));
  children.push(signatureRow('Наемодател (подпис)', 'Наемател (подпис)'));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

const EC_TYPE_LABELS = { labor: 'Трудов договор', civil: 'Граждански договор' };
const EC_STATUS_LABELS = { draft: 'Чернова', active: 'Активен', terminated: 'Прекратен' };

// ⚠️ ПРАВНА БЕЛЕЖКА (не е правен съвет — вижте README): истински трудов
// договор по Кодекса на труда изисква квалифициран електронен подпис (КЕП) от
// работодателя (чл. 62 КТ, Наредба № Н-14/2023) — механизмът за присъствено/
// SES разписване в тази система НЕ покрива този случай и e само за
// чернова/преглед, докато не бъде свързан доставчик на КЕП.
async function buildEmploymentContractDocx({ contract, profile, termsText }) {
  const isLabor = contract.contract_type === 'labor';
  const children = [
    ...titleBlock(
      EC_TYPE_LABELS[contract.contract_type] || contract.contract_type,
      `№ ${contract.contract_number} · Статус: ${EC_STATUS_LABELS[contract.status] || contract.status}`,
      ['Dombi Riders ЕООД', `Дата на съставяне: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
    ),
  ];

  if (isLabor) {
    children.push(new Paragraph({
      children: [new TextRun({
        text: '⚠️ Чернова за преглед. Действителен трудов договор изисква квалифициран електронен подпис (КЕП) от работодателя по чл. 62 КТ — не е правен съвет, консултирайте се с адвокат/счетоводител.',
        color: 'b45309', italics: true, size: 18,
      })],
      spacing: { after: 160 },
    }));
  }

  children.push(
    heading('Работодател'),
    ...textParagraph('Dombi Riders ЕООД, гр. София, действащ чрез оправомощен представител.'),
    heading(isLabor ? 'Работник' : 'Изпълнител'),
    kvTable([
      ['Име', profile ? profile.full_name : contract.profile_id],
      ...(profile && profile.egn ? [['ЕГН', profile.egn]] : []),
      ...(profile && profile.address ? [['Адрес', profile.address]] : []),
      ...(profile && profile.phone ? [['Телефон', profile.phone]] : []),
      ...(profile && profile.email ? [['Имейл', profile.email]] : []),
    ]),
    heading('Условия'),
    kvTable([
      ['Вид договор', EC_TYPE_LABELS[contract.contract_type] || contract.contract_type],
      ...(isLabor ? [['Часове на ден', contract.hours_per_day]] : []),
      ['Начална дата', contract.start_date],
      ['Крайна дата', contract.end_date || 'безсрочен'],
      ['Седмична удръжка', `${contract.weekly_deduction_amount || 0} €`],
    ]),
  );

  if (termsText) {
    children.push(heading(isLabor ? 'Клаузи' : 'Общи условия'));
    children.push(...textParagraph(termsText));
  }

  children.push(new Paragraph({ text: '', spacing: { before: 500 } }));
  children.push(signatureRow('Работодател (подпис)', isLabor ? 'Работник (подпис)' : 'Изпълнител (подпис)'));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildProtocolDocx, buildContractDocx, buildEmploymentContractDocx };
