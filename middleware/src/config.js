'use strict';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && value !== '' && value !== undefined ? n : fallback;
}

function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    crmBaseUrl: env.CRM_BASE_URL || 'http://localhost:4000',
    crmApiToken: env.CRM_API_TOKEN || 'dev-crm-token',
    // The CRM can take up to 10 seconds. We already answered Qiscus, so we can afford to wait.
    crmTimeoutMs: num(env.CRM_TIMEOUT_MS, 12000),
    maxAttempts: num(env.MAX_ATTEMPTS, 5),
    retryBaseMs: num(env.RETRY_BASE_MS, 1000),
    retryMaxMs: num(env.RETRY_MAX_MS, 30000),
    defaultCountry: (env.DEFAULT_COUNTRY || 'MY').toUpperCase(),
    dataDir: env.DATA_DIR || './data',
    webhookSecret: env.WEBHOOK_SECRET || '',
    logLevel: env.LOG_LEVEL || 'info',
  };
}

module.exports = { loadConfig };
