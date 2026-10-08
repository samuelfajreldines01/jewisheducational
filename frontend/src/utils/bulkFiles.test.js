import test from 'node:test';
import assert from 'node:assert/strict';
import { titleFromFileName } from './bulkFiles.js';

test('uses the file name without its extension as the material title', () => {
  assert.equal(titleFromFileName('Alphabet Trace.pdf'), 'Alphabet Trace');
  assert.equal(titleFromFileName('worksheet.final.docx'), 'worksheet.final');
});

test('returns an empty title for a blank name', () => {
  assert.equal(titleFromFileName(''), '');
  assert.equal(titleFromFileName(null), '');
});
