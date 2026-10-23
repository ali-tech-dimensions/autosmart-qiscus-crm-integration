'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sample = (name) => require(`../samples/${name}`);
const { mapWebhookToLead, idempotencyKey, validateWebhook } = require('../middleware/src/mapping');

test('maps the Appendix A WhatsApp webhook to a CRM lead', () => {
  const { lead, issues } = mapWebhookToLead(sample('01-whatsapp-text.json'));
  assert.deepEqual(issues, []);
  assert.deepEqual(lead, {
    full_name: 'Aisyah Rahman',
    phone: '+60123456781',
    source: 'whatsapp',
    first_message: 'Hi, is the new SUV available for a test drive this weekend?',
    external_ref: '70004321',
    created_at: '2026-10-01T03:15:42Z',
  });
});

test('an image with a caption keeps the caption and the link', () => {
  const { lead } = mapWebhookToLead(sample('02-whatsapp-image-caption.json'));
  assert.equal(lead.first_message, 'Can I get the price list for this model? (attachment: https://example.com/files/brochure-request.jpg)');
  assert.equal(lead.phone, '+6591234566');
});

test('an attachment without a caption still produces a readable message', () => {
  const body = sample('02-whatsapp-image-caption.json');
  const copy = JSON.parse(JSON.stringify(body));
  delete copy.payload.message.payload.caption;
  const { lead } = mapWebhookToLead(copy);
  assert.equal(lead.first_message, '[file_attachment] https://example.com/files/brochure-request.jpg');
});

test('Facebook and Instagram leads carry no phone (the field holds a platform ID)', () => {
  const fb = mapWebhookToLead(sample('04-facebook.json')).lead;
  const ig = mapWebhookToLead(sample('05-instagram.json')).lead;
  assert.equal(fb.source, 'facebook');
  assert.equal(ig.source, 'instagram');
  assert.equal(fb.phone, undefined);
  assert.equal(ig.phone, undefined);
});

test('source falls back to room.options when room_log.source is missing', () => {
  const body = JSON.parse(JSON.stringify(sample('04-facebook.json')));
  delete body.room_log.source;
  assert.equal(mapWebhookToLead(body).lead.source, 'facebook');
});

test('unknown channels map to other and are noted', () => {
  const body = JSON.parse(JSON.stringify(sample('04-facebook.json')));
  body.room_log.source = 'line';
  const { lead, issues } = mapWebhookToLead(body);
  assert.equal(lead.source, 'other');
  assert.equal(issues[0].code, 'unknown_source');
});

test('an unusable WhatsApp number is flagged as blocking', () => {
  const { lead, issues } = mapWebhookToLead(sample('06-whatsapp-ambiguous-phone.json'));
  assert.equal(lead.phone, undefined);
  assert.equal(issues[0].code, 'invalid_phone');
  assert.equal(issues[0].blocking, true);
});

test('long names and messages are trimmed to the CRM limits', () => {
  const body = JSON.parse(JSON.stringify(sample('01-whatsapp-text.json')));
  body.payload.from.name = 'A'.repeat(150);
  body.payload.message.text = 'x'.repeat(1500);
  const { lead } = mapWebhookToLead(body);
  assert.equal(lead.full_name.length, 100);
  assert.equal(lead.first_message.length, 1000);
});

test('the same session always gives the same key, a new session gives a new one', () => {
  const a = idempotencyKey(sample('01-whatsapp-text.json'));
  const b = idempotencyKey(JSON.parse(JSON.stringify(sample('01-whatsapp-text.json'))));
  const later = idempotencyKey(sample('07-returning-customer-new-session.json'));
  assert.equal(a, b);
  assert.notEqual(a, later);
});

test('rejects bodies that are not New Session webhooks', () => {
  assert.ok(validateWebhook(null));
  assert.ok(validateWebhook({ webhook_type: 'MARK_AS_RESOLVED' }));
  assert.equal(validateWebhook(sample('01-whatsapp-text.json')), null);
});
