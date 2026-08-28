// ============================================================================
// lib/talon-scan.js — разчитане на данни от снимки чрез AI (Claude Vision):
// талон (свидетелство за регистрация на МПС), лична карта, шофьорска книжка.
//
// Изисква променлива на средата ANTHROPIC_API_KEY (задава се в Render → Environment).
// Без зададен ключ връща ясна грешка, а не измислени данни.
// ============================================================================

const https = require('https');

const TALON_PROMPT = `Ти получаваш снимка на български СВИДЕТЕЛСТВО ЗА РЕГИСТРАЦИЯ НА МПС (талон),
част I. Полетата на този документ са означени с кодове в скоби — (A), (E), (D.1), (D.3),
(R), (J), (F.1), (P.2), (S.1), (C.1.1), (C.1.3), (I) и т.н. Прочети ВНИМАТЕЛНО и ТОЧНО
какво е написано в съответното поле на ТАЗИ КОНКРЕТНА снимка — не давай типови, примерни
или предполагаеми стойности.

Извлечи следните полета, ако се виждат на снимката, и върни СТРОГО валиден JSON обект
(без markdown, без обяснения) с точно следните ключове:

{
  "plate_number": "регистрационният номер от поле (A) на талона, точно както е изписан на тази снимка",
  "vin": "рама / VIN номерът от поле (E), точно както е изписан на тази снимка (обичайно 17 знака)",
  "make": "марката на превозното средство от поле (D.1)",
  "model": "моделът от поле (D.1)/(D.3)",
  "year": "година на първа регистрация, от датата в поле (J) (само число)",
  "color": "цветът от поле (R)",
  "fuel": "тип гориво — избери ЕДНА от точно тези стойности: petrol | diesel | hybrid | electric | lpg | petrol_lpg (petrol_lpg = комбинирано бензин/газ, ако талонът показва и двете). Не връщай друг текст, само една от изброените стойности.",
  "engine_capacity_cc": "обемът на двигателя в куб.см от поле (F.1) (само число)",
  "power_kw": "мощността в kW от поле (P.2) (само число)",
  "seats": "броят места от поле (S.1) (само число)",
  "owner_name": "името на СОБСТВЕНИКА (юридическо или физическо лице) от поле (C.1.1) — това НЕ Е адресът от поле (C.1.3), не ги бъркай",
  "talon_number": "СОБСТВЕНИЯТ номер на самия документ (талона) — обикновено серия от 2 букви + 6-7 цифри, отпечатан в горния десен ъгъл или до баркод/QR код на бланката. Това НЕ Е регистрационният номер на колата (поле A) и НЕ Е рама/VIN номерът (поле E) — не ги бъркай"
}

ВАЖНО: Всяка стойност трябва да е прочетена директно от написаното на СНИМКАТА, а не да е
пример или предположение. Ако дадено поле не се чете ясно, остави стойността null — никога
не връщай измислена или примерна стойност само за да запълниш полето.
Върни САМО JSON обекта, нищо друго.`;

const ID_CARD_PROMPT = `Ти получаваш снимка на българска ЛИЧНА КАРТА (документ за самоличност).
Извлечи следните полета, ако се виждат на снимката, и върни СТРОГО валиден JSON обект
(без markdown, без обяснения) с точно следните ключове:

{
  "full_name": "три имена на притежателя, както са изписани на кирилица",
  "egn": "ЕГН (10 цифри)",
  "id_card_number": "номер на личната карта",
  "address": "постоянен адрес, ако е видим",
  "id_card_expiry": "дата на валидност (изтича на), формат YYYY-MM-DD"
}

Ако дадено поле не се чете ясно от снимката, остави стойността null. Не измисляй данни.
Върни САМО JSON обекта, нищо друго.`;

const DRIVER_LICENSE_PROMPT = `Ти получаваш снимка на българска СВИДЕТЕЛСТВО ЗА УПРАВЛЕНИЕ НА МПС
(шофьорска книжка). Извлечи следните полета, ако се виждат на снимката, и върни
СТРОГО валиден JSON обект (без markdown, без обяснения) с точно следните ключове:

{
  "full_name": "три имена на притежателя, както са изписани на кирилица",
  "driver_license_number": "номер на книжката",
  "categories": "категории, напр. B, BE",
  "driver_license_expiry": "дата на валидност (изтича на), формат YYYY-MM-DD"
}

Ако дадено поле не се чете ясно от снимката, остави стойността null. Не измисляй данни.
Върни САМО JSON обекта, нищо друго.`;

function callClaudeVisionWithPrompt(base64Image, mimeType, promptText) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('NO_API_KEY'));
      return;
    }

    // PDF файловете се подават като "document" блок, снимките — като "image" блок.
    const isPdf = mimeType === 'application/pdf';
    const fileBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Image } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } };

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            { type: 'text', text: promptText },
          ],
        },
      ],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Anthropic API грешка ${res.statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            const text = json.content?.[0]?.text || '{}';
            const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
            resolve(JSON.parse(cleaned));
          } catch (err) {
            reject(new Error('Неуспешно разчитане на отговора от AI: ' + err.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// талон (запазено за съвместимост с автопарк модула)
function callClaudeVision(base64Image, mimeType) {
  return callClaudeVisionWithPrompt(base64Image, mimeType, TALON_PROMPT);
}

// лична карта — за досието на служителя и формата за самокандидатстване
function scanIdCard(base64Image, mimeType) {
  return callClaudeVisionWithPrompt(base64Image, mimeType, ID_CARD_PROMPT);
}

// шофьорска книжка — за досието на служителя и формата за самокандидатстване
function scanDriverLicense(base64Image, mimeType) {
  return callClaudeVisionWithPrompt(base64Image, mimeType, DRIVER_LICENSE_PROMPT);
}

module.exports = { callClaudeVision, scanIdCard, scanDriverLicense };
