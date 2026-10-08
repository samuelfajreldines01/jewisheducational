export function titleFromFileName(name) {
  return String(name || '').replace(/\.[^.]+$/, '').trim();
}
