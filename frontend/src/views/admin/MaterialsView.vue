<script setup>
import { ref, computed, onMounted, provide } from 'vue';
import { RouterLink } from 'vue-router';
import api from '@/api';
import { buildCategoryTree } from '@/utils/categoryTree';
import AdminCategoryFolder from '@/components/admin/AdminCategoryFolder.vue';
import BulkImportModal from '@/components/admin/BulkImportModal.vue';

const resources = ref([]);
const categories = ref([]);
const showBulkImport = ref(false);
const generatingCovers = ref(false);
const coverMessage = ref('');
const syncingGoogleCovers = ref(false);
const generatingThumbs = ref(false);
const thumbMessage = ref('');
const deleteError = ref('');
const deleting = ref(null);
const loading = ref(true);
const error = ref('');
const categoryError = ref('');

const missingCoverCount = computed(() => resources.value.filter((r) => !r.cover_image).length);

const periodLabels = {
  day: '/day',
  week: '/week',
  month: '/month',
  year: '/year',
  forever: ' total',
};

function limitLabel(resource) {
  if (resource.download_limit_max === null || resource.download_limit_max === undefined) {
    return 'Site default';
  }
  if (Number(resource.download_limit_max) === 0) {
    return 'Unlimited';
  }
  const period = periodLabels[resource.download_limit_period] || '/month';
  return `${resource.download_limit_max}${period}`;
}

// Organiza os materials em pastas, espelhando a árvore de categorys.
const categoryTree = computed(() => buildCategoryTree(categories.value));

const resourcesByCategory = computed(() => {
  const map = new Map();
  for (const r of resources.value) {
    if (!r.category_id) continue;
    const key = Number(r.category_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
});

const uncategorizedResources = computed(() => resources.value.filter((r) => !r.category_id));

onMounted(loadData);

async function loadData() {
  loading.value = true;
  error.value = '';
  categoryError.value = '';
  try {
    const [resourceResult, categoryResult] = await Promise.allSettled([
      api.get('/resources/admin/all'),
      api.get('/categories', { params: { include_hidden: 'true' } }),
    ]);
    if (resourceResult.status === 'fulfilled') {
      resources.value = resourceResult.value.data.resources || [];
    } else {
      error.value = resourceResult.reason?.response?.data?.error || 'Could not load materials. Please try again.';
      resources.value = [];
    }
    if (categoryResult.status === 'fulfilled') {
      categories.value = categoryResult.value.data.categories || [];
    } else {
      categoryError.value = categoryResult.reason?.response?.data?.error || 'Could not load categories. Materials are still available below.';
      categories.value = [];
    }
  } finally {
    loading.value = false;
  }
}

async function reloadResources() {
  try {
    const { data } = await api.get('/resources/admin/all');
    resources.value = data.resources || [];
    error.value = '';
  } catch (e) {
    error.value = e.response?.data?.error || 'Could not load materials. Please try again.';
  }
}

function onBulkImported() {
  reloadResources();
}

async function remove(id) {
  if (!confirm('Delete this resource?')) return;
  deleting.value = id;
  deleteError.value = '';
  try {
    await api.delete(`/resources/${id}`);
    resources.value = resources.value.filter((r) => r.id !== id);
  } catch (e) {
    deleteError.value = e.response?.data?.error || 'Could not delete this material. Please try again.';
  } finally {
    deleting.value = null;
  }
}

const publishing = ref(null);

async function togglePublish(r) {
  publishing.value = r.id;
  try {
    const next = !r.is_published;
    const { data } = await api.patch(`/resources/${r.id}/publish`, { is_published: next });
    r.is_published = data.resource.is_published;
  } catch {
    alert('Could not change publication status. Please try again.');
  } finally {
    publishing.value = null;
  }
}

const duplicating = ref(null);

async function duplicate(r) {
  duplicating.value = r.id;
  try {
    const { data } = await api.post(`/resources/${r.id}/duplicate`);
    resources.value = [data.resource, ...resources.value];
  } catch (e) {
    alert('Could not duplicate. ' + (e.response?.data?.error || e.message));
  } finally {
    duplicating.value = null;
  }
}

// Gera a capa (1ª página do PDF) de todos os materials sem capa.
// A renderização roda no servidor — não depende deste navegador.
async function generateMissingCovers() {
  if (!missingCoverCount.value) {
    coverMessage.value = 'All materials already have covers.';
    return;
  }
  generatingCovers.value = true;
  coverMessage.value = '';
  try {
    const { data } = await api.post('/resources/admin/generate-covers');
    const { data: refreshed } = await api.get('/resources/admin/all');
    resources.value = refreshed.resources;
    const skipped = data.skipped || [];
    const detail = skipped.length
      ? ` Without a cover: ${skipped.length} (example: "${skipped[0].title}" — ${skipped[0].reason}).`
      : '';
    coverMessage.value = `Covers generated: ${data.generated}.${detail}`;
  } catch (e) {
    coverMessage.value = 'Could not generate covers: ' + (e.response?.data?.error || e.message);
  } finally {
    generatingCovers.value = false;
  }
}

async function syncGoogleSlidesCovers() {
  if (!confirm('Refresh every cover linked to Google Slides using its current first slide?')) return;
  syncingGoogleCovers.value = true;
  coverMessage.value = '';
  try {
    const { data } = await api.post('/resources/admin/refresh-google-slides-covers');
    await reloadResources();
    const skipped = data.skipped || [];
    const detail = skipped.length
      ? ` Could not refresh: ${skipped.length} (example: "${skipped[0].title}" — ${skipped[0].reason}).`
      : '';
    coverMessage.value = `Google Slides covers synchronized: ${data.generated} of ${data.total}.${detail}`;
  } catch (e) {
    coverMessage.value = 'Could not synchronize Google Slides covers: ' + (e.response?.data?.error || e.message);
  } finally {
    syncingGoogleCovers.value = false;
  }
}

// Gera a miniatura (imagem da página) dos PDFs separados que ainda não têm —
// pros materials separados antes desse recurso existir. Roda no servidor.
async function generateFileThumbnails() {
  generatingThumbs.value = true;
  thumbMessage.value = '';
  try {
    const { data } = await api.post('/resources/admin/generate-file-thumbnails');
    const skipped = data.skipped || [];
    const detail = skipped.length ? ` Skipped: ${skipped.length}.` : '';
    thumbMessage.value = `Thumbnails generated: ${data.generated}.${detail}`;
  } catch (e) {
    thumbMessage.value = 'Could not generate thumbnails: ' + (e.response?.data?.error || e.message);
  } finally {
    generatingThumbs.value = false;
  }
}

provide('materialActions', { publishing, togglePublish, remove, limitLabel, duplicating, duplicate, deleting });
</script>

<template>
  <div>
    <div class="admin-page-header d-flex flex-wrap justify-content-between align-items-end gap-3">
      <div>
        <h1>Materials</h1>
        <p>Manage PDFs, presentations, and worksheets</p>
      </div>
      <div class="d-flex flex-wrap gap-2">
        <button
          v-if="missingCoverCount > 0"
          type="button"
          class="btn btn-outline-secondary"
          :disabled="generatingCovers"
          @click="generateMissingCovers"
        >
          <span v-if="generatingCovers" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-images me-1"></i>
          {{ generatingCovers ? 'Generating covers…' : `Generate missing covers (${missingCoverCount})` }}
        </button>
        <button
          type="button"
          class="btn btn-outline-secondary"
          :disabled="syncingGoogleCovers"
          title="Replace each Google Slides cover with its current first slide"
          @click="syncGoogleSlidesCovers"
        >
          <span v-if="syncingGoogleCovers" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-arrow-repeat me-1"></i>
          {{ syncingGoogleCovers ? 'Synchronizing Google Slides covers…' : 'Sync Google Slides covers' }}
        </button>
        <button
          type="button"
          class="btn btn-outline-secondary"
          :disabled="generatingThumbs"
          title="Generate an image of each separate PDF page so its content can be viewed without downloading"
          @click="generateFileThumbnails"
        >
          <span v-if="generatingThumbs" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-grid-3x3-gap me-1"></i>
          {{ generatingThumbs ? 'Generating thumbnails…' : 'Generate page thumbnails' }}
        </button>
        <button type="button" class="btn btn-outline-secondary" @click="showBulkImport = true">
          <i class="bi bi-cloud-arrow-up me-1"></i>Bulk upload
        </button>
        <RouterLink to="/admin/materials/new" class="btn btn-primary">
          <i class="bi bi-plus-lg me-1"></i>New resource
        </RouterLink>
      </div>
    </div>

    <BulkImportModal
      v-if="showBulkImport"
      :categories="categories"
      @close="showBulkImport = false"
      @imported="onBulkImported"
    />

    <div v-if="coverMessage" class="alert alert-info">{{ coverMessage }}</div>
    <div v-if="thumbMessage" class="alert alert-info">{{ thumbMessage }}</div>
    <div v-if="deleteError" class="alert alert-danger" role="alert">{{ deleteError }}</div>
    <div v-if="categoryError" class="alert alert-warning d-flex flex-wrap align-items-center justify-content-between gap-2" role="alert">
      <span>{{ categoryError }}</span>
      <button type="button" class="btn btn-sm btn-outline-dark" @click="loadData">Retry</button>
    </div>

    <div v-if="loading" class="admin-card text-center py-5" role="status">
      <div class="spinner-border text-primary" aria-hidden="true"></div>
      <p class="mb-0 mt-2">Loading materials…</p>
    </div>

    <div v-else-if="error" class="alert alert-danger d-flex flex-wrap align-items-center justify-content-between gap-2" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="btn btn-sm btn-outline-dark" @click="loadData">Retry</button>
    </div>

    <div v-else class="admin-card admin-card-folders">
      <AdminCategoryFolder
        v-for="node in categoryTree"
        :key="node.id"
        :node="node"
        :resources-by-category="resourcesByCategory"
      />

      <div v-if="uncategorizedResources.length" class="admin-folder">
        <div class="admin-folder-header admin-folder-header-static">
          <i class="bi bi-folder2"></i>
          <span class="admin-folder-name">Uncategorized</span>
          <span class="badge text-bg-light admin-folder-count">{{ uncategorizedResources.length }}</span>
        </div>
        <div class="admin-folder-body">
          <div v-for="r in uncategorizedResources" :key="r.id" class="admin-folder-material">
            <span class="admin-folder-material-title">{{ r.title }}</span>
            <span class="badge" :class="r.is_published ? 'bg-success' : 'bg-secondary'">
              {{ r.is_published ? 'Published' : 'Draft' }}
            </span>
            <span class="badge text-bg-light">{{ limitLabel(r) }}</span>
            <span class="admin-folder-material-downloads" title="Downloads">
              <i class="bi bi-download me-1"></i>{{ r.download_count }}
            </span>
            <div class="admin-actions">
              <button
                type="button"
                class="btn btn-sm admin-action-btn"
                :class="r.is_published ? 'btn-outline-secondary' : 'btn-success'"
                :disabled="publishing === r.id"
                :title="r.is_published ? 'Unpublish (return to draft)' : 'Publish now'"
                :aria-label="r.is_published ? 'Unpublish resource' : 'Publish resource'"
                @click="togglePublish(r)"
              >
                <span v-if="publishing === r.id" class="spinner-border spinner-border-sm"></span>
                <i v-else :class="r.is_published ? 'bi bi-eye-slash' : 'bi bi-globe'"></i>
              </button>
              <RouterLink
                :to="`/admin/materials/${r.id}`"
                class="btn btn-sm btn-outline-primary admin-action-btn"
                title="Edit material"
                aria-label="Edit material"
              >
                <i class="bi bi-pencil-square"></i>
              </RouterLink>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary admin-action-btn"
                :disabled="duplicating === r.id"
                title="Duplicate resource"
                aria-label="Duplicate resource"
                @click="duplicate(r)"
              >
                <span v-if="duplicating === r.id" class="spinner-border spinner-border-sm"></span>
                <i v-else class="bi bi-copy"></i>
              </button>
              <button
                type="button"
                class="btn btn-sm btn-outline-danger admin-action-btn"
                :disabled="deleting === r.id"
                title="Delete material"
                aria-label="Delete material"
                @click="remove(r.id)"
              >
                <span v-if="deleting === r.id" class="spinner-border spinner-border-sm"></span>
                <i v-else class="bi bi-trash3"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!resources.length" class="text-center text-muted py-4 mb-0">No materials have been added.</p>
    </div>
  </div>
</template>
