export const DEFAULT_LIST_ID = 'default';
export const DEFAULT_LIST_NAME = 'Main';
export const DEFAULT_LIST_COLOR = '#2563eb';
export const TEMPLATE_SEP = '::';

export function buildTemplateId(listId: string, normalizedTitle: string) {
  return `${listId}${TEMPLATE_SEP}${normalizedTitle}`;
}

export function parseTemplateId(id: string) {
  const idx = id.indexOf(TEMPLATE_SEP);
  if (idx === -1) {
    return { listId: DEFAULT_LIST_ID, baseKey: id };
  }
  return {
    listId: id.slice(0, idx),
    baseKey: id.slice(idx + TEMPLATE_SEP.length)
  };
}
