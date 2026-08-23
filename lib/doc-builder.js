// ============================================================================
// lib/doc-builder.js — генерира истински .docx документи (протокол за
// предаване/приемане, договор за наем, трудов/граждански договор) от данните
// в системата, чрез npm пакета `docx` (https://docx.js.org). Работи директно,
// без качен Word шаблон — взима предвид редактируемия текст на клаузите/
// бележките от document_templates (виж lib/db.js), ако администраторът го е
// сменил — той се показва като ДОПЪЛНИТЕЛЕН раздел след стандартните клаузи,
// без да заменя правно-структурираните такива по-долу.
//
// Тествано в тази среда (пакетът `docx` е наличен и се изисква директно).
// ============================================================================

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, VerticalAlign, ShadingType,
} = require('docx');

// ---------------------------------------------------------------------------
// Данни за фирмата — показват се в заглавната част на всеки документ.
// ЕИК/адрес не са задължителни — при празни се пропускат в бланката, вместо
// да се измислят несъществуващи регистрационни номера.
// ---------------------------------------------------------------------------
const COMPANY = {
  name: 'ДОМБИ РАЙДЪРС' + ' ЕООД',
  city: 'гр. София, България',
  phone: '0887 25 27 27',
  manager: 'Димчо Петров',
};

const ACCENT = '15803d';   // тъмно зелено — акцент за заглавия/линии
const MUTED = '667085';
const DARK = '15181f';

const NO_BORDERS = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
};
const GRID_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' },
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
          children: [new Paragraph({ children: [new TextRun({ text: k, color: MUTED, size: 19 })] })],
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

// Таблица-чек-лист (напр. състояние екстериор/интериор/техническо) с оцветена
// заглавна лента и рамки — за месечни прегледи/протоколи.
function checklistTable(headerCells, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: GRID_BORDERS,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headerCells.map(h => new TableCell({
          shading: { type: ShadingType.CLEAR, fill: ACCENT },
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({ children: [new TextRun({ text: h, color: 'FFFFFF', bold: true, size: 18 })] })],
        })),
      }),
      ...rows.map(cells => new TableRow({
        children: cells.map(c => new TableCell({
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({ children: [new TextRun({ text: String(c == null || c === '' ? '—' : c), size: 19 })] })],
        })),
      })),
    ],
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
          new Paragraph({ children: [new TextRun({ text: label, color: MUTED, size: 18 })], alignment: AlignmentType.CENTER }),
        ],
      })),
    })],
  });
}

function heading(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, color: ACCENT, size: 24 })],
    spacing: { before: 260, after: 130 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E4E7EC' } },
  });
}

// Заглавна част ("letterhead") — фирмено име, град/телефон вляво, номер и
// дата на документа вдясно, под черта в цвета на бранда.
function letterhead(docTitle, docSubtitle, rightLines) {
  const headerRow = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [
        new TableCell({
          width: { size: 55, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({ children: [new TextRun({ text: COMPANY.name, bold: true, size: 22, color: DARK })] }),
            new Paragraph({ children: [new TextRun({ text: COMPANY.city, size: 17, color: MUTED })] }),
            new Paragraph({ children: [new TextRun({ text: `тел. ${COMPANY.phone}`, size: 17, color: MUTED })] }),
          ],
        }),
        new TableCell({
          width: { size: 45, type: WidthType.PERCENTAGE },
          children: (rightLines || []).map(l => new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: l, size: 17, color: MUTED })],
          })),
        }),
      ],
    })],
  });

  const children = [
    headerRow,
    new Paragraph({ text: '', spacing: { before: 140 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: docTitle.toUpperCase(), bold: true, size: 30, color: DARK })],
    }),
  ];
  if (docSubtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: docSubtitle, size: 19, color: MUTED })],
    }));
  }
  children.push(new Paragraph({
    text: '',
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: ACCENT } },
    spacing: { after: 220 },
  }));
  return children;
}

function textParagraph(text) {
  return String(text).split(/\n+/).map(line => new Paragraph({ text: line, spacing: { after: 100 } }));
}

// Номерирана клауза "Чл. N. ЗАГЛАВИЕ" + текст на клаузата (текстът може да е
// низ или масив от низове — по един параграф на елемент).
function clause(number, title, body) {
  const paras = [
    new Paragraph({
      spacing: { before: 160, after: 60 },
      children: [new TextRun({ text: `Чл. ${number}. ${title}`, bold: true, size: 20, color: DARK })],
    }),
  ];
  const lines = Array.isArray(body) ? body : [body];
  lines.forEach(line => paras.push(new Paragraph({
    children: [new TextRun({ text: line, size: 20, color: DARK })],
    spacing: { after: 80 },
    alignment: AlignmentType.JUSTIFIED,
  })));
  return paras;
}

function preamble(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, color: DARK })],
    spacing: { after: 200 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

const FUEL_TYPE_LABELS = { petrol: 'Бензин', diesel: 'Дизел', gas_petrol: 'Газ + Бензин', electric: 'Електрическа', hybrid: 'Хибрид' };

function fuelLevelLines(protocol) {
  const lines = [];
  const typeLabel = FUEL_TYPE_LABELS[protocol.fuel_type] || null;
  const primaryLabel = protocol.fuel_type === 'gas_petrol' ? 'Ниво на бензин' : 'Ниво на гориво';
  lines.push([typeLabel ? `Вид гориво` : 'Вид гориво', typeLabel || '—']);
  lines.push([primaryLabel, protocol.fuel_level_pct != null ? `${protocol.fuel_level_pct}%` : '—']);
  if (protocol.fuel_type === 'gas_petrol') {
    lines.push(['Ниво на газ (доп.)', protocol.fuel_level_secondary_pct != null ? `${protocol.fuel_level_secondary_pct}%` : '—']);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Приемо-предавателен протокол
// ---------------------------------------------------------------------------
async function buildProtocolDocx({ protocol, vehicle, driverLabel, termsText }) {
  const children = [
    ...letterhead(
      'Приемо-предавателен протокол',
      protocol.type === 'handover' ? 'Предаване на автомобил' : 'Приемане на автомобил',
      [`№ ${protocol.protocol_number}`, new Date(protocol.date).toLocaleString('bg-BG')]
    ),
    heading('1. Данни за автомобила'),
    kvTable([
      ['Рег. номер', vehicle ? vehicle.plate_number : protocol.vehicle_id],
      ['Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—'],
      ['VIN / Рама', vehicle ? vehicle.vin : '—'],
      ['Година', vehicle ? vehicle.year : '—'],
    ]),
    heading('2. Състояние при предаването'),
    kvTable([
      ['Пробег', protocol.odometer_km != null ? `${protocol.odometer_km} км` : '—'],
      ...fuelLevelLines(protocol),
      ['Шофьор / наемател', driverLabel || '—'],
    ]),
  ];

  children.push(heading('3. Външен и вътрешен оглед'));
  children.push(checklistTable(
    ['Елемент', 'Констатация'],
    [
      ['Външно състояние', protocol.exterior_notes || 'Без забележки'],
      ['Вътрешно състояние', protocol.interior_notes || 'Без забележки'],
    ]
  ));

  const photoCount = (protocol.photos || []).length;
  children.push(new Paragraph({
    spacing: { before: 140, after: 60 },
    children: [new TextRun({ text: `Приложени снимки на състоянието: ${photoCount} бр.`, size: 18, color: MUTED, italics: true })],
  }));

  children.push(heading('4. Общи условия'));
  children.push(...textParagraph(termsText ||
    'Приемащата страна декларира, че е прегледала автомобила и е съгласна с описаното по-горе състояние. ' +
    'При установяване на нови повреди при връщането, различни от описаните в настоящия протокол, отговорност носи страната, ползвала автомобила през съответния период.'
  ));

  children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  children.push(signatureRow('Предал (подпис)', 'Приел (подпис)'));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// Договор за наем на автомобил
// ---------------------------------------------------------------------------
async function buildContractDocx({ contract, vehicle, renterName, termsText }) {
  const RATE_PERIOD_LABELS = { day: 'ден', week: 'седмица', month: 'месец' };
  const STATUS_LABELS = { draft: 'Чернова', active: 'Активен', completed: 'Приключен', terminated: 'Прекратен' };
  const RENTER_TYPE_LABELS = { dombi_courier: 'Куриер на Dombi Riders', other_platform: 'Друга платформа', personal_use: 'Лично ползване' };

  const children = [
    ...letterhead(
      'Договор за наем на моторно превозно средство',
      `Статус: ${STATUS_LABELS[contract.status] || contract.status}`,
      [`№ ${contract.contract_number}`, `Дата: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
    ),
    preamble(
      `Днес, ${new Date(contract.created_at).toLocaleDateString('bg-BG')}, в ${COMPANY.city}, между ${COMPANY.name}, ` +
      `представлявано от управителя ${COMPANY.manager}, наричано по-долу „НАЕМОДАТЕЛ“, и ${renterName}` +
      `${contract.renter_egn ? ', ЕГН ' + contract.renter_egn : ''}, наричан/а по-долу „НАЕМАТЕЛ“, се сключи настоящият договор за наем на моторно превозно средство при следните условия:`
    ),
  ];

  children.push(...clause(1, 'ПРЕДМЕТ НА ДОГОВОРА',
    `Наемодателят предоставя на Наемателя, а Наемателят приема да ползва срещу възнаграждение лек автомобил ` +
    `${vehicle ? `марка/модел ${vehicle.make} ${vehicle.model}, рег. № ${vehicle.plate_number}${vehicle.vin ? ', VIN ' + vehicle.vin : ''}` : `с рег. № ${contract.vehicle_id}`}, ` +
    `предаден в изправно техническо и визуално състояние съгласно подписан приемо-предавателен протокол.`
  ));

  children.push(...clause(2, 'СРОК НА ДОГОВОРА',
    `Договорът влиза в сила от ${contract.start_date} и е ${contract.end_date ? `със срок до ${contract.end_date}` : 'безсрочен, до прекратяването му по реда на настоящия договор'}.`
  ));

  children.push(...clause(3, 'НАЕМНА ЦЕНА И НАЧИН НА ПЛАЩАНЕ', [
    `Наемната цена е в размер на ${contract.rate_amount} € на ${RATE_PERIOD_LABELS[contract.rate_period] || contract.rate_period}, платима авансово.`,
    `Целта на ползване на автомобила е декларирана като: ${RENTER_TYPE_LABELS[contract.renter_type] || contract.renter_type}.`,
  ]));

  children.push(...clause(4, 'ДЕПОЗИТ',
    `Наемателят внася депозит в размер на ${contract.deposit_amount || 0} € като обезпечение по настоящия договор. ` +
    `Депозитът се възстановява при прекратяване на договора, след приспадане на евентуални дължими суми за щети, глоби или неплатен наем.`
  ));

  children.push(...clause(5, 'ЗАДЪЛЖЕНИЯ НА НАЕМАТЕЛЯ', [
    'Да ползва автомобила грижливо, по предназначение и съгласно правилата за движение по пътищата.',
    'Да не преотстъпва автомобила на трети лица без писменото съгласие на Наемодателя.',
    'Да заплаща своевременно дължимите наемни вноски, глоби и такси, възникнали през периода на ползване.',
    'Да уведомява незабавно Наемодателя при ПТП, повреда или кражба на автомобила.',
  ]));

  children.push(...clause(6, 'ЗАДЪЛЖЕНИЯ НА НАЕМОДАТЕЛЯ', [
    'Да предаде автомобила в изправно техническо състояние, с валидни документи и застраховки.',
    'Да осигурява своевременно техническо обслужване на автомобила извън случаите на повреда по вина на Наемателя.',
  ]));

  children.push(...clause(7, 'ОТГОВОРНОСТ ПРИ ЩЕТИ',
    'Наемателят носи имуществена отговорност за щети по автомобила, настъпили през периода на ползване по негова вина, ' +
    'както и за всички глоби и санкции, наложени във връзка с управлението на автомобила през този период.'
  ));

  children.push(...clause(8, 'ПРЕКРАТЯВАНЕ',
    'Договорът може да бъде прекратен по взаимно съгласие, с едностранно писмено предизвестие от всяка от страните, ' +
    'или незабавно при съществено неизпълнение на задълженията по настоящия договор.'
  ));

  children.push(heading('9. Данни за автомобила и наемателя'));
  children.push(kvTable([
    ['Рег. номер', vehicle ? vehicle.plate_number : contract.vehicle_id],
    ['Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—'],
    ['VIN / Рама', vehicle ? vehicle.vin : '—'],
    ['Наемател', renterName],
    ...(contract.renter_egn ? [['ЕГН', contract.renter_egn]] : []),
    ...(contract.renter_phone ? [['Телефон', contract.renter_phone]] : []),
    ...(contract.renter_license_number ? [['№ на книжка', contract.renter_license_number]] : []),
    ...(contract.start_odometer_km ? [['Пробег при предаване', `${contract.start_odometer_km} км`]] : []),
    ...(contract.end_odometer_km ? [['Пробег при връщане', `${contract.end_odometer_km} км`]] : []),
  ]));

  if (termsText) {
    children.push(heading('10. Допълнителни условия'));
    children.push(...textParagraph(termsText));
  }

  children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
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
  const employeeName = profile ? profile.full_name : contract.profile_id;

  const children = [
    ...letterhead(
      EC_TYPE_LABELS[contract.contract_type] || contract.contract_type,
      `Статус: ${EC_STATUS_LABELS[contract.status] || contract.status}`,
      [`№ ${contract.contract_number}`, `Дата: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
    ),
  ];

  if (isLabor) {
    children.push(new Paragraph({
      children: [new TextRun({
        text: '⚠️ Чернова за преглед. Действителен трудов договор изисква квалифициран електронен подпис (КЕП) от работодателя по чл. 62 КТ — не е правен съвет, консултирайте се с адвокат/счетоводител.',
        color: 'b45309', italics: true, size: 18,
      })],
      spacing: { after: 200 },
    }));
  }

  children.push(preamble(
    `Днес, ${new Date(contract.created_at).toLocaleDateString('bg-BG')}, в ${COMPANY.city}, между ${COMPANY.name}, ` +
    `представлявано от управителя ${COMPANY.manager}, наричано по-долу „${isLabor ? 'РАБОТОДАТЕЛ' : 'ВЪЗЛОЖИТЕЛ'}“, и ${employeeName}` +
    `${profile && profile.egn ? ', ЕГН ' + profile.egn : ''}, наричан/а по-долу „${isLabor ? 'РАБОТНИК/СЛУЖИТЕЛ' : 'ИЗПЪЛНИТЕЛ'}“, ` +
    `се сключи настоящият ${isLabor ? 'трудов договор на основание чл. 67 във вр. с чл. 70 от Кодекса на труда' : 'граждански договор на основание чл. 258 и сл. от Закона за задълженията и договорите'} при следните условия:`
  ));

  if (isLabor) {
    children.push(...clause(1, 'ПРЕДМЕТ И ДЛЪЖНОСТ',
      'Работодателят възлага, а Работникът/Служителят приема да изпълнява длъжността „Куриер“ в дейността на дружеството.'
    ));
    children.push(...clause(2, 'МЯСТО НА РАБОТА', `Работата се изпълнява на територията на ${COMPANY.city} и прилежащите райони на обслужване.`));
    children.push(...clause(3, 'РАБОТНО ВРЕМЕ', `Установява се непълно/пълно работно време от ${contract.hours_per_day || '—'} часа на ден, при 5-дневна работна седмица, съгласно утвърден график.`));
    children.push(...clause(4, 'ТРУДОВО ВЪЗНАГРАЖДЕНИЕ', `Седмичното възнаграждение/удръжка е в размер на ${contract.weekly_deduction_amount || 0} €, изплащано съгласно вътрешните правила на дружеството.`));
    children.push(...clause(5, 'СРОК НА ДОГОВОРА', `Договорът е сключен считано от ${contract.start_date} и е ${contract.end_date ? `срочен — до ${contract.end_date}` : 'безсрочен'}.`));
    children.push(...clause(6, 'ПРАВА И ЗАДЪЛЖЕНИЯ НА СТРАНИТЕ', [
      'Работникът/Служителят се задължава да изпълнява възложената работа добросъвестно, да спазва трудовата дисциплина и правилата за безопасност на движението.',
      'Работодателят се задължава да осигури условия за изпълнение на работата и да заплаща уговореното възнаграждение в срок.',
    ]));
    children.push(...clause(7, 'ПРЕКРАТЯВАНЕ', 'Договорът се прекратява при условията и по реда на Кодекса на труда.'));
  } else {
    children.push(...clause(1, 'ПРЕДМЕТ НА ДОГОВОРА', 'Възложителят възлага, а Изпълнителят приема да извършва куриерски услуги за нуждите на Възложителя, съгласно неговите указания.'));
    children.push(...clause(2, 'ВЪЗНАГРАЖДЕНИЕ', `Възнаграждението по настоящия договор е в размер на ${contract.weekly_deduction_amount || 0} € седмично, определено съобразно изпълнените поръчки.`));
    children.push(...clause(3, 'СРОК НА ДОГОВОРА', `Договорът е в сила от ${contract.start_date} и е ${contract.end_date ? `до ${contract.end_date}` : 'безсрочен'}.`));
    children.push(...clause(4, 'ПРАВА И ЗАДЪЛЖЕНИЯ НА СТРАНИТЕ', [
      'Изпълнителят извършва възложената работа лично, като организира сам работното си време, без да е обвързан с трудова дисциплина.',
      'Възложителят заплаща уговореното възнаграждение съобразно реално извършената работа.',
    ]));
    children.push(...clause(5, 'ОТГОВОРНОСТ', 'Изпълнителят носи отговорност за качественото и срочно изпълнение на възложената работа съгласно общите правила на гражданското право.'));
    children.push(...clause(6, 'ПРЕКРАТЯВАНЕ', 'Договорът се прекратява с изтичане на срока, по взаимно съгласие или с писмено предизвестие от всяка от страните.'));
  }

  children.push(heading(`${isLabor ? '8' : '7'}. Данни за страните`));
  children.push(kvTable([
    ['Име', employeeName],
    ...(profile && profile.egn ? [['ЕГН', profile.egn]] : []),
    ...(profile && profile.address ? [['Адрес', profile.address]] : []),
    ...(profile && profile.phone ? [['Телефон', profile.phone]] : []),
    ...(profile && profile.email ? [['Имейл', profile.email]] : []),
  ]));

  if (termsText) {
    children.push(heading(isLabor ? 'Допълнителни клаузи' : 'Допълнителни условия'));
    children.push(...textParagraph(termsText));
  }

  children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  children.push(signatureRow(isLabor ? 'Работодател (подпис)' : 'Възложител (подпис)', isLabor ? 'Работник (подпис)' : 'Изпълнител (подпис)'));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildProtocolDocx, buildContractDocx, buildEmploymentContractDocx, COMPANY, FUEL_TYPE_LABELS };
