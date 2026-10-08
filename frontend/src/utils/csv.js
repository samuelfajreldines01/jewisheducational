// Utilidades de CSV para a importação em massa de materials.
//
// O parser segue o formato RFC 4180: campos separados por vírgula, aspas duplas
// para escapar vírgulas/quebras de linha, e `""` para uma aspa literal dentro
// de um campo entre aspas. Também aceita `;` como separador (planilhas em pt-BR
// costumam exportar com ponto e vírgula) — o separador é detectado no cabeçalho.

// Columns canônicas que o backend entende e os apelidos aceitos no cabeçalho
// (PT e EN), para o admin não precisar decorar nomes exatos.
const HEADER_ALIASES = {
  title: ['titulo', 'título', 'title', 'nome', 'name'],
  description: ['descricao', 'descrição', 'description', 'resumo'],
  content_description: ['descricao_conteudo', 'descrição_conteudo', 'conteudo', 'conteúdo', 'content', 'content_description'],
  category: ['category', 'categoria', 'assunto'],
  grade_level: ['serie', 'série', 'ano', 'grade', 'grade_level', 'nivel', 'nível'],
  material_type: ['tipo', 'tipo_material', 'type', 'material_type'],
  keywords: ['palavras_chave', 'palavras-chave', 'palavras chave', 'keywords', 'tags'],
  google_slides_url: ['google_slides', 'google_slides_url', 'slides', 'link_slides', 'apresentacao', 'apresentação'],
  is_published: ['publicar', 'publicado', 'published', 'status'],
  school_only: ['somente_escola', 'school_only', 'escola'],
};

// Headings e uma linha de exemplo do modelo baixável.
export const TEMPLATE_HEADERS = [
  'title',
  'description',
  'category',
  'grade',
  'material_type',
  'keywords',
  'google_slides',
  'published',
];

const TEMPLATE_EXAMPLE = [
  'Aleph-Bet Activity Sheet',
  'Worksheet for practicing the Hebrew alphabet.',
  'Hebrew',
  'Preschool',
  'Worksheet',
  'aleph bet, alphabet, hebrew',
  '',
  'no',
];

// Constrói o mapa apelido -> campo canônico.
const aliasToField = (() => {
  const map = new Map();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) map.set(alias, field);
  }
  return map;
})();

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/^﻿/, '');
}

// Detecta o separador olhando a primeira linha: usa `;` se aparecer mais que `,`.
function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

// Parser de CSV em uma passada, respeitando aspas e o separador informado.
// Retorna uma matriz de linhas (cada linha é um array de células).
function parseRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  // Última célula/linha (arquivo sem quebra final).
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Lê o texto de um CSV e devolve linhas normalizadas nos campos canônicos.
 * @param {string} text conteúdo bruto do arquivo CSV
 * @returns {{ rows: object[], unknownHeaders: string[], hasTitle: boolean }}
 */
export function parseMaterialsCsv(text) {
  const delimiter = detectDelimiter(text);
  const matrix = parseRows(text, delimiter).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!matrix.length) return { rows: [], unknownHeaders: [], hasTitle: false };

  const rawHeaders = matrix[0].map(normalizeHeader);
  const fields = rawHeaders.map((h) => aliasToField.get(h) || null);
  const unknownHeaders = rawHeaders.filter((h, i) => h && !fields[i]);
  const hasTitle = fields.includes('title');

  const rows = matrix.slice(1).map((cells, idx) => {
    const obj = { line: idx + 2 }; // +2: pula o cabeçalho e usa 1-based
    fields.forEach((field, col) => {
      if (!field) return;
      const value = cells[col] !== undefined ? String(cells[col]).trim() : '';
      if (field === 'is_published' || field === 'school_only') {
        obj[field] = /^(1|true|sim|s|yes|y|publicad|publicar)/i.test(value);
      } else {
        obj[field] = value;
      }
    });
    obj.title = obj.title || '';
    return obj;
  });

  return { rows, unknownHeaders, hasTitle };
}

// Escapa uma célula para saída CSV (aspas quando necessário).
function escapeCell(value) {
  const s = String(value ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Gera o conteúdo do modelo CSV (cabeçalho + uma linha de exemplo). O BOM no
// começo faz o Excel abrir os acentos corretamente.
export function buildTemplateCsv() {
  const lines = [
    TEMPLATE_HEADERS.map(escapeCell).join(','),
    TEMPLATE_EXAMPLE.map(escapeCell).join(','),
  ];
  return '﻿' + lines.join('\n');
}
