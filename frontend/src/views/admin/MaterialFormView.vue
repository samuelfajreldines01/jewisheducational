<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '@/api';
import { parseResourcePageLayout, RESOURCE_PAGE_DEFAULTS } from '@/utils/resourcePage';
import { generatePdfThumbnail } from '@/utils/pdfThumbnail';
import { buildCategoryTree } from '@/utils/categoryTree';
import { parseMaterialTypes } from '@/utils/materialTypes';
import CategorySearchSelect from '@/components/admin/CategorySearchSelect.vue';

const route = useRoute();
const router = useRouter();
const isEdit = computed(() => route.params.id && route.params.id !== 'novo');

const categories = ref([]);
const gradeLevels = ref([]);
const materialTypes = ref([]);
const siteName = ref('');
const form = ref({
  title: '',
  description: '',
  content_description: '',
  keywords: '',
  age_range: '',
  grade_level: '',
  material_type: '',
  category_id: '',
  display_mode: 'default',
  is_published: false,
  school_only: false,
  download_limit_type: 'default',
  download_limit_max: 3,
  download_limit_period: 'month',
});
const coverFile = ref(null);
const files = ref([]);
const fileLabels = ref([]);
const existingFiles = ref([]);
const newSingleFile = ref(null);
const newSingleLabel = ref('');
const newSingleIsBundle = ref(false);
const addingFile = ref(false);
const error = ref('');
const loading = ref(false);
const generatingPreview = ref(false);
const generatingCover = ref(false);
const writingCopy = ref(false);
const coverGenerated = ref(false);
const pendingPublish = ref(false);
const pageLayout = ref(structuredClone(RESOURCE_PAGE_DEFAULTS));
const previewSlug = ref('');
const googleSlidesUrl = ref('');
const canvaUrl = ref('');
const importingSlides = ref(false);
const splittingFileId = ref(null);
const removingFileId = ref(null);
const siteDefaultLimitText = ref('');

const hasCoverSource = computed(() => existingFiles.value.some((file) =>
  ['pdf', 'ppt', 'pptx', 'presentation'].includes(String(file.file_type || '').toLowerCase())
));

// Lista todas as categorys em qualquer profundidade. O rótulo mostra só o
// nome da folha (curto, indentado por nível); o caminho completo vai em `path`
// para a busca ainda encontrar pelo nome do assunto-pai.
const categoryOptions = computed(() => {
  const tree = buildCategoryTree(categories.value);
  const options = [];
  function walk(nodes, prefixParts) {
    for (const node of nodes) {
      const parts = [...prefixParts, node.name];
      options.push({
        id: node.id,
        label: node.name,
        parent: prefixParts[prefixParts.length - 1] || '',
        depth: prefixParts.length,
        path: parts.join(' › '),
      });
      if (node.children?.length) walk(node.children, parts);
    }
  }
  walk(tree, []);
  return options;
});

const periodLabels = {
  day: 'per day',
  week: 'per week',
  month: 'per month',
  year: 'per year',
  forever: 'in total',
};

function loadDownloadLimitFromResource(resource) {
  if (resource.download_limit_max === null || resource.download_limit_max === undefined) {
    form.value.download_limit_type = 'default';
    return;
  }
  if (Number(resource.download_limit_max) === 0) {
    form.value.download_limit_type = 'unlimited';
    return;
  }
  form.value.download_limit_type = 'custom';
  form.value.download_limit_max = Number(resource.download_limit_max) || 3;
  form.value.download_limit_period = resource.download_limit_period || 'month';
}

function appendDownloadLimit(fd) {
  if (form.value.download_limit_type === 'default') {
    fd.append('download_limit_max', '');
    fd.append('download_limit_period', '');
  } else if (form.value.download_limit_type === 'unlimited') {
    fd.append('download_limit_max', '0');
    fd.append('download_limit_period', '');
  } else {
    fd.append('download_limit_max', String(form.value.download_limit_max ?? 1));
    fd.append('download_limit_period', form.value.download_limit_period || 'month');
  }
}

onMounted(async () => {
  const { data } = await api.get('/categories', { params: { include_hidden: 'true' } });
  categories.value = data.categories;

  const { data: settingsData } = await api.get('/settings');
  gradeLevels.value = (settingsData.settings?.grade_levels || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  materialTypes.value = parseMaterialTypes(settingsData.settings?.material_types);
  siteName.value = settingsData.settings?.site_name || 'Jewish Educational Resources';

  const settings = settingsData.settings || {};
  if (settings.download_limit_enabled === 'true') {
    const max = Number(settings.download_limit_max);
    if (max === 0) {
      siteDefaultLimitText.value = 'Unlimited';
    } else {
      const period = periodLabels[settings.download_limit_period] || 'per month';
      siteDefaultLimitText.value = `${max} download(s) ${period}`;
    }
  } else {
    siteDefaultLimitText.value = 'Unlimited (global limit disabled)';
  }

  if (isEdit.value) {
    const { data: adminData } = await api.get('/resources/admin/all');
    const resource = adminData.resources.find((r) => r.id === Number(route.params.id));
    if (resource) {
      form.value = {
        title: resource.title,
        description: resource.description || '',
        content_description: resource.content_description || '',
        keywords: resource.keywords || '',
        age_range: resource.age_range || '',
        grade_level: resource.grade_level || '',
        material_type: resource.material_type || '',
        category_id: resource.category_id || '',
        display_mode: resource.display_mode || 'default',
        is_published: !!resource.is_published,
        school_only: !!resource.school_only,
        download_limit_type: 'default',
        download_limit_max: 3,
        download_limit_period: 'month',
      };
      loadDownloadLimitFromResource(resource);
      pendingPublish.value = !!resource.is_published;
      previewSlug.value = resource.slug;
      pageLayout.value = parseResourcePageLayout(resource.page_layout);
      canvaUrl.value = resource.canva_url || '';
      const { data: detail } = await api.get(`/resources/${resource.slug}`);
      existingFiles.value = detail.resource.files || [];
    }
  }
});

function onCoverChange(e) {
  coverFile.value = e.target.files[0] || null;
}

// Gera a capa a partir do arquivo já enviado. Para Google Slides, o servidor
// usa a imagem nativa do primeiro slide; para outros arquivos, usa o renderer
// local correspondente.
async function refreshGeneratedCover() {
  generatingCover.value = true;
  coverGenerated.value = false;
  error.value = '';
  try {
    await api.post(`/resources/${route.params.id}/generate-cover`);
    coverGenerated.value = true;
    setTimeout(() => { coverGenerated.value = false; }, 4000);
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Could not generate the cover.';
  } finally {
    generatingCover.value = false;
  }
}

function onFilesChange(e) {
  files.value = Array.from(e.target.files);
  fileLabels.value = files.value.map((f) => f.name.replace(/\.[^.]+$/, ''));
  const empty = !form.value.description && !form.value.content_description && !form.value.keywords;
  if (empty && form.value.title.trim() && files.value.length) writeCopy();
}

async function writeCopy() {
  const title = form.value.title.trim();
  if (!title || writingCopy.value) return;
  writingCopy.value = true;
  error.value = '';
  try {
    const body = new FormData();
    body.append('title', title);
    const pdf = files.value.find((file) => /\.pdf$/i.test(file.name));
    if (pdf) body.append('file', pdf);
    const { data } = await api.post('/resources/admin/suggest-copy', body);
    form.value.description = data.description || '';
    form.value.content_description = data.content_description || '';
    form.value.keywords = data.keywords || '';
  } catch (e) {
    error.value = e.response?.data?.error || 'Could not write the description.';
  } finally {
    writingCopy.value = false;
  }
}

function updateFileLabel(index, value) {
  fileLabels.value[index] = value;
}

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    const fd = new FormData();
    fd.append('title', form.value.title);
    fd.append('description', form.value.description);
    fd.append('content_description', form.value.content_description);
    fd.append('keywords', form.value.keywords || '');
    fd.append('age_range', form.value.age_range);
    fd.append('grade_level', form.value.grade_level || '');
    fd.append('material_type', form.value.material_type || '');
    fd.append('display_mode', form.value.display_mode);
    if (form.value.category_id) fd.append('category_id', form.value.category_id);
    fd.append('is_published', pendingPublish.value ? 'true' : 'false');
    fd.append('school_only', form.value.school_only ? 'true' : 'false');
    appendDownloadLimit(fd);
    fd.append('page_layout', JSON.stringify(pageLayout.value));
    if (googleSlidesUrl.value.trim()) {
      fd.append('google_slides_url', googleSlidesUrl.value.trim());
    }
    fd.append('canva_url', canvaUrl.value.trim());

    // A capa é gerada no servidor (1ª página do PDF) quando nenhuma é enviada.
    if (coverFile.value) fd.append('cover', coverFile.value);

    files.value.forEach((f) => fd.append('files', f));
    if (fileLabels.value.length) fd.append('file_labels', JSON.stringify(fileLabels.value));

    // Galeria de capas: gera a miniatura da 1ª página de cada PDF enviado e
    // manda junto, com um índice que liga cada miniatura ao seu arquivo.
    if (form.value.display_mode === 'gallery' && files.value.length) {
      generatingPreview.value = true;
      const thumbIndices = [];
      try {
        for (let i = 0; i < files.value.length; i++) {
          const f = files.value[i];
          if (f.type !== 'application/pdf') continue;
          const thumb = await generatePdfThumbnail(f, { watermark: siteName.value });
          if (thumb) {
            fd.append('file_thumbnails', thumb);
            thumbIndices.push(i);
          }
        }
      } catch {
        /* segue sem miniaturas — os cards caem na capa do material */
      } finally {
        generatingPreview.value = false;
      }
      fd.append('file_thumbnail_index', JSON.stringify(thumbIndices));
    }

    let response;
    if (isEdit.value) {
      response = await api.put(`/resources/${route.params.id}`, fd);
    } else {
      response = await api.post('/resources', fd);
    }
    if (response.data?.slides_import_error) {
      alert(`The resource was saved, but the Google Slides presentation could not be imported:\n\n${response.data.slides_import_error}\n\nOpen the resource and try importing the link again.`);
    }
    router.push('/admin/materials');
  } catch (e) {
    error.value = e.response?.data?.error || 'Could not save the resource.';
  } finally {
    loading.value = false;
  }
}

async function removeFile(fileId) {
  if (!confirm('Remove this file?')) return;
  removingFileId.value = fileId;
  error.value = '';
  try {
    await api.delete(`/resources/files/${fileId}`);
    existingFiles.value = existingFiles.value.filter((f) => f.id !== fileId);
  } catch (e) {
    error.value = e.response?.data?.error || 'Could not remove the file.';
  } finally {
    removingFileId.value = null;
  }
}

async function addSingleFile() {
  if (!newSingleFile.value) return;
  addingFile.value = true;
  error.value = '';
  try {
    const fd = new FormData();
    fd.append('file', newSingleFile.value);
    if (newSingleLabel.value.trim()) fd.append('label', newSingleLabel.value.trim());
    if (newSingleIsBundle.value) {
      fd.append('is_bundle', 'true');
      fd.append('premium_only', 'true');
    }
    const { data } = await api.post(`/resources/${route.params.id}/files`, fd);
    existingFiles.value = data.files;
    newSingleFile.value = null;
    newSingleLabel.value = '';
    newSingleIsBundle.value = false;
  } catch (e) {
    error.value = e.response?.data?.error || 'Could not add the file.';
  } finally {
    addingFile.value = false;
  }
}

async function importGoogleSlides() {
  if (!googleSlidesUrl.value.trim()) return;
  importingSlides.value = true;
  error.value = '';
  try {
    const { data } = await api.post(`/resources/${route.params.id}/import-google-slides`, {
      url: googleSlidesUrl.value.trim()
    });
    existingFiles.value = data.files;
    googleSlidesUrl.value = '';
  } catch (e) {
    error.value = e.response?.data?.error || 'Could not import Google Slides.';
  } finally {
    importingSlides.value = false;
  }
}

async function saveFileLabel(file) {
  await api.patch(`/resources/files/${file.id}`, { label: file.label });
}

// Separa um PDF de várias páginas em 1 PDF por página (todos grátis) e
// marca o original como "PDF completo (Premium)" — mesmo efeito do checkbox
// manual, só que sem precisar exportar cada página uma por uma.
async function splitFile(file) {
  if (!confirm(`Split "${file.original_name}" into one file per page?\n\nThe original file becomes the "Full PDF" (Premium), and each page becomes a free file.`)) return;
  splittingFileId.value = file.id;
  error.value = '';
  try {
    const { data } = await api.post(`/resources/${route.params.id}/split-file/${file.id}`);
    existingFiles.value = data.files;
  } catch (e) {
    error.value = e.response?.data?.error || 'Could not split the PDF.';
  } finally {
    splittingFileId.value = null;
  }
}

async function toggleFileBundle(file) {
  const next = !(file.is_bundle || Number(file.is_bundle) === 1);
  const { data } = await api.patch(`/resources/files/${file.id}`, {
    is_bundle: next,
    premium_only: next,
  });
  const idx = existingFiles.value.findIndex((f) => f.id === file.id);
  if (idx >= 0) existingFiles.value[idx] = data.file;
  if (next) {
    existingFiles.value = existingFiles.value.map((f) =>
      f.id === file.id ? data.file : { ...f, is_bundle: 0, premium_only: 0 }
    );
  }
}
</script>

<template>
  <div>
    <div class="admin-page-header d-flex flex-wrap justify-content-between align-items-start gap-3">
      <div>
        <h1>{{ isEdit ? 'Edit resource' : 'New resource' }}</h1>
        <p>Content, files, and complete public-page customization</p>
      </div>
      <a
        v-if="isEdit && previewSlug"
        :href="`/resource/${previewSlug}`"
        target="_blank"
        rel="noopener"
        class="btn btn-outline-secondary btn-sm"
      >
        <i class="bi bi-box-arrow-up-right me-1"></i>View resource page
      </a>
    </div>
    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <form class="admin-card" @submit.prevent="submit">
      <div class="admin-card-body">
        <div class="mb-3">
          <label class="form-label" for="material-title">Title *</label>
          <input id="material-title" v-model="form.title" type="text" class="form-control" required />
        </div>
        <div class="mb-3">
          <label class="form-label">Short summary</label>
          <textarea v-model="form.description" class="form-control" rows="2" placeholder="One line for cards and search"></textarea>
        </div>
        <div class="mb-3">
          <label class="form-label">What is in this file</label>
          <textarea
            v-model="form.content_description"
            class="form-control"
            rows="8"
            placeholder="Describe the PDF content..."
          ></textarea>
        </div>
        <div class="mb-3">
          <label class="form-label">Search keywords</label>
          <input
            v-model="form.keywords"
            type="text"
            class="form-control"
            placeholder="Example: aleph bet, Hebrew alphabet, letters, handwriting"
          />
          <div class="form-text">
            Extra terms that help people find this resource in search, separated by commas. They are not displayed on the public page.
          </div>
          <button
            type="button"
            class="btn btn-outline-secondary btn-sm mt-2"
            :disabled="writingCopy || !form.title.trim()"
            @click="writeCopy"
          >
            <span v-if="writingCopy" class="spinner-border spinner-border-sm me-1"></span>
            {{ writingCopy ? 'Writing…' : 'Write summary, description and keywords' }}
          </button>
        </div>
        <div class="row mb-3">
          <div class="col-md-3">
            <label class="form-label">Age range</label>
            <input v-model="form.age_range" type="text" class="form-control" placeholder="Example: ages 4–8" />
          </div>
          <div class="col-md-3">
            <label class="form-label">Grade</label>
            <div v-if="gradeLevels.length" class="material-choice-list">
              <div class="form-check">
                <input id="grade-none" v-model="form.grade_level" class="form-check-input" type="radio" value="" />
                <label class="form-check-label" for="grade-none">No grade</label>
              </div>
              <div v-for="(g, gi) in gradeLevels" :key="g" class="form-check">
                <input :id="'grade-' + gi" v-model="form.grade_level" class="form-check-input" type="radio" :value="g" />
                <label class="form-check-label" :for="'grade-' + gi">{{ g }}</label>
              </div>
            </div>
            <div v-else class="form-text">
              Define grade levels in Settings to use this field.
            </div>
          </div>
          <div class="col-md-3">
            <label class="form-label">Resource type</label>
            <div v-if="materialTypes.length" class="material-choice-list">
              <div class="form-check">
                <input id="mt-none" v-model="form.material_type" class="form-check-input" type="radio" value="" />
                <label class="form-check-label" for="mt-none">No type</label>
              </div>
              <div v-for="(mt, mti) in materialTypes" :key="mt.label" class="form-check">
                <input :id="'mt-' + mti" v-model="form.material_type" class="form-check-input" type="radio" :value="mt.label" />
                <label class="form-check-label" :for="'mt-' + mti">{{ mt.label }}</label>
              </div>
            </div>
            <div v-else class="form-text">
              Define resource types in Settings to use this field.
            </div>
          </div>
          <div class="col-md-3">
            <label class="form-label">Category</label>
            <CategorySearchSelect
              v-model="form.category_id"
              :options="categoryOptions"
              empty-label="Uncategorized"
              placeholder="Search category..."
            />
          </div>
        </div>

        <div class="mb-3">
          <label class="form-label">Display</label>
          <div class="d-flex flex-wrap gap-4">
            <div class="form-check">
              <input id="display-default" v-model="form.display_mode" class="form-check-input" type="radio" value="default" />
              <label class="form-check-label" for="display-default">File list</label>
            </div>
            <div class="form-check">
              <input id="display-grid" v-model="form.display_mode" class="form-check-input" type="radio" value="grid" />
              <label class="form-check-label" for="display-grid">Grid collection (letters/worksheets)</label>
            </div>
            <div class="form-check">
              <input id="display-gallery" v-model="form.display_mode" class="form-check-input" type="radio" value="gallery" />
              <label class="form-check-label" for="display-gallery">Cover gallery</label>
            </div>
          </div>
          <div class="form-text">
            <strong>List:</strong> files in a simple list.
            <strong>Grid:</strong> ideal for Aleph-Bet — each button represents one PDF containing one letter.
            <strong>Gallery:</strong> each file becomes a card with a thumbnail of the first PDF page.
          </div>
        </div>
        <div v-if="form.display_mode !== 'default'" class="alert alert-info py-2 small mb-3">
          <i class="bi bi-plus-circle me-1"></i>
          <strong>How to add more items:</strong> upload PDFs in bulk or use the new-file field.
          {{ form.display_mode === 'gallery' ? 'Each PDF becomes a card with a gallery thumbnail.' : 'Each PDF becomes a button in the grid.' }}
        </div>
        <div class="mb-4 p-3 border rounded" :class="form.school_only ? 'border-warning bg-warning-subtle' : 'bg-light'">
          <div class="form-check form-switch">
            <input id="school-only" v-model="form.school_only" class="form-check-input" type="checkbox" role="switch" />
            <label class="form-check-label fw-semibold" for="school-only">
              <i class="bi bi-mortarboard me-1"></i>School plan exclusive
            </label>
          </div>
          <div class="form-text">
            When enabled, only <strong>School</strong> plan subscribers and administrators can download or preview this resource.
            Parents &amp; Teachers subscribers and free users see the School plan checkout screen.
          </div>
        </div>

        <div class="mb-4 p-3 border rounded bg-light">
          <label class="form-label fw-semibold mb-2">Download limit for this material</label>
          <p class="text-muted small mb-3">
            Set a limit only for this resource. If you choose "Site default," the rules in Settings apply.
            Browser previews do not count; only file downloads do.
          </p>
          <div class="d-flex flex-column gap-2 mb-3">
            <div class="form-check">
              <input
                id="limit-default"
                v-model="form.download_limit_type"
                class="form-check-input"
                type="radio"
                value="default"
              />
              <label class="form-check-label" for="limit-default">
                Use site default <span v-if="siteDefaultLimitText" class="text-muted small">({{ siteDefaultLimitText }})</span>
              </label>
            </div>
            <div class="form-check">
              <input
                id="limit-unlimited"
                v-model="form.download_limit_type"
                class="form-check-input"
                type="radio"
                value="unlimited"
              />
              <label class="form-check-label" for="limit-unlimited">Unlimited for this resource</label>
            </div>
            <div class="form-check">
              <input
                id="limit-custom"
                v-model="form.download_limit_type"
                class="form-check-input"
                type="radio"
                value="custom"
              />
              <label class="form-check-label" for="limit-custom">Custom limit for this resource</label>
            </div>
          </div>
          <div v-if="form.download_limit_type === 'custom'" class="row g-2">
            <div class="col-md-4">
              <label class="form-label small">Maximum quantity</label>
              <input
                v-model.number="form.download_limit_max"
                type="number"
                min="1"
                class="form-control"
                required
              />
            </div>
            <div class="col-md-4">
              <label class="form-label small">Period</label>
              <select v-model="form.download_limit_period" class="form-select">
                <option value="day">Per day</option>
                <option value="week">Per week</option>
                <option value="month">per month</option>
                <option value="year">Per year</option>
                <option value="forever">Lifetime total (no reset)</option>
              </select>
            </div>
            <div class="col-md-4 d-flex align-items-end">
              <div class="form-text">
                Example: {{ form.download_limit_max || 1 }} download(s) {{ periodLabels[form.download_limit_period] || 'per month' }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="isEdit && hasCoverSource" class="mb-3 p-3 border rounded bg-light">
          <button
            type="button"
            class="btn btn-outline-secondary"
            :disabled="generatingCover"
            @click="refreshGeneratedCover"
          >
            <span v-if="generatingCover" class="spinner-border spinner-border-sm me-1"></span>
            <i v-else class="bi bi-image me-1"></i>
            Refresh generated cover
          </button>
          <span v-if="coverGenerated" class="text-success ms-2 small fw-semibold">
            <i class="bi bi-check-lg"></i> Cover refreshed! Reload the material page to view it.
          </span>
          <div class="form-text">
            Creates a cover from the first page or slide for the library card. Imported Google Slides use Google’s own rendering, so the preview matches the presentation.
          </div>
        </div>

        <div class="mb-3">
          <label class="form-label" for="material-files">Bulk files (up to 50 — PDF, DOCX, PPT)</label>
          <input id="material-files" type="file" class="form-control" multiple accept=".pdf,.docx,.ppt,.pptx" @change="onFilesChange" />
          <div class="form-text">
            <i class="bi bi-info-circle me-1"></i>
            Supports presentations (.ppt, .pptx). <strong>Google Slides</strong> presentations also work when downloaded as PowerPoint (.pptx) or imported below.
          </div>
        </div>
        <div class="mb-3">
          <label class="form-label">Import from Google Slides (optional)</label>
          <div class="input-group">
            <input
              v-model="googleSlidesUrl"
              type="url"
              class="form-control"
              placeholder="Paste a Google Slides edit or view link..."
            />
            <button
              v-if="isEdit"
              type="button"
              class="btn btn-outline-primary"
              :disabled="importingSlides || !googleSlidesUrl.trim()"
              @click="importGoogleSlides"
            >
              <span v-if="importingSlides" class="spinner-border spinner-border-sm me-1"></span>
              <i v-else class="bi bi-download me-1"></i>
              Import now
            </button>
          </div>
          <div class="form-text">
            Make sure the Google Slides presentation is shared as "Anyone with the link can view."
          </div>
        </div>

        <div class="mb-3">
          <label class="form-label" for="material-canva-url">Link from Canva (optional)</label>
          <input
            id="material-canva-url"
            v-model="canvaUrl"
            type="url"
            class="form-control"
            placeholder="Paste a public Canva view, edit, embed, or canva.link URL..."
          />
          <div class="form-text">
            Paste a Canva Share link, including canva.link. Presentations are view-only on this site and cannot be downloaded.
          </div>
        </div>

        <div v-if="files.length" class="mb-3">
          <label class="form-label">Label for each file (example: Hebrew letter)</label>
          <div v-for="(f, i) in files" :key="i" class="input-group mb-2">
            <span class="input-group-text small text-truncate" style="max-width: 180px">{{ f.name }}</span>
            <input
              v-model="fileLabels[i]"
              type="text"
              class="form-control"
              :placeholder="form.display_mode === 'grid' ? 'Example: א' : 'Display name'"
              @input="updateFileLabel(i, $event.target.value)"
            />
          </div>
        </div>

        <div v-if="existingFiles.length" class="mb-3">
          <label class="form-label">Existing files ({{ existingFiles.length }})</label>
          <ul class="list-group mb-3">
            <li v-for="f in existingFiles" :key="f.id" class="list-group-item">
              <div class="d-flex flex-wrap align-items-center gap-2">
                <span class="badge text-bg-light">{{ f.file_type }}</span>
                <input
                  v-model="f.label"
                  type="text"
                  class="form-control form-control-sm"
                  style="max-width: 120px"
                  placeholder="Label"
                  @blur="saveFileLabel(f)"
                />
                <span class="small text-muted flex-grow-1">{{ f.original_name }}</span>
                <div v-if="form.display_mode !== 'default'" class="form-check form-check-inline mb-0">
                  <input
                    :id="'bundle-' + f.id"
                    class="form-check-input"
                    type="checkbox"
                    :checked="!!f.is_bundle"
                    @change="toggleFileBundle(f)"
                  />
                  <label class="form-check-label small" :for="'bundle-' + f.id">Full PDF (Premium)</label>
                </div>
                <button
                  v-if="f.file_type === 'pdf'"
                  type="button"
                  class="btn btn-sm btn-outline-secondary admin-action-btn"
                  :disabled="splittingFileId === f.id"
                  title="Split into one free PDF per page and mark this one as Premium"
                  aria-label="Split PDF into pages"
                  @click="splitFile(f)"
                >
                  <span v-if="splittingFileId === f.id" class="spinner-border spinner-border-sm"></span>
                  <i v-else class="bi bi-scissors"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-danger admin-action-btn" :disabled="removingFileId === f.id" title="Remove file" aria-label="Remove file" @click="removeFile(f.id)">
                  <span v-if="removingFileId === f.id" class="spinner-border spinner-border-sm"></span>
                  <i v-else class="bi bi-trash3"></i>
                </button>
              </div>
            </li>
          </ul>
          <div class="form-text">
            <i class="bi bi-scissors me-1"></i>Use the scissors to split a multi-page PDF into one free PDF per page. The original automatically becomes the "Full PDF (Premium)."
          </div>
        </div>

      </div>
      <div class="admin-card-header border-top d-flex flex-wrap gap-2 align-items-center">
        <span v-if="isEdit" class="badge" :class="form.is_published ? 'bg-success' : 'bg-secondary'">
          <i class="bi me-1" :class="form.is_published ? 'bi-globe' : 'bi-eye-slash'"></i>
          {{ form.is_published ? 'Published' : 'Draft (only you can see it)' }}
        </span>

        <button type="submit" class="btn btn-primary" :disabled="loading" @click="pendingPublish = true">
          <span v-if="loading && pendingPublish" class="spinner-border spinner-border-sm me-2"></span>
          <i v-else class="bi bi-globe me-1"></i>
          {{ isEdit && form.is_published ? 'Save' : 'Publish' }}
        </button>

        <button type="submit" class="btn btn-outline-secondary" :disabled="loading" @click="pendingPublish = false">
          <span v-if="loading && !pendingPublish" class="spinner-border spinner-border-sm me-2"></span>
          <i v-else class="bi me-1" :class="isEdit && form.is_published ? 'bi-eye-slash' : 'bi-pencil'"></i>
          Draft
        </button>

        <router-link to="/admin/materials" class="btn btn-outline-secondary ms-auto">
          <i class="bi bi-x-lg me-1"></i>Cancel
        </router-link>
      </div>
      <p class="text-muted small px-3 pb-3 mb-0">
        <i class="bi bi-info-circle me-1"></i>
        A <strong>Draft</strong> is visible only to you. <strong>Publish</strong> makes the resource visible to everyone on the site.
      </p>
    </form>
  </div>
</template>

<style scoped>
/* Nível/Tipo como botões de opção (no lugar do menu suspenso). Rola se a
   lista ficar longa, sem esticar a altura do formulário. */
.material-choice-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin-top: 0.15rem;
  max-height: 220px;
  overflow-y: auto;
  padding: 0.35rem 0.5rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}
</style>
