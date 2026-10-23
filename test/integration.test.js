'use strict';

// End to end: real HTTP between the middleware and the mock CRM, on random ports.
// Each test gets a fresh CRM and middleware so results do not leak between tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCrm } = require('../crm-mock/app');
const { createMiddleware } = require('../middleware/src/app');
const { loadConfig } = require('../middleware/src/config');

const sample = (name) => fs.readFileSync(path.join(__dirname, '..', 'samples', name), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 8000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(every);
  }
}

async function setup({ crm: crmOpts = {}, mw: mwOpts = {}, crmDown = false } = {}) {
  const crm = createCrm({ token: 'test-token', dataDir: null, quiet: true, slowMs: 1500, retryAfterSec: 1, ...crmOpts });
  const crmPort = await crm.start(0);
  if (crmDown) await crm.stop();
  const config = {
    ...loadConfig({}),
    crmBaseUrl: `http://127.0.0.1:${crmPort}`,
    crmApiToken: 'test-token',
    crmTimeoutMs: 3000,
    maxAttempts: 4,
    retryBaseMs: 50,
    retryMaxMs: 1500,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autosmart-mw-')),
    logLevel: 'silent',
    ...mwOpts,
  };
  const mw = createMiddleware(config);
  const port = await mw.start(0);
  const post = (body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/webhooks/qiscus/new-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  const done = async () => {
    await mw.stop();
    if (!crmDown) await crm.stop();
  };
  return { crm, mw, post, get, done };
}

const statusOf = (mw, key) => (mw.store.get(key) || {}).status;

test('R1 and R2: a WhatsApp webhook becomes a correct CRM lead', async () => {
  const t = await setup();
  try {
    const res = await t.post(sample('01-whatsapp-text.json'));
    assert.equal(res.status, 202);
    const { key } = await res.json();
    await waitFor(() => statusOf(t.mw, key) === 'sent');
    assert.equal(t.crm.leads.length, 1);
    const lead = t.crm.leads[0];
    assert.equal(lead.phone, '+60123456781');
    assert.equal(lead.source, 'whatsapp');
    assert.equal(lead.external_ref, '70004321');
  } finally {
    await t.done();
  }
});

test('R1: image with caption, local number and Facebook are mapped correctly', async () => {
  const t = await setup();
  try {
    for (const f of ['02-whatsapp-image-caption.json', '03-whatsapp-local-number.json', '04-facebook.json']) await t.post(sample(f));
    await waitFor(() => t.crm.leads.length === 3);
    const byRef = Object.fromEntries(t.crm.leads.map((l) => [l.external_ref, l]));
    assert.match(byRef['70004322'].first_message, /^Can I get the price list/);
    assert.equal(byRef['70004323'].phone, '+60123456783');
    assert.equal(byRef['70004324'].source, 'facebook');
    assert.equal(byRef['70004324'].phone, null);
  } finally {
    await t.done();
  }
});

test('R3: the same webhook delivered twice creates one lead', async () => {
  const t = await setup();
  try {
    const first = await t.post(sample('01-whatsapp-text.json'));
    const second = await t.post(sample('01-whatsapp-text.json'));
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).status, 'duplicate_ignored');
    await sleep(400);
    assert.equal(t.crm.leads.length, 1);
  } finally {
    await t.done();
  }
});

test('R3: a redelivery that arrives while the CRM is still busy is also ignored', async () => {
  const t = await setup({ crm: { slowMs: 800 } });
  try {
    t.crm.queue('slow');
    const a = t.post(sample('01-whatsapp-text.json'));
    await sleep(100);
    const b = t.post(sample('01-whatsapp-text.json'));
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 202);
    assert.equal((await rb.json()).status, 'duplicate_ignored');
    await waitFor(() => t.crm.leads.length === 1);
    await sleep(300);
    assert.equal(t.crm.leads.length, 1);
  } finally {
    await t.done();
  }
});

test('R4 and B1: two 503s then success, retried and created once', async () => {
  const t = await setup();
  try {
    t.crm.queue('error', 'error');
    const { key } = await (await t.post(sample('01-whatsapp-text.json'))).json();
    await waitFor(() => statusOf(t.mw, key) === 'sent');
    assert.equal(t.mw.store.get(key).attempts, 3);
    assert.equal(t.crm.leads.length, 1);
  } finally {
    await t.done();
  }
});

test('R4 and B1: 429 with Retry-After is respected', async () => {
  const t = await setup();
  try {
    t.crm.queue('rate_limit');
    const started = Date.now();
    const { key } = await (await t.post(sample('01-whatsapp-text.json'))).json();
    await waitFor(() => statusOf(t.mw, key) === 'sent');
    assert.ok(Date.now() - started >= 1000, 'waited at least the Retry-After second');
    assert.equal(t.crm.leads.length, 1);
  } finally {
    await t.done();
  }
});

test('R4: a slow CRM does not slow down the reply to Qiscus', async () => {
  const t = await setup();
  try {
    t.crm.queue('slow');
    const started = Date.now();
    const res = await t.post(sample('01-whatsapp-text.json'));
    assert.ok(Date.now() - started < 500, 'answered Qiscus well inside 5 seconds');
    const { key } = await res.json();
    await waitFor(() => statusOf(t.mw, key) === 'sent');
    assert.equal(t.crm.leads.length, 1);
  } finally {
    await t.done();
  }
});

test('R3 and R4: if the CRM answers after our timeout we park the lead instead of sending it twice', async () => {
  const t = await setup({ crm: { slowMs: 1200 }, mw: { crmTimeoutMs: 300 } });
  try {
    t.crm.queue('slow');
    const { key } = await (await t.post(sample('01-whatsapp-text.json'))).json();
    await waitFor(() => statusOf(t.mw, key) === 'unknown_outcome');
    await waitFor(() => t.crm.leads.length === 1); // the CRM still created it, late
    await sleep(500);
    assert.equal(t.crm.leads.length, 1, 'no second lead from a blind retry');
    const dead = await t.get('/dead-letters');
    assert.equal(dead[0].status, 'unknown_outcome');
  } finally {
    await t.done();
  }
});

test('R4: CRM unreachable, the service keeps running and parks the lead for replay', async () => {
  const t = await setup({ crmDown: true });
  try {
    const { key } = await (await t.post(sample('01-whatsapp-text.json'))).json();
    await waitFor(() => statusOf(t.mw, key) === 'failed');
    const ev = t.mw.store.get(key);
    assert.equal(ev.attempts, 4);
    assert.match(ev.lastError, /network error/);
    const health = await t.get('/health');
    assert.equal(health.status, 'ok');
  } finally {
    await t.done();
  }
});

test('R4: wrong CRM token is a permanent error and is not retried', async () => {
  const t = await setup({ mw: { crmApiToken: 'wrong' } });
  try {
    const { key } = await (await t.post(sample('01-whatsapp-text.json'))).json();
    await waitFor(() => statusOf(t.mw, key) === 'failed');
    assert.equal(t.mw.store.get(key).attempts, 1);
  } finally {
    await t.done();
  }
});

test('a WhatsApp number that cannot be normalised is held for review, not sent', async () => {
  const t = await setup();
  try {
    const res = await t.post(sample('06-whatsapp-ambiguous-phone.json'));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'accepted_needs_review');
    await sleep(200);
    assert.equal(t.crm.leads.length, 0);
  } finally {
    await t.done();
  }
});

test('a returning customer in a new session creates a new lead', async () => {
  const t = await setup();
  try {
    await t.post(sample('01-whatsapp-text.json'));
    await t.post(sample('07-returning-customer-new-session.json'));
    await waitFor(() => t.crm.leads.length === 2);
    assert.equal(t.crm.leads[0].phone, t.crm.leads[1].phone);
  } finally {
    await t.done();
  }
});

test('bad input never crashes the service', async () => {
  const t = await setup();
  try {
    assert.equal((await t.post('not json')).status, 400);
    assert.equal((await t.post('{"webhook_type":"NEW_SESSION_WEBHOOK"}')).status, 400);
    assert.equal((await t.get('/health')).status, 'ok');
  } finally {
    await t.done();
  }
});

test('B1: a failed lead can be replayed once the CRM is back', async () => {
  const t = await setup({ mw: { maxAttempts: 2 } });
  try {
    t.crm.queue('error', 'error');
    const { key } = await (await t.post(sample('01-whatsapp-text.json'))).json();
    await waitFor(() => statusOf(t.mw, key) === 'failed');
    const res = await fetch(`http://127.0.0.1:${t.mw.server.address().port}/dead-letters/${encodeURIComponent(key)}/replay`, { method: 'POST' });
    assert.equal(res.status, 202);
    await waitFor(() => statusOf(t.mw, key) === 'sent');
    assert.equal(t.crm.leads.length, 1);
  } finally {
    await t.done();
  }
});

test('optional webhook secret blocks unsigned calls', async () => {
  const t = await setup({ mw: { webhookSecret: 's3cret' } });
  try {
    assert.equal((await t.post(sample('01-whatsapp-text.json'))).status, 401);
    assert.equal((await t.post(sample('01-whatsapp-text.json'), { 'X-Webhook-Secret': 's3cret' })).status, 202);
  } finally {
    await t.done();
  }
});
