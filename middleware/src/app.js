'use strict';

const http = require('http');
const { URL } = require('url');
const { EventStore } = require('./store');
const { LeadProcessor, DEAD_LETTER } = require('./processor');
const { mapWebhookToLead, validateWebhook, idempotencyKey } = require('./mapping');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function makeLogger(level = 'info') {
  const min = LEVELS[level] || 20;
  return (lvl, msg, data = {}) => {
    if ((LEVELS[lvl] || 20) < min) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...data });
    (lvl === 'error' ? console.error : console.log)(line);
  };
}

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function summary(ev) {
  const { key, status, attempts, crmId, lastError, lead, issues, createdAt, updatedAt, nextAttemptAt } = ev;
  return { key, status, attempts, crmId, lastError, issues, lead, createdAt, updatedAt, nextAttemptAt };
}

function createMiddleware(config) {
  const log = makeLogger(config.logLevel);
  const store = new EventStore(config.dataDir);
  const processor = new LeadProcessor({ store, config, logger: log });

  async function handleWebhook(req, res, url) {
    if (config.webhookSecret) {
      const given = req.headers['x-webhook-secret'] || url.searchParams.get('secret');
      if (given !== config.webhookSecret) {
        log('warn', 'webhook rejected, wrong or missing secret', { ip: req.socket.remoteAddress });
        return send(res, 401, { error: 'unauthorized' });
      }
    }

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      log('warn', 'webhook body is not valid JSON', { sample: raw.slice(0, 120) });
      return send(res, 400, { error: 'invalid_json' });
    }

    const problem = validateWebhook(body);
    if (problem) {
      log('warn', 'webhook ignored, unexpected shape', { problem });
      return send(res, 400, { error: 'invalid_webhook', detail: problem });
    }

    const key = idempotencyKey(body, raw);
    const existing = store.get(key);
    if (existing) {
      log('info', 'duplicate webhook ignored', { key, status: existing.status });
      return send(res, 200, { status: 'duplicate_ignored', key, current: existing.status });
    }

    const { lead, issues } = mapWebhookToLead(body, { defaultCountry: config.defaultCountry });
    const blocking = issues.find((i) => i.blocking);

    if (blocking) {
      store.upsert(key, { status: 'needs_review', lead, issues, raw: body, lastError: `${blocking.code}: ${blocking.detail}` });
      log('warn', 'lead held for review, data problem', { key, issue: blocking });
      return send(res, 200, { status: 'accepted_needs_review', key, issue: blocking });
    }

    store.upsert(key, { status: 'pending', lead, issues, raw: body });
    if (issues.length) log('warn', 'lead accepted with notes', { key, issues });
    log('info', 'webhook accepted', { key, source: lead.source, external_ref: lead.external_ref });
    // Answer Qiscus straight away, then talk to the CRM in the background.
    send(res, 202, { status: 'accepted', key });
    processor.enqueue(key);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (req.method === 'POST' && path === '/webhooks/qiscus/new-session') return handleWebhook(req, res, url);

    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      const counts = {};
      for (const ev of store.list()) counts[ev.status] = (counts[ev.status] || 0) + 1;
      return send(res, 200, { status: 'ok', crm: config.crmBaseUrl, records: counts, inFlight: processor.inFlight.size });
    }

    if (req.method === 'GET' && path === '/events') {
      const status = url.searchParams.get('status');
      return send(res, 200, store.list(status ? status.split(',') : null).map(summary));
    }

    if (req.method === 'GET' && path === '/dead-letters') {
      return send(res, 200, store.list(DEAD_LETTER).map(summary));
    }

    const replay = path.match(/^\/dead-letters\/(.+)\/replay$/);
    if (req.method === 'POST' && replay) {
      const key = decodeURIComponent(replay[1]);
      const out = processor.replay(key, { force: url.searchParams.get('force') === 'true' });
      if (out.error) return send(res, out.error === 'not found' ? 404 : 409, { error: out.error, key });
      log('info', 'dead letter replayed', { key });
      return send(res, 202, { status: 'replaying', record: summary(out.record) });
    }

    return send(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log('error', 'request failed, service still running', { path: req.url, error: err.message });
      send(res, err.status || 500, { error: 'internal_error' });
    });
  });

  return {
    server,
    store,
    processor,
    log,
    start(port = config.port) {
      return new Promise((resolve) => {
        server.listen(port, () => {
          log('info', 'middleware listening', { port: server.address().port, crm: config.crmBaseUrl });
          processor.resume();
          resolve(server.address().port);
        });
      });
    },
    stop() {
      processor.stop();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createMiddleware, makeLogger };
