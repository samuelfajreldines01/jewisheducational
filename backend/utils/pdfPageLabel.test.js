import test from 'node:test';
import assert from 'node:assert/strict';
import { labelFromTextItems } from './pdfPageLabel.js';

test('picks the large letter over Name and Date', () => {
  const label = labelFromTextItems([
    { str: 'Name:', transform: [1, 0, 0, 12, 0, 0] },
    { str: 'Date:', transform: [1, 0, 0, 12, 0, 0] },
    { str: 'A', transform: [1, 0, 0, 72, 0, 0] },
    { str: 'apple', transform: [1, 0, 0, 18, 0, 0] },
  ]);
  assert.equal(label, 'apple');
});

test('reads a paired uppercase and lowercase letter as one label', () => {
  const label = labelFromTextItems([
    { str: 'A a', transform: [1, 0, 0, 72, 0, 0] },
    { str: 'apple', transform: [1, 0, 0, 18, 0, 0] },
  ]);
  assert.equal(label, 'apple');
});

test('uses the letter only when the page has no subject word', () => {
  const label = labelFromTextItems([
    { str: 'B b', transform: [1, 0, 0, 72, 0, 0] },
    { str: 'Name:', transform: [1, 0, 0, 12, 0, 0] },
  ]);
  assert.equal(label, 'letter b');
});

test('keeps a two-word subject', () => {
  const label = labelFromTextItems([
    { str: 'I i', transform: [1, 0, 0, 72, 0, 0] },
    { str: 'ice cream', transform: [1, 0, 0, 18, 0, 0] },
  ]);
  assert.equal(label, 'ice cream');
});

test('uses the written word when there is no letter', () => {
  const label = labelFromTextItems([
    { str: 'hat', transform: [1, 0, 0, 28, 0, 0] },
  ]);
  assert.equal(label, 'hat');
});

test('returns null when the page has no usable text', () => {
  assert.equal(labelFromTextItems([{ str: 'Name:', transform: [1, 0, 0, 12, 0, 0] }]), null);
});
