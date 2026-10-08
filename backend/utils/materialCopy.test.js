import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaterialCopy, writeMaterialCopy } from './materialCopy.js';

test('reads the three catalog fields from a JSON reply', () => {
  const copy = parseMaterialCopy(`\`\`\`json
{"description":"Trace the letter A.","content_description":"A one-page worksheet.","keywords":"aleph, handwriting"}
\`\`\``);
  assert.equal(copy.description, 'Trace the letter A.');
  assert.equal(copy.content_description, 'A one-page worksheet.');
  assert.equal(copy.keywords, 'aleph, handwriting');
});

test('rejects a reply that omits a field', () => {
  assert.throws(() => parseMaterialCopy('{"description":"Only this."}'));
});

test('sends the title and returns the parsed copy', async () => {
  const copy = await writeMaterialCopy({
    title: 'Alphabet Trace',
    excerpt: 'A a apple',
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      assert.match(prompt, /Alphabet Trace/);
      assert.match(prompt, /apple/);
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  description: 'Trace and color the letter A.',
                  content_description: 'The page shows a large A and the word apple.',
                  keywords: 'alphabet, letter a, apple, tracing',
                }),
              }],
            },
          }],
        }),
      };
    },
  });
  assert.equal(copy.keywords, 'alphabet, letter a, apple, tracing');
});
