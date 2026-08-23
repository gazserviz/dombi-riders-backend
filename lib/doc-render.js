// ============================================================================
// lib/doc-render.js — обединява трите "нива" на генериране на бланки
// (протокол / договор) в едно място, което server.js вика:
//
//   Ниво 1 (ВИНАГИ работи, тествано): вградена бланка (lib/doc-builder.js за
//   .docx, lib/pdf-builder.js за .pdf) + редактируем текст на "Общи условия"
//   от document_templates (ако администраторът го е сменил).
//
//   Ниво 2 (опция, изисква качен .docx шаблон + пакетите docxtemplater/
//   pizzip да са реално инсталирани — виж lib/doc-templates.js): попълва
//   качения от админа .docx с {{токени}}.
//
//   PDF от Ниво 2, и по-качествен (векторен) PDF от Ниво 1, минават през
//   LibreOffice (lib/docx-to-pdf.js), АКО е наличен на сървъра — иначе PDF от
//   Ниво 1 пада към растеризирания генератор (lib/pdf-builder.js, тестван,
//   работи навсякъде), а PDF от Ниво 2 без LibreOffice не е възможен (връща
//   ясна грешка — тогава остава само .docx бутонът за качения шаблон).
// ============================================================================

const db = require('./db');
const docBuilder = require('./doc-builder');
const pdfBuilder = require('./pdf-builder');
const docTemplates = require('./doc-templates');
const docxToPdf = require('./docx-to-pdf');

const RATE_PERIOD_LABELS = { day: 'ден', week: 'седмица', month: 'месец' };
const CONTRACT_STATUS_LABELS = { draft: 'Чернова', active: 'Активен', completed: 'Приключен', terminated: 'Прекратен' };
const RENTER_TYPE_LABELS = { dombi_courier: 'Куриер на Dombi Riders', other_platform: 'Друга платформа', personal_use: 'Лично ползване' };
const FUEL_TYPE_LABELS_RENDER = { petrol: 'Бензин', diesel: 'Дизел', gas_petrol: 'Газ + Бензин', electric: 'Електрическа', hybrid: 'Хибрид' };

function getProtocolDriverLabel(protocol) {
  if (!protocol.assignment_id) return '—';
  const rawDb = db.readDb();
  const a = rawDb.vehicle_assignments.find(x => x.id === protocol.assignment_id);
  if (!a) return '—';
  if (a.driver_id) {
    const u = rawDb.profiles.find(p => p.id === a.driver_id);
    return u ? u.full_name : a.driver_id;
  }
  return `${a.external_name || '—'} (външен)`;
}

function getContractRenterName(contract) {
  if (contract.renter_type === 'dombi_courier' && contract.renter_driver_id) {
    const rawDb = db.readDb();
    const u = rawDb.profiles.find(p => p.id === contract.renter_driver_id);
    if (u) return u.full_name;
  }
  return contract.renter_name || '—';
}

function flattenProtocol(protocol, vehicle, driverLabel) {
  return {
    protocol_number: protocol.protocol_number,
    type_label: protocol.type === 'handover' ? 'Предаване на автомобил' : 'Приемане на автомобил',
    date: new Date(protocol.date).toLocaleString('bg-BG'),
    plate_number: vehicle ? vehicle.plate_number : protocol.vehicle_id,
    make: vehicle ? vehicle.make : '',
    model: vehicle ? vehicle.model : '',
    vin: vehicle ? vehicle.vin || '' : '',
    year: vehicle ? vehicle.year || '' : '',
    odometer_km: protocol.odometer_km != null ? `${protocol.odometer_km} км` : '—',
    fuel_type_label: FUEL_TYPE_LABELS_RENDER[protocol.fuel_type] || '—',
    fuel_level_pct: protocol.fuel_level_pct != null ? `${protocol.fuel_level_pct}%` : '—',
    fuel_level_secondary_pct: protocol.fuel_level_secondary_pct != null ? `${protocol.fuel_level_secondary_pct}%` : '—',
    driver_label: driverLabel,
    exterior_notes: protocol.exterior_notes || '',
    interior_notes: protocol.interior_notes || '',
  };
}

const EC_TYPE_LABELS_RENDER = { labor: 'Трудов договор', civil: 'Граждански договор' };
const EC_STATUS_LABELS_RENDER = { draft: 'Чернова', active: 'Активен', terminated: 'Прекратен' };

function getEmploymentContractProfile(contract) {
  const rawDb = db.readDb();
  return rawDb.profiles.find(p => p.id === contract.profile_id) || null;
}

function flattenEmploymentContract(contract, profile) {
  return {
    contract_number: contract.contract_number,
    contract_type_label: EC_TYPE_LABELS_RENDER[contract.contract_type] || contract.contract_type,
    status_label: EC_STATUS_LABELS_RENDER[contract.status] || contract.status,
    created_date: new Date(contract.created_at).toLocaleDateString('bg-BG'),
    hours_per_day: contract.hours_per_day || '',
    start_date: contract.start_date,
    end_date: contract.end_date || 'безсрочен',
    weekly_deduction_amount: `${contract.weekly_deduction_amount || 0} €`,
    employee_name: profile ? profile.full_name : contract.profile_id,
    employee_egn: profile ? profile.egn || '' : '',
    employee_address: profile ? profile.address || '' : '',
    employee_phone: profile ? profile.phone || '' : '',
    employee_email: profile ? profile.email || '' : '',
  };
}

function flattenContract(contract, vehicle, renterName) {
  return {
    contract_number: contract.contract_number,
    status_label: CONTRACT_STATUS_LABELS[contract.status] || contract.status,
    created_date: new Date(contract.created_at).toLocaleDateString('bg-BG'),
    renter_name: renterName,
    renter_type_label: RENTER_TYPE_LABELS[contract.renter_type] || contract.renter_type,
    renter_egn: contract.renter_egn || '',
    renter_phone: contract.renter_phone || '',
    renter_email: contract.renter_email || '',
    renter_address: contract.renter_address || '',
    plate_number: vehicle ? vehicle.plate_number : contract.vehicle_id,
    make: vehicle ? vehicle.make : '',
    model: vehicle ? vehicle.model : '',
    vin: vehicle ? vehicle.vin || '' : '',
    start_date: contract.start_date,
    end_date: contract.end_date || 'безсрочен',
    rate_amount: `${contract.rate_amount} € / ${RATE_PERIOD_LABELS[contract.rate_period] || contract.rate_period}`,
    deposit_amount: `${contract.deposit_amount || 0} €`,
    start_odometer_km: contract.start_odometer_km != null ? `${contract.start_odometer_km} км` : '—',
    end_odometer_km: contract.end_odometer_km != null ? `${contract.end_odometer_km} км` : '—',
  };
}

// documentType: 'protocol' | 'contract' | 'employment_contract'. За трудови/
// граждански договори се пазят ДВЕ отделни редактируеми бланки (различни са
// по съдържание) под doc_type 'employment_contract_labor' /
// 'employment_contract_civil' — виж resolveTemplateDocType по-долу.
function resolveTemplateDocType(documentType, document_) {
  if (documentType !== 'employment_contract') return documentType;
  return document_.contract_type === 'civil' ? 'employment_contract_civil' : 'employment_contract_labor';
}

function buildersFor(documentType, document_, vehicle) {
  if (documentType === 'protocol') {
    const driverLabel = getProtocolDriverLabel(document_);
    return {
      baseName: document_.protocol_number,
      flatten: () => flattenProtocol(document_, vehicle, driverLabel),
      docx: termsText => docBuilder.buildProtocolDocx({ protocol: document_, vehicle, driverLabel, termsText }),
      pdf: termsText => pdfBuilder.buildProtocolPdf({ protocol: document_, vehicle, driverLabel, termsText }),
    };
  }
  if (documentType === 'employment_contract') {
    const profile = getEmploymentContractProfile(document_);
    return {
      baseName: document_.contract_number,
      flatten: () => flattenEmploymentContract(document_, profile),
      docx: termsText => docBuilder.buildEmploymentContractDocx({ contract: document_, profile, termsText }),
      pdf: termsText => pdfBuilder.buildEmploymentContractPdf({ contract: document_, profile, termsText }),
    };
  }
  // 'contract' (договор за наем на кола)
  const renterName = getContractRenterName(document_);
  return {
    baseName: document_.contract_number,
    flatten: () => flattenContract(document_, vehicle, renterName),
    docx: termsText => docBuilder.buildContractDocx({ contract: document_, vehicle, renterName, termsText }),
    pdf: termsText => pdfBuilder.buildContractPdf({ contract: document_, vehicle, renterName, termsText }),
  };
}

// Връща { buffer, contentType, filename, tier, warning }.
async function renderDocument(documentType, document_, format) {
  const templateDocType = resolveTemplateDocType(documentType, document_);
  const template = db.getDocumentTemplate(templateDocType);

  let vehicle = null;
  if (documentType !== 'employment_contract') {
    const rawDb = db.readDb();
    vehicle = rawDb.vehicles.find(v => v.id === document_.vehicle_id) || null;
  }

  const b = buildersFor(documentType, document_, vehicle);
  const baseName = b.baseName;
  let warning = null;

  // --- Ниво 2: качен .docx шаблон -------------------------------------------------
  if (template.source === 'docx' && template.file_url) {
    if (docTemplates.isAvailable()) {
      const fs = require('fs');
      const path = require('path');
      // file_url е във вид "/uploads/<име>" — физически файлът стои в data/uploads
      // (виж UPLOADS_DIR в server.js), а не в public/, затова махаме префикса и
      // сочим директно към data/uploads.
      const filePath = path.join(__dirname, '..', 'data', 'uploads', template.file_url.replace(/^\/uploads\//, ''));
      try {
        const templateBuffer = fs.readFileSync(filePath);
        const data = b.flatten();
        const docxBuf = docTemplates.fillDocxTemplate(templateBuffer, data);
        if (format === 'docx') {
          return { buffer: docxBuf, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${baseName}.docx`, tier: 'uploaded_docx' };
        }
        // format === 'pdf' — опит за конверсия през LibreOffice
        try {
          const pdfBuf = await docxToPdf.convertDocxToPdf(docxBuf);
          return { buffer: pdfBuf, contentType: 'application/pdf', filename: `${baseName}.pdf`, tier: 'uploaded_docx_via_soffice' };
        } catch (convErr) {
          warning = 'PDF от качения Word шаблон не е наличен на този сървър (липсва LibreOffice) — показва се вградената бланка вместо това.';
          // пада към вградената бланка по-долу
        }
      } catch (fileErr) {
        warning = 'Качения шаблон не може да бъде прочетен — показва се вградената бланка вместо това.';
      }
    } else {
      warning = 'Качен е Word шаблон, но модулите за попълването му (docxtemplater/pizzip) не са активни на сървъра — показва се вградената бланка вместо това.';
    }
  }

  // --- Ниво 1: вградена бланка ------------------------------------------------------
  const termsText = template.source === 'builtin' ? template.content || null : null;

  if (format === 'docx') {
    const buffer = await b.docx(termsText);
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${baseName}.docx`, tier: 'builtin', warning };
  }

  // format === 'pdf' — опит за по-качествен PDF през LibreOffice, иначе растеризиран
  const docxBuffer = await b.docx(termsText);
  try {
    const pdfBuf = await docxToPdf.convertDocxToPdf(docxBuffer);
    return { buffer: pdfBuf, contentType: 'application/pdf', filename: `${baseName}.pdf`, tier: 'builtin_via_soffice', warning };
  } catch (e) {
    const buffer = await b.pdf(termsText);
    return { buffer, contentType: 'application/pdf', filename: `${baseName}.pdf`, tier: 'builtin_rasterized', warning };
  }
}

module.exports = {
  renderDocument, flattenProtocol, flattenContract, flattenEmploymentContract,
  getProtocolDriverLabel, getContractRenterName, getEmploymentContractProfile,
};
