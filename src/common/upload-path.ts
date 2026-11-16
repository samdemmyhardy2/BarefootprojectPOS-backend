/** Keep uploaded files as a path. A saved host breaks when the LAN address changes. */
export function uploadPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('/uploads/') || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed || value;
  try {
    const url = new URL(trimmed);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.pathname.startsWith('/uploads/')) {
      return `${url.pathname}${url.search}`;
    }
  } catch {
    return value;
  }
  return value;
}

export function rewriteUploadUrls(value: unknown): unknown {
  if (typeof value === 'string') return uploadPath(value);
  if (Array.isArray(value)) return value.map((item) => rewriteUploadUrls(item));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = rewriteUploadUrls(item);
  return copy;
}
