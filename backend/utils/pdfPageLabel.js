// Nome curto de uma página de PDF a partir do texto desenhado.
// Folhas tipo "trace the letter" trazem a letra grande e rótulos pequenos
// (Name, Date). A peça mais alta vence; letra isolada ganha de palavra.

const SKIP = /^(name|date|nome|data):?$/i;

export function labelFromTextItems(items) {
  const ranked = [];
  for (const item of items || []) {
    const text = String(item.str || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40 || SKIP.test(text)) continue;
    const height = Math.abs(item.transform?.[3] || item.height || 0);
    if (height <= 0) continue;
    ranked.push({ text, height });
  }
  if (!ranked.length) return null;
  const words = ranked
    .filter((row) => {
      const parts = row.text.split(' ').filter(Boolean);
      if (!parts.length || parts.length > 4) return false;
      if (parts.join('').length < 3) return false;
      return parts.every((part) => /^[\p{L}][\p{L}'-]*$/u.test(part));
    })
    .sort((a, b) => b.height - a.height || a.text.length - b.text.length);
  if (words.length) return words[0].text.toLowerCase();

  const letters = [...ranked].sort((a, b) => b.height - a.height);
  for (const row of letters) {
    const compact = row.text.replace(/\s+/g, '');
    if (/^[\p{L}]{1,2}$/u.test(compact)) return `letter ${compact[0].toLowerCase()}`;
  }
  return null;
}
