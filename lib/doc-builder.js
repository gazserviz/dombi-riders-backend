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
  HeadingLevel, AlignmentType, BorderStyle, WidthType, VerticalAlign, ShadingType, ImageRun,
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

function signatureRow(leftLabel, rightLabel, opts = {}) {
  const { leftStamp } = opts;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [leftLabel, rightLabel].map((label, idx) => new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        children: [
          new Paragraph({ text: '' }),
          new Paragraph({ text: '____________________', alignment: AlignmentType.CENTER }),
          new Paragraph({ children: [new TextRun({ text: label, color: MUTED, size: 18 })], alignment: AlignmentType.CENTER }),
          ...(idx === 0 && leftStamp ? [new Paragraph({ children: [new TextRun({ text: 'М.П.', color: MUTED, size: 18 })], alignment: AlignmentType.CENTER, spacing: { before: 60 } })] : []),
        ],
      })),
    })],
  });
}

// Вгражда РЕАЛНО извършените присъствени подписвания (огледално на
// signedStamp в lib/pdf-builder.js — вж. бележката за loadSignedEvents в
// lib/doc-render.js: без това .docx/.pdf файлът изглежда неподписан дори
// след успешно разписване в системата).
function signedStampParagraphs(events) {
  if (!events || !events.length) return [];
  const out = [
    new Paragraph({ text: '', spacing: { before: 200 } }),
    new Paragraph({
      children: [new TextRun({ text: 'ЕЛЕКТРОННО ПОДПИСАНО (присъствено)', bold: true, color: ACCENT, size: 18 })],
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'E4E7EC' } },
      spacing: { before: 120, after: 100 },
    }),
  ];
  for (const ev of events) {
    if (ev.imageBuffer) {
      try {
        out.push(new Paragraph({
          children: [new ImageRun({ data: ev.imageBuffer, transformation: { width: 140, height: 50 }, type: ev.imageMime === 'image/jpeg' ? 'jpg' : 'png' })],
        }));
      } catch (e) { /* неподдържан формат — показваме само текста по-долу */ }
    }
    const when = ev.completed_at ? new Date(ev.completed_at).toLocaleString('bg-BG') : '';
    const label = `✓ ${ev.signer_name}${ev.signer_role ? ' · ' + ev.signer_role : ''}${when ? ' · ' + when : ''}`;
    out.push(new Paragraph({ children: [new TextRun({ text: label, size: 18 })], spacing: { after: 60 } }));
  }
  return out;
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

// Единичен justified параграф с по-плътен interval (за номерирани точки/
// клаузи без отделно "Чл. N" заглавие — виж buildCivilAdContractDocx).
function justified(text, spacingAfter = 80) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, color: DARK })],
    spacing: { after: spacingAfter },
    alignment: AlignmentType.JUSTIFIED,
  });
}

// Номерира поред текстовете от items като "{prefix}{start+i}. {text}".
function numberedParagraphs(items, start = 1, prefix = '') {
  return items.map((t, i) => justified(`${prefix}${start + i}. ${t}`));
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
async function buildProtocolDocx({ protocol, vehicle, driverLabel, termsText, signedEvents }) {
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
  children.push(...signedStampParagraphs(signedEvents));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// Договор за наем на автомобил
// ---------------------------------------------------------------------------
async function buildContractDocx({ contract, vehicle, renterName, termsText, signedEvents }) {
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
    `Договорът влиза в сила от ${contract.start_date}${contract.start_time ? `, ${contract.start_time} ч.` : ''} и е ` +
    `${contract.end_date ? `със срок до ${contract.end_date}${contract.end_time ? `, ${contract.end_time} ч.` : ''}` : 'безсрочен, до прекратяването му по реда на настоящия договор'}.`
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
    'Да заплаща своевременно дължимите наемни вноски за периода на ползване.',
    'Да заплати на Наемодателя всички глоби, фишове и имуществени санкции за нарушения на Закона за движението по пътищата, ' +
      'настъпили през периода на наема, ведно с административна такса за обработка в размер на 20 лв. за всеки отделен случай, ' +
      'независимо дали нарушението е установено по време на наема или след връщането на автомобила.',
    'Да уведомява незабавно Наемодателя при ПТП, повреда или кражба на автомобила.',
  ]));

  children.push(...clause(6, 'ИЗПОЛЗВАНЕ НА АВТОМОБИЛА ЗА ПРЕВОЗ НА ПЪТНИЦИ', [
    'Наемателят може да използва автомобила за дейност по превоз на пътници и/или товари срещу възнаграждение единствено ' +
      'чрез лицензирани превозвачи и платформи, опериращи в съответствие със Закона за автомобилните превози.',
    'Забранено е използването на автомобила за нелицензирана таксиметрова дейност, включително чрез платформи и приложения, ' +
      'които към момента на ползването не разполагат с необходимия лиценз за таксиметров превоз на пътници по българското ' +
      'законодателство (напр. „Maxim“ и други сходни приложения, функциониращи без такъв лиценз).',
    'При установено нарушение на тази клауза Наемодателят има право незабавно да прекрати договора и да търси обезщетение ' +
      'за всички произтекли от това вреди, глоби и санкции.',
  ]));

  children.push(...clause(7, 'ЗАДЪЛЖЕНИЯ НА НАЕМОДАТЕЛЯ', [
    'Да предаде автомобила в изправно техническо състояние, с валидни документи и застраховки.',
    'Да осигурява своевременно техническо обслужване на автомобила извън случаите на повреда по вина на Наемателя.',
  ]));

  children.push(...clause(8, 'ОТГОВОРНОСТ ПРИ ЩЕТИ', [
    'Наемателят носи имуществена отговорност за щети по автомобила, настъпили през периода на ползване по негова вина, ' +
      'както и за всички глоби и санкции, наложени във връзка с управлението на автомобила през този период.',
    'Наемателят носи пълна имуществена отговорност за вреди, причинени умишлено, при груба небрежност, при управление след ' +
      'употреба на алкохол или наркотични вещества, или при извършване на престъпление с автомобила — независимо от размера ' +
      'на внесения депозит и независимо от наличие на застраховка „Каско“.',
    'Нормалното износване на автомобила вследствие на обичайната му употреба не се счита за щета по смисъла на този член.',
  ]));

  children.push(...clause(9, 'ПРЕКРАТЯВАНЕ',
    'Договорът може да бъде прекратен по взаимно съгласие, с едностранно писмено предизвестие от всяка от страните, ' +
    'или незабавно при съществено неизпълнение на задълженията по настоящия договор.'
  ));

  children.push(heading('10. Данни за автомобила и наемателя'));
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
    children.push(heading('11. Допълнителни условия'));
    children.push(...textParagraph(termsText));
  }

  children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  children.push(signatureRow('Наемодател (подпис)', 'Наемател (подпис)', { leftStamp: true }));
  children.push(...signedStampParagraphs(signedEvents));

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
async function buildEmploymentContractDocx({ contract, profile, termsText, signedEvents }) {
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
  children.push(...signedStampParagraphs(signedEvents));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// ГРАЖДАНСКИ ДОГОВОР „ЗА РЕКЛАМА И ПРЕНОС НА СТОКА“ — .docx огледало на
// buildCivilAdContractPdf в lib/pdf-builder.js (вж. бележката там за пълния
// контекст на този шаблон, 4-те приложения, молбата и декларацията за
// осигуряване). Пазено в синхрон текст-по-текст с PDF версията.
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

async function buildCivilAdContractDocx({ contract, profile, signedEvents, termsText }) {
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

  const children = [
    ...letterhead('Договор за реклама и пренос на стока', `Статус: ${EC_STATUS_LABELS[contract.status] || contract.status}`, [`№ ${contract.contract_number}`, `Дата: ${startDateFmt}`]),
    preamble(
      `Днес, ${startDateFmt}, в гр. София се сключи настоящият граждански договор между ${AD_COMPANY.name}, с ЕИК ${AD_COMPANY.eik}, ` +
      `със седалище и адрес на управление в ${AD_COMPANY.address}, представлявано от ${AD_COMPANY.manager}, наричано по-нататък в договора Възложител, и ${employeeName}` +
      `${profile && profile.egn ? ', ЕГН ' + profile.egn : ''}, наричан по-нататък в договора Изпълнител, за следното:`
    ),
    justified('Настоящият договор отменя всички предишни договори, сключени между дружеството и лицето ' + employeeName + '.'),
    justified(
      'Настоящият договор се сключва въз основа на предварително предоставени лични данни от Изпълнителя, чрез подписана Декларация ' +
      'за съгласие за обработка на лични данни (Приложение 1). Същата съдържа следните данни: три имена, ЕГН, адрес, данни от лична карта, ' +
      'телефон и имейл, и представлява неразделна част от този договор.'
    ),
    justified('Дефиниция: В настоящия договор всички платформи, с които Възложителят си партнира, се посочват под общото наименование „Платформата“.'),
    heading('I. ПРЕДМЕТ НА ДОГОВОРА'),
    justified(
      `1. С настоящия договор Възложителят възлага, а Изпълнителят се задължава да носи рекламно облекло и рекламна табела на автомобила, ` +
      `поставена на видно място, да извърши доставки на стоки до достигането на ${capKm} (${capKm.toLocaleString('bg-BG')}) км или ${capDeliveries} (${capDeliveries.toLocaleString('bg-BG')}) доставки ` +
      `(за всяка платформа отделно), което настъпи първо, използвайки пътя, маршрута, процедурата и транспортното средство, които счита за ` +
      `най-подходящи за възможно най-доброто изпълнение на поставената задача чрез приложението Платформата, инсталирано на личното си смарт устройство.`
    ),
    justified('2. Изпълнителят следва да използва за целите на настоящия договор моторно превозно средство или велосипед, подробно описани в Приложение 1 - Декларация за съгласие за обработка на лични данни.'),
    heading('II. ПРАВА И ЗАДЪЛЖЕНИЯ НА ИЗПЪЛНИТЕЛЯ'),
  ];

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
  children.push(...numberedParagraphs(IZP));

  children.push(heading('III. ПРАВА И ЗАДЪЛЖЕНИЯ НА ВЪЗЛОЖИТЕЛЯ'));
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
  children.push(...numberedParagraphs(VZL));

  children.push(heading('IV. ВЪЗНАГРАЖДЕНИЕ И НАЧИН НА ПЛАЩАНЕ'));
  const PAY = [
    `За изпълнение предмета на този договор, Възложителят заплаща възнаграждение на Изпълнителя след успешно изминати ${capKm} км (${capKm.toLocaleString('bg-BG')} километра) или успешно изпълнени ${capDeliveries} (${capDeliveries.toLocaleString('bg-BG')}) доставки, което достигне първо, представяйки рекламираните брандове съответно чрез табела, поставена в автомобила и рекламно облекло и след предаден от страна на Изпълнителя и приет от страна на Възложителя приемо-предавателен протокол за извършената работа, както и попълнена от Изпълнителя декларация (по образец, изпратен от Възложителя) с информация за осигурителния си доход.`,
    `Възложителят заплаща на Изпълнителя възнаграждение в размер на ${rateKm} евро бруто за всеки изминат километър и/или ${rateDelivery} евро бруто за всяка успешно осъществена доставка. Изпълнителят прави и предава на Възложителя писмен отчет за успешно осъществени поръчки в платформата Платформата.`,
    'При изпълнение на условията в т.1 Възложителят осчетоводява положения от Изпълнителя труд на всяко тримесечие.',
    'Плащането се осъществява в срок от 3 дни от приемането от страна на Възложителя на приемо-предавателния протокол за извършена работа и попълнена от Изпълнителя декларация (по образец, изпратен от Възложителя) с информация за осигурителния си доход.',
    'Възнаграждението се заплаща в брой.',
  ];
  children.push(...numberedParagraphs(PAY));

  children.push(heading('V. ЛИЧНИ ДАННИ'));
  children.push(justified(
    '1. С подписването на този договор Изпълнителят предоставя изричното си съгласие на Възложителя за събирането, организирането, ' +
    'обработването и предоставянето на трети лица, в това число едноличния собственик, счетоводни предприятия, и други контрагенти на ' +
    'Възложителя, със седалище в и извън държавите-членки на Европейския съюз, на личните данни на Изпълнителя, съгласно Закона за защита ' +
    'на личните данни, с цел надлежно изпълнение на задълженията на Страните по договора, управление на човешки ресурси, счетоводна ' +
    'отчетност или ако това се изисква от приложимото законодателство.'
  ));

  children.push(heading('VI. ВЛИЗАНЕ В СИЛА НА ДОГОВОРА. ПРЕКРАТЯВАНЕ'));
  const TERM = [
    `Настоящият договор влиза в сила от датата на сключването му за срок от ${termYears} ${termYears === 1 ? 'година' : 'години'}.`,
    `Настоящият договор се преподновява автоматично след изпълнението му или след изтичането на срока, в случай, че някоя от страните не е заявила изрично писмено желание за прекратяване на договора най-малко една седмица преди изтичането му.`,
    `Настоящият договор се прекратява по взаимно съгласие на страните или с ${noticeMonths === 1 ? 'едномесечно' : noticeMonths + '-месечно'} писмено предизвестие, отправено от едната до другата страна, като Изпълнителят се задължава в срок от 3 последователни дни след прекратяването му да върне на Възложителя предоставеното му оборудването или неговата стойност в евро, подробно описани в Приложение IV - „Приемо-предавателен протокол за полученото оборудване“ за своя сметка, както и натрупания в резултат от извършвани бързи доставки оборот. При забава на връщането на оборудването или неговата парична равностойност, както и натрупания оборот, с повече от три последователни дни, Изпълнителят поема всички евентуални неблагоприятни последици от гражданско и наказателно-правен характер.`,
    'Възложителят има право да прекрати едностранно настоящия договор без предизвестие в случай на нарушаване от страна на Изпълнителя настоящия договор, ведно със съпътстващите го приложения, нарушаване от негова страна на морално-етични норми на поведение, като и приспадне от дължимото към него възнаграждение стойността на причинените от него вреди и щети.',
    'Възложителят има право да прекрати настоящия договор при прекъсване на дейността на Изпълнителя за период от над 10 (десет) календарни дни, без да уведоми Изпълнителя за такова прекъсване.',
  ];
  children.push(...numberedParagraphs(TERM));

  children.push(heading('VII. ОБЩИ РАЗПОРЕДБИ'));
  const GEN = [
    'За всичко неупоменато в този договор се прилагат разпоредбите на гражданското законодателство.',
    'Страните по договора ще пазят в тайна информацията, която ще постъпва при тях във връзка с изпълнението на този договор и няма да я правят достояние на трети лица за цялото време на същия и след неговото прекратяване.',
    'Никаква част от настоящия договор, както и от прилежащите му документи, подписани между Възложителя и Изпълнителя, не могат да бъдат използвани от Изпълнителя за каквито и да било други цели, нито да стават достояние на трети страни, без изричното съгласие от страна на Възложителя. При нарушение на горното Възложителят има право да изиска и получи възстановяване от Изпълнителят на всички суми, получени от Възложителя под формата на разходи за дейността, аванси, плащания и други, считано от датата на подписване на настоящия договор.',
    'Промени в договора се правят с анекси, подписани от страните по него и представляващи негова неразделна част.',
    'Възникналите спорове при изпълнение на договора ще се решават от страните доброволно, а в случай на несъгласие, споровете ще се отнасят за разрешаване от съда.',
    'Приложения – неразделни части от Договора:',
  ];
  children.push(...numberedParagraphs(GEN));
  children.push(justified('6.1. Приложение 1 - Декларация за съгласие за обработка на лични данни;'));
  children.push(justified('6.2. Приложение 2 – Декларация за конфиденциалност и отговорност;'));
  children.push(justified('6.3. Приложение 3 – Изисквания на Платформата;'));
  children.push(justified('6.4. Приложение 4 – Приемо-предавателен протокол за полученото оборудване'));
  children.push(justified('Настоящият договор се състави и подписа в два еднообразни екземпляра – по един за всяка от страните.'));

  if (termsText) {
    children.push(heading('Допълнителни условия'));
    children.push(...textParagraph(termsText));
  }

  children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
  children.push(signatureRow('Изпълнител (подпис)', 'Възложител (подпис)'));

  // --- Приложение 1: ГДПР декларация -----------------------------------
  children.push(heading('ПРИЛОЖЕНИЕ 1 — ДЕКЛАРАЦИЯ ЗА СЪГЛАСИЕ ЗА ОБРАБОТКА НА ЛИЧНИ ДАННИ'));
  children.push(justified('на основание чл. 6, ал. 1, б. „а“ и „б“ от Регламент (ЕС) 2016/679 (GDPR)'));
  children.push(justified('1. Долуподписаният:'));
  children.push(kvTable([
    ['Три имена', employeeName],
    ['ЕГН', profile && profile.egn],
    ['Адрес', profile && profile.address],
    ['Телефон', profile && profile.phone],
    ['Имейл', profile && profile.email],
    ['№ на лична карта', profile && profile.id_card_number],
    ['Дата на издаване', profile && profile.id_card_issue_date ? new Date(profile.id_card_issue_date).toLocaleDateString('bg-BG') : null],
    ['Издадена от (МВР – град)', profile && profile.id_card_issued_by],
  ]));
  children.push(justified('2. Данни за превозно средство:'));
  children.push(kvTable([
    ['Вид', VEHICLE_KIND_LABELS[ov.type] || ov.type || 'Автомобил'],
    ['Електрическо ли е', ov.electric ? 'Да' : 'Не'],
  ]));
  children.push(justified('3. Характеристики на превозното средство (ако е велосипед, не е приложимо):'));
  children.push(kvTable([
    ['Марка', ov.make],
    ['Модел', ov.model],
    ['Регистрационен номер', ov.plate],
    ['Дата на първа регистрация', ov.reg_year],
    ['Вид гориво', ov.fuel],
    ['Разход на 100 км', ov.consumption],
  ]));
  children.push(justified('Изпълнителят е длъжен за уведоми ДОМБИ РАЙДЪРС ЕООД при смяна на договореното МПС.'));
  children.push(justified(
    'С подписването на настоящата декларация давам доброволно съгласието си личните ми данни, изброени по-горе, както и всички други ' +
    'предоставени от мен данни, да бъдат събирани, обработвани, използвани, съхранявани и предавани от ДОМБИ РАЙДЪРС ЕООД за целите на ' +
    'изготвяне, сключване, администриране и изпълнение на договор(и) за предоставяне на услуги, водене на счетоводна и трудово-правна ' +
    'отчетност, комуникация, вкл. чрез електронни канали, и защита на законните интереси на фирмата при евентуални спорове. Запознат/а ' +
    'съм с правата си по GDPR, вкл. право на достъп, корекция, ограничаване на обработването, оттегляне на съгласието и право да подам ' +
    'жалба пред КЗЛД. Съгласявам се личните ми данни да се съхраняват за срок до 5 години от прекратяване на договорните отношения или ' +
    'по-дълъг срок, предвиден от закона.'
  ));
  children.push(justified(`Дата: ${startDateFmt}    Име: ${employeeName}`));

  // --- Приложение 2: Конфиденциалност -----------------------------------
  children.push(heading('ПРИЛОЖЕНИЕ II — ДЕКЛАРАЦИЯ ЗА КОНФИДЕНЦИАЛНОСТ И ОТГОВОРНОСТ'));
  children.push(justified('към договор за реклама и пренос на стока'));
  children.push(justified(`Долуподписаният ${employeeName}, информиран съм, че от момента на получаването на този документ, нося отговорност за да опазя неговото съдържание в пълна конфиденциалност, да не запознавам с него трети лица и потвърждавам, че:`));
  const CONF = [
    'Безсрочно се ангажирам да не разпространявам каквато и да било информация, касаеща реда и условията по договора ми с ДОМБИ РАЙДЪРС ЕООД, GDPR политики, нито каквато и да било част от всички документи, с които съм бил запознат — имена, телефони, адреси на колеги и сътрудници на фирмата, информация станала ми достояние посредством Viber, WhatsApp, Telegram, Facebook и други подобни групи, телефонни разговори и други средства за комуникация, по време на моето сътрудничество и след това.',
    'Безсрочно се ангажирам да не агитирам други служители и сътрудници на фирмата към прекратяване на тяхното сътрудничество или преместването им към друга фирма и няма с каквито и да е думи, публикации, преки или косвени действия да уронвам доброто име на ДОМБИ РАЙДЪРС ЕООД.',
    'Декларирам, че по време на и след прекратяването на договора, сключен между мен и ДОМБИ РАЙДЪРС ЕООД няма да водя разговори за наемане, преговори с друга фирма подизпълнител или използваща бранда Платформата, нито директно с фирмата собственик на бранда Платформата, нито тяхно дъщерно или свързано дружество и няма да сключвам каквито и да е договори с такива в следващите 3 години. Приемам, че подобно действие би се считало за конфликт на интереси, нарушаване опазването на търговските тайни и нарушение на GDPR политиките, които се ангажирам да спазвам.',
    'Наясно съм, че неотчитането на каквато и да била сума, получена по време на изпълнението на микрозадачи, организирани чрез приложението Платформата Couriers, в срок най-късно до 24 часа от получаването ѝ, може да се приеме за нарушаване на договора с ДОМБИ РАЙДЪРС ЕООД, което да доведе до съответните неустойки.',
    'Приемам, че при приключване на договорните си отношения с ДОМБИ РАЙДЪРС ЕООД дължа връщането на предоставеното ми оборудване в срок от 3 (три дни) от извършване на последната доставка, като го предам лично според указанията. В случай, че не върна или представя същото в мръсно или увредено състояние, освен в случаите на обичайното изхабяване, дължа към ДОМБИ РАЙДЪРС ЕООД заплащане на неговата пълна стойност.',
  ];
  children.push(...numberedParagraphs(CONF));
  children.push(justified('6. При поява на ситуация от гореописаните обстоятелства, решението на която не може да бъде уредена посредством преговори и споразумение, ДОМБИ РАЙДЪРС ЕООД ще бъде в правото си да не приеме за изпълнен в каквато и да било степен от моя страна сключения между нас договор, поради което в такъв случай се задължавам:'));
  const CONF6 = [
    'Да възстановя полученото оборудване или неговата стойност, съгласно т.5.',
    'Да възстановя, ако има неотчетени от мен суми, получени по време на изпълнение на микрозадачи, организирани чрез приложението Платформата Couriers.',
    'Да възстановя направените от ДОМБИ РАЙДЪРС ЕООД разходи по създаването и поддръжката на акаунта ми в Платформата Couriers.',
    'Да възстановя на ДОМБИ РАЙДЪРС ЕООД всички суми, изплатени към мен в брой или по банков път като неустойка, поради нарушаване клаузите на договора.',
    'Да заплатя всички пропуснати ползи на ДОМБИ РАЙДЪРС ЕООД, произтичащи от незапочване, неизпълнение или виновно прекъсване на предоставения ми договор, като приема без протест калкулацията за тях.',
    'Да възстановя на ДОМБИ РАЙДЪРС ЕООД всички суми по събирането на вземанията, като възнаграждения на юрист, адвокатски хонорар, допълнителна комисионна към фирма за събиране на дългове и други.',
  ];
  children.push(...numberedParagraphs(CONF6));
  children.push(justified(
    'При игнориране на гореописаното от моя страна, ДОМБИ РАЙДЪРС ЕООД може без да ме уведомява допълнително да: сигнализира органите на ' +
    'МВР и Прокуратурата за извършено престъпление, кражба, незаконно задържане на вещи и пари, чужда собственост и да поиска образуването ' +
    'от страна на Прокуратурата на досъдебно производство; потърси правата си по съдебен ред, заедно с лихва за забава, равна на основния ' +
    'лихвен процент на БНБ плюс десет пункта наказателна лихва и направените от фирмата разходи, включително и адвокатски хонорар; използва ' +
    'правото си да издири и уведоми всички мои настоящи и бъдещи работодатели за моето поведение, водещо до нарушаване на ангажиментите ' +
    'поети по Договор, противозаконното задържане на вещи и пари, нарушаване на GDPR политики, изнасяне на фирмена информация и нарушаване ' +
    'на корпоративни тайни, уронване на престижа на компанията и други; продаде задължението ми на агенция за издирване на длъжници и ' +
    'изкупуване на дългове.'
  ));
  children.push(justified('Настоящото подписвам в електронен вариант и се счита за част от договорните ми отношения с ДОМБИ РАЙДЪРС ЕООД.'));
  children.push(justified(`Дата: ${startDateFmt}    Име: ${employeeName}`));

  // --- Приложение 3: Изисквания на Платформата ---------------------------
  children.push(heading('ПРИЛОЖЕНИЕ III — ИЗИСКВАНИЯ НА ПЛАТФОРМАТА'));
  children.push(justified('чрез ДОМБИ РАЙДЪРС ЕООД, в качеството си на подизпълнител на Платформата'));
  children.push(justified('1. Доставчикът да притежава:'));
  const REQ1 = [
    'заверена лична здравна книжка.',
    'МПС с валидни гражданска застраховка и технически преглед (не важи за доставчици, заявили, че ще извършват доставки с личен велосипед).',
    'Валидна шофьорска книжка.',
  ];
  children.push(...REQ1.map((t, i) => justified(`1.${i + 1}. ${t}`)));
  children.push(justified('2. Доставчикът се задължава да:'));
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
  children.push(...REQ2.map((t, i) => justified(`2.${i + 1}. ${t}`)));
  children.push(justified('3. Доставчикът няма право да:'));
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
  children.push(...REQ3.map((t, i) => justified(`3.${i + 1}. ${t}`)));
  children.push(justified('Прочетох и съм наясно с всичко описано.'));
  children.push(justified(`Дата: ${startDateFmt}    Име: ${employeeName}`));

  // --- Приложение 4: Приемо-предавателен протокол за оборудването --------
  children.push(heading('ПРИЛОЖЕНИЕ IV — ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ'));
  const equipmentTotal = equipment.reduce((s, e) => s + (Number(e.value) || 0), 0);
  children.push(justified(
    `Днес, ${startDateFmt} г., гр. София, между ${AD_COMPANY.name}, вписано в Търговски регистър, с ЕИК ${AD_COMPANY.eik}, ДДС регистрация ${AD_COMPANY.vat}, ` +
    `със седалище и адрес на управление в ${AD_COMPANY.address}, представлявано от ${AD_COMPANY.manager} – управител, наричан по-долу Възложител и ${employeeName}, ` +
    `наричан по-долу Изпълнител, се подписа настоящия приемо-предавателен протокол, за следното:`
  ));
  children.push(justified('1. Във връзка със сключен между Възложителя и Изпълнителя настоящия граждански договор за реклама, извършвайки доставки чрез приложението Платформата от, на Изпълнителя се предоставя рекламно облекло, оборудване и пари за правилно изпълнение на възложената работа.'));
  children.push(justified(`2. Възложителят предаде на Изпълнителя в пълна изправност, следното облекло, оборудване на обща стойност ${equipmentTotal} евро, видими в персоналния акаунт на Работника в приложението Платформата, както следва:`));
  for (let i = 0; i < equipment.length; i++) {
    children.push(justified(`${i + 1}. ${equipment[i].name} – 1 бр., на стойност ${equipment[i].value} евро.`));
  }
  children.push(justified(`${equipment.length + 1}. Оборотни пари, които се генерират чрез приложението Платформата, получавайки ги от клиенти.`));
  const PROT = [
    'Изпълнителят приема предадените му рекламно облекло и оборудване, без възражения и бележки. Приетото облекло и оборудване следва да се поддържа чисто през целия срок на експлоатацията му и да бъде върнато почистено.',
    'Изпълнителят приема да носи финансовата отговорност за получените оборотни пари, оперирайки с приложението Платформата и се задължава да ги отчита в цялостен размер чрез платформата на Изипей, чрез своя идентификационен номер всеки ден.',
    'В случай, че предоставеното на Изпълнителя рекламно облекло и оборудване погине, без значение по каква причина, Изпълнителят дължи на Възложителя неговата парична равностойност, посочена в т. 2.1; т. 2.2.; т. 2.3. и т. 2.4., в срок от пет работни дни от настъпване на събитието. В случай, че Договорът не е прекратен към момента на погиването, Възложителят има право да приспадне дължимата за облеклото и оборудването сума от възнаграждението на Изпълнителя по договор.',
    'При прекратяване на Договора Изпълнителят е длъжен да върне предоставените му рекламно облекло, оборудване и пари или документи, удостоверяващи отчитането на събраните оборотни пари към Платформата, в срок от три календарни дни от деня на прекратяването. За предаването да се подпише предавателно-приемателен протокол, в който се описва състоянието, в което се предават облеклото и оборудването. В случай на констатирани повреди, липса или замърсен външен вид на предаденото облекло и оборудване, се описва в предавателно-приемателен протокол и Изпълнителят се задължава незабавно да възстанови паричната равностойност на облеклото и оборудването съобразно т. 2 от настоящия приемо-предавателен протокол.',
    'В случай, че Изпълнителят не изпълни задължението си да върне предоставеното му във връзка със сключения с него Договор рекламно облекло, оборудване и пари или документи, удостоверяващи отчитането на събраните оборотни пари към Платформата, Възложителят има следните права: да се снабди с изпълнителен лист по реда на чл. 410 ГПК, без възражения от Изпълнителя, заедно със законна лихва за забава, начислена за всеки ден просрочие, след изтичане на срока по т. 3 от настоящия приемо-предавателен протокол, равна на основния лихвен процент на БНБ плюс 10 пункта наказателна лихва и разноските по делото, както и заплатените адвокатски хонорари; да сигнализира органите на МВР и Прокуратурата за невърнатото облекло, оборудване и пари от Изпълнителя; да търси правата си по съдебен ред, заедно с обезщетение за нанесени имуществени вреди и пропуснати ползи, законна лихва, равна на основния лихвен процент на БНБ плюс 10 пункта наказателна лихва, държавните такси, депозити за вещи лица, адвокатски хонорари; да уведоми работодателите, при които Изпълнителят постъпва на работа след прекратяването на сключения с него Договор за некоректното му поведение и присвояване на предоставеното му облекло, оборудване и пари.',
    'Настоящият приемо-предавателен протокол се състави и подписа в два еднообразни екземпляра – по един за всяка от страните и е неразделна част от Договора.',
  ];
  children.push(...numberedParagraphs(PROT, 3));
  children.push(new Paragraph({ text: '', spacing: { before: 200 } }));
  children.push(signatureRow('Изпълнител (подпис)', 'Възложител (подпис)'));

  // --- Молба --------------------------------------------------------------
  children.push(heading('МОЛБА'));
  children.push(justified(`От ${employeeName},`));
  children.push(justified('Уважаеми г-н Управител,'));
  children.push(justified(
    `С настоящата молба Ви моля за Вашето съгласие за извършването на рекламна дейност и доставки по заявка чрез приложението Платформата. ` +
    `Същите ще извършвам чрез личен ${VEHICLE_KIND_LABELS[ov.type] || 'автомобил/велосипед/скутер/мотор'}. Моля за целта броят поръчки да бъде фиксиран в граждански договор към ${AD_COMPANY.name}.`
  ));
  children.push(justified('Декларирам, че притежавам лична здравна книжка, застраховка Гражданска отговорност и преглед на МПС марка.'));
  children.push(justified(`Дата: ${startDateFmt}    Име: ${employeeName}`));

  // --- Декларация за осигуряване ------------------------------------------
  children.push(heading('ДЕКЛАРАЦИЯ ЗА ОСИГУРЯВАНЕ'));
  children.push(justified(`Долуподписаният/ата ${employeeName}, с ЕГН/ЛНЧ: ${(profile && profile.egn) || '—'},`));
  children.push(justified(`Декларирам, че за месец ${todayFmt.slice(3)} г.:`));
  children.push(kvTable([
    ['Осигурителният ми статус е', (profile && profile.insurance_status) || '—'],
    ['Брутна сума', profile && profile.insurance_gross_amount != null ? `${profile.insurance_gross_amount} €` : '—'],
  ]));
  children.push(justified('Известно ми е, че за декларирани неверни данни нося наказателна отговорност по чл. 313 от Наказателния кодекс.'));
  children.push(justified(`Настоящата декларация да послужи пред ${AD_COMPANY.name} във връзка с изплащане на суми по договор на основание чл. 280 - 292 от Закона за задълженията и договорите.`));
  children.push(justified(`Дата: ${todayFmt}    Име: ${employeeName}`));

  children.push(...signedStampParagraphs(signedEvents));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = {
  buildProtocolDocx, buildContractDocx, buildEmploymentContractDocx, buildCivilAdContractDocx,
  COMPANY, FUEL_TYPE_LABELS,
};
