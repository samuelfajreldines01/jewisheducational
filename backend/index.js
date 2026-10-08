import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
process.env.DB_DRIVER = 'firestore';

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const jwtSecret = defineSecret('JWT_SECRET');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const migrationSecret = defineSecret('MIGRATION_SECRET');
const frontendUrl = defineString('FRONTEND_URL', {
  default: 'https://jewisheducationalresources.org',
});
// Payments and outbound email are optional integrations. The public site must
// remain deployable when those products are not enabled for this project.
const paymentsEnabled = defineString('PAYMENTS_ENABLED', { default: 'false' });
const emailEnabled = defineString('EMAIL_ENABLED', { default: 'false' });

const apiSecrets = [
  jwtSecret,
  geminiApiKey,
];

const apps = new Map();

async function getApp({ includeMigration = false } = {}) {
  const cacheKey = includeMigration ? 'migration' : 'api';
  if (!apps.has(cacheKey)) {
    const dotenv = await import('dotenv');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    dotenv.config({ path: path.join(__dirname, '.env') });
    const { createApp } = await import('./app.js');
    // Firebase parameter values are resolved at runtime. Local development
    // can still override them through the environment or .env.localdev.
    if (!process.env.FRONTEND_URL) {
      const configuredUrl = frontendUrl.value();
      if (configuredUrl) process.env.FRONTEND_URL = configuredUrl;
    }
    if (process.env.K_SERVICE) {
      // Optional integrations fail closed at their own endpoints. They do
      // not make the public catalog unavailable when the project does not
      // use payments or outbound email.
      process.env.STRIPE_REQUIRED = String(paymentsEnabled.value()).toLowerCase() === 'true' ? 'true' : 'false';
      process.env.SMTP_REQUIRED = String(emailEnabled.value()).toLowerCase() === 'true' ? 'true' : 'false';
    }
    apps.set(cacheKey, createApp({ includeMigration }));
  }
  return apps.get(cacheKey);
}

export const api = onRequest(
  // Memória/timeout maiores: a geração de capa de apresentações (PPTX) roda
  // um Chromium headless (Puppeteer) dentro desta function.
  { memory: '2GiB', timeoutSeconds: 180, cors: false, secrets: apiSecrets },
  async (req, res) => {
    const expressApp = await getApp();
    return expressApp(req, res);
  }
);

// Migration is a separate private Cloud Function. It is never mounted in the
// public API and its secret is not available to normal traffic.
export const migrationApi = onRequest(
  {
    memory: '2GiB',
    timeoutSeconds: 540,
    cors: false,
    invoker: 'private',
    secrets: [migrationSecret],
  },
  async (req, res) => {
    const expressApp = await getApp({ includeMigration: true });
    return expressApp(req, res);
  }
);

export const subscriptionReminders = onSchedule(
  {
    schedule: 'every day 09:00',
    timeZone: 'America/New_York',
    memory: '256MiB',
  },
  async () => {
    if (String(emailEnabled.value()).toLowerCase() !== 'true') {
      console.log('Subscription reminders skipped: outbound email is disabled.');
      return;
    }
    const dotenv = await import('dotenv');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    dotenv.config({ path: path.join(__dirname, '.env') });
    if (!process.env.FRONTEND_URL) {
      const configuredUrl = frontendUrl.value();
      if (configuredUrl) process.env.FRONTEND_URL = configuredUrl;
    }
    const { processSubscriptionReminders } = await import('./utils/subscriptionReminders.js');
    const results = await processSubscriptionReminders({ daysBefore: 7 });
    console.log('Subscription reminders:', JSON.stringify(results));
  }
);
