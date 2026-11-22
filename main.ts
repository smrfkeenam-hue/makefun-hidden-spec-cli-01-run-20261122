// mend: one patch tool for every AI edit format.
//
// Reads a patch (unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits),
// finds the lines each edit names at the first of three matching tiers
// (exact, trailing-whitespace-tolerant, both-sides-whitespace-tolerant),
// and writes every change or none. See SPEC.md for the whole contract.
//
// Node 22, standard library only. Run as:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: exactly one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
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
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One file as lines: its line break, its lines, whether it ends with a line break. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** Whether a file's line break is CRLF (its first line feed follows a carriage return). */
function isCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** The tree as the edits leave it: paths changed in `cur` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();
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
    return this.cur.has(p) ? this.cur.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.cur.set(p, v);
  }
  snapshot(): Map<string, string | null> {
    return new Map(this.cur);
  }
  restore(s: Map<string, string | null>): void {
    this.cur = new Map(s);
  }
  changedPaths(): string[] {
    return [...this.cur.keys()];
  }
}

/** One edit: applies itself to the tree, returning a move pair [old, new] when it moved a file. */
type EditFn = (tree: Tree) => [string, string] | null;

/** Whether two lines are equal at a matching tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null. */
function firstTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function firstTierSingle(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/**
 * The lines N becomes when it replaces O matched at `at`: a context line is
 * written as the file's own matched line; at tier 2 every other line is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function buildNew(
  o: string[],
  oCtx: boolean[],
  n: string[],
  nCtx: boolean[],
  fileLines: string[],
  at: number,
  tier: number,
): string[] {
  const oCtxPos: number[] = [];
  for (let j = 0; j < o.length; j += 1) if (oCtx[j]) oCtxPos.push(j);
  const p = leadWs(o.length > 0 ? o[0]! : '');
  const f = leadWs(fileLines[at] ?? '');
  let ctxSeen = 0;
  const out: string[] = [];
  for (let j = 0; j < n.length; j += 1) {
    if (nCtx[j]) {
      out.push(fileLines[at + oCtxPos[ctxSeen]!]!);
      ctxSeen += 1;
    } else {
      const line = n[j]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    }
  }
  return out;
}

/** Detect the patch format from its lines, or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface UBodyLine {
  k: ' ' | '-' | '+' | '\\';
  t: string;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
}
interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  create: boolean;
  remove: boolean;
  hunks: UHunk[];
}

/** The path a `--- ` / `+++ ` line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function noNlAfterLast(h: UHunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j += 1) {
    const b = h.body[j]!;
    if (b.k === ' ' || b.k === '+') last = j;
  }
  if (last < 0) return false;
  const after = h.body[last + 1];
  return after !== undefined && after.k === '\\';
}

/** Apply a section's hunks in order to a file's lines. */
function applyUnifiedHunks(doc: Doc, hunks: UHunk[], strict: boolean, path: string): Doc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const oCtx: boolean[] = [];
    const n: string[] = [];
    const nCtx: boolean[] = [];
    for (const b of h.body) {
      if (b.k === ' ') {
        o.push(b.t);
        oCtx.push(true);
        n.push(b.t);
        nCtx.push(true);
      } else if (b.k === '-') {
        o.push(b.t);
        oCtx.push(false);
      } else if (b.k === '+') {
        n.push(b.t);
        nCtx.push(false);
      }
    }
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      let newFinal = cur.final;
      if (at === cur.lines.length) newFinal = !noNlAfterLast(h);
      cur = { br: cur.br, lines: [...cur.lines.slice(0, at), ...n, ...cur.lines.slice(at)], final: newFinal };
      d += n.length;
    } else {
      const found = firstTier(cur.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const newLines = buildNew(o, oCtx, n, nCtx, cur.lines, best, found.tier);
      let newFinal = cur.final;
      if (best + o.length === cur.lines.length) newFinal = !noNlAfterLast(h);
      cur = { br: cur.br, lines: [...cur.lines.slice(0, best), ...newLines, ...cur.lines.slice(best + o.length)], final: newFinal };
      d += n.length - o.length;
    }
  }
  return cur;
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: USection[] = [];
  let cur: USection | null = null;
  let header = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git') && (line.length === 10 || line[10] === ' ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        pairOld: undefined,
        pairNew: undefined,
        renameOld: null,
        renameNew: null,
        gitOld: m[1]!,
        gitNew: m[2]!,
        hasPair: false,
        create: false,
        remove: false,
        hunks: [],
      };
      sections.push(cur);
      header = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur === null || !header || cur.hasPair) {
        cur = {
          pairOld: oldP,
          pairNew: newP,
          renameOld: null,
          renameNew: null,
          gitOld: null,
          gitNew: null,
          hasPair: true,
          create: false,
          remove: false,
          hunks: [],
        };
        sections.push(cur);
        header = true;
      } else {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && header) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      const body: UBodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ k: ' ', t: '' });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ k: c, t: bl.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const lastB = body[body.length - 1]!;
        if (lastB.k === ' ' && lastB.t === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && header) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: EditFn[] = [];
  for (const s of sections) {
    const oldP = s.pairOld !== undefined ? s.pairOld : (s.renameOld ?? s.gitOld);
    const newP = s.pairNew !== undefined ? s.pairNew : (s.renameNew ?? s.gitNew);
    if (oldP === null || s.create) {
      const target = newP;
      if (target === null || target === undefined) {
        edits.push(() => null);
        continue;
      }
      const plus: string[] = [];
      let lastPlus: { h: UHunk; j: number } | null = null;
      for (const h of s.hunks) {
        h.body.forEach((b, j) => {
          if (b.k === '+') {
            plus.push(b.t);
            lastPlus = { h, j };
          }
        });
      }
      let finalBreak = true;
      if (lastPlus !== null) {
        const after = lastPlus.h.body[lastPlus.j + 1];
        if (after !== undefined && after.k === '\\') finalBreak = false;
      }
      const text = writeDoc({ br: '\n', lines: plus, final: plus.length > 0 && finalBreak });
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.set(target, text);
        return null;
      });
    } else if (newP === null || s.remove) {
      const target = oldP;
      if (target === null || target === undefined) {
        edits.push(() => null);
        continue;
      }
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.set(target, null);
        return null;
      });
    } else if (oldP !== newP) {
      const from = oldP!;
      const to = newP!;
      edits.push((tree) => {
        if (!safe(from)) throw new Fail('unsafe', from);
        if (!safe(to)) throw new Fail('unsafe', to);
        const curText = tree.get(from);
        if (curText === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const doc = applyUnifiedHunks(readDoc(curText), s.hunks, strict, from);
        tree.set(from, null);
        tree.set(to, writeDoc(doc));
        return [from, to];
      });
    } else {
      const target = oldP!;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        const curText = tree.get(target);
        if (curText === null) throw new Fail('missing', target);
        const doc = applyUnifiedHunks(readDoc(curText), s.hunks, strict, target);
        tree.set(target, writeDoc(doc));
        return null;
      });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, writeDoc({ br: '\n', lines: [...newLines], final: newLines.length > 0 }));
      return null;
    }
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    const doc = readDoc(curText);
    const found = firstTier(doc.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const replaced = buildNew(
      oldLines,
      oldLines.map(() => false),
      newLines,
      newLines.map(() => false),
      doc.lines,
      at,
      found.tier,
    );
    tree.set(path, writeDoc({ ...doc, lines: [...doc.lines.slice(0, at), ...replaced, ...doc.lines.slice(at + oldLines.length)] }));
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VBodyLine {
  k: ' ' | '-' | '+';
  t: string;
}
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: VBodyLine[];
}

function makeAddEdit(path: string, fileLines: string[]): EditFn {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, writeDoc({ br: '\n', lines: [...fileLines], final: fileLines.length > 0 }));
    return null;
  };
}

function makeDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
    return null;
  };
}

function makeUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): EditFn {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = readDoc(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = firstTierSingle(doc.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const oCtx: boolean[] = [];
      const n: string[] = [];
      const nCtx: boolean[] = [];
      for (const b of ch.body) {
        if (b.k === ' ') {
          o.push(b.t);
          oCtx.push(true);
          n.push(b.t);
          nCtx.push(true);
        } else if (b.k === '-') {
          o.push(b.t);
          oCtx.push(false);
        } else if (b.k === '+') {
          n.push(b.t);
          nCtx.push(false);
        }
      }
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        doc = { ...doc, lines: [...doc.lines.slice(0, at), ...n, ...doc.lines.slice(at)] };
        cursor = at + n.length;
      } else {
        const found = firstTier(doc.lines, o, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let at: number | null = null;
        for (const pos of found.occ) {
          if (ch.eof) {
            if (pos + o.length === doc.lines.length) {
              at = pos;
              break;
            }
          } else {
            at = pos;
            break;
          }
        }
        if (at === null) throw new Fail('no-match', path);
        const newLines = buildNew(o, oCtx, n, nCtx, doc.lines, at, found.tier);
        doc = { ...doc, lines: [...doc.lines.slice(0, at), ...newLines, ...doc.lines.slice(at + o.length)] };
        cursor = at + newLines.length;
      }
    }
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, writeDoc(doc));
      return [path, moveTo];
    }
    tree.set(path, writeDoc(doc));
    return null;
  };
}

function parseV4A(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSection = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      i += 1;
      while (i < last && !isSection(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        const l = lines[i]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(makeAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isSection(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        if (blank(lines[i]!)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(makeDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (i < last && !isSection(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          const aText = l.slice(2).trim();
          cur = { anchor: aText === '' ? null : aText, eof: false, body: [] };
          chunks.push(cur);
          i += 1;
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i += 1;
        } else if (blank(l) && cur === null && chunks.length > 0) {
          // A blank line after a chunk has closed is not part of any chunk:
          // at the end of the section it is not part of it (SPEC.md section 8),
          // and between chunks it is only formatting, so it is skipped.
          i += 1;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ k: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), t: l === '' ? '' : l.slice(1) });
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0) {
          const b = lc.body[lc.body.length - 1]!;
          if (b.k === ' ' && b.t === '') lc.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                     */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
      return null;
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const crlf = isCrlf(before);
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = readDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(lineNo, 0, ...add);
      tree.set(p, writeDoc({ ...doc, lines }));
      return null;
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
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
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                     */
/* ------------------------------------------------------------------ */

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
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const movesBefore = moves.length;
    try {
      const mv = edit(tree);
      if (mv !== null) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(snap);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const goodMoves = moves.filter(
    ([o, n]) => tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null,
  );
  const movedOld = new Set(goodMoves.map(([o]) => o));
  const movedNew = new Set(goodMoves.map(([, n]) => n));
  const rows: { key: string; line: string }[] = [];
  const sortedPaths = tree.changedPaths().sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  for (const p of sortedPaths) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (now === null && movedOld.has(p)) continue;
    if (was === null && movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of goodMoves) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
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
