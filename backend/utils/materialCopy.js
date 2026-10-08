import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const MODEL = 'gemini-2.0-flash';

export function parseMaterialCopy(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The description came back in an unexpected format.');
  const data = JSON.parse(text.slice(start, end + 1));
  const description = String(data.description || '').replace(/\s+/g, ' ').trim();
  const content = String(data.content_description || '').trim();
  const keywords = String(data.keywords || '').replace(/\s+/g, ' ').trim();
  if (!description || !content || !keywords) throw new Error('The description came back incomplete.');
  return {
    description: description.slice(0, 240),
    content_description: content.slice(0, 2000),
    keywords: keywords.slice(0, 400),
  };
}

export async function excerptFromPdf(pdfBuffer) {
  const data = new Uint8Array(pdfBuffer);
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, isEvalSupported: false }).promise;
  const parts = [];
  try {
    const total = Math.min(doc.numPages, 3);
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
      if (line) parts.push(line);
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return parts.join('\n').slice(0, 6000);
}

export async function writeMaterialCopy({ title, excerpt, apiKey, fetchImpl = fetch }) {
  const prompt = [
    'Write catalog copy in English for one educational worksheet.',
    'The title is already chosen. Do not invent a different title.',
    'Use the page text when it is present. Do not claim details that are not supported by the title or the page text.',
    'Return only JSON with these keys:',
    'description: one sentence, under 160 characters, for a card.',
    'content_description: two to four sentences describing what is in the file.',
    'keywords: 8 to 12 search terms, separated by commas. No hash marks.',
    `Title: ${title}`,
    excerpt ? `Page text:\n${excerpt}` : 'No page text was available.',
  ].join('\n');

  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
      }),
    }
  );
  if (!response.ok) throw new Error('Could not write the description.');
  const body = await response.json();
  const raw = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return parseMaterialCopy(raw);
}
