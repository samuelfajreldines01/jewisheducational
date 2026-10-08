import fs from 'fs';
import path from 'path';
import { query, queryOne, withTransaction as mysqlWithTransaction } from '../config/database.mysql.js';
import { uploadDir } from '../middleware/upload.js';
import { sourceForRow } from '../utils/attribution.js';
import { resourceInsertParams } from './resourceInsert.js';

export async function withTransaction(work) {
  return mysqlWithTransaction(work);
}

function safeUploadPath(storagePath) {
  const relative = String(storagePath || '').replace(/^[/\\]+/, '');
  if (!relative || relative.includes('\0')) return null;
  const root = path.resolve(uploadDir);
  const full = path.resolve(root, relative);
  if (full === root || !full.startsWith(root + path.sep)) return null;
  return full;
}

async function enrichResource(row) {
  if (!row) return null;
  return queryOne(
    `SELECT r.*, c.name AS category_name, c.slug AS category_slug,
            pc.name AS parent_category_name, pc.slug AS parent_category_slug,
            u.name AS author_name
     FROM resources r
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN categories pc ON pc.id = c.parent_id
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.id = :id`,
    { id: row.id }
  );
}

export async function userFindById(id) {
  return queryOne(
    'SELECT id, name, email, role, is_blocked, account_type, avatar_url, password_hash, reset_token, reset_token_expires, created_at FROM users WHERE id = :id',
    { id }
  );
}

export async function userFindByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = :email', { email });
}

export async function userCreate(data) {
  const result = await query(
    `INSERT INTO users
      (name, email, password_hash, role, avatar_url, account_type, signup_method,
       signup_source, signup_referrer, signup_utm_source, signup_utm_medium,
       signup_utm_campaign, signup_landing_path, stripe_customer_id, stripe_subscription_id)
     VALUES (:name, :email, :password_hash, :role, :avatar_url, :account_type, :signup_method,
       :signup_source, :signup_referrer, :signup_utm_source, :signup_utm_medium,
       :signup_utm_campaign, :signup_landing_path, :stripe_customer_id, :stripe_subscription_id)`,
    {
      name: data.name,
      email: String(data.email || '').trim().toLowerCase(),
      password_hash: data.password_hash,
      role: data.role || 'user',
      avatar_url: data.avatar_url || null,
      account_type: data.account_type || 'free',
      signup_method: data.signup_method || null,
      signup_source: data.signup_source || null,
      signup_referrer: data.signup_referrer || null,
      signup_utm_source: data.signup_utm_source || null,
      signup_utm_medium: data.signup_utm_medium || null,
      signup_utm_campaign: data.signup_utm_campaign || null,
      signup_landing_path: data.signup_landing_path || null,
      stripe_customer_id: data.stripe_customer_id || null,
      stripe_subscription_id: data.stripe_subscription_id || null,
    }
  );
  return { insertId: result.insertId };
}

export async function userUpdate(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await query(
    `UPDATE users SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`,
    { ...fields, id }
  );
}

export async function userDelete(id) {
  await deleteUserRelatedData(id);
  await query('DELETE FROM users WHERE id = :id', { id });
}

async function deleteUserRelatedData(userId) {
  const tables = [
    'DELETE FROM favorites WHERE user_id = :id',
    'DELETE FROM favorite_folders WHERE user_id = :id',
    'DELETE FROM downloads WHERE user_id = :id',
    'DELETE FROM download_intents WHERE user_id = :id',
    'DELETE FROM analytics_interactions WHERE user_id = :id',
    'DELETE FROM subscriptions WHERE user_id = :id',
    'DELETE FROM payments WHERE user_id = :id',
  ];
  let removed = 0;
  for (const sql of tables) {
    const result = await query(sql, { id: userId });
    removed += result.affectedRows || 0;
  }
  return removed;
}

export async function purgeNonAdminUsers() {
  const users = await query('SELECT id, name, email, role FROM users ORDER BY id');
  const admins = users.filter((u) => u.role === 'admin');
  const toDelete = users.filter((u) => u.role !== 'admin');
  let relatedRemoved = 0;
  for (const user of toDelete) {
    relatedRemoved += await deleteUserRelatedData(user.id);
    await query('DELETE FROM users WHERE id = :id', { id: user.id });
  }
  return {
    admins: admins.map((u) => ({ id: u.id, name: u.name, email: u.email })),
    deleted: toDelete.map((u) => ({ id: u.id, name: u.name, email: u.email })),
    relatedRemoved,
  };
}

export async function userList() {
  return query(
    `SELECT id, name, email, role, is_blocked, account_type,
      signup_method, signup_source, signup_referrer,
      signup_utm_source, signup_utm_medium, signup_utm_campaign, signup_landing_path,
      created_at
     FROM users ORDER BY created_at DESC`
  );
}

export async function userCount() {
  return queryOne('SELECT COUNT(*) AS total FROM users');
}

export async function userFindByResetToken(token) {
  return queryOne(
    `SELECT id FROM users WHERE reset_token = :token AND reset_token_expires > NOW()`,
    { token }
  );
}

export async function categoryFindById(id) {
  return queryOne('SELECT * FROM categories WHERE id = :id', { id });
}

export async function categoryFindBySlug(slug) {
  return queryOne(
    `SELECT c.*, pc.name AS parent_name, pc.slug AS parent_slug
     FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id WHERE c.slug = :slug`,
    { slug }
  );
}

export async function categorySlugExists(slug, excludeId = null) {
  const row = excludeId
    ? await queryOne('SELECT id FROM categories WHERE slug = :slug AND id != :id', { slug, id: excludeId })
    : await queryOne('SELECT id FROM categories WHERE slug = :slug', { slug });
  return !!row;
}

export async function categoryListAll() {
  return query('SELECT * FROM categories');
}

export async function categoryChildren(parentId) {
  return query(
    'SELECT id, name, slug, description, sort_order FROM categories WHERE parent_id = :id ORDER BY sort_order, name',
    { id: parentId }
  );
}

export async function categoryCreate(data) {
  const result = await query(
    'INSERT INTO categories (name, slug, description, parent_id, sort_order, nav_visible, is_archived) VALUES (:name, :slug, :description, :parent_id, :sort_order, :nav_visible, :is_archived)',
    {
      ...data,
      nav_visible: data.nav_visible === undefined ? 1 : data.nav_visible,
      is_archived: data.is_archived === undefined ? 0 : data.is_archived,
    }
  );
  return { insertId: result.insertId };
}

export async function categoryUpdate(id, data) {
  const existing = await categoryFindById(id);
  if (!existing) return null;
  const next = { ...existing, ...data };
  const nextParentId = next.parent_id ? Number(next.parent_id) : null;
  if (nextParentId) {
    if (nextParentId === Number(id)) {
      const error = new Error('A category cannot be its own parent.');
      error.status = 400;
      throw error;
    }
    const descendants = await categoryGetDescendantIds(id);
    if (descendants.includes(nextParentId)) {
      const error = new Error('A category cannot be moved inside one of its own subtopics.');
      error.status = 400;
      throw error;
    }
    if (!(await categoryFindById(nextParentId))) {
      const error = new Error('Invalid parent category.');
      error.status = 400;
      throw error;
    }
  }
  await query(
    `UPDATE categories SET name = :name, slug = :slug, description = :description,
     parent_id = :parent_id, sort_order = :sort_order, nav_visible = :nav_visible,
     is_archived = :is_archived WHERE id = :id`,
    {
      name: next.name,
      slug: next.slug,
      description: next.description,
       parent_id: nextParentId,
      sort_order: next.sort_order,
      nav_visible: next.nav_visible === undefined ? 1 : next.nav_visible,
      is_archived: next.is_archived === undefined ? 0 : next.is_archived,
      id,
    }
  );
  return categoryFindById(id);
}

export async function categoryDelete(id) {
  await query('DELETE FROM categories WHERE id = :id', { id });
}

export async function categoryGetDescendantIds(categoryId) {
  const ids = [];
  const queue = [Number(categoryId)];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!Number.isFinite(current) || visited.has(current)) continue;
    visited.add(current);
    ids.push(current);
    const children = await query('SELECT id FROM categories WHERE parent_id = :id', { id: current });
    children.forEach((child) => queue.push(Number(child.id)));
  }
  return ids;
}

export async function categoryListWithCounts() {
  return query(
    `SELECT c.*, pc.name AS parent_name, pc.slug AS parent_slug,
      (SELECT COUNT(*) FROM resources r WHERE r.is_published = 1 AND r.is_archived = 0 AND r.category_id IN (
        WITH RECURSIVE cat_tree AS (
          SELECT id FROM categories WHERE id = c.id AND is_archived = 0
          UNION
          SELECT sc.id FROM categories sc INNER JOIN cat_tree ct ON sc.parent_id = ct.id WHERE sc.is_archived = 0
        )
        SELECT id FROM cat_tree
      )) AS resource_count
     FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id
     ORDER BY COALESCE(c.parent_id, c.id), c.parent_id IS NOT NULL, c.sort_order, c.name`
  );
}

export async function resourceFindById(id) {
  return queryOne('SELECT * FROM resources WHERE id = :id', { id });
}

async function publicCategoryIds() {
  const rows = await query('SELECT id, parent_id, is_archived FROM categories');
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const publicIds = new Set();
  for (const row of rows) {
    let current = row;
    const visited = new Set();
    let visible = true;
    while (current) {
      const id = Number(current.id);
      if (visited.has(id) || current.is_archived) { visible = false; break; }
      visited.add(id);
      current = current.parent_id ? byId.get(Number(current.parent_id)) : null;
    }
    if (visible) publicIds.add(Number(row.id));
  }
  return publicIds;
}

export async function resourceFindBySlug(slug, publishedOnly = true) {
  const row = await queryOne(
    `SELECT r.*, c.name AS category_name, c.slug AS category_slug,
            pc.name AS parent_category_name, pc.slug AS parent_category_slug,
            u.name AS author_name
     FROM resources r
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN categories pc ON pc.id = c.parent_id
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.slug = :slug ${publishedOnly ? 'AND r.is_published = 1 AND r.is_archived = 0 AND (c.is_archived = 0 OR c.id IS NULL) AND (pc.is_archived = 0 OR pc.id IS NULL)' : ''}`,
    { slug }
  );
  if (publishedOnly && row?.category_id) {
    const publicIds = await publicCategoryIds();
    if (!publicIds.has(Number(row.category_id))) return null;
  }
  return row;
}

export async function resourceSlugExists(slug, excludeId = null) {
  const row = excludeId
    ? await queryOne('SELECT id FROM resources WHERE slug = :slug AND id != :id', { slug, id: excludeId })
    : await queryOne('SELECT id FROM resources WHERE slug = :slug', { slug });
  return !!row;
}

export async function resourceCreate(data) {
  const result = await query(
    `INSERT INTO resources (title, slug, description, content_description, age_range, keywords, action_visibility, grade_level, material_type, google_slides_url, canva_url, category_id, cover_image, cover_hidden, display_mode, download_limit_max, download_limit_period, school_only, page_layout, is_premium, is_published, is_archived, sort_order, created_by)
     VALUES (:title, :slug, :description, :content_description, :age_range, :keywords, :action_visibility, :grade_level, :material_type, :google_slides_url, :canva_url, :category_id, :cover_image, :cover_hidden, :display_mode, :download_limit_max, :download_limit_period, :school_only, :page_layout, :is_premium, :is_published, :is_archived, :sort_order, :created_by)`,
    resourceInsertParams(data)
  );
  return { insertId: result.insertId };
}

export async function resourceUpdate(id, data) {
  const keys = Object.keys(data);
  const normalized = { ...data };
  if (normalized.action_visibility != null && typeof normalized.action_visibility !== 'string') {
    normalized.action_visibility = JSON.stringify(normalized.action_visibility);
  }
  await query(
    `UPDATE resources SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`,
    { ...normalized, id }
  );
}

export async function resourceDelete(id) {
  await query('DELETE FROM resources WHERE id = :id', { id });
}

export async function resourceCoverReferenceCount(storagePath, excludeId = null) {
  const target = String(storagePath || '').replace(/^\/+/, '').replace(/^uploads\//, '');
  if (!target) return 0;
  const row = await queryOne(
    `SELECT COUNT(*) AS count FROM resources
     WHERE cover_image IS NOT NULL
       AND (cover_image = :target OR cover_image = :uploadsTarget OR cover_image LIKE :suffix)
       ${excludeId === null || excludeId === undefined ? '' : 'AND id != :excludeId'}`,
    {
      target,
      uploadsTarget: `/uploads/${target}`,
      suffix: `%/${target}`,
      ...(excludeId === null || excludeId === undefined ? {} : { excludeId }),
    }
  );
  return Number(row?.count) || 0;
}

export async function resourceIncrementViews(id) {
  await query('UPDATE resources SET view_count = view_count + 1 WHERE id = :id', { id });
}

export async function resourceIncrementDownloads(id) {
  await query('UPDATE resources SET download_count = download_count + 1 WHERE id = :id', { id });
}

export async function resourceAdminList() {
  return query(
    `SELECT r.*, c.name AS category_name FROM resources r
     LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.created_at DESC`
  );
}

export async function resourceListFiltered({ params, orderBy, limit, offset }) {
  const conditions = ['r.is_published = 1', 'r.is_archived = 0', '(c.is_archived = 0 OR c.id IS NULL)', '(pc.is_archived = 0 OR pc.id IS NULL)'];
  const sqlParams = {};
  const publicIds = await publicCategoryIds();
  if (publicIds.size) {
    conditions.push(`(r.category_id IS NULL OR r.category_id IN (${[...publicIds].map((_, i) => `:publicCat${i}`).join(',')}))`);
    [...publicIds].forEach((id, i) => { sqlParams[`publicCat${i}`] = id; });
  } else {
    // If every category is archived, only uncategorized published resources
    // remain public. Skipping this predicate would expose descendants of an
    // archived root through a direct library query.
    conditions.push('r.category_id IS NULL');
  }
  if (params.q) {
    conditions.push('(r.title LIKE :q OR r.description LIKE :q OR r.keywords LIKE :q)');
    sqlParams.q = `%${params.q}%`;
  }
  if (params.categoryIds?.length) {
    conditions.push(`r.category_id IN (${params.categoryIds.map((_, i) => `:cat${i}`).join(',')})`);
    params.categoryIds.forEach((id, i) => { sqlParams[`cat${i}`] = id; });
  }
  if (params.type === 'presentation') {
    conditions.push(`((r.canva_url IS NOT NULL AND r.canva_url <> '') OR EXISTS (SELECT 1 FROM resource_files rf WHERE rf.resource_id = r.id AND rf.is_archived = 0 AND rf.file_type IN ('ppt', 'pptx')))`);
  } else if (params.type) {
    conditions.push('EXISTS (SELECT 1 FROM resource_files rf WHERE rf.resource_id = r.id AND rf.is_archived = 0 AND rf.file_type = :type)');
    sqlParams.type = params.type;
  }
  if (params.access === 'free') conditions.push('r.is_premium = 0');
  if (params.access === 'premium') conditions.push('r.is_premium = 1');
  if (params.grade) {
    conditions.push('r.grade_level = :grade');
    sqlParams.grade = params.grade;
  }
  if (params.materialType) {
    conditions.push('r.material_type = :materialType');
    sqlParams.materialType = params.materialType;
  }

  const sortOptions = {
    featured: 'r.sort_order ASC, r.created_at DESC',
    newest: 'r.created_at DESC',
    oldest: 'r.created_at ASC',
    downloads: 'r.download_count DESC, r.created_at DESC',
    views: 'r.view_count DESC, r.created_at DESC',
    title_asc: 'r.title ASC',
    title_desc: 'r.title DESC',
  };
  const where = conditions.join(' AND ');
  const resources = await query(
    `SELECT r.id, r.title, r.slug, r.description, r.cover_image, r.cover_hidden, r.sort_order, r.download_count, r.view_count,
            r.is_premium, r.display_mode, r.grade_level, r.material_type, r.canva_url, r.created_at, c.name AS category_name, c.slug AS category_slug,
            (SELECT GROUP_CONCAT(DISTINCT rf.file_type ORDER BY rf.file_type SEPARATOR ',')
             FROM resource_files rf WHERE rf.resource_id = r.id AND rf.is_archived = 0) AS file_types,
            (SELECT COUNT(*) FROM resource_files rf WHERE rf.resource_id = r.id AND rf.is_archived = 0) AS file_count,
            (SELECT rf.id FROM resource_files rf WHERE rf.resource_id = r.id AND rf.is_archived = 0
             ORDER BY rf.is_primary DESC, rf.sort_order ASC LIMIT 1) AS primary_file_id
     FROM resources r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN categories pc ON pc.id = c.parent_id
     WHERE ${where} ORDER BY ${sortOptions[orderBy] || sortOptions.newest}
     LIMIT ${limit} OFFSET ${offset}`,
    sqlParams
  );
  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM resources r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN categories pc ON pc.id = c.parent_id WHERE ${where}`,
    sqlParams
  );
  return { resources, total };
}

export async function fileFindById(id) {
  return queryOne('SELECT * FROM resource_files WHERE id = :id', { id });
}

export async function fileFindByIdAndResource(fileId, resourceId) {
  return queryOne(
    `SELECT rf.*, r.title AS resource_title, r.is_published
     FROM resource_files rf JOIN resources r ON r.id = rf.resource_id
     WHERE rf.id = :fileId AND rf.resource_id = :resourceId`,
    { fileId, resourceId }
  );
}

export async function filesByResource(resourceId, options = {}) {
  const includeArchived = options === true || options?.includeArchived === true;
  const archivedClause = includeArchived ? '' : ' AND is_archived = 0';
  return query(
    `SELECT id, original_name, label, sort_order, file_name, file_type, file_size, mime_type, is_primary, is_archived, is_bundle, premium_only, thumbnail
     FROM resource_files WHERE resource_id = :id${archivedClause} ORDER BY sort_order ASC, is_primary DESC, id ASC`,
    { id: resourceId }
  );
}

export async function fileCreate(resourceId, data) {
  const result = await query(
    `INSERT INTO resource_files (resource_id, file_name, original_name, label, sort_order, file_type, file_size, mime_type, is_primary, is_archived, is_bundle, premium_only, thumbnail)
     VALUES (:resource_id, :file_name, :original_name, :label, :sort_order, :file_type, :file_size, :mime_type, :is_primary, :is_archived, :is_bundle, :premium_only, :thumbnail)`,
    { resource_id: resourceId, thumbnail: null, is_archived: data.is_archived === undefined ? 0 : data.is_archived, ...data }
  );
  return { insertId: result.insertId };
}

export async function fileUpdate(id, data) {
  const keys = Object.keys(data);
  await query(
    `UPDATE resource_files SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`,
    { ...data, id }
  );
}

export async function fileDelete(id) {
  await query('DELETE FROM resource_files WHERE id = :id', { id });
}

export async function fileMaxSortOrder(resourceId) {
  return queryOne('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM resource_files WHERE resource_id = :id', { id: resourceId });
}

export async function fileClearBundleFlags(resourceId, exceptId = null) {
  if (exceptId) {
    await query('UPDATE resource_files SET is_bundle = 0, premium_only = 0 WHERE resource_id = :rid AND id != :id', { rid: resourceId, id: exceptId });
  } else {
    await query('UPDATE resource_files SET is_bundle = 0, premium_only = 0 WHERE resource_id = :id', { id: resourceId });
  }
}

export async function settingsGetAll() {
  return query('SELECT setting_key, setting_value FROM settings');
}

export async function settingsGetByKeys(keys) {
  return query(
    `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys.map((k) => `'${k}'`).join(',')})`
  );
}

export async function settingsUpsert(key, value) {
  await query(
    `INSERT INTO settings (setting_key, setting_value) VALUES (:key, :value)
     ON DUPLICATE KEY UPDATE setting_value = :value`,
    { key, value: value ?? '' }
  );
}

export async function settingsSeed(defaults) {
  for (const [key, value] of defaults) {
    await settingsUpsert(key, value);
  }
}

export async function downloadCreate(data) {
  await query(
    `INSERT INTO downloads
      (resource_id, file_id, user_id, ip_address, user_agent, request_id, status, completed_at)
     VALUES (:resource_id, :file_id, :user_id, :ip, :ua, :request_id, 'completed', NOW())`,
    {
      resource_id: data.resource_id,
      file_id: data.file_id,
      user_id: data.user_id,
      ip: data.ip_address,
      ua: data.user_agent,
      request_id: data.request_id || null,
    }
  );
}

const DOWNLOAD_RESERVATION_TTL_MINUTES = 30;

function downloadPeriodCondition(period, alias = 'd') {
  return {
    day: `${alias}.created_at >= CURDATE()`,
    week: `${alias}.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    month: `${alias}.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)`,
    year: `${alias}.created_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)`,
    forever: '1=1',
  }[period] || `${alias}.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)`;
}

function downloadCountCondition(mode, resourceId) {
  return mode === 'global' ? { sql: '', params: {} } : {
    sql: ' AND d.resource_id = :resourceId',
    params: { resourceId },
  };
}

function downloadLimitError(used, max) {
  const error = new Error('Download limit reached.');
  error.code = 'DOWNLOAD_LIMIT';
  error.status = 429;
  error.used = used;
  error.max = max;
  return error;
}

export async function downloadReserve(data) {
  const requestId = String(data.request_id || '').trim();
  if (!requestId) throw new Error('A download request id is required.');

  return withTransaction(async () => {
    const quotaKey = `${data.user_id}:${data.mode === 'global' ? 'global' : `resource:${data.resource_id}`}:${data.period || 'month'}`;
    await query(
      `INSERT INTO download_quota_locks (quota_key) VALUES (:quotaKey)
       ON DUPLICATE KEY UPDATE quota_key = VALUES(quota_key)`,
      { quotaKey }
    );
    await queryOne('SELECT quota_key FROM download_quota_locks WHERE quota_key = :quotaKey FOR UPDATE', { quotaKey });

    const existing = await queryOne(
      'SELECT id, status, reserved_until FROM downloads WHERE request_id = :requestId FOR UPDATE',
      { requestId }
    );
    if (existing?.status === 'completed') return { alreadyCompleted: true, id: existing.id, requestId };
    if (existing?.status === 'reserved' && existing.reserved_until && new Date(existing.reserved_until).getTime() > Date.now()) {
      return { alreadyReserved: true, id: existing.id, requestId };
    }
    if (existing) await query('DELETE FROM downloads WHERE id = :id AND status = \'reserved\'', { id: existing.id });

    const max = Number(data.max) || 0;
    const scope = downloadCountCondition(data.mode, data.resource_id);
    const count = await queryOne(
      `SELECT COUNT(*) AS total FROM downloads d
       WHERE d.user_id = :userId
         AND ${downloadPeriodCondition(data.period, 'd')}
         ${scope.sql}
         AND (d.status = 'completed' OR d.status IS NULL
              OR (d.status = 'reserved' AND d.reserved_until > NOW()))`,
      { userId: data.user_id, ...scope.params }
    );
    const used = Number(count?.total || 0);
    if (max > 0 && used >= max) throw downloadLimitError(used, max);

    const result = await query(
      `INSERT INTO downloads
        (resource_id, file_id, user_id, ip_address, user_agent, request_id, status, reserved_until)
       VALUES (:resourceId, :fileId, :userId, :ip, :ua, :requestId, 'reserved',
               DATE_ADD(NOW(), INTERVAL ${DOWNLOAD_RESERVATION_TTL_MINUTES} MINUTE))`,
      {
        resourceId: data.resource_id,
        fileId: data.file_id,
        userId: data.user_id,
        ip: data.ip_address || null,
        ua: data.user_agent || null,
        requestId,
      }
    );
    return { id: result.insertId, requestId, created: true };
  });
}

export async function downloadFinalize(requestId) {
  const result = await query(
    `UPDATE downloads
     SET status = 'completed', reserved_until = NULL, completed_at = NOW()
     WHERE request_id = :requestId AND status = 'reserved'`,
    { requestId: String(requestId) }
  );
  return Number(result.affectedRows || 0) === 1;
}

export async function downloadComplete(requestId, resourceId) {
  return withTransaction(async () => {
    const result = await query(
      `UPDATE downloads
       SET status = 'completed', reserved_until = NULL, completed_at = NOW()
       WHERE request_id = :requestId AND status = 'reserved'`,
      { requestId: String(requestId) }
    );
    if (Number(result.affectedRows || 0) !== 1) return false;
    const resourceResult = await query(
      'UPDATE resources SET download_count = download_count + 1 WHERE id = :id',
      { id: resourceId }
    );
    if (Number(resourceResult.affectedRows || 0) !== 1) {
      throw new Error('Resource not found while completing download.');
    }
    return true;
  });
}

export async function downloadRelease(requestId) {
  const result = await query(
    `DELETE FROM downloads WHERE request_id = :requestId AND status = 'reserved'`,
    { requestId: String(requestId) }
  );
  return Number(result.affectedRows || 0) === 1;
}

export async function downloadIntentCreate(data) {
  await query(
    'INSERT INTO download_intents (resource_id, file_id, user_id, ip_address, user_agent) VALUES (:resource_id, :file_id, :user_id, :ip, :ua)',
    {
      resource_id: data.resource_id,
      file_id: data.file_id,
      user_id: data.user_id,
      ip: data.ip_address,
      ua: data.user_agent,
    }
  );
}

export async function downloadIntentRecent(limit = 20) {
  return query(
    `SELECT di.created_at, r.title AS resource_title,
            COALESCE(rf.label, rf.original_name) AS file_label,
            u.name AS user_name, u.email AS user_email
     FROM download_intents di
     JOIN resources r ON r.id = di.resource_id
     LEFT JOIN resource_files rf ON rf.id = di.file_id
     LEFT JOIN users u ON u.id = di.user_id
     ORDER BY di.created_at DESC LIMIT ${Number(limit) || 20}`
  );
}

export async function downloadCountByUser(userId, { resourceId = null, period = 'month', mode = 'global' } = {}) {
  const scope = downloadCountCondition(mode, resourceId);
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM downloads d
     WHERE d.user_id = :userId
       AND ${downloadPeriodCondition(period, 'd')}
       ${scope.sql}
       AND (d.status = 'completed' OR d.status IS NULL
            OR (d.status = 'reserved' AND d.reserved_until > NOW()))`,
    { userId, ...scope.params }
  );
  return Number(row?.total || 0);
}

export async function downloadCount() {
  return queryOne("SELECT COUNT(*) AS total FROM downloads WHERE status = 'completed' OR status IS NULL");
}

export async function downloadRecent(limit = 10) {
  return query(
    `SELECT d.created_at, r.title AS resource_title, r.id AS resource_id, d.file_id,
            COALESCE(rf.label, rf.original_name) AS file_label,
            u.name AS user_name, u.email AS user_email
     FROM downloads d
     JOIN resources r ON r.id = d.resource_id
     LEFT JOIN resource_files rf ON rf.id = d.file_id
     LEFT JOIN users u ON u.id = d.user_id
     WHERE d.status = 'completed' OR d.status IS NULL
     ORDER BY d.created_at DESC LIMIT ${limit}`
  );
}

export async function downloadReport(limit = 100) {
  const perFile = await query(
    `SELECT r.id AS resource_id, r.title AS resource_title, rf.id AS file_id,
            COALESCE(rf.label, rf.original_name) AS file_label, COUNT(*) AS count
     FROM downloads d
     JOIN resources r ON r.id = d.resource_id
     LEFT JOIN resource_files rf ON rf.id = d.file_id
     WHERE d.status = 'completed' OR d.status IS NULL
     GROUP BY r.id, r.title, rf.id, rf.label, rf.original_name
     ORDER BY count DESC`
  );
  const perUserRows = await query(
    `SELECT u.id AS user_id, u.name AS user_name, u.email AS user_email,
            r.title AS resource_title, COALESCE(rf.label, rf.original_name) AS file_label,
            COUNT(*) AS count
     FROM downloads d
     JOIN users u ON u.id = d.user_id
     JOIN resources r ON r.id = d.resource_id
     LEFT JOIN resource_files rf ON rf.id = d.file_id
     WHERE d.status = 'completed' OR d.status IS NULL
     GROUP BY u.id, u.name, u.email, r.title, rf.label, rf.original_name
     ORDER BY u.name, count DESC`
  );
  const userMap = {};
  for (const row of perUserRows) {
    const key = String(row.user_id);
    if (!userMap[key]) {
      userMap[key] = {
        user_id: row.user_id,
        user_name: row.user_name,
        user_email: row.user_email,
        total: 0,
        files: [],
      };
    }
    userMap[key].total += Number(row.count);
    userMap[key].files.push({
      resource_title: row.resource_title,
      file_label: row.file_label,
      count: Number(row.count),
    });
  }
  const perUser = Object.values(userMap).sort((a, b) => b.total - a.total);
  const recent = await downloadRecent(limit);
  const recentIntents = await downloadIntentRecent(Math.min(limit, 30));
  const [{ total }] = await query("SELECT COUNT(*) AS total FROM downloads WHERE status = 'completed' OR status IS NULL");
  return { perFile, perUser, recent, recentIntents, total };
}

export async function downloadsByUser(userId) {
  const rows = await query(
    `SELECT r.id, r.title, r.slug, r.description, r.cover_image,
            c.name AS category_name, c.slug AS category_slug,
            COUNT(*) AS download_count, MAX(d.created_at) AS downloaded_at,
            (SELECT d2.file_id FROM downloads d2
             WHERE d2.user_id = :user_id AND d2.resource_id = r.id
               AND (d2.status = 'completed' OR d2.status IS NULL)
             ORDER BY d2.created_at DESC LIMIT 1) AS last_file_id
     FROM downloads d JOIN resources r ON r.id = d.resource_id
     LEFT JOIN categories c ON c.id = r.category_id
     WHERE d.user_id = :user_id AND r.is_published = 1
       AND (d.status = 'completed' OR d.status IS NULL)
     GROUP BY r.id, r.title, r.slug, r.description, r.cover_image, c.name, c.slug
     ORDER BY downloaded_at DESC`,
    { user_id: userId }
  );
  for (const row of rows) {
    row.files = await filesByResource(row.id);
  }
  return rows;
}

export async function favoriteFolderEnsureDefault(userId) {
  let row = await queryOne(
    'SELECT id FROM favorite_folders WHERE user_id = :user_id AND is_default = 1 LIMIT 1',
    { user_id: userId }
  );
  if (!row) {
    const result = await query(
      'INSERT INTO favorite_folders (user_id, name, is_default) VALUES (:user_id, :name, 1)',
      { user_id: userId, name: 'Default' }
    );
    row = { id: result.insertId };
  }

  await query(
    'UPDATE favorites SET folder_id = :folder_id WHERE user_id = :user_id AND folder_id IS NULL',
    { folder_id: row.id, user_id: userId }
  );

  return row.id;
}

export async function favoriteFolderFindById(id, userId) {
  return queryOne(
    'SELECT id, name, is_default FROM favorite_folders WHERE id = :id AND user_id = :user_id',
    { id, user_id: userId }
  );
}

export async function favoriteFolderListByUser(userId) {
  await favoriteFolderEnsureDefault(userId);
  const folders = await query(
    `SELECT ff.id, ff.name, ff.is_default,
            (SELECT COUNT(*) FROM favorites f WHERE f.folder_id = ff.id) AS item_count
     FROM favorite_folders ff
     WHERE ff.user_id = :user_id
     ORDER BY ff.is_default DESC, ff.name ASC`,
    { user_id: userId }
  );
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    is_default: !!f.is_default,
    item_count: Number(f.item_count) || 0,
  }));
}

export async function favoriteFolderCreate(userId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Folder name is required.');
  const result = await query(
    'INSERT INTO favorite_folders (user_id, name, is_default) VALUES (:user_id, :name, 0)',
    { user_id: userId, name: trimmed }
  );
  return { id: result.insertId, name: trimmed, is_default: false, item_count: 0 };
}

export async function favoriteListByUser(userId, folderId = null) {
  const params = { user_id: userId };
  let folderClause = '';
  if (folderId) {
    folderClause = ' AND f.folder_id = :folder_id';
    params.folder_id = folderId;
  }
  const rows = await query(
    `SELECT r.id, r.title, r.slug, r.description, r.cover_image, r.canva_url, r.category_id,
            c.name AS category_name, c.slug AS category_slug, f.created_at AS saved_at,
            f.folder_id, ff.name AS folder_name
     FROM favorites f
     JOIN resources r ON r.id = f.resource_id
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN favorite_folders ff ON ff.id = f.folder_id
     WHERE f.user_id = :user_id AND r.is_published = 1${folderClause}
     ORDER BY f.created_at DESC`,
    params
  );
  for (const row of rows) {
    row.files = await filesByResource(row.id);
  }
  return rows;
}

export async function favoriteIdsByUser(userId) {
  const rows = await query('SELECT resource_id FROM favorites WHERE user_id = :user_id', { user_id: userId });
  return rows.map((r) => r.resource_id);
}

export async function favoriteAdd(userId, resourceId, folderId = null) {
  let fid = folderId ? Number(folderId) : null;
  if (fid) {
    const folder = await favoriteFolderFindById(fid, userId);
    if (!folder) fid = await favoriteFolderEnsureDefault(userId);
  } else {
    fid = await favoriteFolderEnsureDefault(userId);
  }

  await query(
    `INSERT INTO favorites (user_id, resource_id, folder_id) VALUES (:user_id, :resource_id, :folder_id)
     ON DUPLICATE KEY UPDATE folder_id = VALUES(folder_id)`,
    { user_id: userId, resource_id: resourceId, folder_id: fid }
  );
  return fid;
}

export async function favoriteRemove(userId, resourceId) {
  await query('DELETE FROM favorites WHERE user_id = :user_id AND resource_id = :resource_id', {
    user_id: userId,
    resource_id: resourceId,
  });
}

export async function planFindPremium() {
  return queryOne('SELECT id FROM plans WHERE slug = :slug LIMIT 1', { slug: 'premium' });
}

export async function planFindBySlug(slug) {
  return queryOne('SELECT id, name, slug, description, price, interval_type, is_active FROM plans WHERE slug = :slug LIMIT 1', {
    slug: String(slug || '').trim().toLowerCase(),
  });
}

export async function planCreateFromConfig(data = {}) {
  const slug = String(data.slug || '').trim().toLowerCase();
  if (!slug) throw new Error('Plan slug is required.');
  const existing = await planFindBySlug(slug);
  if (existing) return { insertId: existing.id };
  const result = await query(
    `INSERT INTO plans (name, slug, description, price, interval_type, is_active)
     VALUES (:name, :slug, :description, :price, :interval_type, 1)`,
    {
      name: String(data.name || slug).slice(0, 150),
      slug,
      description: data.description || null,
      price: Number(data.price) || 0,
      interval_type: ['monthly', 'yearly', 'lifetime'].includes(data.interval_type) ? data.interval_type : 'monthly',
    }
  );
  return { insertId: result.insertId };
}

export async function planCreatePremium() {
  const result = await query(
    `INSERT INTO plans (name, slug, description, price, interval_type) VALUES ('Premium', 'premium', 'Assinatura', 0, 'monthly')`
  );
  return { insertId: result.insertId };
}

export async function subscriptionHasActive(userId) {
  const row = await queryOne(
    `SELECT s.id FROM subscriptions s WHERE s.user_id = :userId AND s.status = 'active'
     AND (s.ends_at IS NULL OR s.ends_at > NOW())`,
    { userId }
  );
  return !!row;
}

export async function subscriptionGetStatus(userId) {
  const sub = await queryOne(
    `SELECT s.id, s.status, s.starts_at, s.ends_at, p.name AS plan_name, p.price, p.interval_type
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = :userId AND s.status = 'active' AND (s.ends_at IS NULL OR s.ends_at > NOW())
     ORDER BY s.id DESC LIMIT 1`,
    { userId }
  );
  if (!sub) return { active: false };
  return {
    active: true,
    planName: sub.plan_name,
    price: sub.price,
    intervalType: sub.interval_type,
    endsAt: sub.ends_at,
  };
}

export async function subscriptionCancelActive(userId) {
  await query(`UPDATE subscriptions SET status = 'cancelled' WHERE user_id = :uid AND status = 'active'`, { uid: userId });
}

export async function subscriptionActivate(userId, planId, months, tier = 'standard') {
  await query(
    `INSERT INTO subscriptions (user_id, plan_id, status, tier, starts_at, ends_at)
     VALUES (:uid, :planId, 'active', :tier, NOW(), DATE_ADD(NOW(), INTERVAL :months MONTH))`,
    { uid: userId, planId, months, tier: tier === 'school' ? 'school' : 'standard' }
  );
}

// Tier ('school' | 'standard') da assinatura ativa mais recente, ou null.
export async function subscriptionActiveTier(userId) {
  const row = await queryOne(
    `SELECT s.tier FROM subscriptions s WHERE s.user_id = :userId AND s.status = 'active'
     AND (s.ends_at IS NULL OR s.ends_at > NOW())
     ORDER BY s.id DESC LIMIT 1`,
    { userId }
  );
  return row ? row.tier || 'standard' : null;
}

export async function subscriptionListNeedingReminder(daysBefore = 7) {
  return query(
    `SELECT s.id, s.user_id, s.ends_at
     FROM subscriptions s
     WHERE s.status = 'active'
       AND s.ends_at IS NOT NULL
       AND s.renewal_reminder_sent_at IS NULL
       AND s.ends_at >= DATE_ADD(NOW(), INTERVAL :minDay DAY)
       AND s.ends_at <= DATE_ADD(NOW(), INTERVAL :maxDay DAY)`,
    { minDay: daysBefore - 1, maxDay: daysBefore + 1 }
  );
}

export async function subscriptionMarkReminderSent(subscriptionId) {
  await query(
    'UPDATE subscriptions SET renewal_reminder_sent_at = NOW() WHERE id = :id',
    { id: subscriptionId }
  );
}

export async function pageViewCreate(data) {
  await query(
    `INSERT INTO page_views
      (path, page_title, referrer, user_agent, session_id, utm_source, utm_medium, utm_campaign, traffic_source, referrer_host)
     VALUES (:path, :pageTitle, :referrer, :userAgent, :sessionId, :utm_source, :utm_medium, :utm_campaign, :traffic_source, :referrer_host)`,
    {
      ...data,
      pageTitle: data.pageTitle ?? data.page_title ?? null,
      userAgent: data.userAgent ?? data.user_agent ?? null,
      sessionId: data.sessionId ?? data.session_id ?? null,
    }
  );
}

function aggregateTrafficSources(rows) {
  const map = {};
  rows.forEach((r) => {
    const key = sourceForRow(r);
    map[key] = (map[key] || 0) + 1;
  });
  return Object.entries(map)
    .map(([source, visits]) => ({ source, visits }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 10);
}

export async function userSignupSourceStats() {
  const rows = await query(
    `SELECT signup_source, signup_referrer, signup_utm_source, signup_utm_medium FROM users`
  );
  const map = {};
  rows.forEach((u) => {
    const key = sourceForRow({
      traffic_source: u.signup_source,
      referrer: u.signup_referrer,
      utm_source: u.signup_utm_source,
      utm_medium: u.signup_utm_medium,
    });
    map[key] = (map[key] || 0) + 1;
  });
  return Object.entries(map)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

export async function pageViewStats() {
  const today = await queryOne(
    `SELECT COUNT(*) AS pageViews, COUNT(DISTINCT session_id) AS visitors FROM page_views WHERE DATE(created_at) = CURDATE()`
  );
  const week = await queryOne(
    `SELECT COUNT(*) AS pageViews, COUNT(DISTINCT session_id) AS visitors FROM page_views WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
  );
  const month = await queryOne(
    `SELECT COUNT(*) AS pageViews, COUNT(DISTINCT session_id) AS visitors FROM page_views WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
  );
  const total = await queryOne(`SELECT COUNT(*) AS pageViews, COUNT(DISTINCT session_id) AS visitors FROM page_views`);
  const topPages = await query(
    `SELECT path, COUNT(*) AS views FROM page_views WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
     GROUP BY path ORDER BY views DESC LIMIT 8`
  );
  const recentVisits = await query(
    `SELECT path, page_title, referrer, created_at FROM page_views ORDER BY created_at DESC LIMIT 12`
  );
  const dailyChart = await query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS views, COUNT(DISTINCT session_id) AS visitors
     FROM page_views WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
     GROUP BY DATE(created_at) ORDER BY day ASC`
  );
  const monthRows = await query(
    `SELECT traffic_source, referrer, referrer_host, utm_source, utm_medium FROM page_views WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
  );
  const topTrafficSources = aggregateTrafficSources(monthRows);
  return { today, week, month, total, topPages, recentVisits, dailyChart, topTrafficSources };
}

export async function resourceTopByDownloads(limit = 5) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 5)));
  return query('SELECT id, title, download_count, view_count FROM resources ORDER BY download_count DESC LIMIT ' + safeLimit);
}

export async function storageUpload(buffer, destPath, mimeType) {
  const full = safeUploadPath(destPath);
  if (!full) throw new Error('Invalid storage path.');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return `/uploads/${String(destPath).replace(/^[/\\]+/, '').replaceAll('\\', '/')}`;
}

export async function storageDownloadStream(storagePath) {
  const full = safeUploadPath(storagePath);
  if (!full) return null;
  if (!fs.existsSync(full)) return null;
  return fs.createReadStream(full);
}

export async function storageDelete(storagePath) {
  const full = safeUploadPath(storagePath);
  if (!full) return;
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

export async function storageCopy(sourcePath, destinationPath) {
  const source = safeUploadPath(sourcePath);
  const destination = safeUploadPath(destinationPath);
  if (!source || !destination) throw new Error('Invalid storage path.');
  if (!fs.existsSync(source)) throw new Error('Staged upload not found.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return `/uploads/${String(destinationPath).replace(/^[/\\]+/, '').replaceAll('\\', '/')}`;
}

export async function storageStat(storagePath) {
  const full = safeUploadPath(storagePath);
  if (!full) return null;
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  return { size: stat.size };
}

export function localPathToStorage(localPath) {
  return localPath?.replace(/^\/uploads\//, '') || null;
}

export async function setCounter() {}
export async function importDoc() {}

export async function contactMessageCreate(data) {
  const result = await query(
    `INSERT INTO contact_messages
      (name, email, message, status, notification_status)
     VALUES (:name, :email, :message, :status, :notification_status)`,
    {
      name: data.name,
      email: data.email,
      message: data.message,
      status: data.status === 'read' ? 'read' : 'unread',
      notification_status: data.notification_status || 'not_configured',
    }
  );
  return { insertId: result.insertId };
}

// A single monotonic editor revision lets the Content editor detect a stale
// browser draft before it can overwrite another administrator's publish.
export async function editorRevisionGet() {
  const row = await queryOne('SELECT setting_value FROM settings WHERE setting_key = :key', { key: 'editor_revision' });
  return Number(row?.setting_value) || 0;
}

export async function editorRevisionBump(expected = null) {
  const row = await queryOne(
    'SELECT setting_value FROM settings WHERE setting_key = :key FOR UPDATE',
    { key: 'editor_revision' }
  );
  const current = Number(row?.setting_value) || 0;
  if (expected !== null && expected !== undefined && Number(expected) !== current) {
    const error = new Error('This site changed in another editor. Reload the latest version before publishing.');
    error.code = 'EDITOR_REVISION_CONFLICT';
    error.status = 409;
    throw error;
  }
  const next = current + 1;
  await settingsUpsert('editor_revision', String(next));
  return next;
}

export async function editorUploadSessionCreate(data) {
  await query(
    `INSERT INTO editor_upload_sessions
      (upload_id, owner_id, name, mime_type, size_bytes, kind, chunk_size,
       storage_path, session_url, staged_path, status, received_bytes, last_chunk,
       expires_at)
     VALUES (:upload_id, :owner_id, :name, :mime_type, :size_bytes, :kind, :chunk_size,
       :storage_path, :session_url, :staged_path, :status, :received_bytes, :last_chunk,
       :expires_at)
     ON DUPLICATE KEY UPDATE
       owner_id = VALUES(owner_id), name = VALUES(name), mime_type = VALUES(mime_type),
       size_bytes = VALUES(size_bytes), kind = VALUES(kind), chunk_size = VALUES(chunk_size),
       storage_path = VALUES(storage_path), session_url = VALUES(session_url),
       staged_path = VALUES(staged_path), status = VALUES(status),
       received_bytes = VALUES(received_bytes), last_chunk = VALUES(last_chunk),
       expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP`,
    {
      upload_id: String(data.upload_id),
      owner_id: Number(data.owner_id),
      name: String(data.name || 'upload').slice(0, 255),
      mime_type: String(data.mime_type || 'application/octet-stream'),
      size_bytes: Number(data.size) || 0,
      kind: data.kind === 'cover' ? 'cover' : 'file',
      chunk_size: Number(data.chunk_size) || 8 * 1024 * 1024,
      storage_path: data.storage_path || null,
      session_url: data.session_url || null,
      staged_path: data.staged_path || null,
      status: data.status || 'started',
      received_bytes: Number(data.received_bytes) || 0,
      last_chunk: data.last_chunk === undefined ? -1 : Number(data.last_chunk),
      expires_at: data.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000),
    }
  );
  return editorUploadSessionFind(data.upload_id, data.owner_id);
}

export async function editorUploadSessionFind(uploadId, ownerId = null) {
  return queryOne(
    `SELECT upload_id, owner_id, name, mime_type, size_bytes AS size, kind, chunk_size,
            storage_path, session_url, staged_path, status, received_bytes, last_chunk,
            created_at, updated_at, expires_at
     FROM editor_upload_sessions
     WHERE upload_id = :upload_id ${ownerId === null || ownerId === undefined ? '' : 'AND owner_id = :owner_id'}`,
    { upload_id: String(uploadId), ...(ownerId === null || ownerId === undefined ? {} : { owner_id: Number(ownerId) }) }
  );
}

export async function editorUploadSessionUpdate(uploadId, fields = {}) {
  const map = {
    name: 'name', mime_type: 'mime_type', size: 'size_bytes', size_bytes: 'size_bytes', kind: 'kind',
    chunk_size: 'chunk_size', storage_path: 'storage_path', session_url: 'session_url',
    staged_path: 'staged_path', status: 'status', received_bytes: 'received_bytes', last_chunk: 'last_chunk',
    expires_at: 'expires_at', owner_id: 'owner_id',
  };
  const pairs = [];
  const params = { upload_id: String(uploadId) };
  Object.entries(fields).forEach(([key, value]) => {
    const column = map[key];
    if (!column) return;
    pairs.push(`${column} = :${column}`);
    params[column] = key === 'name' ? String(value || '').slice(0, 255) : value;
  });
  if (!pairs.length) return editorUploadSessionFind(uploadId);
  pairs.push('updated_at = CURRENT_TIMESTAMP');
  await query(`UPDATE editor_upload_sessions SET ${pairs.join(', ')} WHERE upload_id = :upload_id`, params);
  return editorUploadSessionFind(uploadId);
}

export async function editorUploadSessionDelete(uploadId, ownerId = null) {
  const result = await query(
    `DELETE FROM editor_upload_sessions WHERE upload_id = :upload_id
     ${ownerId === null || ownerId === undefined ? '' : 'AND owner_id = :owner_id'}`,
    { upload_id: String(uploadId), ...(ownerId === null || ownerId === undefined ? {} : { owner_id: Number(ownerId) }) }
  );
  return (result?.affectedRows || 0) > 0;
}

export async function editorUploadSessionListExpired(before = new Date()) {
  return query(
    `SELECT upload_id, owner_id, name, mime_type, size_bytes AS size, kind, chunk_size,
            storage_path, session_url, staged_path, status, received_bytes, last_chunk,
            created_at, updated_at, expires_at
     FROM editor_upload_sessions WHERE expires_at <= :before`,
    { before }
  );
}

export async function interactionEventCreate(data) {
  await query(
    `INSERT INTO analytics_interactions
      (event_key, event_name, resource_id, file_id, resource_title, file_label, page_index, path, session_id, user_id, ip_address, user_agent)
     VALUES (:event_key, :event_name, :resource_id, :file_id, :resource_title, :file_label, :page_index, :path, :session_id, :user_id, :ip_address, :user_agent)
     ON DUPLICATE KEY UPDATE id = id`,
    {
      event_key: data.event_key || data.client_event_id || null,
      event_name: data.event_name,
      resource_id: data.resource_id || null,
      file_id: data.file_id || null,
      resource_title: data.resource_title || null,
      file_label: data.file_label || null,
      page_index: data.page_index || null,
      path: data.path || null,
      session_id: data.session_id || null,
      user_id: data.user_id || null,
      ip_address: data.ip_address || null,
      user_agent: data.user_agent || null,
    }
  );
}

export async function interactionEventStats(limit = 30) {
  const recent = await query(
    `SELECT event_name, resource_id, file_id, resource_title, file_label, page_index, path, session_id, created_at
     FROM analytics_interactions ORDER BY created_at DESC LIMIT ${Number(limit) || 30}`
  );
  const perFile = await query(
    `SELECT resource_id, MAX(resource_title) AS resource_title, file_id, MAX(file_label) AS file_label,
            SUM(event_name = 'resource_preview_open') AS previews,
            SUM(event_name = 'resource_page_click') AS page_clicks,
            SUM(event_name = 'resource_download_click') AS download_clicks,
            SUM(event_name = 'download_page_open') AS download_page_opens,
            SUM(event_name = 'download_started') AS download_started,
            SUM(event_name = 'download_completed') AS download_completed
     FROM analytics_interactions
     WHERE file_id IS NOT NULL
     GROUP BY resource_id, file_id
     ORDER BY (previews + page_clicks + download_clicks) DESC LIMIT 50`
  );
  const totalsRows = await query(
    'SELECT event_name, COUNT(*) AS count FROM analytics_interactions GROUP BY event_name'
  );
  const totals = Object.fromEntries(totalsRows.map((row) => [row.event_name, Number(row.count)]));
  return { recent, perFile, totals };
}

export async function contactMessageList() {
  return query(
    `SELECT id, name, email, message,
       COALESCE(status, 'unread') AS status,
       read_at,
       COALESCE(notification_status, 'not_configured') AS notification_status,
       created_at
     FROM contact_messages
     ORDER BY created_at DESC, id DESC`
  );
}

export async function contactMessageUpdate(id, changes = {}) {
  const updates = [];
  const params = { id };
  if (changes.status === 'read' || changes.status === 'unread') {
    updates.push('status = :status');
    updates.push(`read_at = ${changes.status === 'read' ? 'CURRENT_TIMESTAMP' : 'NULL'}`);
    params.status = changes.status;
  }
  if (['not_configured', 'sent', 'failed'].includes(changes.notification_status)) {
    updates.push('notification_status = :notification_status');
    params.notification_status = changes.notification_status;
  }
  if (updates.length) {
    await query(`UPDATE contact_messages SET ${updates.join(', ')} WHERE id = :id`, params);
  }
}

export async function contactMessageDelete(id) {
  await query('DELETE FROM contact_messages WHERE id = :id', { id });
}

export async function stripeWebhookEventClaim(eventId) {
  const id = String(eventId || '').trim();
  if (!id) throw new Error('Stripe event id is required.');
  const result = await query(
    `INSERT INTO stripe_webhook_events (event_id, status)
     VALUES (:eventId, 'processing')
     ON DUPLICATE KEY UPDATE event_id = event_id`,
    { eventId: id }
  );
  if (Number(result?.affectedRows || 0) === 1) return true;
  const reclaimed = await query(
    `UPDATE stripe_webhook_events
     SET created_at = CURRENT_TIMESTAMP
     WHERE event_id = :eventId AND status = 'processing'
       AND created_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
    { eventId: id }
  );
  return Number(reclaimed?.affectedRows || 0) === 1;
}

export async function stripeWebhookEventComplete(eventId) {
  const result = await query(
    `UPDATE stripe_webhook_events
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP
     WHERE event_id = :eventId`,
    { eventId: String(eventId) }
  );
  return Number(result?.affectedRows || 0) > 0;
}

export async function stripeWebhookEventRelease(eventId) {
  const result = await query(
    `DELETE FROM stripe_webhook_events
     WHERE event_id = :eventId AND status = 'processing'`,
    { eventId: String(eventId) }
  );
  return Number(result?.affectedRows || 0) > 0;
}

export const COL = {};
