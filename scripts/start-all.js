'use strict';

// Starts the mock CRM and the middleware together for local runs.
// Ctrl+C stops both.

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const children = [
  spawn(process.execPath, ['crm-mock/server.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: process.env.CRM_PORT || '4000' } }),
  spawn(process.execPath, ['middleware/server.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: process.env.MIDDLEWARE_PORT || '3000' } }),
];

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
