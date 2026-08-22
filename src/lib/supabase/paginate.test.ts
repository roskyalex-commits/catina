import { describe, expect, it, vi } from "vitest";
import { readAllByKeyset } from "./paginate";

/**
 * The failure this replaces was silent and scale-dependent: offset paging over
 * `companies` worked for months at 17,156 rows and started timing out the day
 * the table reached 351,694. So these pin the two properties that matter —
 * every row is returned, and the cursor advances by key rather than by count.
 */

type Row = { id: string; n: number };

/** A fake table that only answers `id > cursor`, like a keyset scan does. */
function fakeTable(rows: Row[]) {
  const calls: { cursor?: string; limit: number }[] = [];

  const build = () => {
    let cursor: string | undefined;
    let limit = 1000;

    const query = {
      order: () => query,
      limit: (n: number) => {
        limit = n;
        return query;
      },
      gt: (_column: string, value: string) => {
        cursor = value;
        return query;
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => {
        calls.push({ cursor, limit });
        const after = cursor ? rows.filter((row) => row.id > cursor!) : rows;
        return Promise.resolve({ data: after.slice(0, limit), error: null }).then(resolve);
      },
    };
    return query as never;
  };

  return { build, calls };
}

const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i + 1).padStart(6, "0"),
    n: i,
  }));

describe("readAllByKeyset", () => {
  it("returns every row across several pages", async () => {
    const table = fakeTable(rows(2500));
    const result = await readAllByKeyset<Row>({
      query: table.build,
      cursorOf: (row) => row.id,
      pageSize: 1000,
    });

    expect(result).toHaveLength(2500);
    expect(result[0].n).toBe(0);
    expect(result[2499].n).toBe(2499);
  });

  it("advances by cursor, never by offset", async () => {
    /*
     * The whole point. An offset pager asks for rows 1000-1999; this asks for
     * "after id 001000", which Postgres answers with an index range scan
     * instead of walking and discarding a thousand rows.
     */
    const table = fakeTable(rows(2500));
    await readAllByKeyset<Row>({ query: table.build, cursorOf: (row) => row.id, pageSize: 1000 });

    expect(table.calls[0].cursor).toBeUndefined();
    expect(table.calls[1].cursor).toBe("001000");
    expect(table.calls[2].cursor).toBe("002000");
  });

  it("stops on a short page rather than asking again", async () => {
    // 2,000 rows in pages of 1,000 is two full pages and one empty one. Three
    // calls, not four: the second page is full, so it cannot know it is done.
    const table = fakeTable(rows(2000));
    const result = await readAllByKeyset<Row>({
      query: table.build,
      cursorOf: (row) => row.id,
      pageSize: 1000,
    });
    expect(result).toHaveLength(2000);
    expect(table.calls).toHaveLength(3);
  });

  it("handles an empty table", async () => {
    const table = fakeTable([]);
    expect(
      await readAllByKeyset<Row>({ query: table.build, cursorOf: (row) => row.id }),
    ).toEqual([]);
  });

  it("honours a limit without over-reading", async () => {
    const table = fakeTable(rows(10_000));
    const result = await readAllByKeyset<Row>({
      query: table.build,
      cursorOf: (row) => row.id,
      pageSize: 1000,
      limit: 2500,
    });

    expect(result).toHaveLength(2500);
    // The last page asks for 500, not 1000 — a limit that over-reads spends
    // rows, and on a metered source it would spend credits.
    expect(table.calls[table.calls.length - 1].limit).toBe(500);
  });

  it("throws rather than returning a partial table", async () => {
    /*
     * The direction that matters. A caller that silently receives a tenth of
     * the rows looks exactly like one that received all of them — the same
     * failure the silent 1,000-row PostgREST cap already caused here once.
     */
    const query = () =>
      ({
        order: () => query(),
        limit: () => query(),
        gt: () => query(),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: "statement timeout" } }).then(resolve),
      }) as never;

    await expect(
      readAllByKeyset<Row>({ query, cursorOf: (row) => row.id }),
    ).rejects.toThrow(/statement timeout/);
  });

  it("reports progress as it goes", async () => {
    const table = fakeTable(rows(2500));
    const onPage = vi.fn();
    await readAllByKeyset<Row>({
      query: table.build,
      cursorOf: (row) => row.id,
      pageSize: 1000,
      onPage,
    });
    expect(onPage.mock.calls.map(([n]) => n)).toEqual([1000, 2000, 2500]);
  });
});
