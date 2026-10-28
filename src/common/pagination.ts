export const DEFAULT_PAGE_SIZE = 10;

export function paginationWindow(page = 1, limit = DEFAULT_PAGE_SIZE) {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const safeLimit = Number.isFinite(limit) ? Math.min(DEFAULT_PAGE_SIZE, Math.max(1, Math.floor(limit))) : DEFAULT_PAGE_SIZE;
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit, take: safeLimit };
}

export async function pageResponse<T>(page: number, limit: number, total: number, rows: Promise<T[]>) {
  const data = await rows;
  return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
}
