import { demoDataset, isDemoMode } from "./demo";
import { SCORE_BANDS } from "./score";
import type { ContactRow } from "./types";

export type ContactFilter = {
  /** Matches name, title, company or email. */
  query?: string;
  agentId?: string;
  listId?: string;
  minScore?: number;
  page?: number;
  perPage?: number;
};

export type ContactPage = {
  rows: ContactRow[];
  total: number;
  page: number;
  perPage: number;
};

/**
 * Filtering runs here rather than in the page so that the same predicate serves
 * the fixtures today and becomes a `where` clause later. A page component that
 * filters its own array would have to be rewritten when the data moves.
 */
export function matchesFilter(row: ContactRow, filter: ContactFilter): boolean {
  if (filter.agentId && row.agentId !== filter.agentId) return false;
  if (filter.listId && row.list?.id !== filter.listId) return false;
  if (filter.minScore !== undefined && row.score < filter.minScore) return false;

  const query = filter.query?.trim().toLowerCase();
  if (!query) return true;

  return [
    row.fullName,
    row.title,
    row.companyName,
    row.companyDomain,
    row.email?.address,
    row.county,
  ].some((field) => field?.toLowerCase().includes(query));
}

export async function listContacts(
  filter: ContactFilter = {},
): Promise<ContactPage> {
  const page = Math.max(1, filter.page ?? 1);
  const perPage = Math.min(200, Math.max(1, filter.perPage ?? 100));

  if (!isDemoMode()) {
    return { rows: [], total: 0, page, perPage };
  }

  const matched = demoDataset().contacts.filter((row) =>
    matchesFilter(row, filter),
  );

  return {
    rows: matched.slice((page - 1) * perPage, page * perPage),
    total: matched.length,
    page,
    perPage,
  };
}

export async function hotContacts(limit = 5): Promise<ContactRow[]> {
  const { rows } = await listContacts({ minScore: SCORE_BANDS.hot, perPage: limit });
  return rows;
}
