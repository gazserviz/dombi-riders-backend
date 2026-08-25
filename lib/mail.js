// ============================================================================
// lib/mail.js — интеграция с фирмената пощенска кутия (office@dombi.bg,
// хоствана в Zoho Mail, EU дата център) директно в админ панела: списък с
// входящи писма, преглед на цяло писмо (текст/HTML + прикачени файлове),
// изпращане на ново писмо и отговор в нишка.
//
// Изисква три env променливи в Render (задават се РЪЧНО от собственика на
// бизнеса в Render Dashboard → Environment — тук НЕ се съхраняват пароли):
//   MAIL_USER     — пълният имейл адрес, напр. office@dombi.bg
//   MAIL_PASSWORD — App-Specific Password от Zoho (Account → Security →
//                   App Passwords), НЕ обикновената парола за вход в Zoho.
// Хостовете/портовете на Zoho EU дата център са фиксирани по-долу.
//
// Пакетите imapflow/nodemailer/mailparser се зареждат "лениво" (при първо
// извикване, с try/catch) — ако инсталацията им се провали по някаква
// причина, останалата част от системата продължава да работи нормално;
// само страницата "Пощенска кутия" ще показва ясна грешка вместо да чупи
// целия сървър при стартиране (виж същия подход при lib/db.js → loadPg()).
// ============================================================================

const IMAP_HOST = 'imappro.zoho.eu';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtppro.zoho.eu';
const SMTP_PORT = 465;

function getCredentials() {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASSWORD;
  if (!user || !pass) {
    const err = new Error('Пощата не е конфигурирана — липсват MAIL_USER/MAIL_PASSWORD в Environment на Render.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return { user, pass };
}

function loadImapFlow() {
  try { return require('imapflow').ImapFlow; } catch (e) { return null; }
}
function loadNodemailer() {
  try { return require('nodemailer'); } catch (e) { return null; }
}
function loadMailParser() {
  try { return require('mailparser').simpleParser; } catch (e) { return null; }
}

async function withImapClient(fn) {
  const ImapFlow = loadImapFlow();
  if (!ImapFlow) {
    const err = new Error('Пакетът "imapflow" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  const { user, pass } = getCredentials();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch (e) { /* игнорираме грешка при затваряне */ }
  }
}

// последните `limit` писма от INBOX, най-новите първи
async function listInbox({ limit = 30 } = {}) {
  return withImapClient(async client => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      if (!total) return [];
      const from = Math.max(1, total - limit + 1);
      const messages = [];
      for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, uid: true })) {
        const env = msg.envelope || {};
        const fromAddr = (env.from && env.from[0]) || {};
        messages.push({
          uid: msg.uid,
          from: fromAddr.address || '',
          fromName: fromAddr.name || fromAddr.address || '(непознат подател)',
          subject: env.subject || '(без тема)',
          date: env.date ? new Date(env.date).toISOString() : null,
          seen: msg.flags ? msg.flags.has('\\Seen') : false,
        });
      }
      messages.sort((a, b) => (b.uid || 0) - (a.uid || 0));
      return messages;
    } finally {
      lock.release();
    }
  });
}

// пълно съдържание на едно писмо по UID (текст/HTML + метаданни за
// прикачени файлове) — маркира го и като прочетено
async function getMessage(uid) {
  const simpleParser = loadMailParser();
  if (!simpleParser) {
    const err = new Error('Пакетът "mailparser" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return withImapClient(async client => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const full = await client.fetchOne(String(uid), { source: true, uid: true });
      if (!full) {
        const err = new Error('Писмото не е намерено.');
        err.code = 'MAIL_NOT_FOUND';
        throw err;
      }
      const parsed = await simpleParser(full.source);
      try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch (e) { /* не е критично */ }
      return {
        uid,
        from: (parsed.from && parsed.from.text) || '',
        to: (parsed.to && parsed.to.text) || '',
        subject: parsed.subject || '(без тема)',
        date: parsed.date ? parsed.date.toISOString() : null,
        text: parsed.text || '',
        html: parsed.html || null,
        messageId: parsed.messageId || null,
        references: parsed.references
          ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references)
          : null,
        attachments: (parsed.attachments || []).map((a, i) => ({
          index: i,
          filename: a.filename || `прикачен-файл-${i + 1}`,
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || (a.content ? a.content.length : 0),
        })),
      };
    } finally {
      lock.release();
    }
  });
}

// съдържанието (Buffer) на конкретен прикачен файл от дадено писмо, за сваляне
async function getAttachment(uid, index) {
  const simpleParser = loadMailParser();
  if (!simpleParser) {
    const err = new Error('Пакетът "mailparser" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return withImapClient(async client => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const full = await client.fetchOne(String(uid), { source: true, uid: true });
      if (!full) {
        const err = new Error('Писмото не е намерено.');
        err.code = 'MAIL_NOT_FOUND';
        throw err;
      }
      const parsed = await simpleParser(full.source);
      const att = (parsed.attachments || [])[index];
      if (!att) {
        const err = new Error('Прикаченият файл не е намерен.');
        err.code = 'MAIL_NOT_FOUND';
        throw err;
      }
      return { filename: att.filename || `прикачен-файл-${index + 1}`, contentType: att.contentType || 'application/octet-stream', content: att.content };
    } finally {
      lock.release();
    }
  });
}

// изпращане на ново писмо (или отговор, ако се подадат inReplyTo/references)
async function sendMail({ to, subject, text, inReplyTo, references }) {
  const nodemailer = loadNodemailer();
  if (!nodemailer) {
    const err = new Error('Пакетът "nodemailer" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  const { user, pass } = getCredentials();
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user, pass },
  });
  const mailOptions = { from: user, to, subject, text };
  if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
  if (references) mailOptions.references = references;
  const info = await transporter.sendMail(mailOptions);
  return { messageId: info.messageId };
}

module.exports = { listInbox, getMessage, getAttachment, sendMail };
