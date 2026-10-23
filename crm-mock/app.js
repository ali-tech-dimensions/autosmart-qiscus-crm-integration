'use strict';

// Mock of AutoSmart's CRM (Appendix B). It copies the parts that matter for the
// integration: token auth, validation, no duplicate checks, and bad days
// (slow answers, 503, 429 with Retry-After). It also serves a leads page.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const SOURCES = ['whatsapp', 'facebook', 'instagram', 'other'];
const E164 = /^\+[1-9]\d{7,14}$/;
const SCENARIOS = ['ok', 'slow', 'error', 'internal', 'rate_limit'];

function createCrm(options = {}) {
  const opts = {
    token: options.token || process.env.CRM_API_TOKEN || 'dev-crm-token',
    slowMs: Number(options.slowMs ?? process.env.MOCK_SLOW_MS ?? 10000),
    retryAfterSec: Number(options.retryAfterSec ?? process.env.MOCK_RETRY_AFTER ?? 2),
    // Chance (0 to 1) of a random bad response when no scenario is forced.
    randomFailureRate: Number(options.randomFailureRate ?? process.env.MOCK_RANDOM_FAILURE_RATE ?? 0),
    dataDir: options.dataDir === undefined ? process.env.DATA_DIR || './data' : options.dataDir,
    quiet: options.quiet || false,
  };

  const file = opts.dataDir ? path.join(opts.dataDir, 'crm-leads.json') : null;
  let leads = [];
  let counter = 0;
  const queued = []; // scenarios queued with POST /mock/scenarios, used in order
  const stats = { requests: 0, created: 0, rejected: 0, byScenario: {} };

  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        leads = saved.leads || [];
        counter = saved.counter || leads.length;
      } catch {
        leads = [];
      }
    }
  }
  const save = () => file && fs.writeFileSync(file, JSON.stringify({ counter, leads }, null, 2));
  const log = (msg, data = {}) => !opts.quiet && console.log(JSON.stringify({ time: new Date().toISOString(), service: 'mock-crm', msg, ...data }));

  function json(res, status, body, headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function pickScenario(req) {
    const forced = String(req.headers['x-mock-scenario'] || '').toLowerCase();
    if (SCENARIOS.includes(forced)) return forced;
    if (queued.length) return queued.shift();
    if (opts.randomFailureRate > 0 && Math.random() < opts.randomFailureRate) {
      return ['slow', 'error', 'rate_limit'][Math.floor(Math.random() * 3)];
    }
    return 'ok';
  }

  function validate(body) {
    const details = [];
    const add = (field, message) => details.push({ field, message });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ field: 'body', message: 'must be a JSON object' }];
    if (typeof body.full_name !== 'string' || !body.full_name.trim()) add('full_name', 'is required');
    else if (body.full_name.length > 100) add('full_name', 'must be 1 to 100 characters');
    if (!SOURCES.includes(body.source)) add('source', `must be one of ${SOURCES.join(', ')}`);
    if (body.phone !== undefined && body.phone !== null && body.phone !== '') {
      if (typeof body.phone !== 'string' || !E164.test(body.phone)) add('phone', 'must be E.164');
    } else if (body.source === 'whatsapp') add('phone', 'is required when source is whatsapp');
    if (body.first_message !== undefined && (typeof body.first_message !== 'string' || body.first_message.length > 1000)) {
      add('first_message', 'must be a string of at most 1000 characters');
    }
    if (body.external_ref !== undefined && typeof body.external_ref !== 'string') add('external_ref', 'must be a string');
    if (body.created_at !== undefined && Number.isNaN(Date.parse(body.created_at))) add('created_at', 'must be ISO 8601');
    return details;
  }

  function createLeadRecord(body) {
    counter += 1;
    const lead = {
      id: `LD-${String(counter).padStart(6, '0')}`,
      status: 'new',
      full_name: body.full_name.trim(),
      phone: body.phone || null,
      source: body.source,
      first_message: body.first_message || null,
      external_ref: body.external_ref || null,
      created_at: body.created_at || null,
      received_at: new Date().toISOString(),
    };
    leads.push(lead);
    stats.created += 1;
    save();
    return lead;
  }

  async function createLeadRoute(req, res) {
    stats.requests += 1;
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${opts.token}`) {
      stats.rejected += 1;
      return json(res, 401, { error: 'unauthorized' });
    }

    const scenario = pickScenario(req);
    stats.byScenario[scenario] = (stats.byScenario[scenario] || 0) + 1;

    if (scenario === 'error') {
      log('simulated 503', {});
      return json(res, 503, { error: 'internal_error' });
    }
    if (scenario === 'internal') return json(res, 500, { error: 'internal_error' });
    if (scenario === 'rate_limit') {
      log('simulated 429', { retryAfter: opts.retryAfterSec });
      return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(opts.retryAfterSec) });
    }

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      stats.rejected += 1;
      return json(res, 400, { error: 'validation_error', details: [{ field: 'body', message: 'invalid JSON' }] });
    }
    const details = validate(body);
    if (details.length) {
      stats.rejected += 1;
      log('validation failed', { details });
      return json(res, 400, { error: 'validation_error', details });
    }

    if (scenario === 'slow') {
      log('simulated slow response', { delayMs: opts.slowMs });
      await new Promise((r) => setTimeout(r, opts.slowMs));
      // Like the real CRM: the lead is created even if the caller gave up waiting.
      const lead = createLeadRecord(body);
      log('lead created after delay', { id: lead.id, callerStillWaiting: !res.destroyed });
      return json(res, 201, { id: lead.id, status: lead.status });
    }

    const lead = createLeadRecord(body);
    log('lead created', { id: lead.id, source: lead.source });
    return json(res, 201, { id: lead.id, status: lead.status });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/$/, '') || '/';

    if (req.method === 'POST' && p === '/api/leads') return createLeadRoute(req, res);
    if (req.method === 'GET' && p === '/api/leads') return json(res, 200, leads);

    // Helpers for demos and tests, not part of the real CRM API.
    if (req.method === 'DELETE' && p === '/api/leads') {
      leads = [];
      counter = 0;
      queued.length = 0;
      Object.assign(stats, { requests: 0, created: 0, rejected: 0, byScenario: {} });
      save();
      return json(res, 200, { status: 'cleared' });
    }
    if (req.method === 'POST' && p === '/mock/scenarios') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const list = (body.queue || []).filter((s) => SCENARIOS.includes(s));
      queued.push(...list);
      return json(res, 200, { queued: [...queued] });
    }
    if (req.method === 'GET' && p === '/mock/stats') return json(res, 200, { ...stats, queued: [...queued], leads: leads.length });

    if (req.method === 'GET' && (p === '/' || p === '/leads')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderLeadsPage(leads, stats));
    }

    return json(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log('request failed', { error: err.message });
      json(res, 500, { error: 'internal_error' });
    });
  });

  return {
    server,
    get leads() {
      return leads;
    },
    queue: (...s) => queued.push(...s),
    reset() {
      leads = [];
      counter = 0;
      queued.length = 0;
    },
    start(port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    stop() {
      return new Promise((resolve) => {
        server.closeAllConnections && server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLeadsPage(leads, stats) {
  // Same chat twice: same Qiscus room and same first contact time, a true duplicate.
  // Same phone only: probably a returning customer, worth a look but not an error.
  const sessionKey = (l) => (l.external_ref ? `${l.external_ref}|${l.created_at || ''}` : null);
  const phoneCount = {};
  const sessionCount = {};
  for (const l of leads) {
    if (l.phone) phoneCount[l.phone] = (phoneCount[l.phone] || 0) + 1;
    const k = sessionKey(l);
    if (k) sessionCount[k] = (sessionCount[k] || 0) + 1;
  }
  const dupes = leads.filter((l) => sessionKey(l) && sessionCount[sessionKey(l)] > 1).length;
  const repeatPhones = leads.filter((l) => l.phone && phoneCount[l.phone] > 1).length;
  const noPhone = leads.filter((l) => !l.phone).length;

  const rows = [...leads]
    .reverse()
    .map((l) => {
      const flags = [];
      if (sessionKey(l) && sessionCount[sessionKey(l)] > 1) flags.push('<span class="flag red">duplicate: same chat twice</span>');
      else if (l.phone && phoneCount[l.phone] > 1) flags.push('<span class="flag amber">phone seen before</span>');
      if (!l.phone) flags.push('<span class="flag grey">no phone</span>');
      const cls = flags.some((f) => f.includes('red')) ? 'dup' : '';
      return `<tr class="${cls}">
        <td class="mono">${esc(l.id)}</td>
        <td>${esc(l.full_name)}</td>
        <td class="mono">${esc(l.phone || '')}</td>
        <td><span class="src ${esc(l.source)}">${esc(l.source)}</span></td>
        <td class="msg">${esc(l.first_message || '')}</td>
        <td class="mono">${esc(l.external_ref || '')}</td>
        <td class="mono small">${esc((l.created_at || '').replace('T', ' ').replace('Z', ''))}</td>
        <td>${flags.join(' ')}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>AutoSmart CRM (mock) · Leads</title>
<style>
  body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;margin:0;background:#f4f6f8;color:#1c2430}
  header{background:#0d3b3a;color:#fff;padding:18px 28px}
  header h1{margin:0;font-size:20px} header p{margin:4px 0 0;color:#bfe0dc;font-size:13px}
  main{padding:20px 28px}
  .stats{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .stat{background:#fff;border:1px solid #dde3ea;border-radius:8px;padding:10px 14px;min-width:120px}
  .stat b{display:block;font-size:22px} .stat span{font-size:12px;color:#5b6676}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dde3ea;border-radius:8px;overflow:hidden;font-size:13px}
  th{text-align:left;background:#eef2f5;padding:9px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5b6676}
  td{padding:9px 10px;border-top:1px solid #eef1f4;vertical-align:top}
  tr.dup td{background:#fff3f2}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px} .small{font-size:11px;color:#5b6676}
  .msg{max-width:340px}
  .src{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#eef0f3}
  .src.whatsapp{background:#e3f6ea;color:#1a7f43}.src.facebook{background:#e6eefc;color:#2d5bc4}.src.instagram{background:#fbe8f2;color:#b02a6f}
  .flag{font-size:11px;padding:2px 7px;border-radius:10px;white-space:nowrap}
  .flag.red{background:#fde2df;color:#b42318}.flag.amber{background:#fef0c7;color:#93530d}.flag.grey{background:#eef0f3;color:#5b6676}
  .empty{padding:30px;text-align:center;color:#5b6676}
</style></head>
<body>
<header><h1>AutoSmart CRM · Leads (mock)</h1><p>Stand in for the client CRM. Refreshes every 5 seconds. Newest first.</p></header>
<main>
  <div class="stats">
    <div class="stat"><b>${leads.length}</b><span>leads</span></div>
    <div class="stat"><b>${dupes}</b><span>duplicates (same chat)</span></div>
    <div class="stat"><b>${repeatPhones}</b><span>with a repeat phone</span></div>
    <div class="stat"><b>${noPhone}</b><span>without phone</span></div>
    <div class="stat"><b>${stats.requests}</b><span>API calls received</span></div>
  </div>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Source</th><th>First message</th><th>Qiscus room</th><th>First contact (UTC)</th><th>Checks</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="empty">No leads yet. Send a webhook to the middleware.</td></tr>'}</tbody>
  </table>
</main></body></html>`;
}

module.exports = { createCrm, renderLeadsPage };
