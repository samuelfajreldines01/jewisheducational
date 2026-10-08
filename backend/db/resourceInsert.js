// Valores do INSERT de resources. Campos ausentes viram NULL ou o default
// da coluna. mysql2 rejeita undefined em parâmetro nomeado.
export function resourceInsertParams(data) {
  return {
    ...data,
    google_slides_url: data.google_slides_url ?? null,
    canva_url: data.canva_url ?? null,
    cover_hidden: data.cover_hidden ? 1 : 0,
    is_archived: data.is_archived ? 1 : 0,
    sort_order: Number.isFinite(Number(data.sort_order)) ? Number(data.sort_order) : 0,
    is_premium: data.is_premium ? 1 : 0,
    action_visibility: data.action_visibility == null
      ? null
      : (typeof data.action_visibility === 'string' ? data.action_visibility : JSON.stringify(data.action_visibility)),
  };
}
