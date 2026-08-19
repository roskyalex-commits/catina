/**
 * A small streaming CSV reader.
 *
 * Written rather than installed for the same reason `lib/export/csv.ts` writes
 * CSV by hand: the shape needed here is narrow, and the register is ~4M rows,
 * so the one property that actually matters is that nothing ever holds the
 * whole file. Everything below works a chunk at a time.
 *
 * The delimiter is sniffed rather than assumed. Romanian public data is
 * exported from Excel on a ro-RO locale more often than not, and that writes
 * `;` — reading it as `,` yields one enormous column and a mapping that looks
 * broken for a reason that has nothing to do with the mapping.
 */

/**
 * `^` leads because it is what ONRC actually publishes — an unusual choice, and
 * not one anybody would guess. It is also the safest of the five: a caret never
 * occurs in a company name or a Romanian address, so unlike `,` or `;` it needs
 * no quoting and can never be confused with content.
 */
const DELIMITER_CANDIDATES = ["^", ";", ",", "\t", "|"] as const;

/**
 * Used when a header contains none of the candidates — a single-column file.
 * Named rather than positional: this was `DELIMITER_CANDIDATES[1]`, so adding a
 * new candidate at the front silently changed the fallback.
 */
const DEFAULT_DELIMITER = ",";
const QUOTE = '"';

/**
 * Pick the delimiter from a header line.
 *
 * Counts occurrences outside quotes and takes the winner. Ties go to the
 * earlier candidate, which puts `;` first deliberately: a Romanian export
 * containing `Cluj-Napoca, jud. Cluj` in a quoted address field is the case
 * that misleads a naive comma count.
 */
export function sniffDelimiter(headerLine: string): string {
  let best: string = DELIMITER_CANDIDATES[0];
  let bestCount = -1;

  for (const candidate of DELIMITER_CANDIDATES) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < headerLine.length; i += 1) {
      const char = headerLine[i];
      if (char === QUOTE) {
        inQuotes = !inQuotes;
      } else if (char === candidate && !inQuotes) {
        count += 1;
      }
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : DEFAULT_DELIMITER;
}

/** Strips the UTF-8 BOM Excel writes, which would otherwise corrupt column 1. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split one CSV record into fields, honouring RFC 4180 quoting.
 *
 * A doubled quote inside a quoted field is a literal quote. Anything after a
 * closing quote but before the delimiter is appended rather than discarded —
 * malformed, but discarding it silently loses data from a row that a human
 * could still read.
 */
export function splitRow(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === QUOTE) {
        if (line[i + 1] === QUOTE) {
          field += QUOTE;
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === QUOTE && field.length === 0) {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

/**
 * Yields complete records from a stream of text chunks.
 *
 * Records are split on newlines *outside* quotes, because a quoted address can
 * legally contain one. Handles LF and CRLF, and a final line with no trailing
 * newline.
 */
export async function* readRecords(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  let inQuotes = false;
  let first = true;

  for await (const rawChunk of chunks) {
    let chunk = rawChunk;
    if (first) {
      chunk = stripBom(chunk);
      first = false;
    }
    buffer += chunk;

    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const char = buffer[i];
      if (char === QUOTE) {
        inQuotes = !inQuotes;
      } else if (char === "\n" && !inQuotes) {
        const end = buffer[i - 1] === "\r" ? i - 1 : i;
        yield buffer.slice(start, end);
        start = i + 1;
      }
    }
    // Keep only what has not been emitted, so memory stays flat.
    buffer = buffer.slice(start);
  }

  if (buffer.length > 0) yield buffer.replace(/\r$/, "");
}

/** Reads a whole CSV string into rows. Tests and `--dry-run` only. */
export function parseCsv(text: string): {
  delimiter: string;
  header: string[];
  rows: string[][];
} {
  const clean = stripBom(text);
  const lines: string[] = [];
  let start = 0;
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (char === QUOTE) inQuotes = !inQuotes;
    else if (char === "\n" && !inQuotes) {
      const end = clean[i - 1] === "\r" ? i - 1 : i;
      lines.push(clean.slice(start, end));
      start = i + 1;
    }
  }
  if (start < clean.length) lines.push(clean.slice(start).replace(/\r$/, ""));

  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return { delimiter: ",", header: [], rows: [] };

  const delimiter = sniffDelimiter(nonEmpty[0]);
  return {
    delimiter,
    header: splitRow(nonEmpty[0], delimiter),
    rows: nonEmpty.slice(1).map((line) => splitRow(line, delimiter)),
  };
}
