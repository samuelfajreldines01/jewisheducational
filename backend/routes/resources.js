import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import * as db from '../db/index.js';
import { authenticate, optionalAuth, requireAdmin } from '../middleware/auth.js';
import { upload, getFileType, processUploadedFile, processUploadedFiles, uploadDir } from '../middleware/upload.js';
import { uniqueSlug } from '../utils/helpers.js';
import { getDescendantIds } from './categories.js';
import { isFirestoreBackend } from '../config/database.js';
import { generatePdfCover } from '../utils/pdfCover.js';
import { excerptFromPdf, writeMaterialCopy } from '../utils/materialCopy.js';
import { generateImageCover, generatePptxCover } from '../utils/pptxCover.js';
import {
  downloadGoogleSlidesFirstSlide,
  googleSlidesPptxExportUrl,
  googleSlidesPresentationId,
  googleSlidesSourceUrl,
  googleSlidesSourceUrlFromImportedFile,
} from '../utils/googleSlides.js';
import { resolveCanvaSourceUrl } from '../utils/canva.js';
import { PDFDocument } from 'pdf-lib';
import { normalizeBundleFiles } from '../utils/resourceFiles.js';
import { normalizeFileName } from '../utils/storagePaths.js';

const router = Router();
const MAX_FILES = 50;

function createResultId(result) {
  return result?.insertId ?? result?.id ?? result?.resource?.id ?? null;
}

function assetExtension(storagePath, fallback = '.jpg') {
  const extension = path.extname(String(storagePath || '')).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(extension) ? extension : fallback;
}

function imageMimeType(storagePath, fallback = 'image/jpeg') {
  const extension = assetExtension(storagePath);
  return {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[extension] || fallback;
}

function parseFileLabels(body) {
  if (!body.file_labels) return [];
  try {
    const parsed = typeof body.file_labels === 'string' ? JSON.parse(body.file_labels) : body.file_labels;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDownloadLimit(body) {
  const raw = body.download_limit_max;
  if (raw === '' || raw === undefined || raw === null) {
    return { download_limit_max: null, download_limit_period: null };
  }
  const max = parseInt(raw, 10);
  if (Number.isNaN(max)) {
    return { download_limit_max: null, download_limit_period: null };
  }
  const period = max > 0 ? (body.download_limit_period || null) : null;
  return { download_limit_max: max, download_limit_period: period };
}

function parsePageLayout(body) {
  const raw = body.page_layout;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      return null;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

// Normaliza um valor de célula da planilha: string aparada ou null.
function bulkStr(v) {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

// Interpreta a coluna "publicar" da planilha (aceita PT/EN, número ou boolean).
function bulkBool(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'sim', 's', 'yes', 'y', 'publicado', 'publicar'].includes(s);
}

function coverUrl(file, existing = null) {
  if (file?.publicUrl) return file.publicUrl;
  if (file?.filename) return `/uploads/covers/${file.filename}`;
  return existing;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function uploadedStoragePath(file) {
  if (!file) return null;
  if (file.storagePath) return file.storagePath;
  if (file.path) {
    return path.relative(uploadDir, file.path).replaceAll('\\', '/');
  }
  if (file.filename) {
    const subdir = file.fieldname === 'cover' || file.fieldname === 'file_thumbnails' ? 'covers' : 'files';
    return `${subdir}/${file.filename}`;
  }
  return null;
}

async function cleanupUploadedFiles(files = []) {
  const paths = new Set((files || []).map(uploadedStoragePath).filter(Boolean));
  const failed = [];
  for (const storagePath of paths) {
    try { await db.storageDelete(storagePath); } catch (error) {
      failed.push(storagePath);
      console.error('Storage cleanup deferred:', storagePath, error.message);
    }
  }
  return failed;
}

async function cleanupThumbnailMap(thumbnailMap = {}) {
  const paths = new Set(Object.values(thumbnailMap).map(storedAssetPath).filter(Boolean));
  const failed = [];
  for (const storagePath of paths) {
    try { await db.storageDelete(storagePath); } catch (error) {
      failed.push(storagePath);
      console.error('Thumbnail cleanup deferred:', storagePath, error.message);
    }
  }
  return failed;
}

async function cleanupStoragePaths(storagePaths = []) {
  const failed = [];
  for (const storagePath of new Set(storagePaths.filter(Boolean))) {
    try { await db.storageDelete(storagePath); } catch (error) {
      failed.push(storagePath);
      console.error('Storage cleanup deferred:', storagePath, error.message);
    }
  }
  return failed;
}

async function removeStoragePathWithRetry(storagePath, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await db.storageDelete(storagePath);
      if (!(await db.storageStat(storagePath))) return true;
    } catch {
      // A transient Storage failure is retried before the request reports an
      // incomplete rollback to the caller.
    }
  }
  return false;
}

async function cleanupUnreferencedCover(storagePath, excludeId = null) {
  if (!storagePath || !String(storagePath).startsWith('covers/')) return;
  try {
    const references = await db.resourceCoverReferenceCount(storagePath, excludeId);
    if (Number(references) === 0) await db.storageDelete(storagePath);
  } catch (error) {
    // A failed reference check must not delete a potentially shared image.
    console.error('Cover cleanup deferred:', storagePath, error.message);
  }
}

// Caminho do PDF no storage — mesma lógica de routes/downloads.js.
async function storagePathForFile(file) {
  const fileName = normalizeFileName(file.file_name);
  if (!fileName) return null;
  const storagePath = `files/${fileName}`;
  if (isFirestoreBackend()) return storagePath;
  return db.localPathToStorage(`/uploads/${storagePath}`);
}

// Return a storage-relative path only for assets managed by this app. Public
// theme assets (for example /images/hero/...) are intentionally kept as-is;
// they do not belong to a material and must not be deleted during a clone.
function storedAssetPath(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (!raw) return null;

  if (raw.startsWith('gs://')) {
    raw = raw.slice(5).replace(/^[^/]+\//, '');
  } else if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const encodedObject = url.pathname.match(/\/o\/([^/].*)$/)?.[1];
      raw = encodedObject ? decodeURIComponent(encodedObject) : url.pathname;
    } catch {
      return null;
    }
  }

  raw = raw.replace(/^\/+/, '').replace(/^uploads\//i, '');
  const managed = raw.match(/(?:^|\/)(covers|files)\/(.+)$/i);
  return managed ? `${managed[1].toLowerCase()}/${managed[2]}` : null;
}

// Caminho de storage da capa a partir do valor salvo em cover_image
// (URL pública completa no Firestore, caminho local no MySQL).
function coverStoragePath(coverImage) {
  return storedAssetPath(coverImage);
}

async function getWatermarkText() {
  try {
    const rows = await db.settingsGetByKeys(['site_name']);
    const siteName = Array.isArray(rows)
      ? rows.find((row) => row.setting_key === 'site_name')?.setting_value
      : rows?.site_name;
    return siteName || 'Jewish Educational Resources';
  } catch {
    return 'Jewish Educational Resources';
  }
}

// Gera a capa (1ª página do PDF, ou 1º slide da apresentação) no servidor e
// salva no material. Retorna { ok, cover_image } ou { ok: false, reason }.
async function saveGeneratedCover(resourceId, jpeg) {
  const publicUrl = await db.storageUpload(jpeg, `covers/${uuidv4()}.jpg`, 'image/jpeg');
  try {
    await db.resourceUpdate(resourceId, { cover_image: publicUrl });
  } catch (error) {
    await cleanupUnreferencedCover(storedAssetPath(publicUrl));
    throw error;
  }
  return { ok: true, cover_image: publicUrl };
}

function googleSlidesSourceForResource(resource, files = []) {
  return googleSlidesSourceUrl(resource?.google_slides_url)
    || files.map((file) => googleSlidesSourceUrlFromImportedFile(file)).find(Boolean);
}

async function renderGoogleSlidesCover(sourceUrl, watermark) {
  try {
    const image = await downloadGoogleSlidesFirstSlide(sourceUrl);
    const jpeg = await generateImageCover(image, { watermark });
    if (!jpeg) return { ok: false, reason: 'Google Slides first slide could not be rendered' };
    return { ok: true, jpeg };
  } catch (error) {
    return { ok: false, reason: error.message || 'Could not retrieve the Google Slides first slide' };
  }
}

async function refreshGoogleSlidesCover(resource, files, watermark) {
  const sourceUrl = googleSlidesSourceForResource(resource, files);
  if (!sourceUrl) return { ok: false, reason: 'no Google Slides source' };

  const rendered = await renderGoogleSlidesCover(sourceUrl, watermark);
  if (!rendered.ok) {
    // A new import still needs a usable cover when Google temporarily blocks
    // its preview. Existing covers are deliberately left untouched instead
    // of replacing them with the less faithful PPTX fallback.
    if (!resource.cover_image) return ensureCoverForResource(resource.id, watermark);
    return rendered;
  }

  const previousCover = resource.cover_image;
  const result = await saveGeneratedCover(resource.id, rendered.jpeg);
  const previousPath = storedAssetPath(previousCover);
  if (previousPath && previousCover !== result.cover_image) {
    await cleanupUnreferencedCover(previousPath, resource.id);
  }
  return result;
}

async function ensureCoverForResource(resourceId, watermark) {
  const [resource, files] = await Promise.all([
    db.resourceFindById(resourceId),
    db.filesByResource(resourceId),
  ]);
  const googleSlidesSource = googleSlidesSourceForResource(resource, files);

  // Google-created slides can use fonts, illustrations, and RTL text that a
  // downloaded PPTX does not always reproduce. Prefer Google's own image and
  // retain the local PPTX renderer as a safe fallback for legacy decks.
  if (googleSlidesSource) {
    const rendered = await renderGoogleSlidesCover(googleSlidesSource, watermark);
    if (rendered.ok) return saveGeneratedCover(resourceId, rendered.jpeg);
    console.warn(`Google Slides native cover failed for resource ${resourceId}; using PPTX fallback:`, rendered.reason);
  }

  const pdf = files.find((f) => f.is_primary && f.file_type === 'pdf')
    || files.find((f) => f.file_type === 'pdf');
  if (pdf) {
    const stream = await db.storageDownloadStream(await storagePathForFile(pdf));
    if (!stream) return { ok: false, reason: 'PDF not found in storage' };
    const pdfBuffer = await streamToBuffer(stream);
    const jpeg = await generatePdfCover(pdfBuffer, { watermark });
    if (!jpeg) return { ok: false, reason: 'PDF could not be rendered' };
    return saveGeneratedCover(resourceId, jpeg);
  }

  const presentation = files.find((f) => f.is_primary && (f.file_type === 'pptx' || f.file_type === 'presentation'))
    || files.find((f) => f.file_type === 'pptx' || f.file_type === 'presentation');
  if (presentation) {
    const stream = await db.storageDownloadStream(await storagePathForFile(presentation));
    if (!stream) return { ok: false, reason: 'presentation not found in storage' };
    const pptxBuffer = await streamToBuffer(stream);
    const jpeg = await generatePptxCover(pptxBuffer, { watermark });
    if (!jpeg) return { ok: false, reason: 'presentation could not be rendered' };
    return saveGeneratedCover(resourceId, jpeg);
  }

  return { ok: false, reason: 'no PDF or presentation file' };
}

// Gera uma miniatura (imagem da 1ª página) de um PDF em memória e sobe pro
// storage. Retorna a URL pública ou null — nunca lança, pois uma falha de
// render não pode quebrar o split nem o backfill.
async function renderPdfThumbnail(pdfBuffer, watermark) {
  try {
    const jpeg = await generatePdfCover(pdfBuffer, { maxWidth: 500, watermark });
    if (!jpeg) return null;
    return await db.storageUpload(jpeg, `covers/${uuidv4()}.jpg`, 'image/jpeg');
  } catch (e) {
    console.error('Page thumbnail failed:', e.message);
    return null;
  }
}

// Gera a capa só quando o material ficou sem capa e tem um PDF. Nunca lança:
// uma falha de render não pode quebrar o upload.
async function autoGenerateCover(resourceId) {
  try {
    const resource = await db.resourceFindById(resourceId);
    if (resource?.cover_image) return null;
    return await ensureCoverForResource(resourceId, await getWatermarkText());
  } catch (e) {
    console.error(`auto-cover falhou (resource ${resourceId}):`, e.message);
    return null;
  }
}

async function downloadGoogleSlidesAsPptx(url) {
  const sourceUrl = googleSlidesSourceUrl(url);
  const presentationId = googleSlidesPresentationId(sourceUrl);
  if (!presentationId) throw new Error('Invalid Google Slides link. Make sure it is a valid Google Slides presentation link.');

  const exportUrl = googleSlidesPptxExportUrl(sourceUrl);
  if (!exportUrl) {
    const error = new Error('This published Google Slides link will be shown directly. To also import a downloadable PPTX copy, use the editable Google Slides sharing link.');
    error.status = 422;
    throw error;
  }

  let response;
  try {
    response = await fetch(exportUrl);
  } catch (e) {
    throw new Error('Could not download the presentation. Make sure the link is public and "Anyone with the link can view" is enabled.');
  }
  if (!response.ok) {
    throw new Error('Could not download the presentation. Make sure the link is public and "Anyone with the link can view" is enabled.');
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // O Google só devolve um .pptx de verdade quando o link é público. Quando
  // não é, ele responde 200 OK com uma página de login/permissão em HTML —
  // sem checar isso, salvaríamos essa página como se fosse a apresentação.
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!isZip) {
    throw new Error('The link did not return a valid presentation. Make sure it is public ("Anyone with the link can view") and try again.');
  }

  const ext = '.pptx';
  const filename = `${uuidv4()}${ext}`;

  if (isFirestoreBackend()) {
    return {
      originalname: `Google Slides - ${presentationId}.pptx`,
      mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: buffer,
      size: buffer.length
    };
  } else {
    const subdir = 'files';
    const dir = path.join(uploadDir, subdir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);

    return {
      filename: filename,
      originalname: `Google Slides - ${presentationId}.pptx`,
      size: buffer.length,
      mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      path: filePath
    };
  }
}

function canonicalGoogleSlidesUrl(value) {
  return googleSlidesSourceUrl(value) || null;
}

async function canonicalCanvaUrl(value) {
  return (await resolveCanvaSourceUrl(value)) || null;
}

async function insertUploadedFiles(resourceId, uploadedFiles, labels, startOrder = 0, primaryIndex = null, thumbnailByIndex = {}) {
  const createdIds = [];
  try {
    for (let i = 0; i < uploadedFiles.length; i++) {
      const f = uploadedFiles[i];
      const label = labels[i]?.trim() || null;
      const sortOrder = startOrder + i;
      const isPrimary = primaryIndex === i ? 1 : 0;
      const result = await db.fileCreate(resourceId, {
        file_name: f.filename,
        original_name: f.originalname,
        label,
        sort_order: sortOrder,
        file_type: getFileType(f.mimetype),
        file_size: f.size,
        mime_type: f.mimetype,
        is_primary: i === 0 && primaryIndex === null ? 1 : isPrimary,
        is_bundle: 0,
        premium_only: 0,
        thumbnail: thumbnailByIndex[i] || null,
      });
      const id = createResultId(result);
      if (id) createdIds.push(id);
    }
  } catch (error) {
    await Promise.all(createdIds.map((id) => db.fileDelete(id).catch(() => {})));
    throw error;
  }
  return createdIds;
}

// Galeria de capas: o front envia miniaturas (1ª página de cada PDF) no campo
// `file_thumbnails` e um índice paralelo `file_thumbnail_index` que diz a qual
// arquivo (posição em `files`) cada miniatura pertence.
async function buildThumbnailMap(req) {
  const thumbFiles = await processUploadedFiles(req.files?.file_thumbnails || []);
  let indices = [];
  try {
    indices = JSON.parse(req.body.file_thumbnail_index || '[]');
  } catch {
    indices = [];
  }
  const map = {};
  thumbFiles.forEach((tf, j) => {
    const idx = indices[j];
    if (idx !== undefined && idx !== null) map[Number(idx)] = coverUrl(tf);
  });
  return map;
}

router.get('/', optionalAuth, async (req, res) => {
  const { q, category, page = 1, limit = 12, type, sort = 'featured', access, grade, material_type: materialType } = req.query;
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 12));
  const pageNum = Math.max(1, Number(page) || 1);
  const offsetNum = (pageNum - 1) * limitNum;
  const params = { q, type, access, grade, materialType };

  if (category) {
    const cat = await db.categoryFindBySlug(category);
    if (cat) {
      params.categoryIds = await getDescendantIds(cat.id);
    } else {
      return res.json({ resources: [], pagination: { page: pageNum, limit: limitNum, total: 0 } });
    }
  }

  const { resources, total } = await db.resourceListFiltered({
    params,
    orderBy: sort,
    limit: limitNum,
    offset: offsetNum,
  });

  res.json({ resources, pagination: { page: pageNum, limit: limitNum, total } });
});

router.post('/admin/suggest-copy', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Add the title first.' });
    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) return res.status(503).json({ error: 'Description writing is not configured.' });
    let excerpt = '';
    if (req.file?.path && /\.pdf$/i.test(req.file.originalname || '')) {
      excerpt = await excerptFromPdf(fs.readFileSync(req.file.path));
    }
    const copy = await writeMaterialCopy({ title, excerpt, apiKey });
    res.json(copy);
  } catch {
    res.status(502).json({ error: 'Could not write the description.' });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }
});

router.get('/admin/all', authenticate, requireAdmin, async (req, res) => {
  const resources = await db.resourceAdminList();
  res.json({ resources });
});

router.get('/:slug', optionalAuth, async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const resource = await db.resourceFindBySlug(req.params.slug, !isAdmin);
  if (!resource || (!isAdmin && resource.is_archived)) return res.status(404).json({ error: 'Resource not found.' });

  resource.files = normalizeBundleFiles(await db.filesByResource(resource.id));

  if (req.user) {
    const ids = await db.favoriteIdsByUser(req.user.id);
    resource.is_favorited = ids.includes(resource.id);
  } else {
    resource.is_favorited = false;
  }

  res.json({ resource });
});

router.post('/', authenticate, requireAdmin, upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'files', maxCount: MAX_FILES },
  { name: 'file_thumbnails', maxCount: MAX_FILES },
]), async (req, res) => {
  const { title, description, content_description, age_range, grade_level, material_type, category_id, is_published, display_mode, google_slides_url, canva_url, keywords } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });
  const canvaSource = await canonicalCanvaUrl(canva_url);
  if (canva_url?.trim() && !canvaSource) {
    return res.status(400).json({ error: 'Invalid Canva link. Paste a public Canva view, edit, embed, or canva.link URL.' });
  }
  if (canvaSource && google_slides_url?.trim()) {
    return res.status(400).json({ error: 'Choose either Google Slides or Canva for this presentation.' });
  }

  const slug = await uniqueSlug(title, (s) => db.resourceSlugExists(s));
  let uploadedFiles = [];
  let thumbMap = {};
  let createdResourceId = null;
  let createdFileIds = [];
  const generatedStoragePaths = [];
  const createdExternalFiles = [];
  try {
    if (req.files?.cover?.[0]) await processUploadedFile(req.files.cover[0]);
    uploadedFiles = await processUploadedFiles(req.files?.files || []);

    const cover = req.files?.cover?.[0];
    const mode = ['grid', 'gallery'].includes(display_mode) ? display_mode : 'default';
    const downloadLimit = parseDownloadLimit(req.body);
    const pageLayout = parsePageLayout(req.body);
    const googleSlidesSourceUrl = canonicalGoogleSlidesUrl(google_slides_url);

    const result = await db.resourceCreate({
      title: title.trim(),
      slug,
      description: description || null,
      content_description: content_description || null,
      age_range: age_range || null,
      keywords: keywords?.trim() || null,
      grade_level: grade_level || null,
      material_type: material_type || null,
      google_slides_url: googleSlidesSourceUrl,
      canva_url: canvaSource,
      category_id: category_id ? Number(category_id) : null,
      cover_image: coverUrl(cover),
      display_mode: mode,
      download_limit_max: downloadLimit.download_limit_max,
      download_limit_period: downloadLimit.download_limit_period,
      school_only: req.body.school_only === 'true' || req.body.school_only === '1' ? 1 : 0,
      page_layout: pageLayout,
      is_published: is_published === 'false' ? 0 : 1,
      created_by: req.user.id,
    });

    const labels = parseFileLabels(req.body);
    thumbMap = await buildThumbnailMap(req);
    createdResourceId = createResultId(result);
    if (!createdResourceId) {
      const error = new Error('Could not create the resource.');
      error.status = 500;
      throw error;
    }
    createdFileIds = await insertUploadedFiles(createdResourceId, uploadedFiles, labels, 0, null, thumbMap);

    let slidesImportError = null;
    if (google_slides_url?.trim()) {
      let downloadedFile = null;
      try {
        downloadedFile = await downloadGoogleSlidesAsPptx(google_slides_url);
         await processUploadedFile(downloadedFile);
         createdExternalFiles.push(downloadedFile);
        const { maxOrder } = await db.fileMaxSortOrder(createdResourceId);
        const created = await db.fileCreate(createdResourceId, {
          file_name: downloadedFile.filename,
          original_name: downloadedFile.originalname,
          label: 'Slides',
          sort_order: maxOrder + 1,
          file_type: 'pptx',
          file_size: downloadedFile.size,
          mime_type: downloadedFile.mimetype,
          is_primary: 0,
          is_bundle: 0,
          premium_only: 0,
        });
        const createdId = createResultId(created);
        if (createdId) createdFileIds.push(createdId);
      } catch (err) {
        await cleanupUploadedFiles([downloadedFile]);
        console.error('Error importing Google Slides on create:', err);
        slidesImportError = err.message;
      }
    }

    if (!cover) {
      const generated = await autoGenerateCover(createdResourceId);
      const generatedPath = storedAssetPath(generated?.cover_image);
      if (generatedPath) generatedStoragePaths.push(generatedPath);
    }

    const resource = await db.resourceFindById(createdResourceId);
    resource.files = await db.filesByResource(createdResourceId);
    res.status(201).json({ resource, slides_import_error: slidesImportError });
  } catch (error) {
    if (createdResourceId) {
      try { await db.resourceDelete(createdResourceId); } catch { /* best effort rollback */ }
    }
    for (const id of createdFileIds) {
      try { await db.fileDelete(id); } catch { /* best effort rollback */ }
    }
    await cleanupUploadedFiles([
      ...(req.files?.cover || []),
      ...(req.files?.files || []),
      ...(req.files?.file_thumbnails || []),
      ...createdExternalFiles,
    ]);
    await cleanupThumbnailMap(thumbMap);
    await cleanupStoragePaths(generatedStoragePaths);
    res.status(error.status || 500).json({ error: error.message || 'Could not create the resource.' });
  }
});

router.put('/:id', authenticate, requireAdmin, upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'files', maxCount: MAX_FILES },
  { name: 'file_thumbnails', maxCount: MAX_FILES },
]), async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });

  const { title, description, content_description, age_range, grade_level, material_type, category_id, is_published, display_mode, google_slides_url, canva_url, keywords } = req.body;
  const hasCanvaField = Object.prototype.hasOwnProperty.call(req.body, 'canva_url');
  const requestedCanvaUrl = hasCanvaField ? await canonicalCanvaUrl(canva_url) : (existing.canva_url || null);
  if (canva_url?.trim() && !requestedCanvaUrl) {
    return res.status(400).json({ error: 'Invalid Canva link. Paste a public Canva view, edit, embed, or canva.link URL.' });
  }
  if (requestedCanvaUrl && google_slides_url?.trim()) {
    return res.status(400).json({ error: 'Choose either Google Slides or Canva for this presentation.' });
  }
  let slug = existing.slug;

  if (title && title !== existing.title) {
    slug = await uniqueSlug(title, (s) => db.resourceSlugExists(s, req.params.id));
  }
  const previousResource = {
    title: existing.title,
    slug: existing.slug,
    description: existing.description,
    content_description: existing.content_description,
    age_range: existing.age_range,
    keywords: existing.keywords,
    grade_level: existing.grade_level,
    material_type: existing.material_type,
    google_slides_url: existing.google_slides_url,
    canva_url: existing.canva_url,
    category_id: existing.category_id,
    cover_image: existing.cover_image,
    display_mode: existing.display_mode,
    download_limit_max: existing.download_limit_max,
    download_limit_period: existing.download_limit_period,
    school_only: existing.school_only,
    page_layout: existing.page_layout,
    is_published: existing.is_published,
  };
  let uploadedFiles = [];
  let thumbMap = {};
  let createdFileIds = [];
  let updated = false;
  const generatedStoragePaths = [];
  let previousCoverToCleanup = null;
  const externalFiles = [];
  try {
    if (req.files?.cover?.[0]) await processUploadedFile(req.files.cover[0]);
    uploadedFiles = await processUploadedFiles(req.files?.files || []);

    const cover = req.files?.cover?.[0];
    const mode = ['grid', 'gallery', 'default'].includes(display_mode) ? display_mode : existing.display_mode;
    const hasDownloadLimitFields = Object.prototype.hasOwnProperty.call(req.body, 'download_limit_max')
      || Object.prototype.hasOwnProperty.call(req.body, 'download_limit_period');
    const downloadLimit = hasDownloadLimitFields
      ? parseDownloadLimit(req.body)
      : {
          download_limit_max: existing.download_limit_max ?? null,
          download_limit_period: existing.download_limit_period ?? null,
        };
    const pageLayout = parsePageLayout(req.body) ?? existing.page_layout;
    const nextCover = coverUrl(cover, existing.cover_image);
    const nextGoogleSlidesUrl = requestedCanvaUrl
      ? null
      : google_slides_url !== undefined
        ? (canonicalGoogleSlidesUrl(google_slides_url) || existing.google_slides_url || null)
        : (existing.google_slides_url || null);
    const nextCanvaUrl = google_slides_url?.trim()
      ? null
      : requestedCanvaUrl;

    await db.resourceUpdate(req.params.id, {
      title: title?.trim() || existing.title,
      slug,
      description: description ?? existing.description,
      content_description: content_description ?? existing.content_description,
      age_range: age_range ?? existing.age_range,
      keywords: keywords !== undefined ? (keywords?.trim() || null) : existing.keywords,
      grade_level: grade_level !== undefined ? (grade_level || null) : existing.grade_level,
      material_type: material_type !== undefined ? (material_type || null) : existing.material_type,
      google_slides_url: nextGoogleSlidesUrl,
      canva_url: nextCanvaUrl,
      category_id: category_id !== undefined ? (category_id ? Number(category_id) : null) : existing.category_id,
      cover_image: nextCover,
      display_mode: mode,
      download_limit_max: downloadLimit.download_limit_max,
      download_limit_period: downloadLimit.download_limit_period,
      school_only: req.body.school_only !== undefined
        ? (req.body.school_only === 'true' || req.body.school_only === '1' ? 1 : 0)
        : (existing.school_only ?? 0),
      page_layout: pageLayout,
      is_published: is_published === 'false' ? 0 : is_published === 'true' ? 1 : existing.is_published,
    });
    updated = true;

    if (uploadedFiles.length) {
      const { maxOrder } = await db.fileMaxSortOrder(req.params.id);
      const labels = parseFileLabels(req.body);
      thumbMap = await buildThumbnailMap(req);
      createdFileIds = await insertUploadedFiles(req.params.id, uploadedFiles, labels, maxOrder + 1, null, thumbMap);
    }

    let slidesImportError = null;
    if (google_slides_url?.trim()) {
      let downloadedFile = null;
      try {
        downloadedFile = await downloadGoogleSlidesAsPptx(google_slides_url);
        await processUploadedFile(downloadedFile);
        externalFiles.push(downloadedFile);
        const { maxOrder } = await db.fileMaxSortOrder(req.params.id);
        const created = await db.fileCreate(req.params.id, {
          file_name: downloadedFile.filename,
          original_name: downloadedFile.originalname,
          label: 'Slides',
          sort_order: maxOrder + 1,
          file_type: 'pptx',
          file_size: downloadedFile.size,
          mime_type: downloadedFile.mimetype,
          is_primary: 0,
          is_bundle: 0,
          premium_only: 0,
        });
        const createdId = createResultId(created);
        if (createdId) createdFileIds.push(createdId);
      } catch (err) {
        await cleanupUploadedFiles([downloadedFile]);
        console.error('Error importing Google Slides on update:', err);
        slidesImportError = err.message;
      }
    }

    if (!cover) {
      const generated = await autoGenerateCover(req.params.id);
      const generatedPath = storedAssetPath(generated?.cover_image);
      if (generatedPath) generatedStoragePaths.push(generatedPath);
    }
    if (cover && existing.cover_image && nextCover !== existing.cover_image) {
      previousCoverToCleanup = storedAssetPath(existing.cover_image);
    }

    const resource = await db.resourceFindById(req.params.id);
    resource.files = await db.filesByResource(req.params.id);
    if (previousCoverToCleanup) {
      await cleanupUnreferencedCover(previousCoverToCleanup, req.params.id);
    }
    res.json({ resource, slides_import_error: slidesImportError });
  } catch (error) {
    if (updated) {
      try { await db.resourceUpdate(req.params.id, previousResource); } catch { /* best effort rollback */ }
    }
    for (const id of createdFileIds) {
      try { await db.fileDelete(id); } catch { /* best effort rollback */ }
    }
    await cleanupUploadedFiles([
      ...(req.files?.cover || []),
      ...(req.files?.files || []),
      ...(req.files?.file_thumbnails || []),
      ...externalFiles,
    ]);
    await cleanupThumbnailMap(thumbMap);
    await cleanupStoragePaths(generatedStoragePaths);
    res.status(error.status || 500).json({ error: error.message || 'Could not update the resource.' });
  }
});

// Backfill: gera a capa (1ª página do PDF) de todos os materiais sem capa.
// Roda 100% no servidor — não depende do navegador.
router.post('/admin/generate-covers', authenticate, requireAdmin, async (req, res) => {
  const all = await db.resourceAdminList();
  const targets = all.filter((r) => !r.cover_image);
  const watermark = await getWatermarkText();
  let generated = 0;
  const skipped = [];
  for (const r of targets) {
    try {
      const result = await ensureCoverForResource(r.id, watermark);
      if (result.ok) generated++;
      else skipped.push({ id: r.id, title: r.title, reason: result.reason });
    } catch (e) {
      skipped.push({ id: r.id, title: r.title, reason: e.message });
    }
  }
  res.json({ total: targets.length, generated, skipped });
});

// Replaces existing covers only for resources linked to Google Slides. Unlike
// the missing-cover backfill above, this deliberately reads the live first
// slide so imported presentations can be synchronized after they change.
router.post('/admin/refresh-google-slides-covers', authenticate, requireAdmin, async (req, res) => {
  const all = await db.resourceAdminList();
  const watermark = await getWatermarkText();
  let total = 0;
  let generated = 0;
  const skipped = [];

  for (const resource of all) {
    if (!resource.cover_image) continue;
    const files = await db.filesByResource(resource.id);
    if (!googleSlidesSourceForResource(resource, files)) continue;
    total += 1;
    try {
      const result = await refreshGoogleSlidesCover(resource, files, watermark);
      if (result.ok) generated += 1;
      else skipped.push({ id: resource.id, title: resource.title, reason: result.reason });
    } catch (error) {
      skipped.push({ id: resource.id, title: resource.title, reason: error.message });
    }
  }

  res.json({ total, generated, skipped });
});

// Backfill: gera a miniatura (imagem da página) dos arquivos PDF que ainda não
// têm — usado pros materiais separados antes da miniatura por página existir.
router.post('/admin/generate-file-thumbnails', authenticate, requireAdmin, async (req, res) => {
  const all = await db.resourceAdminList();
  const watermark = await getWatermarkText();
  let generated = 0;
  const skipped = [];
  for (const r of all) {
    const files = await db.filesByResource(r.id);
    for (const f of files) {
      if (f.file_type !== 'pdf' || f.is_bundle || f.thumbnail) continue;
      try {
        const stream = await db.storageDownloadStream(await storagePathForFile(f));
        if (!stream) { skipped.push({ file: f.original_name, reason: 'file not found in storage' }); continue; }
        const buffer = await streamToBuffer(stream);
        const url = await renderPdfThumbnail(buffer, watermark);
        if (!url) { skipped.push({ file: f.original_name, reason: 'could not be rendered' }); continue; }
        await db.fileUpdate(f.id, { thumbnail: url });
        generated++;
      } catch (e) {
        skipped.push({ file: f.original_name, reason: e.message });
      }
    }
  }
  res.json({ generated, skipped });
});

// Importa vários materiais de uma vez a partir das linhas de uma planilha (CSV).
// O CSV é lido, mapeado e validado no navegador; aqui chegam as linhas já
// normalizadas em `rows`. Cada linha vira um material — sem arquivo por padrão
// (o PDF é anexado depois na tela de edição), a não ser que traga um link de
// Google Slides, que é baixado e anexado como a apresentação do material.
router.post('/admin/bulk-import', authenticate, requireAdmin, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || !rows.length) {
    return res.status(400).json({ error: 'No rows to import.' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: 'Imports are limited to 500 rows.' });
  }

  // Índice de categorias por nome e por slug (case-insensitive) para resolver a
  // coluna "categoria" da planilha — o admin digita o nome, não o id.
  const categories = await db.categoryListAll();
  const byName = new Map();
  const bySlug = new Map();
  for (const c of categories) {
    if (c.name) byName.set(String(c.name).trim().toLowerCase(), c.id);
    if (c.slug) bySlug.set(String(c.slug).trim().toLowerCase(), c.id);
  }

  const created = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const line = Number(row.line) || i + 1;
    const title = String(row.title || '').trim();
    if (!title) {
      errors.push({ line, title: '', error: 'Title vazio.' });
      continue;
    }

    let categoryId = null;
    const catRaw = String(row.category || '').trim();
    if (catRaw) {
      categoryId = byName.get(catRaw.toLowerCase()) ?? bySlug.get(catRaw.toLowerCase()) ?? null;
      if (categoryId === null) {
        errors.push({ line, title, error: `Category not found: "${catRaw}".` });
        continue;
      }
    }

    let createdResourceId = null;
    const createdFileIds = [];
    let downloadedFile = null;
    const generatedStoragePaths = [];
    try {
      const slug = await uniqueSlug(title, (s) => db.resourceSlugExists(s));
      const result = await db.resourceCreate({
        title,
        slug,
        description: bulkStr(row.description),
        content_description: bulkStr(row.content_description),
        age_range: null,
        keywords: bulkStr(row.keywords),
        grade_level: bulkStr(row.grade_level),
        material_type: bulkStr(row.material_type),
        google_slides_url: canonicalGoogleSlidesUrl(row.google_slides_url),
        category_id: categoryId,
        cover_image: null,
        display_mode: 'default',
        download_limit_max: null,
        download_limit_period: null,
        school_only: bulkBool(row.school_only) ? 1 : 0,
        page_layout: null,
        is_published: bulkBool(row.is_published) ? 1 : 0,
        created_by: req.user.id,
      });
      createdResourceId = createResultId(result);
      if (!createdResourceId) throw new Error('Could not create the resource.');

      const slidesUrl = String(row.google_slides_url || '').trim();
      if (slidesUrl) {
        try {
          downloadedFile = await downloadGoogleSlidesAsPptx(slidesUrl);
          await processUploadedFile(downloadedFile);
          const created = await db.fileCreate(createdResourceId, {
            file_name: downloadedFile.filename,
            original_name: downloadedFile.originalname,
            label: 'Slides',
            sort_order: 0,
            file_type: 'pptx',
            file_size: downloadedFile.size,
            mime_type: downloadedFile.mimetype,
            is_primary: 0,
            is_bundle: 0,
            premium_only: 0,
          });
          const createdFileId = createResultId(created);
          if (createdFileId) createdFileIds.push(createdFileId);
          const generated = await autoGenerateCover(createdResourceId);
          const generatedPath = storedAssetPath(generated?.cover_image);
          if (generatedPath) generatedStoragePaths.push(generatedPath);
        } catch (err) {
          // A row with a requested external file is not valid if the file
          // cannot be fetched or persisted. Let the outer rollback remove the
          // resource and any staged asset instead of publishing a partial row.
          throw new Error(`Google Slides import failed: ${err.message}`);
        }
      }

      created.push({ line, id: createdResourceId, title });
    } catch (err) {
      console.error(`bulk-import linha ${line} falhou:`, err);
      for (const id of createdFileIds) {
        try { await db.fileDelete(id); } catch { /* resource rollback continues */ }
      }
      if (createdResourceId) {
        try { await db.resourceDelete(createdResourceId); } catch { /* report below */ }
      }
      await cleanupUploadedFiles([downloadedFile]);
      await cleanupStoragePaths(generatedStoragePaths);
      errors.push({ line, title, error: err.message || 'Could not create the resource.' });
    }
  }

  res.json({ created, errors, total: rows.length });
});

// Gera/regenera a capa de um único material a partir do seu PDF.
router.post('/:id/generate-cover', authenticate, requireAdmin, async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });
  const result = await ensureCoverForResource(req.params.id, await getWatermarkText());
  if (!result.ok) {
    return res.status(400).json({ error: `Could not generate the cover: ${result.reason}` });
  }
  res.json({ cover_image: result.cover_image });
});

// Duplica um material: copia os dados e os arquivos (PDF, capa) para novos
// caminhos no storage — nunca compartilha o mesmo arquivo com o original,
// senão excluir um dos dois apagaria o arquivo do outro.
router.post('/:id/duplicate', authenticate, requireAdmin, async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });

  const newTitle = `${existing.title} (copy)`;
  const slug = await uniqueSlug(newTitle, (s) => db.resourceSlugExists(s));
  const files = await db.filesByResource(existing.id, { includeArchived: true });
  const copiedStoragePaths = [];
  const createdFileIds = [];
  let createdResourceId = null;

  async function copyAsset(sourcePath, destinationPath, mimeType, options = {}) {
    if (!sourcePath) return null;
    // Track the destination before any I/O. Some storage providers can finish
    // the copy and then fail while returning metadata; rollback must still
    // know which object to remove in that case.
    copiedStoragePaths.push(destinationPath);
    const stat = await db.storageStat(sourcePath);
    if (!stat) throw new Error(`Asset not found in storage: ${sourcePath}`);
    const copied = await db.storageCopy(sourcePath, destinationPath, mimeType, options);
    if (!copied) throw new Error(`Could not copy asset: ${sourcePath}`);
    return copied;
  }

  async function copyOptionalImage(value) {
    const sourcePath = storedAssetPath(value);
    if (!sourcePath) return value || null;
    const extension = assetExtension(sourcePath);
    const target = `covers/${uuidv4()}${extension}`;
    return copyAsset(sourcePath, target, imageMimeType(sourcePath), { public: true });
  }

  try {
    const newCoverUrl = await copyOptionalImage(existing.cover_image);
    const clonedFiles = [];

    for (const file of files) {
      const sourcePath = await storagePathForFile(file);
      if (!sourcePath || sourcePath.endsWith('/undefined')) {
        throw new Error(`File ${file.id} has no storage path.`);
      }
      const extension = path.extname(file.file_name || file.original_name || '');
      const destinationPath = `files/${uuidv4()}${extension}`;
      await copyAsset(sourcePath, destinationPath, file.mime_type || 'application/octet-stream', { public: false });

      let thumbnail = file.thumbnail || null;
      const thumbnailPath = storedAssetPath(file.thumbnail);
      if (thumbnailPath) {
        const thumbnailExtension = path.extname(thumbnailPath) || '.jpg';
        thumbnail = await copyAsset(
          thumbnailPath,
          `covers/${uuidv4()}${thumbnailExtension}`,
          imageMimeType(thumbnailPath),
          { public: true },
        );
      }

      clonedFiles.push({ ...file, file_name: path.basename(destinationPath), thumbnail });
    }

    await db.withTransaction(async () => {
      const result = await db.resourceCreate({
        title: newTitle,
        slug,
        description: existing.description ?? null,
        content_description: existing.content_description ?? null,
        age_range: existing.age_range ?? null,
        keywords: existing.keywords ?? null,
        action_visibility: existing.action_visibility ?? null,
        grade_level: existing.grade_level ?? null,
        material_type: existing.material_type ?? null,
        google_slides_url: existing.google_slides_url ?? null,
        canva_url: existing.canva_url ?? null,
        category_id: existing.category_id ?? null,
        cover_image: newCoverUrl,
        cover_hidden: existing.cover_hidden ? 1 : 0,
        display_mode: existing.display_mode || 'default',
        download_limit_max: existing.download_limit_max ?? null,
        download_limit_period: existing.download_limit_period ?? null,
        school_only: existing.school_only ? 1 : 0,
        page_layout: existing.page_layout ?? null,
        is_premium: existing.is_premium ? 1 : 0,
        is_published: 0,
        is_archived: 0,
        sort_order: existing.sort_order ?? 0,
        created_by: req.user.id,
      });
      createdResourceId = result?.insertId ?? result?.id;
      if (!createdResourceId) throw new Error('Could not create the duplicated material.');

      for (const file of clonedFiles) {
        const createdFile = await db.fileCreate(createdResourceId, {
          file_name: file.file_name,
          original_name: file.original_name,
          label: file.label,
          sort_order: file.sort_order,
          file_type: file.file_type,
          file_size: file.file_size,
          mime_type: file.mime_type,
          is_primary: file.is_primary,
          is_archived: file.is_archived ? 1 : 0,
          is_bundle: file.is_bundle ? 1 : 0,
          premium_only: file.premium_only ? 1 : 0,
          thumbnail: file.thumbnail,
        });
        const createdFileId = createResultId(createdFile);
        if (!createdFileId) throw new Error('Could not create a duplicated file record.');
        createdFileIds.push(createdFileId);
      }
    });

    const resource = await db.resourceFindById(createdResourceId);
    if (!resource) throw new Error('The duplicated material could not be reloaded.');
    resource.files = await db.filesByResource(createdResourceId, { includeArchived: true });
    res.status(201).json({ resource });
  } catch (error) {
    let rollbackComplete = true;
    if (createdResourceId) {
      try { await db.resourceDelete(createdResourceId); } catch { rollbackComplete = false; }
    }
    for (const id of createdFileIds) {
      try { await db.fileDelete(id); } catch { rollbackComplete = false; }
    }
    for (const storagePath of [...copiedStoragePaths].reverse()) {
      if (!(await removeStoragePathWithRetry(storagePath))) rollbackComplete = false;
    }
    if (!rollbackComplete) console.error('Duplicate rollback could not be fully verified.', { copiedStoragePaths });
    console.error('Could not duplicate resource:', error);
    res.status(500).json({
      error: rollbackComplete
        ? 'Could not duplicate the material. No partial copy was kept.'
        : 'Could not duplicate the material. Rollback needs operator review.',
    });
  }
});

router.post('/:id/import-google-slides', authenticate, requireAdmin, async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });
  
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'Google Slides link is required.' });
  const sourceUrl = canonicalGoogleSlidesUrl(url);
  if (!sourceUrl) return res.status(400).json({ error: 'Invalid Google Slides link. Make sure it is a valid Google Slides presentation link.' });

  // A published /d/e/ URL has a publication id, which Google intentionally
  // does not expose through the editable Drive/PPTX export endpoint. Keep the
  // exact published source for the native viewer and generate its cover from
  // the public embed instead of replacing it with a different Drive URL.
  if (!googleSlidesPptxExportUrl(sourceUrl)) {
    try {
      await db.resourceUpdate(req.params.id, { google_slides_url: sourceUrl, canva_url: null });
      const files = await db.filesByResource(req.params.id);
      const current = await db.resourceFindById(req.params.id);
      const cover = await refreshGoogleSlidesCover(current, files, await getWatermarkText());
      if (!cover.ok) console.warn(`Google Slides cover refresh failed for resource ${req.params.id}:`, cover.reason);
      return res.status(201).json({ files, linked_only: true });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Could not link Google Slides.' });
    }
  }

  let downloadedFile = null;
  let createdFileId = null;
  try {
    downloadedFile = await downloadGoogleSlidesAsPptx(url);
    await processUploadedFile(downloadedFile);
    
    const { maxOrder } = await db.fileMaxSortOrder(req.params.id);
    const created = await db.fileCreate(req.params.id, {
      file_name: downloadedFile.filename,
      original_name: downloadedFile.originalname,
      label: 'Slides',
      sort_order: maxOrder + 1,
      file_type: 'pptx',
      file_size: downloadedFile.size,
      mime_type: downloadedFile.mimetype,
      is_primary: 0,
      is_bundle: 0,
      premium_only: 0,
    });
    createdFileId = createResultId(created);
    await db.resourceUpdate(req.params.id, {
      google_slides_url: sourceUrl,
      canva_url: null,
    });
    const files = await db.filesByResource(req.params.id);
    const current = await db.resourceFindById(req.params.id);
    const cover = await refreshGoogleSlidesCover(current, files, await getWatermarkText());
    if (!cover.ok) console.warn(`Google Slides cover refresh failed for resource ${req.params.id}:`, cover.reason);
    res.status(201).json({ files });
  } catch (err) {
    if (createdFileId) {
      try { await db.fileDelete(createdFileId); } catch { /* best effort rollback */ }
    }
    await cleanupUploadedFiles([downloadedFile]);
    res.status(err.status || 500).json({ error: err.message || 'Could not import Google Slides.' });
  }
});

router.patch('/:id/publish', authenticate, requireAdmin, async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });

  const publish = req.body.is_published === true || req.body.is_published === 'true' || req.body.is_published === 1;
  await db.resourceUpdate(req.params.id, { is_published: publish ? 1 : 0 });

  res.json({ resource: { ...existing, is_published: publish ? 1 : 0 } });
});

router.post('/:id/files', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });
  if (!req.file) return res.status(400).json({ error: 'A file is required.' });

  const originalFlags = await db.filesByResource(req.params.id, { includeArchived: true });
  const isBundle = req.body.is_bundle === 'true' || req.body.is_bundle === true;
  const premiumOnly = isBundle || req.body.premium_only === 'true' || req.body.premium_only === true;

  let createdFileId = null;
  try {
    await processUploadedFile(req.file);

    const { maxOrder } = await db.fileMaxSortOrder(req.params.id);
    const label = req.body.label?.trim() || null;

    if (isBundle) {
      await db.fileClearBundleFlags(req.params.id);
    }

    const created = await db.fileCreate(req.params.id, {
      file_name: req.file.filename,
      original_name: req.file.originalname,
      label,
      sort_order: maxOrder + 1,
      file_type: getFileType(req.file.mimetype),
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      is_primary: 0,
      is_bundle: isBundle ? 1 : 0,
      premium_only: premiumOnly ? 1 : 0,
    });
    createdFileId = createResultId(created);

    const files = await db.filesByResource(req.params.id, { includeArchived: true });
    res.status(201).json({ files });
  } catch (err) {
    if (createdFileId) {
      try { await db.fileDelete(createdFileId); } catch { /* best effort rollback */ }
    }
    await cleanupUploadedFiles([req.file]);
    if (isBundle) {
      for (const previous of originalFlags) {
        try {
          await db.fileUpdate(previous.id, {
            is_bundle: previous.is_bundle,
            premium_only: previous.premium_only,
          });
        } catch { /* best effort rollback */ }
      }
    }
    res.status(err.status || 500).json({ error: err.message || 'Could not upload the file.' });
  }
});

// Separa um PDF de várias páginas em um PDF por página (todos gratuitos),
// e marca o PDF original como "pacote completo" (Premium) — mesmo efeito de
// marcar manualmente o checkbox "PDF completo (Premium)".
router.post('/:id/split-file/:fileId', authenticate, requireAdmin, async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });

  const file = await db.fileFindByIdAndResource(req.params.fileId, req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  if (file.file_type !== 'pdf') {
    return res.status(400).json({ error: 'Only PDF files can be split.' });
  }

  const stream = await db.storageDownloadStream(await storagePathForFile(file));
  if (!stream) return res.status(404).json({ error: 'File not found in storage.' });
  const buffer = await streamToBuffer(stream);

  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(buffer);
  } catch (e) {
    return res.status(400).json({ error: 'Could not read this PDF.' });
  }
  const pageCount = srcDoc.getPageCount();
  if (pageCount < 2) {
    return res.status(400).json({ error: 'This PDF has only one page and cannot be split.' });
  }

  const baseName = file.original_name.replace(/\.pdf$/i, '');
  const { maxOrder } = await db.fileMaxSortOrder(req.params.id);
  let nextOrder = maxOrder + 1;
  const watermark = await getWatermarkText();
  const originalFiles = await db.filesByResource(req.params.id, { includeArchived: true });
  const createdFileIds = [];
  const createdStoragePaths = [];
  const createdThumbnailPaths = [];
  try {
    await db.fileClearBundleFlags(req.params.id, req.params.fileId);
    await db.fileUpdate(req.params.fileId, { is_bundle: 1, premium_only: 1 });

    for (let i = 0; i < pageCount; i++) {
      const pageDoc = await PDFDocument.create();
      const [copiedPage] = await pageDoc.copyPages(srcDoc, [i]);
      pageDoc.addPage(copiedPage);
      const pageBuffer = Buffer.from(await pageDoc.save());

      const newFileName = `${uuidv4()}.pdf`;
      const storagePath = `files/${newFileName}`;
      createdStoragePaths.push(storagePath);
      await db.storageUpload(pageBuffer, storagePath, 'application/pdf');
      // Miniatura da página — deixa ver o conteúdo direto, sem baixar.
      const thumbnail = await renderPdfThumbnail(pageBuffer, watermark);
      const thumbnailPath = storedAssetPath(thumbnail);
      if (thumbnailPath) createdThumbnailPaths.push(thumbnailPath);
      const created = await db.fileCreate(req.params.id, {
        file_name: newFileName,
        original_name: `${baseName} — Page ${i + 1}.pdf`,
        label: `Page ${i + 1}`,
        sort_order: nextOrder++,
        file_type: 'pdf',
        file_size: pageBuffer.length,
        mime_type: 'application/pdf',
        is_primary: 0,
        is_bundle: 0,
        premium_only: 0,
        thumbnail,
      });
      const createdId = createResultId(created);
      if (!createdId) throw new Error('Could not save a split PDF page.');
      createdFileIds.push(createdId);
    }

    const files = await db.filesByResource(req.params.id);
    res.status(201).json({ files, pages: pageCount });
  } catch (error) {
    for (const id of createdFileIds) {
      try { await db.fileDelete(id); } catch { /* best effort rollback */ }
    }
    for (const storagePath of [...createdThumbnailPaths, ...createdStoragePaths].reverse()) {
      try { await db.storageDelete(storagePath); } catch { /* best effort rollback */ }
    }
    for (const previous of originalFiles) {
      try {
        await db.fileUpdate(previous.id, {
          is_bundle: previous.is_bundle,
          premium_only: previous.premium_only,
        });
      } catch { /* best effort rollback */ }
    }
    res.status(error.status || 500).json({ error: error.message || 'Could not split the PDF.' });
  }
});

router.patch('/files/:fileId', authenticate, requireAdmin, async (req, res) => {
  const file = await db.fileFindById(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found.' });

  const { label, sort_order, is_bundle, premium_only } = req.body;
  const nextIsBundle = is_bundle !== undefined ? (is_bundle === true || is_bundle === 'true' || is_bundle === 1 ? 1 : 0) : file.is_bundle;
  const nextPremium = premium_only !== undefined
    ? (premium_only === true || premium_only === 'true' || premium_only === 1 ? 1 : 0)
    : (nextIsBundle ? 1 : file.premium_only);

  if (nextIsBundle) {
    await db.fileClearBundleFlags(file.resource_id, file.id);
  }

  await db.fileUpdate(req.params.fileId, {
    label: label !== undefined ? (label?.trim() || null) : file.label,
    sort_order: sort_order !== undefined ? Number(sort_order) : file.sort_order,
    is_bundle: nextIsBundle,
    premium_only: nextIsBundle ? 1 : nextPremium,
  });

  const updated = await db.fileFindById(req.params.fileId);
  res.json({ file: updated });
});

// Keep the more specific file route before /:id. Otherwise Express treats
// DELETE /resources/files/:fileId as a resource deletion for id="files".
router.delete('/files/:fileId', authenticate, requireAdmin, async (req, res) => {
  const file = await db.fileFindById(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found.' });

  const fileStoragePath = await storagePathForFile(file);
  if (fileStoragePath) await db.storageDelete(fileStoragePath);
  const thumbnailPath = storedAssetPath(file.thumbnail);
  if (thumbnailPath) await db.storageDelete(thumbnailPath);
  await db.fileDelete(req.params.fileId);
  res.json({ message: 'File removed.' });
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const existing = await db.resourceFindById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Resource not found.' });

  const files = await db.filesByResource(req.params.id, { includeArchived: true });
  for (const f of files) {
    const fileStoragePath = await storagePathForFile(f);
    if (fileStoragePath) await db.storageDelete(fileStoragePath);
    const thumbnailPath = storedAssetPath(f.thumbnail);
    if (thumbnailPath) await db.storageDelete(thumbnailPath);
  }

  const coverPath = coverStoragePath(existing.cover_image);
  if (coverPath) await db.storageDelete(coverPath);

  await db.resourceDelete(req.params.id);
  res.json({ message: 'Resource deleted.' });
});

export default router;
