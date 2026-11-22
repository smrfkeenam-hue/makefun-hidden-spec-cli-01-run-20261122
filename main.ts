// mend: one patch tool for every AI edit format.
//
// Applies an edit a model wrote — a unified diff, SEARCH/REPLACE blocks, a
// V4A patch, or JSON edit objects — to the tree of text files rooted at the
// working directory. Every file is changed or nothing is, and the program
// prints what it changed or why it failed. SPEC.md is the whole contract.
//
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** A file's text viewed as lines: its line break, its lines, whether it ends with a break. */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

/** The text of lines joined by br, with a final break exactly when final. A file of no lines is written empty. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

/** A move that succeeded, for the R lines of the exit-0 output. */
interface Move {
  old: string;
  new: string;
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Whether two lines are equal at a matching tier (0 exact, 1 trailing ws, 2 both sides). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

/** Every 0-based position at or after `from` where O matches the file's lines at a tier. */
function occurrences(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length - from) return out;
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence at or after `from`, and those occurrences; null when there is none. */
function findTier(file: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let pos = occurrences(file, o, tier, from);
    if (eofOnly) pos = pos.filter((i) => i + o.length === file.length);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(file: string[], anchor: string, strict: boolean, from: number): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < file.length; i++) {
      if (lineEq(file[i], anchor, tier)) return { tier, at: i };
    }
  }
  return null;
}

/** One new line: its text, and the index in O it copies from the file when it is a context line (-1: a new line). */
interface NewLine {
  text: string;
  ctx: number;
}

/**
 * Replace the k matched lines at `at` by N. A context line is written as the
 * file's own matched line; at tier 2 every other line is re-indented from O's
 * first line's leading whitespace to the file's first matched line's.
 */
function applyMatch(file: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = at < file.length ? leadWs(file[at]) : '';
  const p = o.length > 0 ? leadWs(o[0]) : '';
  const rep = n.map((item) => {
    if (item.ctx >= 0) return file[at + item.ctx];
    const t = item.text;
    if (tier !== 2) return t;
    if (t === '' || t.trim() === '' || !t.startsWith(p)) return t;
    return f + t.slice(p.length);
  });
  return [...file.slice(0, at), ...rep, ...file.slice(at + o.length)];
}

/** Detect the patch format from its lines, or null when none is detected. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const crlf = before.indexOf('\n') > 0 && before[before.indexOf('\n') - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const { br, lines, final } = splitFile(before);
      if (lineNo < 0 || lineNo > lines.length) throw new Fail('no-match', p);
      lines.splice(lineNo, 0, ...add);
      tree.set(p, joinFile(lines, br, final));
    };
  }
  return null;
}

/** The edits of a JSON patch: one array, or one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a --- / +++ line names: up to the first tab, surrounding spaces removed, /dev/null means no file, a leading a/ or b/ removed. */
function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0].trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) return rest.slice(2);
  return rest;
}

function hunkStart(line: string, i: number): number {
  const m = HUNK_RE.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1], 10);
}

/** A hunk's body: lines starting with space, -, + or \, or empty; it ends at the first other line, a diff --git line, or a --- line followed by +++. Trailing empty context lines are not part of it. */
function hunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      i++;
      continue;
    }
    const c = l[0];
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c as BodyLine['kind'], text: c === '\\' ? l : l.slice(1) });
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === ' ' && last.text === '') body.pop();
    else break;
  }
  return { body, next: i };
}

/** Split a hunk body into its old lines O and its new lines N (context lines keep their index in O). */
function hunkSides(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a \ line immediately follows the hunk's last context or + line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].kind === ' ' || body[i].kind === '+') {
      return i + 1 < body.length && body[i + 1].kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file's lines, tracking the final line break. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const { br, lines: startLines, final: startFinal } = splitFile(text);
  let lines = startLines;
  let final = startFinal;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkSides(h.body);
    const noBackslash = !backslashAfterLast(h.body);
    if (o.length > 0) {
      const found = findTier(lines, o, strict, 0, false);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let at = found.pos[0];
      let best = Math.abs(at - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      if (at + o.length === lines.length) final = noBackslash;
      lines = applyMatch(lines, at, o, n, found.tier);
    } else {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      if (at === lines.length) final = noBackslash;
      lines = [...lines.slice(0, at), ...n.map((x) => x.text), ...lines.slice(at)];
    }
    d += n.length - o.length;
  }
  return joinFile(lines, br, final);
}

function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const open = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, create: false, remove: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      open(m[1], m[2]);
      i++;
      continue;
    }
    if (cur !== null && !inHeader && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      open(headerPath(line), headerPath(lines[i + 1]));
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        open(headerPath(line), headerPath(lines[i + 1]));
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.newPath = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const a = hunkStart(line, i);
        inHeader = false;
        i++;
        const b = hunkBody(lines, i);
        cur.hunks.push({ a, body: b.body });
        i = b.next;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = hunkStart(line, i);
      i++;
      const b = hunkBody(lines, i);
      cur.hunks.push({ a, body: b.body });
      i = b.next;
      continue;
    }
    i++;
  }
  return sections.map((s) => (tree) => {
    const isCreate = s.oldPath === null || s.create;
    const isDelete = s.newPath === null || s.remove;
    if (isCreate) {
      const p = s.newPath ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let finalBr = true;
      for (const h of s.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j];
          if (b.kind === '+') {
            plus.push(b.text);
            finalBr = !(j + 1 < h.body.length && h.body[j + 1].kind === '\\');
          }
        }
      }
      tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = s.oldPath ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const oldP = s.oldPath ?? '';
    const newP = s.newPath ?? '';
    if (oldP === newP) {
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      tree.set(oldP, applyHunks(before, s.hunks, strict, oldP));
      return;
    }
    if (!safePath(oldP)) throw new Fail('unsafe', oldP);
    if (!safePath(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const out = applyHunks(before, s.hunks, strict, oldP);
    tree.set(newP, out);
    tree.set(oldP, null);
    moves.push({ old: oldP, new: newP });
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  searchLine: number;
  old: string[];
  replacement: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    let j = searchIdx + 1;
    for (; j < n; j++) {
      const t = lines[j].trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (j = sep + 1; j < n; j++) {
      const t = lines[j].trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, searchLine: searchIdx + 1, old: lines.slice(searchIdx + 1, sep), replacement: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => (tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.replacement.length === 0 ? '' : b.replacement.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const { br, lines: file, final } = splitFile(before);
    const found = findTier(file, b.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.pos[0];
    const nlines: NewLine[] = b.replacement.map((text) => ({ text, ctx: -1 }));
    const out = applyMatch(file, at, b.old, nlines, found.tier);
    tree.set(b.path, joinFile(out, br, final));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4Section {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: { text: string; no: number }[];
  chunks: V4Chunk[];
  updateNo: number;
}

const V4_ADD = '*** Add File: ';
const V4_DELETE = '*** Delete File: ';
const V4_UPDATE = '*** Update File: ';
const V4_MOVE = '*** Move to: ';

function v4SectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const [prefix, kind] of [
    [V4_ADD, 'add'],
    [V4_DELETE, 'delete'],
    [V4_UPDATE, 'update'],
  ] as const) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

function parseV4A(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4Section[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) {
      i++;
      continue;
    }
    const start = v4SectionStart(lines[i]);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    const section: V4Section = { kind: start.kind, path: start.path, moveTo: null, lines: [], chunks: [], updateNo: i + 1 };
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < last && v4SectionStart(lines[i]) === null) {
      raw.push({ text: lines[i], no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1].text)) raw.pop();
    section.lines = raw;
    if (section.kind === 'add') {
      for (const l of raw) {
        if (l.text !== '' && !l.text.startsWith('+')) throw new Exit2(`error: parse ${l.no}`);
      }
    } else if (section.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0].no}`);
    } else {
      let j = 0;
      if (j < raw.length && raw[j].text.startsWith(V4_MOVE)) {
        section.moveTo = raw[j].text.slice(V4_MOVE.length).trim();
        j++;
      }
      let cur: V4Chunk | null = null;
      for (; j < raw.length; j++) {
        const l = raw[j];
        if (l.text.startsWith('@@')) {
          if (cur !== null) section.chunks.push(cur);
          cur = { anchor: l.text.slice(2).trim() === '' ? null : l.text.slice(2).trim(), body: [], eof: false };
          continue;
        }
        const c = l.text === '' ? ' ' : l.text[0];
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push({ kind: c as BodyLine['kind'], text: l.text === '' ? '' : l.text.slice(1) });
          continue;
        }
        if (l.text.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${l.no}`);
          cur.eof = true;
          section.chunks.push(cur);
          cur = null;
          continue;
        }
        throw new Exit2(`error: parse ${l.no}`);
      }
      if (cur !== null) section.chunks.push(cur);
      if (section.chunks.length === 0 && section.moveTo === null) throw new Exit2(`error: parse ${section.updateNo}`);
    }
    sections.push(section);
  }
  return sections.map((s) => (tree) => {
    if (s.kind === 'add') {
      if (!safePath(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const ls = s.lines.map((l) => (l.text === '' ? '' : l.text.slice(1)));
      tree.set(s.path, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safePath(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
      return;
    }
    if (!safePath(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safePath(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const { br, lines: startLines, final } = splitFile(before);
    let lines = startLines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const a = findAnchor(lines, chunk.anchor, strict, cursor);
        if (a === null) throw new Fail('no-match', s.path);
        cursor = a.at + 1;
      }
      const { o, n } = hunkSides(chunk.body);
      if (o.length > 0) {
        const found = findTier(lines, o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const at = found.pos[0];
        lines = applyMatch(lines, at, o, n, found.tier);
        cursor = at + n.length;
      } else {
        const at = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...n.map((x) => x.text), ...lines.slice(at)];
        cursor = at + n.length;
      }
    }
    const out = joinFile(lines, br, final);
    if (s.moveTo !== null) {
      tree.set(s.moveTo, out);
      tree.set(s.path, null);
      moves.push({ old: s.path, new: s.moveTo });
    } else {
      tree.set(s.path, out);
    }
  });
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const r of rows) {
      if (r.line.startsWith('R ')) {
        const [oldP, newP] = r.line.slice(2).split(' -> ');
        rmSync(oldP, { force: true });
        mkdirSync(dirname(newP), { recursive: true });
        writeFileSync(newP, tree.get(newP)!);
      } else if (r.line.startsWith('D ')) {
        rmSync(r.line.slice(2), { force: true });
      } else {
        const p = r.line.slice(2);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, tree.get(p)!);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
