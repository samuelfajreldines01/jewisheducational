import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceInsertParams } from './resourceInsert.js';

test('missing optional fields become null or column defaults', () => {
  const params = resourceInsertParams({ title: 'Aleph', slug: 'aleph' });
  assert.equal(params.action_visibility, null);
  assert.equal(params.google_slides_url, null);
  assert.equal(params.canva_url, null);
  assert.equal(params.cover_hidden, 0);
  assert.equal(params.is_archived, 0);
  assert.equal(params.sort_order, 0);
  assert.equal(params.is_premium, 0);
  assert.equal(Object.values(params).includes(undefined), false);
});

test('keeps a string action visibility and a numeric sort order', () => {
  const params = resourceInsertParams({
    title: 'Aleph',
    slug: 'aleph',
    action_visibility: '{"download":true}',
    sort_order: 4,
    is_premium: 1,
  });
  assert.equal(params.action_visibility, '{"download":true}');
  assert.equal(params.sort_order, 4);
  assert.equal(params.is_premium, 1);
});
