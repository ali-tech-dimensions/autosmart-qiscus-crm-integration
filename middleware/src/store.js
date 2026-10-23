'use strict';

const fs = require('fs');
const path = require('path');

// A small JSON file store. It keeps one record per webhook (keyed by the
// idempotency key) so we can spot repeats, retry failures and replay dead letters.
// Writes go to a temp file first and are then renamed, so a crash mid write
// does not corrupt the file. Fine for one instance; see README for scaling notes.

class EventStore {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'middleware-events.json') : null;
    this.events = {};
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        try {
          this.events = JSON.parse(fs.readFileSync(this.file, 'utf8')).events || {};
        } catch {
          // A broken file should not stop the service. Keep a copy and start clean.
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
          this.events = {};
        }
      }
    }
  }

  get(key) {
    return this.events[key] || null;
  }

  upsert(key, patch) {
    const now = new Date().toISOString();
    const current = this.events[key] || { key, createdAt: now, attempts: 0, history: [] };
    this.events[key] = { ...current, ...patch, updatedAt: now };
    this.flush();
    return this.events[key];
  }

  note(key, entry) {
    const ev = this.events[key];
    if (!ev) return;
    ev.history = [...(ev.history || []), { at: new Date().toISOString(), ...entry }].slice(-20);
    this.flush();
  }

  list(statuses) {
    const all = Object.values(this.events);
    return statuses ? all.filter((e) => statuses.includes(e.status)) : all;
  }

  flush() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ events: this.events }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { EventStore };
