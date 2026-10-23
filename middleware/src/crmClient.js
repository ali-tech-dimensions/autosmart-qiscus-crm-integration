'use strict';

// Thin client for POST /api/leads. It never throws: every outcome comes back
// as a plain object so the caller can decide whether to retry.
//
// kind:
//   created    201, lead exists in the CRM
//   retryable  429, 500, 502, 503, 504 or the CRM could not be reached (lead not created)
//   permanent  400, 401, 403 or other 4xx (retrying will not help)
//   timeout    we stopped waiting; the CRM may still create the lead

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function createLead(lead, { baseUrl, token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(lead),
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    const result = { status: res.status, body, ms: Date.now() - started };
    if (res.status === 201 || res.status === 200) return { kind: 'created', ...result };
    if (res.status === 429 || res.status >= 500) {
      return { kind: 'retryable', retryAfterMs: parseRetryAfter(res.headers.get('retry-after')), ...result };
    }
    return { kind: 'permanent', ...result };
  } catch (err) {
    if (err.name === 'AbortError') return { kind: 'timeout', ms: Date.now() - started, error: `no response within ${timeoutMs} ms` };
    const code = (err.cause && err.cause.code) || err.code || err.message;
    return { kind: 'retryable', ms: Date.now() - started, error: `network error: ${code}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createLead, parseRetryAfter };
