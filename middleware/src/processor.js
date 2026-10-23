'use strict';

const { createLead } = require('./crmClient');

// Statuses a record can have:
//   pending          received, waiting to be sent
//   retrying         a temporary CRM error happened, another attempt is scheduled
//   sent             lead created in the CRM (crmId saved)
//   failed           gave up: permanent CRM error or retries used up (dead letter)
//   needs_review     data problem, for example a WhatsApp number we cannot normalise (dead letter)
//   unknown_outcome  the CRM did not answer in time; it may have created the lead (dead letter)

const DEAD_LETTER = ['failed', 'needs_review', 'unknown_outcome'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LeadProcessor {
  constructor({ store, config, logger }) {
    this.store = store;
    this.config = config;
    this.log = logger;
    this.inFlight = new Set();
    this.stopped = false;
  }

  backoff(attempt, retryAfterMs) {
    const { retryBaseMs, retryMaxMs } = this.config;
    const exp = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * Math.min(250, retryBaseMs));
    // Respect Retry-After when the CRM sends it, but never wait less than our own backoff.
    return Math.min(retryMaxMs, Math.max(exp + jitter, retryAfterMs || 0));
  }

  /** Start work on a record without blocking the caller. */
  enqueue(key) {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.run(key)
      .catch((err) => this.log('error', 'processor crashed on record, kept running', { key, error: err.message }))
      .finally(() => this.inFlight.delete(key));
  }

  async run(key) {
    const { maxAttempts } = this.config;
    let ev = this.store.get(key);
    if (!ev || !['pending', 'retrying'].includes(ev.status)) return;

    while (!this.stopped) {
      const attempt = (ev.attempts || 0) + 1;
      this.store.upsert(key, { attempts: attempt, status: 'pending' });
      const result = await createLead(ev.lead, {
        baseUrl: this.config.crmBaseUrl,
        token: this.config.crmApiToken,
        timeoutMs: this.config.crmTimeoutMs,
      });
      this.store.note(key, { attempt, kind: result.kind, status: result.status, error: result.error, ms: result.ms });

      if (result.kind === 'created') {
        const crmId = result.body && result.body.id;
        this.store.upsert(key, { status: 'sent', crmId, lastError: null });
        this.log('info', 'lead created in CRM', { key, crmId, attempt, ms: result.ms });
        return;
      }

      if (result.kind === 'permanent') {
        const detail = result.body ? JSON.stringify(result.body) : `HTTP ${result.status}`;
        this.store.upsert(key, { status: 'failed', lastError: `CRM rejected the lead (${result.status}): ${detail}` });
        this.log('error', 'CRM rejected lead, not retrying', { key, status: result.status, body: result.body });
        return;
      }

      if (result.kind === 'timeout') {
        // The CRM keeps working after we stop waiting and has no duplicate check.
        // Retrying blindly could create a second lead, so a person checks first.
        this.store.upsert(key, {
          status: 'unknown_outcome',
          lastError: `${result.error}. The CRM may still have created this lead. Check the CRM before replaying.`,
        });
        this.log('warn', 'CRM did not answer in time, parked for review to avoid a duplicate', { key, attempt });
        return;
      }

      // Retryable: 429, 5xx or unreachable.
      const reason = result.error || `HTTP ${result.status}`;
      if (attempt >= maxAttempts) {
        this.store.upsert(key, { status: 'failed', lastError: `gave up after ${attempt} attempts, last error: ${reason}` });
        this.log('error', 'CRM still failing, moved to dead letters', { key, attempts: attempt, reason });
        return;
      }
      const wait = this.backoff(attempt, result.retryAfterMs);
      this.store.upsert(key, { status: 'retrying', lastError: reason, nextAttemptAt: new Date(Date.now() + wait).toISOString() });
      this.log('warn', 'temporary CRM error, will retry', { key, attempt, reason, retryInMs: wait });
      await sleep(wait);
      ev = this.store.get(key);
    }
  }

  /** Pick up records left pending or retrying by a previous run (crash or restart). */
  resume() {
    const open = this.store.list(['pending', 'retrying']);
    for (const ev of open) this.enqueue(ev.key);
    if (open.length) this.log('info', 'resumed unfinished records after start', { count: open.length });
  }

  /** Put a dead letter back in the queue. Returns the record, or an error string. */
  replay(key, { force = false } = {}) {
    const ev = this.store.get(key);
    if (!ev) return { error: 'not found' };
    if (!DEAD_LETTER.includes(ev.status)) return { error: `record is ${ev.status}, only dead letters can be replayed` };
    if (ev.status === 'needs_review') return { error: 'fix the data first (for example the phone number) before replaying' };
    if (ev.status === 'unknown_outcome' && !force) {
      return { error: 'check the CRM for this lead first, then replay with ?force=true if it is not there' };
    }
    this.store.upsert(key, { status: 'pending', attempts: 0, lastError: null });
    this.enqueue(key);
    return { record: this.store.get(key) };
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = { LeadProcessor, DEAD_LETTER };
