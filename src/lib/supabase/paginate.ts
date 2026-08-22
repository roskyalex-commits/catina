/**
 * Reading a whole table without a quadratic scan.
 *
 * `.range(n, n + 999)` becomes `OFFSET n LIMIT 1000`, and Postgres walks and
 * discards those n rows on **every** page. The total work is O(rows²), which is
 * invisible on a small table and fatal on a large one.
 *
 * It became fatal here the day `companies` went from 17,156 rows to 351,694: a
 * repair script that had run fine minutes earlier died with
 * `canceling statement due to statement timeout` somewhere past offset 300,000,
 * having written nothing. Nothing about the failure pointed at pagination.
 *
 * Keyset paging asks for "the next 1,000 rows after this id" instead, which is
 * a range scan on the primary key — the same cost per page whatever the table
 * size. `AnafAdapter` already pages this way; this makes it available to
 * everything else.
 *
 * ## When `.range()` is still fine
 *
 * When the result set is bounded and small: a `--limit 200` measurement, one
 * page of a UI, a filtered slice that cannot grow. The rule is about *whole
 * table* scans, and the threshold is roughly where the offset gets into the
 * tens of thousands.
 */

/** The subset of a PostgREST builder this needs. Keeps the helper untyped-safe. */
type KeysetQuery<T> = {
  order(column: string, options: { ascending: boolean }): KeysetQuery<T>;
  limit(count: number): KeysetQuery<T>;
  gt(column: string, value: string): KeysetQuery<T>;
  then: PromiseLike<{ data: T[] | null; error: { message: string } | null }>["then"];
};

export type KeysetOptions<T> = {
  /** Builds a fresh query. Called once per page — it must not be reused. */
  query: () => KeysetQuery<T>;
  /** The ordered, unique column to page on. Almost always the primary key. */
  cursorColumn?: string;
  /** Reads the cursor value out of a row. */
  cursorOf: (row: T) => string;
  pageSize?: number;
  /** Stop early once this many rows are collected. */
  limit?: number;
  onPage?: (total: number) => void;
};

/**
 * Every row matching a query, read by keyset.
 *
 * Throws rather than returning a partial set: a caller that silently gets a
 * tenth of the table looks exactly like one that got all of it, which is the
 * failure mode the 1,000-row PostgREST cap already caused once in this repo.
 */
export async function readAllByKeyset<T>(options: KeysetOptions<T>): Promise<T[]> {
  const pageSize = options.pageSize ?? 1000;
  const cursorColumn = options.cursorColumn ?? "id";
  const rows: T[] = [];
  let cursor: string | undefined;

  for (;;) {
    const wanted = options.limit
      ? Math.min(pageSize, options.limit - rows.length)
      : pageSize;
    if (wanted <= 0) break;

    let query = options.query().order(cursorColumn, { ascending: true }).limit(wanted);
    if (cursor) query = query.gt(cursorColumn, cursor);

    const { data, error } = await query;
    if (error) throw new Error(`Keyset read failed: ${error.message}`);

    const batch = data ?? [];
    rows.push(...batch);
    options.onPage?.(rows.length);

    // A short page is the end of the table. Anything else and there is more.
    if (batch.length < wanted) break;
    cursor = options.cursorOf(batch[batch.length - 1]);
  }

  return rows;
}
