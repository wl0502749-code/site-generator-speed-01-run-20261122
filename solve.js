// A faster drop-in for makefun-site 1.0.0: run(input) returns, byte for byte, the output tree
// makefun-site 1.0.0's build returns for the same input. Written from the reference's README and
// code (baseline/makefun-site/vendor/makefun-site/ in the kit): same front matter, template
// dialect, Markdown subset, slug rule and report, same order of checks and reports. Speed comes
// from doing less work, not from different answers: plain-text runs are escaped once instead of
// a regex call per character, the lexer and renderer are one pass with no token objects, inline
// markup scans by index instead of slicing substrings, slugs and long dates are cached, and
// template loops reuse one scope frame per loop instead of allocating two objects per element.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped (the reference's table, in its order). */
export function escapeHtml(text) {
  let out = '';
  let start = 0;
  let m;
  ESC_RE.lastIndex = 0;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(start, m.index) + ESCAPES[m[0]];
    start = m.index + 1;
  }
  if (start === 0) return text;
  return out + text.slice(start);
}

const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;
const slugCache = new Map();

/**
 * The slug of `text` (README.md, "Text"): NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-"
 * left at the cut dropped), "untitled" when nothing is left. Pure ASCII text is its own NFKD
 * with no combining marks, so it skips the normalise step; the char loop reads code units, which
 * is the same answer because only ASCII letters and digits are ever kept.
 */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  let hit = dateCache.get(date);
  if (hit === undefined) {
    hit = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, hit);
  }
  return hit;
}

/** The words of a body: its runs of characters other than whitespace (the reference's /\S+/g, counted by hand). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || (c >= 9 && c <= 13);
    else ws = c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const TAG_BAD = /["[\]]/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a real day from 1970-01-01 to 2099-12-31, as YYYY-MM-DD. */
function dateOk(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  return !(y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo));
}

/** Whether `raw` is a template name (a-z, 0-9 and `-`, at least one character). */
function nameOk(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug (a-z and 0-9, single `-` between), at most 64 characters. */
function slugOk(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateOk(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || TAG_BAD.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return nameOk(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return slugOk(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether a line is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. Only the front matter's own lines are ever sliced out;
 * the body is one slice, never split and re-joined.
 */
export function parseFrontMatter(text) {
  if (!text.startsWith('---\n')) return { error: text === '---' ? 'the front matter is not closed' : 'no front matter' };
  let closeAt = -1;
  let j = 3;
  for (;;) {
    j = text.indexOf('\n---', j);
    if (j === -1) break;
    const p = j + 1;
    const after = p + 3;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeAt = p;
      break;
    }
    j = j + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = 4;
  let lineNo = 2;
  while (pos < closeAt) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 || eol >= closeAt ? closeAt - 1 : eol;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (line === '' || line.charCodeAt(0) === 35) {
      lineNo++;
      continue;
    }
    if (isBlank(line)) {
      lineNo++;
      continue;
    }
    // `key: value`: a key of a-z and `_`, a colon, one space and the value, its trailing spaces
    // and tabs dropped (the reference's /^([a-z_]+):(?: (.*))?$/", read by hand).
    let ki = 0;
    while (ki < line.length) {
      const c = line.charCodeAt(ki);
      if ((c >= 97 && c <= 122) || c === 95) ki++;
      else break;
    }
    if (ki === 0 || ki >= line.length || line.charCodeAt(ki) !== 58) return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, ki);
    let raw;
    if (ki + 1 === line.length) raw = '';
    else if (line.charCodeAt(ki + 1) === 32) raw = line.slice(ki + 2);
    else return { error: `line ${lineNo} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeAt + 3 === text.length ? '' : text.slice(closeAt + 4) };
}

// ---------------------------------------------------------------- markdown

/** A line of spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A fence's language, or null: a line of three backticks and an optional language, then spaces or tabs only. */
function fenceOpen(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

/** Whether a line closes a fence: three backticks, spaces or tabs after them. */
function fenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let s = n + 1;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: n, text: line.slice(s, e) };
}

/** Whether a line is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** A bullet item's text after `- ` or `* `, or null. */
function bulletOf(line) {
  if (line.length < 2) return null;
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's [number, text] after `digits. ` (1 to 9 digits), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i + 1 >= line.length) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return [line.slice(0, i), line.slice(i + 2)];
}

const WS1 = /\s/;

/** Whether a line continues a list item: two or more spaces, then a non-space character. */
function continuedOf(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !WS1.test(line[i]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9 && c !== 96 && c !== 35 && c !== 45 && c !== 42) return false;
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes, by code unit (\\ ` * _ [ ] ( ) # + - . ! >). */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** The first index from `from` (below `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (below `end`, one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[start..end]` rendered inline into `out`; `env.link(target)` is a link's href. One regex
 * jumps straight to the next character that matters (`\`, backtick, `*`, `[`, and the five HTML
 * escapables) instead of a scan a character at a time; a plain run between two such characters
 * holds nothing escapable, so it is pushed as it stands, never through escapeHtml; nested strong,
 * emphasis and link text recurse by index, never by slicing the string. A special that turns out
 * to be literal stays in the plain run (`plain` only moves past a real construct).
 */
const SPECIAL = /[\\`*[&<>"']/g;
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function inline(s, start, end, env, out) {
  let plain = start;
  let scan = start;
  for (;;) {
    SPECIAL.lastIndex = scan;
    const m = SPECIAL.exec(s);
    const j = m === null || m.index >= end ? -1 : m.index;
    if (j === -1) {
      if (plain < end) out.push(s.slice(plain, end));
      return;
    }
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (plain < j) out.push(s.slice(plain, j));
      out.push(ENTITIES[s[j]]);
      plain = scan = j + 1;
      continue;
    }
    if (c === 92) {
      if (j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)]) {
        if (plain < j) out.push(s.slice(plain, j));
        out.push(s[j + 1]);
        plain = scan = j + 2;
      } else scan = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        if (plain < j) out.push(s.slice(plain, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        plain = scan = k + 1;
      } else scan = j + 1;
      continue;
    }
    if (c === 42) {
      if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, end);
        if (k !== -1 && k > j + 2) {
          if (plain < j) out.push(s.slice(plain, j));
          out.push('<strong>');
          inline(s, j + 2, k, env, out);
          out.push('</strong>');
          plain = scan = k + 2;
        } else scan = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, end);
      if (k !== -1 && k > j + 1) {
        if (plain < j) out.push(s.slice(plain, j));
        out.push('<em>');
        inline(s, j + 1, k, env, out);
        out.push('</em>');
        plain = scan = k + 1;
      } else scan = j + 1;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, end);
    if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
      let m2 = s.indexOf(')', k + 2);
      if (m2 === -1 || m2 >= end) m2 = -1;
      if (m2 !== -1) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !WS1.test(target)) {
          if (plain < j) out.push(s.slice(plain, j));
          out.push('<a href="', escapeHtml(env.link(target)), '">');
          inline(s, j + 1, k, env, out);
          out.push('</a>');
          plain = scan = m2 + 1;
          continue;
        }
      }
    }
    scan = j + 1;
  }
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or ""). Lexing and rendering are one pass: no token objects.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9 || line.length === 0) {
      // Blank, or a paragraph: no block marker opens on a space, a tab, or nothing.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
        i++;
        while (i < n && !fenceClose(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        if (h.depth === 2 || h.depth === 3) {
          const inner = [];
          inline(h.text, 0, h.text.length, env, inner);
          const html = inner.join('');
          out.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>\n`);
          toc.push({ level: h.depth, id, html });
        } else {
          out.push(`<h${h.depth} id="${id}">`);
          inline(h.text, 0, h.text.length, env, out);
          out.push(`</h${h.depth}>\n`);
        }
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        out.push('<ul>\n');
        while (i < n) {
          const item = bulletOf(lines[i]);
          if (item === null) break;
          const parts = [trimLine(item)];
          i++;
          while (i < n && continuedOf(lines[i])) {
            parts.push(trimLine(lines[i]));
            i++;
          }
          const text = parts.join('\n');
          out.push('<li>');
          inline(text, 0, text.length, env, out);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') parts.push(t);
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = parts.join('\n');
        out.push('<blockquote>\n<p>');
        inline(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const start = Number(o[0]);
        out.push(start !== 1 ? `<ol start="${start}">\n` : '<ol>\n');
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m === null) break;
          const parts = [trimLine(m[1])];
          i++;
          while (i < n && continuedOf(lines[i])) {
            parts.push(trimLine(lines[i]));
            i++;
          }
          const text = parts.join('\n');
          out.push('<li>');
          inline(text, 0, text.length, env, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const text = parts.join('\n');
    if (excerpt === null) {
      const inner = [];
      inline(text, 0, text.length, env, inner);
      excerpt = inner.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inline(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const hasOwn = Object.hasOwn;

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** Whether `text` is a path: names joined by dots (a-z, A-Z, 0-9 and `_`, from a letter or `_`). */
function isPath(text) {
  if (text.length === 0 || !isNameStart(text.charCodeAt(0))) return false;
  let i = 1;
  for (;;) {
    while (i < text.length && isNameChar(text.charCodeAt(i))) i++;
    if (i === text.length) return true;
    if (text.charCodeAt(i) !== 46) return false;
    i++;
    if (i >= text.length || !isNameStart(text.charCodeAt(i))) return false;
    i++;
  }
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!isPath(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text strings, ['v'|'r', path] and ['g', tag]; a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push(text);
      text = '';
      tokens.push([raw ? 'r' : 'v', pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push(text);
    text = '';
    tokens.push(['g', src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push(text);
  return tokens;
}

/** A `for x in path` tag's [name, path text], or null (the reference's /^for ([A-Za-z_][A-Za-z0-9_]*) in (\\S+)$/"). */
function forOf(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  const ns = i;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const varName = tag.slice(ns, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const rest = tag.slice(i + 4);
  if (rest === '' || WS1.test(rest)) return null;
  return [varName, rest];
}

/** An `if [not] path` tag's [not, path text], or null (the reference's "/^if (not )?(\\S+)$/"). */
function ifOf(tag) {
  if (!tag.startsWith('if ')) return null;
  let i = 3;
  let not = false;
  if (tag.startsWith('not ', i)) {
    not = true;
    i += 4;
  }
  const rest = tag.slice(i);
  if (rest === '' || WS1.test(rest)) return null;
  return [not, rest];
}

/** An `include "name"` tag's name, or null (the reference's "/^include \"([a-z0-9-]+)\"$/"). */
function includeOf(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"')) return null;
  const nm = tag.slice(9, -1);
  if (nm === '') return null;
  for (let i = 0; i < nm.length; i++) {
    const c = nm.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return nm;
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not parse). Nodes are text
 * strings, or arrays: ['v'|'r', path], ['i', not, path, then, else], ['f', name, path, body],
 * ['c', name].
 */
export function parseTemplate(name, src) {
  const root = [];
  const stack = [null];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (typeof tok === 'string') {
      body.push(tok);
      continue;
    }
    if (tok[0] === 'v' || tok[0] === 'r') {
      body.push(tok);
      continue;
    }
    const tag = tok[1];
    const top = stack[stack.length - 1];
    let m;
    if ((m = forOf(tag)) !== null) {
      const node = ['f', m[0], pathOf(name, m[1]), []];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if ((m = ifOf(tag)) !== null) {
      const node = ['i', m[0], pathOf(name, m[1]), [], null];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if (tag === 'else') {
      if (top === null || top[0] !== 'i' || top[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top[4] = [];
      body = top[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top === null || top[0] !== (tag === 'endfor' ? 'f' : 'i')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent === null ? root : parent[0] === 'f' ? parent[3] : (parent[4] ?? parent[3]);
    } else if ((m = includeOf(tag)) !== null) body.push(['c', m]);
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1][0] === 'f' ? 'for' : 'if'} is not closed`);
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`, in `scope` ({ vars, parent }). `templates` is the parsed templates
 * (a Map of name to nodes, a template that did not parse absent). A loop reuses one scope frame
 * and one loop object for all its elements: rendering is synchronous and depth-first, and a
 * re-entered loop (through an include) gets a fresh frame of its own, so no iteration ever sees
 * another's bindings.
 */
export function renderNodes(nodes, scope, templates, out, depth) {
  for (const n of nodes) {
    if (typeof n === 'string') {
      out.push(n);
      continue;
    }
    const k = n[0];
    if (k === 'v') out.push(escapeHtml(textOf(lookup(scope, n[1]))));
    else if (k === 'r') out.push(textOf(lookup(scope, n[1])));
    else if (k === 'i') {
      const v = truthy(lookup(scope, n[2]));
      const branch = v !== n[1] ? n[3] : n[4];
      if (branch !== null) renderNodes(branch, scope, templates, out, depth);
    } else if (k === 'f') {
      const xs = lookup(scope, n[2]);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      const loop = { index: 1, first: true, last: len === 1, length: len };
      const vars = Object.create(null);
      vars.loop = loop;
      const child = { vars, parent: scope };
      for (let i = 0; i < len; i++) {
        vars[n[1]] = xs[i];
        vars.loop = loop;
        loop.index = i + 1;
        loop.first = i === 0;
        loop.last = i === len - 1;
        renderNodes(n[3], child, templates, out, depth);
      }
    } else {
      const t = templates.get(n[1]);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, out, depth + 1);
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory segments `parts`, or null when it climbs out of the root. */
function resolvePath(parts, rel) {
  const out = parts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` opens on a scheme (`https:`, `mailto:` ...): a letter, then letters, digits, `+`, `-`, `.`, then `:`. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A source's tags, each slug once, in its own order (the first spelling kept). */
function ownTags(s) {
  const names = s.data.tags;
  if (names === undefined) return [];
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(name);
  }
  return out;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A source's reading time in minutes: its body's words over 200, rounded up, at least 1. */
function readingOf(s) {
  if (s.reading === undefined) s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  return s.reading;
}

/** A source's tags as templates read them (each `name`, `slug`, `url`). */
function tagCardsOf(s) {
  if (s.tagCards === undefined) s.tagCards = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
  return s.tagCards;
}

/** A post's card, as lists show it. `reading_minutes` is lazy: a page layout that never reads it never pays for the word count. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    get reading_minutes() {
      return readingOf(s);
    },
    tags: tagCardsOf(s),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    get reading_minutes() {
      return readingOf(s);
    },
    tags: tagCardsOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  if (base.endsWith('/')) base = base.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One root scope per kind of page, its slots filled in before each render: renders run one at
  // a time and templates only read, so no render ever sees another's values.
  const pageVars = { site, tags: allTags, recent, page: null };
  const pageScope = { vars: pageVars, parent: null };
  const indexVars = { site, tags: allTags, recent, posts: null, pager: null };
  const indexScope = { vars: indexVars, parent: null };
  const tagVars = { site, tags: allTags, recent, tag: null };
  const tagScope = { vars: tagVars, parent: null };
  const tagsScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, scope) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, templates, out, 0);
    return out.join('');
  };
  for (const s of kept) {
    pageVars.page = pageOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, pageScope);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexVars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    indexVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', indexScope);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    tagVars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', tagScope);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', tagsScope);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  return build(input);
}
