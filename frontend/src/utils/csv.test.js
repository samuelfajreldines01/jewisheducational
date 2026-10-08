import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaterialsCsv } from './csv.js';

test('maps the categoria column onto category', () => {
  const parsed = parseMaterialsCsv('title,categoria,published\nAleph,Torah,no\n');
  assert.deepEqual(parsed.unknownHeaders, []);
  assert.equal(parsed.hasTitle, true);
  assert.equal(parsed.rows[0].category, 'Torah');
  assert.equal(parsed.rows[0].is_published, false);
});
