<script setup>
import { ref, computed } from 'vue';
import api from '@/api';
import { parseMaterialsCsv, buildTemplateCsv } from '@/utils/csv';
import { titleFromFileName } from '@/utils/bulkFiles';

const props = defineProps({
  // Categories (com id, name, slug) para validar a coluna "category" na
  // pré-visualização — mesma resolução que o backend faz na importação.
  categories: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'imported']);

const step = ref('select'); // select | preview | result
const fileName = ref('');
const rows = ref([]);
const fileRows = ref([]);
const folderForAll = ref('');
const unknownHeaders = ref([]);
const hasTitle = ref(false);
const parseError = ref('');
const importing = ref(false);
const result = ref(null);

// Nomes/slugs de category conhecidos (minúsculos) para marcar o que não bate.
const categoryKeys = computed(() => {
  const set = new Set();
  for (const c of props.categories) {
    if (c.name) set.add(String(c.name).trim().toLowerCase());
    if (c.slug) set.add(String(c.slug).trim().toLowerCase());
  }
  return set;
});

function rowStatus(row) {
  if (!row.title || !row.title.trim()) return { ok: false, reason: 'No title' };
  if (row.category && !categoryKeys.value.has(row.category.trim().toLowerCase())) {
    return { ok: false, reason: 'Unknown category' };
  }
  return { ok: true, reason: '' };
}

const validRows = computed(() => rows.value.filter((r) => rowStatus(r).ok));
const invalidCount = computed(() => rows.value.length - validRows.value.length);

function downloadTemplate() {
  const blob = new Blob([buildTemplateCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'materials-import-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function onFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  parseError.value = '';
  fileName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseMaterialsCsv(String(reader.result || ''));
      rows.value = parsed.rows;
      unknownHeaders.value = parsed.unknownHeaders;
      hasTitle.value = parsed.hasTitle;
      if (!parsed.hasTitle) {
        parseError.value = 'The spreadsheet needs a "title" column. Download the template to check the headings.';
        return;
      }
      if (!parsed.rows.length) {
        parseError.value = 'No rows were found in the spreadsheet.';
        return;
      }
      step.value = 'preview';
    } catch (e) {
      parseError.value = 'The CSV could not be read. Check the file and try again.';
    }
  };
  reader.onerror = () => { parseError.value = 'The file could not be read.'; };
  reader.readAsText(file, 'utf-8');
  event.target.value = '';
}

async function runImport() {
  importing.value = true;
  try {
    const { data } = await api.post('/resources/admin/bulk-import', { rows: validRows.value });
    result.value = data;
    step.value = 'result';
    emit('imported');
  } catch (e) {
    parseError.value = e.response?.data?.error || 'Import failed. Please try again.';
  } finally {
    importing.value = false;
  }
}

function onDocs(event) {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (!files.length) return;
  parseError.value = '';
  fileRows.value = files.map((file) => ({
    file,
    title: titleFromFileName(file.name),
    category_id: '',
  }));
  folderForAll.value = '';
  step.value = 'files';
}

function applyFolderToAll() {
  for (const row of fileRows.value) row.category_id = folderForAll.value;
}

async function runFileImport() {
  importing.value = true;
  parseError.value = '';
  const created = [];
  const errors = [];
  for (const row of fileRows.value) {
    const title = row.title.trim();
    if (!title) {
      errors.push({ line: row.file.name, title: '', error: 'No title' });
      continue;
    }
    const body = new FormData();
    body.append('title', title);
    body.append('is_published', 'false');
    if (row.category_id) body.append('category_id', row.category_id);
    body.append('files', row.file);
    body.append('file_labels', JSON.stringify([title]));
    try {
      const { data } = await api.post('/resources', body);
      created.push({ title, id: data.resource?.id });
    } catch (e) {
      errors.push({ line: row.file.name, title, error: e.response?.data?.error || 'Upload failed' });
    }
  }
  result.value = { created, errors, total: fileRows.value.length };
  step.value = 'result';
  emit('imported');
  importing.value = false;
}

function reset() {
  step.value = 'select';
  fileName.value = '';
  rows.value = [];
  fileRows.value = [];
  folderForAll.value = '';
  unknownHeaders.value = [];
  parseError.value = '';
  result.value = null;
}
</script>

<template>
  <teleport to="body">
    <div class="bulk-backdrop" @click.self="emit('close')">
      <div class="bulk-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <div class="bulk-header">
          <h2 id="bulk-title" class="bulk-title">
            <i class="bi bi-cloud-arrow-up me-2"></i>Bulk upload
          </h2>
          <button type="button" class="btn-close" aria-label="Close" @click="emit('close')"></button>
        </div>

        <div class="bulk-body">
          <!-- Passo 1: escolher arquivo -->
          <template v-if="step === 'select'">
            <p class="text-muted">
              Attach one document per material and choose its folder. Or import a
              spreadsheet. A CSV still does not carry the PDF. Add a public
              <code>google_slides</code> link only when the file is a presentation.
            </p>

            <button type="button" class="btn btn-outline-secondary mb-3" @click="downloadTemplate">
              <i class="bi bi-download me-1"></i>Download CSV template
            </button>

            <label class="bulk-drop mb-3">
              <input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,application/pdf" class="d-none" multiple @change="onDocs" />
              <i class="bi bi-paperclip fs-2 d-block mb-2"></i>
              <span>Attach documents (PDF, DOC, PPT). One material per file.</span>
            </label>

            <label class="bulk-drop">
              <input type="file" accept=".csv,text/csv" class="d-none" @change="onFile" />
              <i class="bi bi-cloud-arrow-up fs-2 d-block mb-2"></i>
              <span>Or choose a CSV file</span>
            </label>

            <div class="bulk-hint">
              Accepted columns: <code>title</code>, <code>description</code>,
              <code>category</code>, <code>grade</code>, <code>material_type</code>,
              <code>keywords</code>, <code>google_slides</code>, and
              <code>published</code> (yes/no). Materials are imported as
              <strong>drafts</strong> by default.
            </div>

            <div v-if="parseError" class="alert alert-danger mt-3 mb-0">{{ parseError }}</div>
          </template>

          <template v-else-if="step === 'files'">
            <p class="text-muted">
              Each file becomes a draft. Set the title and the folder for that document.
            </p>
            <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
              <select v-model="folderForAll" class="form-select form-select-sm" style="max-width: 240px">
                <option value="">No folder</option>
                <option v-for="c in categories" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
              </select>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="applyFolderToAll">Apply folder to all</button>
              <span class="badge bg-success">{{ fileRows.length }} file(s)</span>
            </div>
            <div class="bulk-table-wrap">
              <table class="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Title</th>
                    <th>Folder</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in fileRows" :key="index">
                    <td class="text-muted small">{{ row.file.name }}</td>
                    <td><input v-model="row.title" class="form-control form-control-sm" /></td>
                    <td>
                      <select v-model="row.category_id" class="form-select form-select-sm">
                        <option value="">No folder</option>
                        <option v-for="c in categories" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="parseError" class="alert alert-danger mt-3 mb-0">{{ parseError }}</div>
          </template>

          <!-- Passo 2: pré-visualização -->
          <template v-else-if="step === 'preview'">
            <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
              <span class="badge text-bg-light"><i class="bi bi-file-earmark-text me-1"></i>{{ fileName }}</span>
              <span class="badge bg-success">{{ validRows.length }} valid</span>
              <span v-if="invalidCount" class="badge bg-warning text-dark">{{ invalidCount }} skipped</span>
            </div>

            <div v-if="unknownHeaders.length" class="alert alert-warning py-2">
              Unrecognized columns (will be ignored): {{ unknownHeaders.join(', ') }}
            </div>

            <div class="bulk-table-wrap">
              <table class="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Title</th>
                    <th>Category</th>
                    <th>Publish</th>
                    <th>Slides</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in rows" :key="row.line" :class="{ 'table-warning': !rowStatus(row).ok }">
                    <td class="text-muted">{{ row.line }}</td>
                    <td>{{ row.title || '—' }}</td>
                    <td>{{ row.category || '—' }}</td>
                    <td>{{ row.is_published ? 'Yes' : 'No' }}</td>
                    <td>
                      <i v-if="row.google_slides_url" class="bi bi-check-lg text-success" title="Link included"></i>
                      <span v-else class="text-muted">—</span>
                    </td>
                    <td>
                      <span v-if="rowStatus(row).ok" class="text-success"><i class="bi bi-check-circle"></i></span>
                      <span v-else class="text-warning-emphasis small">{{ rowStatus(row).reason }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="parseError" class="alert alert-danger mt-3 mb-0">{{ parseError }}</div>
          </template>

          <!-- Passo 3: resultado -->
          <template v-else-if="step === 'result'">
            <div class="alert alert-success">
              <i class="bi bi-check-circle-fill me-1"></i>
              {{ result.created.length }} material(s) created from {{ result.total }} row(s).
            </div>

            <div v-if="result.errors.length" class="mb-3">
              <p class="fw-semibold mb-1">Rows with errors ({{ result.errors.length }}):</p>
              <ul class="bulk-errors">
                <li v-for="err in result.errors" :key="err.line">
                  Row {{ err.line }}<span v-if="err.title"> — “{{ err.title }}”</span>: {{ err.error }}
                </li>
              </ul>
            </div>

            <div v-if="result.created.some((c) => c.slides_error)" class="mb-0">
              <p class="fw-semibold mb-1">Google Slides warnings:</p>
              <ul class="bulk-errors">
                <li v-for="c in result.created.filter((x) => x.slides_error)" :key="c.line">
                  Row {{ c.line }} — “{{ c.title }}”: {{ c.slides_error }}
                </li>
              </ul>
            </div>
          </template>
        </div>

        <div class="bulk-footer">
          <template v-if="step === 'files'">
            <button type="button" class="btn btn-link text-secondary" @click="reset">Back</button>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="importing || !fileRows.length"
              @click="runFileImport"
            >
              <span v-if="importing" class="spinner-border spinner-border-sm me-1"></span>
              {{ importing ? 'Uploading…' : `Upload ${fileRows.length} document(s)` }}
            </button>
          </template>
          <template v-else-if="step === 'preview'">
            <button type="button" class="btn btn-link text-secondary" @click="reset">Back</button>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="importing || !validRows.length"
              @click="runImport"
            >
              <span v-if="importing" class="spinner-border spinner-border-sm me-1"></span>
              {{ importing ? 'Importing…' : `Import ${validRows.length} material(s)` }}
            </button>
          </template>
          <template v-else-if="step === 'result'">
            <button type="button" class="btn btn-outline-secondary" @click="reset">Import another file</button>
            <button type="button" class="btn btn-primary" @click="emit('close')">Done</button>
          </template>
          <template v-else>
            <button type="button" class="btn btn-outline-secondary" @click="emit('close')">Cancel</button>
          </template>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.bulk-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 1060;
}
.bulk-modal {
  background: #fff;
  border-radius: 14px;
  width: 100%;
  max-width: 760px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
}
.bulk-header,
.bulk-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
}
.bulk-header { border-bottom: 1px solid #e5e7eb; }
.bulk-footer { border-top: 1px solid #e5e7eb; gap: 0.5rem; }
.bulk-title { font-size: 1.15rem; font-weight: 700; margin: 0; }
.bulk-body { padding: 1.25rem; overflow-y: auto; }
.bulk-drop {
  display: block;
  text-align: center;
  padding: 1.75rem 1rem;
  border: 2px dashed #cbd5e1;
  border-radius: 12px;
  color: #64748b;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.bulk-drop:hover { border-color: #3bafb8; background: #f0fdfa; color: #0f766e; }
.bulk-hint {
  margin-top: 1rem;
  font-size: 0.85rem;
  color: #64748b;
  line-height: 1.6;
}
.bulk-hint code {
  background: #f1f5f9;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: #0f172a;
}
.bulk-table-wrap {
  max-height: 42vh;
  overflow: auto;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}
.bulk-errors {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.88rem;
  color: #b45309;
}
</style>
