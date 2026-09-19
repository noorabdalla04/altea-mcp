// React Flight ("RSC payload") parser for myaltea.app.
//
// The app is a Next.js App Router site. Every page fetch with the `RSC: 1`
// header returns a text/x-component stream made of rows:
//   <id>:<json>\n                      ordinary row (JSON value, or I/HL/X hints)
//   <id>:T<hexByteLength>,<raw utf-8>   text row; NO newline terminator, the
//                                       byte length tells you where it ends.
// Text rows are why naive `split('\n')` parsing breaks: the waiver HTML row is
// followed immediately by the next JSON row on the same "line".
//
// References inside JSON: "$@42" = promise resolved by row 42, "$L2" = lazy
// component, "$undefined" = undefined, "$2f:props:..." = path into row 2f.

export function parseRSC(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const rows = {};
  const n = buf.length;
  let i = 0;
  const readUntil = (code) => {
    const s = i;
    while (i < n && buf[i] !== code) i++;
    const out = buf.subarray(s, i).toString('utf8');
    i++; // skip delimiter
    return out;
  };
  while (i < n) {
    const id = readUntil(0x3a /* : */);
    if (i >= n) break;
    if (buf[i] === 0x54 /* T */) {
      i++;
      const len = parseInt(readUntil(0x2c /* , */), 16);
      rows[id] = { type: 'T', text: buf.subarray(i, i + len).toString('utf8') };
      i += len;
      if (buf[i] === 0x0a) i++;
    } else {
      const line = readUntil(0x0a /* \n */);
      const row = { type: 'J', raw: line };
      try { row.json = JSON.parse(line); } catch { /* I[...], HL[...], X, C … */ }
      rows[id] = row;
    }
  }
  return rows;
}

/** Resolve a "$@N" reference to row N's json (one hop). */
export function deref(rows, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('$@')) return ref;
  const row = rows[ref.slice(2)];
  return row ? row.json : undefined;
}

/** First row whose parsed JSON satisfies `pred`. Returns [id, json] or null. */
export function findRow(rows, pred) {
  for (const [id, row] of Object.entries(rows)) {
    if (row.json !== undefined) {
      try { if (pred(row.json, id)) return [id, row.json]; } catch { /* ignore */ }
    }
  }
  return null;
}

/** All rows whose JSON satisfies `pred`. */
export function findRows(rows, pred) {
  const out = [];
  for (const [id, row] of Object.entries(rows)) {
    if (row.json !== undefined) {
      try { if (pred(row.json, id)) out.push([id, row.json]); } catch { /* ignore */ }
    }
  }
  return out;
}

const isEvent = (x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id.startsWith('evt_') && 'startDate' in x;

/** The schedule page's events array (row referenced by `eventsPromise`). */
export function eventsFromRows(rows) {
  const hit = findRow(rows, (j) => Array.isArray(j) && (j.length === 0 ? false : isEvent(j[0])));
  if (hit) return hit[1];
  // Empty day: the eventsPromise resolves to []. Find it via the tree prop.
  const tree = findRow(rows, (j) => Array.isArray(j) && JSON.stringify(j).includes('"eventsPromise"'));
  if (tree) {
    const m = JSON.stringify(tree[1]).match(/"eventsPromise":"\$@([0-9a-f]+)"/);
    if (m && rows[m[1]] && Array.isArray(rows[m[1]].json)) return rows[m[1]].json;
  }
  return [];
}

/** Rows that are plain objects and contain all of `keys`. */
export function objectRowWithKeys(rows, keys) {
  return findRow(rows, (j) => j && typeof j === 'object' && !Array.isArray(j) && keys.every((k) => k in j));
}

/**
 * Parse a Next.js server-action response. Row 0 is
 *   {"a":"$@1","f":"","q":"","i":false,"b":"<buildId>"}
 * where `a` points at the action's return value row. When the action calls
 * revalidatePath(), the response also carries the re-rendered tree and the
 * header `x-action-revalidated: 1`.
 */
export function parseActionResponse(text) {
  const rows = parseRSC(text);
  const head = rows['0']?.json;
  let result;
  if (head && typeof head === 'object' && 'a' in head) result = deref(rows, head.a);
  const serverError = result && typeof result === 'object' ? (result.serverError ?? result.error ?? null) : null;
  return { rows, head, result, buildId: head?.b ?? null, serverError };
}

/** Depth-first search through parsed JSON for the first value satisfying `pred` (arrays included). */
export function deepFind(value, pred, depth = 0) {
  if (depth > 80 || value === null || typeof value !== 'object') return undefined;
  try { if (pred(value)) return value; } catch { /* ignore */ }
  if (Array.isArray(value)) { for (const v of value) { const r = deepFind(v, pred, depth + 1); if (r !== undefined) return r; } }
  else { for (const k of Object.keys(value)) { const r = deepFind(value[k], pred, depth + 1); if (r !== undefined) return r; } }
  return undefined;
}

/** deepFind across every parsed row. */
export function deepFindInRows(rows, pred) {
  for (const row of Object.values(rows)) {
    if (row.json !== undefined) { const r = deepFind(row.json, pred); if (r !== undefined) return r; }
  }
  return undefined;
}
