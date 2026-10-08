import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('app exposes separate liveness and readiness contracts', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/api\/health'/);
  assert.match(source, /app\.get\('\/api\/ready'/);
  assert.match(source, /status: ready \? 'ready' : 'not_ready'/);
  assert.match(source, /checks\.database/);
  assert.match(source, /checks\.storage/);
  assert.match(source, /checks\.configuration/);
});

test('migration routes are opt-in and not mounted on the normal API', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const index = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /createApp\(\{ includeMigration = false \} = \{\}\)/);
  assert.match(source, /if \(includeMigration\) app\.use\('\/api\/migrate', migrateRoutes\)/);
  assert.match(index, /const apiSecrets = \[/);
  assert.match(index, /const apiSecrets = \[\s*jwtSecret,\s*geminiApiKey,\s*\]/);
  assert.match(index, /secrets: apiSecrets/);
  assert.match(index, /PAYMENTS_ENABLED/);
  assert.match(index, /EMAIL_ENABLED/);
  assert.match(index, /export const migrationApi = onRequest/);
  assert.match(index, /invoker: 'private'/);
  assert.match(index, /getApp\(\{ includeMigration: true \}\)/);
  const normalApiBlock = index.slice(index.indexOf('export const api ='), index.indexOf('// Migration is'));
  assert.doesNotMatch(normalApiBlock, /migrationSecret/);
  assert.match(source, /express\.json\(\{\s*limit:/);
  assert.match(source, /express\.urlencoded\(\{ extended: true, limit:/);
  assert.match(source, /X-Frame-Options/);
  assert.match(source, /API route not found/);
  assert.doesNotMatch(source, /app\.use\('\/api\/cron'/);
});
