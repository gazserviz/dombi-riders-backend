// ============================================================================
// lib/esign.js — електронно разписване на протоколи/договори (не трудови!),
// в два варианта:
//
//  1) ПРИСЪСТВЕНО ("in_person") — работи ВИНАГИ, без външни услуги. Подписващият
//     рисува подпис на екран (или потвърждава с име) пред служителя, снимката
//     на подписа + име + IP/user-agent + timestamp + SHA-256 хеш на самия
//     документ се записват като одиторска следа (esign_events). Това е т.нар.
//     "обикновен електронен подпис" (SES) по чл. 3, т. 10 от Регламент (ЕС)
//     № 910/2014 (eIDAS) — за протоколи/договори за наем българското право НЕ
//     изисква специална форма за действителност (свобода на формата, чл. 293
//     ЗЗД и сл.), затова SES е достатъчен като доказателствено средство.
//     ТЕСТВАНО в тази среда (само хеширане/файлова логика — без външна услуга).
//
//  2) ОТДАЛЕЧЕНО ("remote") — интеграция със SignNow REST API за изпращане на
//     покана за подпис по имейл до подписващия. Изисква истински SignNow
//     бизнес акаунт и SIGNNOW_ACCESS_TOKEN в средата (Render → Environment).
//     НЕ Е ТЕСТВАНО в тази среда (няма как да се сдобия с реални credentials
//     тук) — при липсващ токен връща ясна грешка вместо да се преструва, че е
//     изпратено (същия принцип като lib/talon-scan.js за ANTHROPIC_API_KEY).
//
// ВАЖНО ПРАВНО ЗАБЕЛЕЖКА (не е юридическа консултация): бъдещите ТРУДОВИ
// договори по КТ изискват КВАЛИФИЦИРАН електронен подпис (КЕП) от
// работодателя (чл. 62 КТ, Наредба № Н-14/2023) — SES/SignNow пътят тук НЕ
// покрива този случай; за HR модула ще трябва доставчик на КЕП (напр.
// Evrotrust, който има публично API за облачен/отдалечен КЕП).
// ============================================================================

const https = require('https');
const crypto = require('crypto');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// ПРИСЪСТВЕНО разписване — винаги достъпно, без външна услуга.
// ---------------------------------------------------------------------------
function recordInPersonSignature({ documentBuffer, signerName, signerRole, signatureImageUrl, ipAddress, userAgent }) {
  if (!signerName || !String(signerName).trim()) {
    throw new Error('Липсва име на подписващия');
  }
  return {
    method: 'in_person',
    provider: 'in_house',
    status: 'signed_in_person',
    signer_name: signerName,
    signer_role: signerRole || null,
    signature_image_url: signatureImageUrl || null,
    document_hash: documentBuffer ? sha256(documentBuffer) : null,
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
    completed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// ОТДАЛЕЧЕНО разписване през SignNow REST API.
// Документация (към момента на писане): https://docs.signnow.com/docs/signnow/reference
// Изисква SIGNNOW_ACCESS_TOKEN (Bearer токен от SignNow бизнес акаунт).
// ---------------------------------------------------------------------------
const SIGNNOW_HOST = 'api.signnow.com';

function signnowRequest(method, path, { token, body, isMultipart, multipartBoundary }) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` };
    let payload = null;
    if (isMultipart) {
      headers['content-type'] = `multipart/form-data; boundary=${multipartBoundary}`;
      payload = body; // вече е Buffer, сглобен от извикващия
      headers['content-length'] = payload.length;
    } else if (body) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: SIGNNOW_HOST, path, method, headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : {}; } catch (e) { json = { raw: data }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`SignNow API грешка ${res.statusCode}: ${JSON.stringify(json).slice(0, 300)}`));
          return;
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function buildMultipartUpload(filename, fileBuffer) {
  const boundary = '----dombiEsign' + crypto.randomBytes(8).toString('hex');
  const pre = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/pdf\r\n\r\n`
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, buffer: Buffer.concat([pre, fileBuffer, post]) };
}

// Изпраща документ (PDF буфер) за отдалечено подписване по имейл.
// Връща { envelope_id, status } или хвърля грешка с code=NO_API_KEY, ако
// SIGNNOW_ACCESS_TOKEN липсва.
async function sendForRemoteSigning({ pdfBuffer, filename, signerEmail, signerName, subject, message }) {
  const token = process.env.SIGNNOW_ACCESS_TOKEN;
  if (!token) {
    const err = new Error('NO_API_KEY');
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (!signerEmail) throw new Error('Липсва имейл на подписващия');

  // 1) качване на документа
  const { boundary, buffer } = buildMultipartUpload(filename || 'document.pdf', pdfBuffer);
  const uploaded = await signnowRequest('POST', '/document', { token, body: buffer, isMultipart: true, multipartBoundary: boundary });
  const documentId = uploaded.id;
  if (!documentId) throw new Error('SignNow не върна ID на документа');

  // 2) покана за подпис по имейл
  await signnowRequest('POST', `/document/${documentId}/invite`, {
    token,
    body: {
      to: [{ email: signerEmail, role_id: '', role: 'Signer 1', order: 1 }],
      from: process.env.SIGNNOW_SENDER_EMAIL || signerEmail,
      subject: subject || 'Моля, подпишете документа — Dombi Riders',
      message: message || 'Приложен е документ за електронно подписване от Dombi Riders ЕООД.',
    },
  });

  return { envelope_id: documentId, status: 'sent_remote' };
}

// Проверява статуса на вече изпратен документ.
async function checkRemoteStatus(envelopeId) {
  const token = process.env.SIGNNOW_ACCESS_TOKEN;
  if (!token) {
    const err = new Error('NO_API_KEY');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const doc = await signnowRequest('GET', `/document/${envelopeId}`, { token });
  const signed = Array.isArray(doc.signatures) && doc.signatures.length > 0;
  return { status: signed ? 'signed_remote' : 'sent_remote', raw: doc };
}

module.exports = {
  sha256,
  recordInPersonSignature,
  sendForRemoteSigning,
  checkRemoteStatus,
  isRemoteConfigured: () => !!process.env.SIGNNOW_ACCESS_TOKEN,
};
