'use strict';

const { loadConfig } = require('./src/config');
const { createMiddleware } = require('./src/app');

const config = loadConfig();
const app = createMiddleware(config);

// Last line of defence: log and keep serving. Nothing here should take the service down.
process.on('unhandledRejection', (err) => app.log('error', 'unhandled rejection', { error: String(err && err.message ? err.message : err) }));
process.on('uncaughtException', (err) => app.log('error', 'uncaught exception', { error: err.message }));

app.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    app.log('info', 'shutting down', { signal: sig });
    await app.stop();
    process.exit(0);
  });
}
