'use strict';

const crypto = require('crypto');
const { normalizePhone } = require('./phone');

const SOURCE_MAP = {
  wa: 'whatsapp',
  whatsapp: 'whatsapp',
  fb: 'facebook',
  facebook: 'facebook',
  ig: 'instagram',
  instagram: 'instagram',
};

const MAX_NAME = 100;
const MAX_MESSAGE = 1000;

function parseRoomOptions(options) {
  if (!options) return {};
  if (typeof options === 'object') return options;
  try {
    const parsed = JSON.parse(options);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveSource(body) {
  const options = parseRoomOptions(body && body.payload && body.payload.room && body.payload.room.options);
  const raw = (body && body.room_log && body.room_log.source) || options.source || options.channel || '';
  const key = String(raw).trim().toLowerCase();
  return { raw: key, source: SOURCE_MAP[key] || 'other' };
}

function stripFileTags(text) {
  return String(text || '').replace(/\[\/?file\]/gi, '').trim();
}

function extractFirstMessage(message) {
  if (!message) return '';
  const payload = message.payload || {};
  let text;
  if (!message.type || message.type === 'text') {
    text = message.text || '';
  } else {
    const caption = (payload.caption || '').trim();
    const url = payload.url || stripFileTags(message.text);
    if (caption && url) text = `${caption} (attachment: ${url})`;
    else if (caption) text = caption;
    else if (url) text = `[${message.type}] ${url}`;
    else text = stripFileTags(message.text);
  }
  text = String(text).replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 3)}...` : text;
}

function pickName(body) {
  const p = (body && body.payload) || {};
  const candidates = [p.from && p.from.name, p.room && p.room.name, body && body.room_log && body.room_log.name];
  const name = candidates.map((n) => (n ? String(n).trim() : '')).find(Boolean) || 'Unknown customer';
  return name.slice(0, MAX_NAME);
}

/** Check that the body is a New Session webhook we can work with. Returns an error string or null. */
function validateWebhook(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (body.webhook_type && body.webhook_type !== 'NEW_SESSION_WEBHOOK') return `unsupported webhook_type ${body.webhook_type}`;
  if (!body.payload || !body.payload.room) return 'payload.room is missing';
  if (!body.payload.room.id_str && body.payload.room.id === undefined) return 'payload.room.id is missing';
  return null;
}

/**
 * Key used to make sure one webhook creates at most one lead.
 * A new session in the same room starts with a new first message, so room plus
 * first message ID identifies the session. If either is missing we fall back to
 * a hash of the body, which still catches exact redeliveries.
 */
function idempotencyKey(body, rawBody) {
  const p = (body && body.payload) || {};
  const roomId = p.room && (p.room.id_str || (p.room.id !== undefined ? String(p.room.id) : ''));
  const messageId = p.message && (p.message.id_str || (p.message.id !== undefined ? String(p.message.id) : ''));
  if (roomId && messageId) return `qiscus:${roomId}:${messageId}`;
  const hash = crypto.createHash('sha256').update(rawBody || JSON.stringify(body)).digest('hex').slice(0, 24);
  return `body:${hash}`;
}

/**
 * Turn a Qiscus New Session webhook into a CRM lead.
 * Returns { lead, issues } where issues lists anything a person should look at.
 */
function mapWebhookToLead(body, { defaultCountry = 'MY' } = {}) {
  const p = body.payload || {};
  const { source, raw } = resolveSource(body);
  const roomId = p.room && (p.room.id_str || String(p.room.id));
  const issues = [];

  const lead = {
    full_name: pickName(body),
    source,
    first_message: extractFirstMessage(p.message),
    external_ref: roomId,
    created_at: (p.message && p.message.timestamp) || (body.room_log && body.room_log.created_at) || undefined,
  };

  if (source === 'other' && raw) issues.push({ code: 'unknown_source', detail: `channel "${raw}" mapped to other` });

  if (source === 'whatsapp') {
    const rawPhone = (p.from && p.from.email) || (body.room_log && body.room_log.user_id);
    const phone = normalizePhone(rawPhone, defaultCountry);
    if (phone.ok) lead.phone = phone.e164;
    else issues.push({ code: 'invalid_phone', detail: phone.reason, input: phone.input, hint: phone.hint, blocking: true });
  }
  // For Facebook and Instagram the "email" field holds a platform ID, not a phone,
  // so we leave phone out. The CRM only requires a phone for WhatsApp leads.

  if (!lead.first_message) delete lead.first_message;
  if (!lead.created_at) delete lead.created_at;
  return { lead, issues };
}

module.exports = { mapWebhookToLead, validateWebhook, idempotencyKey, resolveSource, extractFirstMessage, parseRoomOptions };
