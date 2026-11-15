/**
 * Step 2: geometry. Turn the loose runs of one page into single-column regions
 * in reading order, then into lines, then into blocks.
 *
 * The one idea that carries the reading order: a column gutter is a tall
 * vertical strip of the page that no text crosses while text sits on both sides
 * of it. Anything that does cross the strip (a title, an abstract, a wide
 * caption) is a "spanning" band, read in place between the column bands above
 * and below it. Applying that recursively handles one, two and three columns,
 * and pages whose column structure changes part-way down.
 */

import type { Block, Line, LineRun, RawItem } from './types';

const ASCENT = 0.78;
const DESCENT = 0.22;

const top = (it: RawItem): number => it.base - ASCENT * it.size;
const bottom = (it: RawItem): number => it.base + DESCENT * it.size;
const middle = (it: RawItem): number => it.base - 0.28 * it.size;

export interface Region {
  x0: number;
  x1: number;
  items: RawItem[];
}

export interface GutterHint {
  x: number;
  /** Width of the empty strip where this gutter was established. */
  width: number;
}

export interface LayoutContext {
  pageWidth: number;
  pageHeight: number;
  bodySize: number;
  /**
   * Gutters established elsewhere in the document. Near one, a much shorter column band is
   * accepted, provided the strip is nearly as wide as the gutter itself. That width test is
   * what stops the chance alignment of word gaps in a few lines of full-width text from
   * passing as a gutter.
   */
  gutterHints: GutterHint[];
  /** The gutters of the page before this one: where a side column that runs over would stand. */
  before?: GutterHint[];
}

interface River {
  x: number;
  /** Width of the empty strip, when measured. */
  width?: number;
  halfWidth: number;
  segments: Array<[number, number]>;
  score: number;
}

/** Runs in order of height on the page, so that the runs of a horizontal band are a slice. */
interface Stack {
  items: RawItem[];
  /** `middle()` of each run, ascending. */
  mids: number[];
}

function stackOf(items: RawItem[]): Stack {
  const sorted = items.slice().sort((p, q) => middle(p) - middle(q));
  return { items: sorted, mids: sorted.map(middle) };
}

/** Index of the first run whose middle lies below `y` (strictly, or at it when `inclusive`). */
function firstBelow(mids: number[], y: number, inclusive: boolean): number {
  let lo = 0, hi = mids.length;
  while (lo < hi) {
    const at = (lo + hi) >> 1;
    if (inclusive ? mids[at] >= y : mids[at] > y) hi = at;
    else lo = at + 1;
  }
  return lo;
}

/**
 * Score a vertical line at `x` (or a strip of half-width `half` around it):
 * the total height over which it runs between two columns without being crossed.
 */
function scoreStrip(
  stack: Stack, x: number, half: number, minHeight: number, ctx: LayoutContext, needAlignedEdge = false, minClear = 0
): River | null {
  const items = stack.items;
  const lineHeight = 1.2 * ctx.bodySize;
  const minColumn = Math.max(55, 0.09 * ctx.pageWidth);

  const crossing: Array<[number, number]> = [];
  for (const it of items) {
    if (it.x0 < x - half && it.x1 > x + half) crossing.push([top(it), bottom(it)]);
    else if (half > 0 && it.x1 > x - half && it.x0 < x + half && it.x1 - it.x0 < 4 * half) crossing.push([top(it), bottom(it)]);
  }
  crossing.sort((a, b) => a[0] - b[0]);

  const free: Array<[number, number]> = [];
  let cursor = -Infinity;
  for (const [t, b] of crossing) {
    if (t - cursor >= minHeight) free.push([cursor, t]);
    cursor = Math.max(cursor, b);
  }
  free.push([cursor, Infinity]);

  const segments: Array<[number, number]> = [];
  let score = 0;
  for (const [a, b] of free) {
    let lTop = Infinity, lBot = -Infinity, lX0 = Infinity, lX1 = -Infinity, lN = 0;
    let rTop = Infinity, rBot = -Infinity, rX0 = Infinity, rX1 = -Infinity, rN = 0;
    // Size of the largest type that comes right up to the strip, on each side.
    let nearLeft = 0, nearRight = 0;
    const from = firstBelow(stack.mids, a, false);
    const to = firstBelow(stack.mids, b, true);
    for (let k = from; k < to; k++) {
      const it = items[k];
      if (it.x1 <= x + half) {
        if (it.x1 > x - half - 1.5 * it.size && it.size > nearLeft) nearLeft = it.size;
      } else if (it.x0 < x + half + 1.5 * it.size && it.size > nearRight) {
        nearRight = it.size;
      }
      if (it.x1 <= x + half) {
        lN++;
        if (top(it) < lTop) lTop = top(it);
        if (bottom(it) > lBot) lBot = bottom(it);
        if (it.x0 < lX0) lX0 = it.x0;
        if (it.x1 > lX1) lX1 = it.x1;
      } else if (it.x0 >= x - half) {
        rN++;
        if (top(it) < rTop) rTop = top(it);
        if (bottom(it) > rBot) rBot = bottom(it);
        if (it.x0 < rX0) rX0 = it.x0;
        if (it.x1 > rX1) rX1 = it.x1;
      }
    }
    if (lN < 2 || rN < 2) continue;
    // A real gutter is wider than a word space in the type that borders it on both sides.
    // Without this, the space between two words of a large title can pass for a gutter.
    if (half > 0 && 2 * half < 0.45 * Math.min(nearLeft, nearRight)) continue;
    if (lX1 - lX0 < minColumn || rX1 - rX0 < minColumn) continue;
    if (lBot - lTop < 1.8 * lineHeight || rBot - rTop < 1.8 * lineHeight) continue;
    let y0 = Math.max(a, Math.min(lTop, rTop) - 0.5);
    let y1 = Math.min(b, Math.max(lBot, rBot) + 0.5);
    // The short last line of a spanning paragraph sits just under the paragraph and well
    // above anything else on its side of the strip. It belongs to the paragraph, not to
    // the column band; likewise a short heading just above a spanning block.
    y0 = trimEdge(items, from, to, x, half, y0, y1, a, lineHeight, +1);
    y1 = trimEdge(items, from, to, x, half, y0, y1, b, lineHeight, -1);
    if (y1 - y0 < minHeight) continue;
    if (needAlignedEdge && !startsAligned(items, x, half, y0, y1)) continue;
    if (minClear > 0 && clearance(items, x, half, y0, y1) < minClear) continue;
    segments.push([y0, y1]);
    score += y1 - y0;
  }
  return segments.length ? { x, halfWidth: half, segments, score } : null;
}

/**
 * True when the lines to the right of the strip all start at the same x, as the lines of a
 * column do. Where the "strip" is only word spaces that happen to line up in a few lines of
 * full-width text, the words after the gaps start at scattered positions.
 */
function startsAligned(items: RawItem[], x: number, half: number, y0: number, y1: number): boolean {
  const firstInRow = new Map<number, number>();
  for (const it of items) {
    const y = middle(it);
    if (y <= y0 || y >= y1 || it.x0 < x - half) continue;
    const row = Math.round(it.base / (0.6 * it.size));
    const seen = firstInRow.get(row);
    if (seen === undefined || it.x0 < seen) firstInRow.set(row, it.x0);
  }
  const starts = [...firstInRow.values()].sort((a, b) => a - b);
  if (starts.length < 2) return false;
  let best = 0;
  for (let i = 0; i < starts.length; i++) {
    let j = i;
    while (j < starts.length && starts[j] - starts[i] <= 2) j++;
    best = Math.max(best, j - i);
  }
  return best >= Math.max(2, Math.ceil(0.7 * starts.length));
}

/**
 * How wide the empty strip at `x` typically is, line by line: from where the text on its
 * left stops to where the text on its right starts. A gutter is wide on nearly every line;
 * word spaces that line up over two or three lines are not. Lines with text on one side
 * only (a heading, the short last line of a paragraph) say nothing about the strip, and are
 * left out when two or more lines have text on both.
 */
function clearance(items: RawItem[], x: number, half: number, y0: number, y1: number): number {
  const ends = new Map<number, number>();
  const starts = new Map<number, number>();
  for (const it of items) {
    const y = middle(it);
    if (y <= y0 || y >= y1) continue;
    const row = Math.round(it.base / (0.6 * it.size));
    if (it.x1 <= x + half) ends.set(row, Math.max(ends.get(row) ?? -Infinity, it.x1));
    else if (it.x0 >= x - half) starts.set(row, Math.min(starts.get(row) ?? Infinity, it.x0));
  }
  const both = [...ends.keys()].filter((row) => starts.has(row));
  const median = (m: Map<number, number>): number => {
    const values = (both.length >= 2 ? both.map((row) => m.get(row) as number) : [...m.values()]).sort((a, b) => a - b);
    return values[values.length >> 1] ?? NaN;
  };
  return median(starts) - median(ends);
}

/**
 * Move one edge of a column band inwards past stray lines that belong to whatever lies
 * beyond that edge: the short last line of a spanning paragraph, a heading that sits just
 * above the text it heads, the first lines of a column that starts under a spanning block.
 * Such lines hug the edge and are cut off from the rest of their side of the strip by clear
 * space. `dir` is +1 for the top edge and -1 for the bottom edge. Only the runs `from` to
 * `to` of the height-ordered list are looked at: those of the band being trimmed.
 */
function trimEdge(
  items: RawItem[], from: number, to: number, x: number, half: number, y0: number, y1: number, wall: number, lineHeight: number,
  dir: 1 | -1
): number {
  const edge = dir > 0 ? y0 : y1;
  if (!Number.isFinite(wall)) return edge;
  const MAX_STRAY = 4.5 * lineHeight;

  /** How far the stray cluster on one side reaches in from the wall: 0 if none, -1 if the side runs unbroken. */
  const reach = (side: -1 | 1): number => {
    // Only what lies near the wall can be part of the cluster; of the rest it is enough to
    // know that there is some, and how near the nearest of it comes.
    const horizon = MAX_STRAY + 1.6 * lineHeight;
    const mine: Array<[number, number]> = [];
    let beyond = Infinity;
    for (let k = from; k < to; k++) {
      const it = items[k];
      const y = middle(it);
      if (y <= y0 || y >= y1) continue;
      if ((it.x1 <= x + half ? -1 : 1) !== side) continue;
      // Distances measured inwards from the wall: [near edge, far edge].
      const near = dir > 0 ? top(it) - wall : wall - bottom(it);
      if (near > horizon) beyond = Math.min(beyond, near);
      else mine.push([near, dir > 0 ? bottom(it) - wall : wall - top(it)]);
    }
    if (!mine.length) return 0;
    mine.sort((a, b) => a[0] - b[0]);
    if (mine[0][0] >= 1.3 * lineHeight) return 0;
    let far = mine[0][1];
    for (let i = 1; i < mine.length; i++) {
      if (mine[i][0] - far > 1.6 * lineHeight) return far <= MAX_STRAY ? far : -1;
      far = Math.max(far, mine[i][1]);
    }
    return beyond < Infinity && beyond - far > 1.6 * lineHeight && far <= MAX_STRAY ? far : -1;
  };

  const left = reach(-1);
  const right = reach(1);
  if (left < 0 || right < 0) return edge;
  const depth = Math.max(left, right);
  if (depth === 0) return edge;
  return dir > 0 ? wall + depth + 0.5 : wall - depth - 0.5;
}

function findRiver(items: RawItem[], ctx: LayoutContext): River | null {
  let x0 = Infinity, x1 = -Infinity;
  for (const it of items) {
    if (it.x0 < x0) x0 = it.x0;
    if (it.x1 > x1) x1 = it.x1;
  }
  const lineHeight = 1.2 * ctx.bodySize;
  const strict = Math.max(5 * lineHeight, 0.07 * ctx.pageHeight);
  const lenient = 2.2 * lineHeight;
  const inset = Math.max(40, 0.06 * ctx.pageWidth);

  const STEP = 2;
  const stack = stackOf(items);
  const scores: Array<{ x: number; score: number }> = [];
  for (let x = x0 + inset; x <= x1 - inset; x += STEP) {
    scores.push({ x, score: scoreStrip(stack, x, 0, strict, ctx)?.score ?? 0 });
  }

  // Take the candidate lines from the highest score down. Each is widened to the plateau
  // around it and re-tested as a strip of real width, so that neither a line of separately
  // placed words nor the word spaces of a large title can pass for a gutter.
  const order = scores.map((s, i) => i).filter((i) => scores[i].score > 0).sort((a, b) => scores[b].score - scores[a].score);
  const tested = new Set<number>();
  let attempts = 0;
  for (const at of order) {
    if (tested.has(at)) continue;
    if (++attempts > 12) break;
    const peak = scores[at].score;
    let lo = at, hi = at;
    while (lo > 0 && scores[lo - 1].score >= peak * 0.97) lo--;
    while (hi < scores.length - 1 && scores[hi + 1].score >= peak * 0.97) hi++;
    for (let i = lo; i <= hi; i++) tested.add(i);
    const centre = (scores[lo].x + scores[hi].x) / 2;
    const plateau = scores[hi].x - scores[lo].x;
    const river = scoreStrip(stack, centre, Math.min(8, Math.max(0.5, plateau * 0.4)), strict, ctx);
    if (river) {
      river.width = plateau + STEP;
      return river;
    }
  }

  // No tall gutter. A short band at a known gutter still counts, if the strip is properly wide:
  // wider than the word spaces of two lines that happen to line up there.
  let short: River | null = null;
  for (const hint of ctx.gutterHints) {
    if (hint.x < x0 + inset || hint.x > x1 - inset) continue;
    const half = Math.max(2.5, 0.3 * hint.width);
    const clear = Math.max(6, 0.6 * hint.width);
    for (const dx of [0, -2, 2, -4, 4]) {
      const river = scoreStrip(stack, hint.x + dx, half, lenient, ctx, true, clear);
      if (river && (!short || river.score > short.score)) short = river;
    }
  }
  return short;
}

/** A run that is nothing but leader dots, as between an entry of a contents list and its page number. */
const LEADER = /^(?:[.\u00B7\u2026] ?)+$/;

/**
 * Leader dots often come one dot to a run, hundreds to a page, lined up in columns with
 * clear strips between them. For finding gutters, each row of them is what it looks like:
 * one rule across the page.
 */
function joinLeaders(items: RawItem[]): RawItem[] {
  const dots = items.filter((it) => LEADER.test(it.s.trim()));
  if (dots.length < 2) return items;
  dots.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const out = items.filter((it) => !LEADER.test(it.s.trim()));
  let rule: RawItem | null = null;
  for (const it of dots) {
    if (rule && Math.abs(rule.base - it.base) <= 0.3 * it.size && it.x0 - rule.x1 <= 3 * it.size) rule.x1 = Math.max(rule.x1, it.x1);
    else out.push((rule = { ...it }));
  }
  return out;
}

function makeRegion(items: RawItem[]): Region {
  let x0 = Infinity, x1 = -Infinity;
  for (const it of items) {
    if (it.x0 < x0) x0 = it.x0;
    if (it.x1 > x1) x1 = it.x1;
  }
  return { x0, x1, items };
}

/**
 * A side column can run over from the page before for a line or two: small print beside the
 * top of the text. That is too short for a column band, and its lines would be taken for
 * cells of the lines of text beside them. Such a group is a region of its own: small print
 * wholly on one side of a gutter known from the page before or from elsewhere in the
 * document, larger type beside it across the gutter, and nothing that crosses the gutter at
 * its height.
 */
function sideOverflow(items: RawItem[], ctx: LayoutContext): { side: RawItem[]; rest: RawItem[] } | null {
  for (const hint of [...ctx.gutterHints, ...(ctx.before ?? [])]) {
    const half = Math.max(2.5, 0.3 * hint.width);
    for (const dir of [-1, 1]) {
      const beyond = (it: RawItem): boolean => (dir < 0 ? it.x1 <= hint.x : it.x0 >= hint.x);
      const small = items.filter((it) => beyond(it) && it.size <= 0.93 * ctx.bodySize).sort((p, q) => p.base - q.base);
      for (let i = 0; i < small.length; ) {
        let j = i + 1;
        while (j < small.length && small[j].base - small[j - 1].base <= 2.5 * small[j].size) j++;
        const group = small.slice(i, j);
        i = j;
        const y0 = Math.min(...group.map(top)) - 0.5;
        const y1 = Math.max(...group.map(bottom)) + 0.5;
        const print = Math.max(...group.map((it) => it.size));
        const beside = items.filter((it) => !group.includes(it) && middle(it) > y0 && middle(it) < y1);
        if (!beside.length || beside.some((it) => (dir < 0 ? it.x0 < hint.x - half : it.x1 > hint.x + half))) continue;
        const width = (list: RawItem[]): number => list.reduce((n, it) => n + it.x1 - it.x0, 0);
        if (width(beside.filter((it) => it.size >= 1.1 * print)) < 0.8 * width(beside)) continue;
        const clear = dir < 0
          ? Math.min(...beside.map((it) => it.x0)) - Math.max(...group.map((it) => it.x1))
          : Math.min(...group.map((it) => it.x0)) - Math.max(...beside.map((it) => it.x1));
        if (clear < Math.max(6, 0.6 * hint.width)) continue;
        return { side: group, rest: items.filter((it) => !group.includes(it)) };
      }
    }
  }
  return null;
}

/** Split a page (or part of one) into single-column regions in reading order. */
export function splitIntoRegions(items: RawItem[], ctx: LayoutContext, depth = 0, rivers?: River[]): Region[] {
  if (!items.length) return [];
  if (depth > 5 || items.length < 4) return [makeRegion(items)];
  /** One column, as far as gutters go; small print that ran over from a side column is still set apart. */
  const whole = (): Region[] => {
    const over = sideOverflow(items, ctx);
    return over ? [makeRegion(over.side), ...splitIntoRegions(over.rest, ctx, depth + 1)] : [makeRegion(items)];
  };
  const river = findRiver(joinLeaders(items), ctx);
  if (!river) return whole();
  if (depth === 0) rivers?.push(river);

  const out: Region[] = [];
  let rest = items;
  for (const [y0, y1] of river.segments) {
    const above: RawItem[] = [], left: RawItem[] = [], right: RawItem[] = [], below: RawItem[] = [];
    for (const it of rest) {
      const y = middle(it);
      if (y < y0) above.push(it);
      else if (y > y1) below.push(it);
      else if ((it.x0 + it.x1) / 2 < river.x) left.push(it);
      else right.push(it);
    }
    // A band that failed to separate anything would recurse forever.
    if (!left.length || !right.length) continue;
    out.push(...splitIntoRegions(above, ctx, depth + 1));
    out.push(...splitIntoRegions(left, ctx, depth + 1));
    out.push(...splitIntoRegions(right, ctx, depth + 1));
    rest = below;
  }
  if (rest.length === items.length) return whole();
  out.push(...splitIntoRegions(rest, ctx, depth + 1));
  return out;
}

/** Top-level gutter positions on a page, used to build document-wide hints. */
export function pageGutters(items: RawItem[], ctx: LayoutContext): Array<{ x: number; height: number; width: number }> {
  const rivers: River[] = [];
  splitIntoRegions(items, { ...ctx, gutterHints: [] }, 0, rivers);
  return rivers.map((r) => ({ x: r.x, height: r.score, width: r.width ?? 6 }));
}

// --------------------------------- lines ---------------------------------

// unicode-table: superscript forms
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '–': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', ',': ',', ' ': ' ',
};
// unicode-table: subscript forms
const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', ',': ',', ' ': ' ',
};

function mapAll(s: string, table: Record<string, string>): string | null {
  let out = '';
  for (const ch of s) {
    const m = table[ch];
    if (m === undefined) return null;
    out += m;
  }
  return out;
}

// unicode-table: free-standing accents as TeX prints them, and the combining mark each stands for
const SPACING_ACCENTS: Record<string, string> = {
  '\u00A8': '\u0308', '\u00B4': '\u0301', '`': '\u0300', '\u02C6': '\u0302', '\u02DC': '\u0303',
  '\u02C7': '\u030C', '\u00B8': '\u0327', '\u02DA': '\u030A', '\u00AF': '\u0304', '\u02D8': '\u0306',
};

/** What an accent can stand over: a Latin or Greek letter, or a letter of the mathematical alphabets. */
const LETTER = /^(?:[A-Za-z\u00C0-\u024F\u0370-\u03FF]|\uD835[\uDC00-\uDFFF])$/;

/** One character of a line being assembled: where it sits and which run it came from. */
interface Glyph {
  ch: string;
  x0: number;
  x1: number;
  /** Index of the run in the row, or -1 for a space this code put between two runs. */
  run: number;
  /** Which word of that run the character belongs to. */
  word: number;
}

/**
 * Rough advance width of a character in a text face, in ems. PDF.js gives the width of a
 * whole run only; sharing it out by these ratios, not evenly, puts each word of a long run
 * within a fraction of a character of where it is printed.
 */
function advance(ch: string, mono: boolean): number {
  if (mono) return 1;
  if (ch === ' ' || "iIjl.,:;'|!".includes(ch)) return 0.28;
  if ('ftr()[]-"*/'.includes(ch)) return 0.34;
  if ('mwMW@%'.includes(ch)) return 0.86;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.5;
}

/** A letter with a combining mark on it: one character where there is one, the letter and the mark where not. */
function accented(letter: string, mark: string): string {
  return ((letter === '\u0131' ? 'i' : letter === '\u0237' ? 'j' : letter) + mark).normalize('NFC');
}

/**
 * TeX often prints an accented letter as the accent followed by the bare letter
 * ("na" + diaeresis + dotless i + "ve"). Put the two back together.
 */
function composeAccents(glyphs: Glyph[]): void {
  for (let i = 0; i < glyphs.length - 1; i++) {
    const accent = glyphs[i];
    const mark = SPACING_ACCENTS[accent.ch];
    const next = glyphs[i + 1];
    if (!mark || !LETTER.test(next.ch)) continue;
    const composed = accented(next.ch, mark);
    if (composed.length === 1 && /^[A-Za-z\u0131\u0237]$/.test(next.ch)) {
      next.ch = composed;
      next.x0 = Math.min(next.x0, accent.x0);
      glyphs.splice(i, 1);
    } else if (next.run >= 0 && next.run !== accent.run && next.x0 < (accent.x0 + accent.x1) / 2) {
      // A letter with no accented form of its own (a Greek one, a variable) takes the accent
      // only where it is seen to stand under it: another run, begun before the accent's middle.
      next.ch = composed;
      accent.ch = '';
    }
  }
}

/** Words that begin anew after a word ending in an accented letter ("a cafe and a bar"). */
const AFTER_ACCENT = new Set('et and de du des van von the of in is was were has had are for with from to as at by that which who syndrome disease'.split(' '));

/** Does the text after an accent and a blank start a new word, or carry on the accented one ("fac", cedilla, blank, "ade")? */
function startsWord(rest: string): boolean {
  const first = rest.split(' ', 1)[0];
  if (/^[a-z\u00DF-\u00F6\u00F8-\u00FF]/.test(first)) return AFTER_ACCENT.has(first.replace(/[^a-z]+$/, ''));
  return !/^[,.;:!?)\]}'\u2019\u201D\u2010-\u2014%-]/.test(first);
}

/**
 * Letter-spaced capitals ("T A B L E 1", "A B S T R A C T") are one word. A run of four or
 * more capitals that each stand alone loses the spaces between them; so does a whole line
 * of single letters.
 */
function joinSpacedLetters(glyphs: Glyph[]): void {
  const gap = (g: Glyph | undefined): boolean => !g || g.ch === ' ';
  const alone = (k: number, pattern: RegExp): boolean =>
    k < glyphs.length && pattern.test(glyphs[k].ch) && gap(glyphs[k - 1]) && gap(glyphs[k + 1]);
  const wholeLine = glyphs.length >= 7 && glyphs.every((g, k) => (k % 2 ? g.ch === ' ' : /^[A-Za-z]$/.test(g.ch)));
  const letter = wholeLine ? /^[A-Za-z]$/ : /^[A-Z]$/;
  for (let i = 0; i < glyphs.length; i++) {
    let n = 0;
    while (alone(i + 2 * n, letter)) n++;
    if (n < 4) continue;
    for (let k = n - 1; k >= 1; k--) glyphs.splice(i + 2 * k - 1, 1);
    i += n - 1;
  }
}

function lineFromRow(row: RawItem[], page: number): Line | null {
  row.sort((a, b) => a.x0 - b.x0 || a.seq - b.seq);

  // Dominant size and font by character count.
  const sizeVotes = new Map<number, number>();
  const fontVotes = new Map<string, number>();
  let chars = 0;
  let monoChars = 0;
  for (const it of row) {
    const n = it.s.trim().length;
    chars += n;
    if (it.mono) monoChars += n;
    const key = Math.round(it.size * 4) / 4;
    sizeVotes.set(key, (sizeVotes.get(key) ?? 0) + n);
    fontVotes.set(it.font, (fontVotes.get(it.font) ?? 0) + n);
  }
  if (!chars) return null;
  let size = 0, sizeBest = -1;
  for (const [k, v] of sizeVotes) if (v > sizeBest) { sizeBest = v; size = k; }
  let altSize = 0, altBest = 0.15 * chars;
  for (const [k, v] of sizeVotes) if (k !== size && v >= altBest) { altBest = v; altSize = k; }
  let font = '', fontBest = -1;
  for (const [k, v] of fontVotes) if (v > fontBest) { fontBest = v; font = k; }

  const mainBases = row.filter((it) => Math.abs(it.size - size) <= 0.3).map((it) => it.base).sort((a, b) => a - b);
  const base = mainBases.length ? mainBases[mainBases.length >> 1] : row[0].base;

  // Capitals and small capitals: every letter a capital, the line opening in a larger size that
  // stands on the same baseline. Such a line is as large as its capitals.
  const cap = row[0];
  if (
    cap.size >= 1.12 * size && cap.size <= 1.7 * size && Math.abs(cap.base - base) <= 0.06 * size &&
    row.every((it) => Math.abs(it.size - size) <= 0.3 || Math.abs(it.size - cap.size) <= 0.3) &&
    !/[a-z\u00DF-\u00FF]/.test(row.map((it) => it.s).join('')) && row.reduce((n, it) => n + it.s.replace(/[^A-Z]/g, '').length, 0) >= 4
  ) {
    altSize = size;
    size = Math.round(cap.size * 4) / 4;
  }

  // Beside display type (a title), a much smaller detached run is a badge or label, not part of the line.
  if (size >= 14) {
    row = row.filter((it, k) => {
      const edge = k === 0 || k === row.length - 1;
      if (it.size > 0.6 * size && !(edge && it.font !== font)) return true;
      const before = row[k - 1];
      const after = row[k + 1];
      const detached = (!before || it.x0 - before.x1 > 0.3 * size) && (!after || after.x0 - it.x1 > 0.3 * size);
      return !detached;
    });
    if (!row.length) return null;
  }

  // Letter-spaced text ("A B S T R A C T") arrives as a run of one- and two-letter pieces set
  // at even intervals. The interval is then no word space; only a clearly wider gap is. (A
  // line of symbols with whole words among them is set word by word, not letter by letter.)
  let wordGap = 0;
  if (row.length >= 4 && chars / row.length <= 2.2 && row.every((it) => it.s.trim().length <= 3)) {
    const gaps: number[] = [];
    for (let k = 1; k < row.length; k++) gaps.push(row[k].x0 - row[k - 1].x1);
    gaps.sort((a, b) => a - b);
    const typicalGap = gaps[gaps.length >> 1];
    const regular = gaps.filter((g) => g >= 0.5 * typicalGap && g <= 1.6 * typicalGap).length >= 0.6 * gaps.length;
    if (typicalGap > 0.08 * size && typicalGap < 1.2 * size && regular) wordGap = Math.max(2.2 * typicalGap, 0.5 * size);
  }

  const glyphs: Glyph[] = [];
  let cells = 1;
  let prev: RawItem | null = null;
  const leadFont = row[0].font;
  /** Number of runs at the start of the line that are set in `leadFont`. */
  let leadRuns = 0;
  while (leadRuns < row.length && row[leadRuns].font === leadFont) leadRuns++;

  row.forEach((it, r) => {
    let piece = it.s.trim();
    if (it.size <= 0.82 * size && piece.length <= 12) {
      const lift = base - it.base;
      const mapped = lift >= 0.18 * size ? mapAll(piece, SUPERSCRIPT) : lift <= -0.08 * size ? mapAll(piece, SUBSCRIPT) : null;
      if (mapped) piece = mapped;
    }
    let letters = Array.from(piece);
    let x = it.x0;
    let word = 0;
    // An accent can be a run of its own, or begin one, printed over the letter before it: a
    // hat on a variable; the cedilla of "facade" where the file holds "fac", the accent set
    // back under the c, and then "ade". It is part of that letter, and the first word of its
    // run is the letter's word.
    const mark = /^[\u0300-\u036F]$/.test(letters[0]) ? letters[0] : SPACING_ACCENTS[letters[0]];
    const under = glyphs[glyphs.length - 1];
    const mid = it.x0 + (letters.length > 1 ? 0.15 * it.size : (it.x1 - it.x0) / 2);
    if (mark && prev && mid < prev.x1 && mid > under.x0 && LETTER.test(under.ch)) {
      under.ch = accented(under.ch, mark);
      glyphs.push({ ch: '', x0: under.x1, x1: under.x1, run: r, word: 0 });
      // An accent alone: what follows is still measured from the letter.
      if (letters.length === 1) return;
      // The blank the viewer often has after such an accent is only the way back to the end
      // of the letter. The word goes on through it unless a new one plainly starts there.
      const through = letters[1] === ' ' && !startsWord(letters.slice(2).join(''));
      letters = letters.slice(through ? 2 : 1);
      if (through) word = 1;
      x = Math.max(it.x0, Math.min(prev.x1, it.x1 - 0.1));
    } else if (prev) {
      const gap = it.x0 - prev.x1;
      const unit = Math.min(prev.size, it.size);
      // A blank in front of a run that starts just where the run before it ends has no room
      // on the line: it marks a place where the line may be broken (inside an address, before
      // an index), not a space. After a hyphen such a mark can take a sliver of room; the space
      // after a hyphen that stands for a word left out ("pre- and post-") is a whole one.
      const room = /[A-Za-z0-9][-\u2010\u2011]$/.test(prev.s) ? 0.15 : 0.03;
      const blank = prev.s.endsWith(' ') || (it.s.startsWith(' ') && it.origin - prev.x1 > room * unit);
      const space = wordGap ? gap > wordGap : blank || gap > 0.16 * unit;
      if (gap > 1.8 * size) cells++;
      if (space && glyphs[glyphs.length - 1].ch !== ' ') {
        glyphs.push({ ch: ' ', x0: Math.min(prev.x1, it.x0), x1: it.x0, run: -1, word: 0 });
      }
    }
    let total = 0;
    for (const ch of letters) total += advance(ch, it.mono);
    const scale = (it.x1 - x) / total;
    for (const ch of letters) {
      const width = advance(ch, it.mono) * scale;
      if (ch === ' ') word++;
      glyphs.push({ ch, x0: x, x1: x + width, run: ch === ' ' ? -1 : r, word });
      x += width;
    }
    prev = it;
  });
  composeAccents(glyphs);
  joinSpacedLetters(glyphs);

  let text = '';
  const wordX0: number[] = [];
  const wordX1: number[] = [];
  const runs: LineRun[] = row.map((it) => ({ x: it.origin, base: it.base, size: it.size, words: [] }));
  let leadWords = 0;
  let open = false;
  for (const g of glyphs) {
    text += g.ch;
    if (g.ch === ' ') {
      open = false;
      continue;
    }
    if (!open) {
      wordX0.push(g.x0);
      wordX1.push(g.x1);
      open = true;
    }
    const at = wordX0.length - 1;
    wordX1[at] = Math.max(wordX1[at], g.x1);
    if (g.run >= 0) {
      const words = runs[g.run].words;
      if (words[g.word] === undefined) words[g.word] = at;
      if (g.run < leadRuns) leadWords = at + 1;
    }
  }
  if (!text) return null;
  // A run-word that lost its only character (a bare accent) is the word that took it over.
  for (const run of runs) {
    for (let k = run.words.length - 1; k >= 0; k--) run.words[k] ??= run.words[k + 1] ?? wordX0.length - 1;
  }
  const tail = row[row.length - 1];

  let x0 = Infinity, x1 = -Infinity;
  for (const it of row) {
    if (it.x0 < x0) x0 = it.x0;
    if (it.x1 > x1) x1 = it.x1;
  }
  return {
    page, x0, x1, base,
    top: base - ASCENT * size,
    bottom: base + DESCENT * size,
    size, altSize, font,
    purity: fontBest / chars,
    text, cells, wordX0, wordX1, runs, leadFont, leadWords,
    tailSize: tail.size,
    tailFont: tail.font,
    mono: monoChars > 0.6 * chars,
  };
}

/** Group the runs of one single-column region into text lines, top to bottom. */
export function buildLines(region: Region, page: number): Line[] {
  // A drop cap is one or two letters several lines tall. It is held back and put in front of
  // the first line it stands beside, where the word it begins is. A figure can be one too
  // ("5" before "-day runs"), when smaller type higher up on its right carries on from it.
  const sizes = region.items.map((it) => it.size).sort((a, b) => a - b);
  const typical = sizes[sizes.length >> 1] ?? 0;
  const carriesOn = (cap: RawItem): boolean =>
    region.items.some(
      (o) =>
        o.size <= cap.size / 1.7 && o.x0 >= cap.x1 - 2 && o.x0 - cap.x1 < 1.5 * cap.size &&
        o.base < cap.base - 0.5 * o.size && o.base > cap.base - cap.size && /^[-\u2010\u2011\d]/.test(o.s.trim())
    );
  // Nothing else of its size stands on a drop cap's baseline: beside it are lines of the text.
  const alone = (cap: RawItem): boolean =>
    !region.items.some((o) => o !== cap && o.size >= 0.75 * cap.size && Math.abs(o.base - cap.base) <= 0.2 * cap.size);
  const isDropCap = (it: RawItem): boolean => {
    if (it.size < 1.7 * typical) return false;
    const s = it.s.trim();
    return (/^["'\u201C\u2018]?[A-Z]{1,2}$/.test(s) || (/^\d$/.test(s) && carriesOn(it))) && alone(it);
  };
  const caps = region.items.filter(isDropCap);
  const items = region.items.filter((it) => !isDropCap(it)).sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows: Array<{ anchor: RawItem; items: RawItem[] }> = [];

  for (const it of items) {
    let home: { anchor: RawItem; items: RawItem[] } | null = null;
    for (let r = rows.length - 1; r >= 0 && r >= rows.length - 6; r--) {
      const a = rows[r].anchor;
      const overlap = Math.min(bottom(it), bottom(a)) - Math.max(top(it), top(a));
      if (overlap >= 0.5 * Math.min(it.size, a.size)) {
        home = rows[r];
        break;
      }
    }
    if (!home) {
      rows.push({ anchor: it, items: [it] });
    } else {
      home.items.push(it);
      // The anchor is the row's largest ordinary run; a drop cap must not swallow the lines beside
      // it. A row that began with a small raised mark is anchored on the text that follows it,
      // however much larger: an index under that text is then on the row too.
      if (it.size > home.anchor.size && (it.size < 1.6 * home.anchor.size || it.size <= 1.25 * typical)) home.anchor = it;
    }
  }

  // A sign from a font of large symbols (a radical, a sum, an integral) has its origin at its
  // top, well above the line it is printed on. By its baseline it falls on the line above,
  // across that line's words, or between two lines. Two things cannot be read at one spot: the
  // sign belongs to the line under it that has room for it, with words on either side.
  const across = (a: RawItem, b: RawItem): number => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  for (const row of rows) {
    for (const it of row.items.slice()) {
      const width = it.x1 - it.x0;
      if (!/^[\u221A\u2211\u220F\u222B-\u2233\u22C0-\u22C3]$/.test(it.s.trim())) continue;
      if (row.items.length > 1 && !row.items.some((o) => o !== it && across(it, o) > 0.5 * width)) continue;
      const slack = 0.15 * width;
      const under = rows.find((o) => {
        const drop = o.anchor.base - it.base;
        return (
          o !== row && drop > 0.25 * o.anchor.size && drop <= 1.2 * o.anchor.size && o.items.every((w) => across(it, w) <= slack) &&
          o.items.some((w) => w.x1 <= it.x0 + slack) && o.items.some((w) => w.x0 >= it.x1 - slack)
        );
      });
      if (!under) continue;
      row.items.splice(row.items.indexOf(it), 1);
      under.items.push(it);
      if (row.anchor === it && row.items.length) row.anchor = row.items.reduce((a, b) => (b.size > a.size ? b : a));
    }
  }

  // A mark or two alone between two lines, over or under the words of one of them, is a bar
  // or an accent drawn with a glyph of its own (a double bar over a letter, set as "="). It
  // is no line of the text, and must not part the lines it lies between.
  const ornament = (row: { anchor: RawItem; items: RawItem[] }): boolean => {
    const it = row.items[0];
    if (row.items.length !== 1 || !/^[^A-Za-z0-9\s]{1,2}$/.test(it.s.trim())) return false;
    return rows.some((o) => {
      const a = o.anchor;
      if (o === row || a.size < 1.25 * it.size) return false;
      const apart = Math.max(top(a) - bottom(it), top(it) - bottom(a));
      return apart <= 0.3 * a.size && o.items.some((w) => w.x0 <= it.x0) && o.items.some((w) => w.x1 >= it.x1);
    });
  };

  const lines: Line[] = [];
  for (const row of rows) {
    if (!row.items.length || ornament(row)) continue;
    const line = lineFromRow(row.items, page);
    if (line) lines.push(line);
  }
  lines.sort((a, b) => a.base - b.base || a.x0 - b.x0);

  for (const cap of caps) {
    const capTop = top(cap);
    const beside = lines.filter((l) => l.bottom > capTop && l.top < cap.base && l.x0 >= cap.x1 - 2 && l.x0 - cap.x1 < 1.5 * cap.size);
    const first = beside[0];
    if (first) {
      first.text = cap.s.trim() + first.text;
      first.wordX0[0] = Math.min(first.wordX0[0], cap.x0);
      first.runs.unshift({ x: cap.origin, base: cap.base, size: cap.size, words: [0] });
    } else {
      const own = lineFromRow([cap], page);
      if (own) lines.push(own);
    }
  }
  if (caps.length) lines.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  return lines;
}

// --------------------------------- blocks ---------------------------------

/** Most common value, to the nearest `quantum`; the smallest of them when several are as common. */
function mode(values: number[], quantum: number): number {
  const votes = new Map<number, number>();
  let best = 0, bestN = 0;
  for (const v of values) {
    const k = Math.round(v / quantum) * quantum;
    const n = (votes.get(k) ?? 0) + 1;
    votes.set(k, n);
    if (n > bestN || (n === bestN && k < best)) { bestN = n; best = k; }
  }
  return best;
}

/**
 * The step from one line of a region to the next: the commonest one. On a page of formulas
 * no step is common (three of one kind among dozens), and the commonest may be the one between
 * a display and the text beside it. The step is then the smallest one that recurs and suits
 * the size most of the text is set in.
 */
function lineStep(steps: number[], lines: Line[]): number {
  const votes = new Map<number, number>();
  for (const d of steps) {
    const k = Math.round(d / 0.5) * 0.5;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  const common = mode(steps, 0.5);
  const support = votes.get(common) ?? 0;
  if (support > 3 || support >= 0.25 * steps.length) return common;
  const letters = new Map<number, number>();
  for (const l of lines) letters.set(l.size, (letters.get(l.size) ?? 0) + l.text.length);
  let main = lines[0].size;
  for (const [size, n] of letters) if (n > (letters.get(main) ?? 0)) main = size;
  let least = Infinity;
  for (const [k, n] of votes) if (n >= 2 && k >= main && k <= 1.5 * main && k < least) least = k;
  return least < Infinity ? least : common;
}

function makeBlock(lines: Line[], region: Region, regionIndex: number, bodyFonts: ReadonlySet<string>): Block {
  let x0 = Infinity, x1 = -Infinity;
  const sizes: number[] = [];
  const fontVotes = new Map<string, number>();
  for (const l of lines) {
    if (l.x0 < x0) x0 = l.x0;
    if (l.x1 > x1) x1 = l.x1;
    sizes.push(l.size);
    fontVotes.set(l.font, (fontVotes.get(l.font) ?? 0) + l.text.length);
  }
  let font = '', fontBest = -1;
  for (const [k, v] of fontVotes) if (v > fontBest) { fontBest = v; font = k; }
  // A paragraph that opens with a heading run in on it, in a size of its own, is as large as its text.
  const text = lines.filter((l) => bodyFonts.has(l.font)).map((l) => l.size);
  return {
    page: lines[0].page,
    region: regionIndex,
    regionX0: region.x0,
    regionX1: region.x1,
    x0, x1,
    top: lines[0].top,
    bottom: lines[lines.length - 1].bottom,
    lines,
    size: mode(text.length ? text : sizes, 0.25),
    font,
    plain: bodyFonts.has(font),
    kind: 'paragraph',
    level: 0,
  };
}

/** A section number of several parts and the word after it: "3.2.1. Calibration". */
/**
 * Does the text close a sentence? After the stop may come closing quotes and brackets, and
 * the marks of a citation or a note ("...in mice.\u00B3,\u2074", "...in mice.12,13"). Figures straight after
 * a stop are such marks only where a word comes before the stop: "3.5" closes nothing. Nor
 * does the stop of an abbreviation that a citation is hung on ("Writer et al.\u00B3").
 * `also` names further stops to count (":;").
 */
export function sentenceEnds(text: string, also = ''): boolean {
  const m = /([.!?:;])["'\u201D\u2019)\]]*((?:[\u00B9\u00B2\u00B3\u2070-\u2079*\u2020\u2021\u00A7][\u00B9\u00B2\u00B3\u2070-\u2079,\u2013\u2010*\u2020\u2021\u00A7-]*)?|\d{1,3}(?:[,\u2013-]\d{1,3})*)$/.exec(text);
  if (!m || ((m[1] === ':' || m[1] === ';') && !also.includes(m[1]))) return false;
  if (!m[2]) return true;
  const before = text.slice(0, m.index);
  if (/(?:^|[ (])(?:al|e\.g|i\.e|vs|cf|ca|approx|Figs?|Eqs?|Refs?)$/.test(before)) return false;
  return !/^\d/.test(m[2]) || /[A-Za-z\u00C0-\u024F)\]%]$/.test(before);
}

export const SUBSECTION = /^\d{1,2}(?:\.\d{1,2}){1,3}\.?\s+[A-Z]/;

export const BULLET = /^(?:[\u2022\u25CF\u25E6\u25AA\u2023\u2043\u2013\u2014*-]|\(?\d{1,2}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s+\S/;

/**
 * Cut a hard block into paragraphs using its indentation pattern, the only
 * paragraph signal left in layouts that do not put space between paragraphs.
 */
function splitByIndent(lines: Line[]): Line[][] {
  if (lines.length < 3) return [lines];
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const em = lines[0].size;
  const indented = lines.map((l) => l.x0 - left >= 0.8 * em && l.x0 - left <= 4 * em);
  const flush = lines.map((l) => l.x0 - left < 0.45 * em);
  const nIndented = indented.filter(Boolean).length;
  const nFlush = flush.filter(Boolean).length;
  const justified = lines.filter((l) => right - l.x1 < 0.4 * em).length >= 0.6 * lines.length;

  const starts = new Set<number>([0]);
  // A number or a letter that opens a line of running text is a citation, a count or a
  // variable ("(31) to a value of", "72. The tip", "p. However"), not the marker of an item:
  // the line before it is full and stops in mid-sentence, and either lower case follows the
  // marker or no line of the block opens with the marker next to it in order ("1." with no
  // "2."). Nor is a dash that such a line runs on to ("... East Midlands" / "- Derby ...")
  // where it is the only one.
  const marker = lines.map((l) => /^\(?(\d{1,2}|[a-z]|[ivx]{1,4})[.)]\s+(\S)/.exec(l.text));
  const dash = lines.map((l) => /^[\u2013\u2014-]\s+(\S)/.exec(l.text));
  const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
  /** The places of a marker in the orders it may belong to: figures, letters, Roman numerals. */
  const places = (mark: string): number[] => {
    if (/^\d/.test(mark)) return [Number(mark)];
    const at: number[] = [];
    if (mark.length === 1) at.push(100 + mark.charCodeAt(0));
    if (ROMAN.includes(mark)) at.push(1000 + ROMAN.indexOf(mark));
    return at;
  };
  const taken = new Set<number>();
  for (const m of marker) if (m) for (const n of places(m[1])) taken.add(n);
  const inText = (i: number): boolean => {
    const m = marker[i] ?? dash[i];
    if (!m || i === 0 || sentenceEnds(lines[i - 1].text, ':;') || right - lines[i - 1].x1 >= 1.5 * em) return false;
    if (/[a-z]/.test(m[m.length - 1])) return true;
    return marker[i] ? !places(m[1]).some((n) => taken.has(n - 1) || taken.has(n + 1)) : dash.filter(Boolean).length === 1;
  };
  // "(20-" at a line end followed by "22) and ..." is a citation range, not a list item.
  const bullets = lines.map((l, i) => BULLET.test(l.text) && !(i > 0 && /[\u2013\u2014(,-]$/.test(lines[i - 1].text)) && !inText(i));
  // Notes of a line or two each, hung from their first lines, have more flush lines than
  // indented ones, as paragraphs with indented first lines do. The lines before tell the two
  // apart: every flush line follows the end of a sentence or a short line, and no indented one does.
  const closed = (i: number): boolean => sentenceEnds(lines[i - 1].text) || right - lines[i - 1].x1 > 2.5 * em;
  const hung = flush[0] && nIndented > 0 && lines.every((_, i) => i === 0 || (flush[i] ? closed(i) : !indented[i] || !closed(i)));
  if (bullets.some(Boolean)) {
    // A bulleted list: each bullet opens an item and the lines under it belong to it.
    for (let i = 1; i < lines.length; i++) if (bullets[i]) starts.add(i);
  } else if (!hung && (nFlush > nIndented || (nFlush === nIndented && indented[0]))) {
    // First-line indents: every indented line opens a paragraph.
    for (let i = 1; i < lines.length; i++) if (indented[i] && flush[i - 1]) starts.add(i);
  } else if (flush[0] && (hung || nIndented > nFlush || indented[1])) {
    // Hanging indents (numbered lists, reference entries): every flush line opens an item.
    // Entries of two lines each have as many flush lines as indented ones; the order tells.
    for (let i = 1; i < lines.length; i++) if (flush[i]) starts.add(i);
  }
  if (justified) {
    // In justified text a line that stops well short of the margin ends its paragraph.
    for (let i = 1; i < lines.length; i++) if (right - lines[i - 1].x1 > 2.5 * em) starts.add(i);
  }

  const out: Line[][] = [];
  const order = [...starts].sort((a, b) => a - b);
  for (let k = 0; k < order.length; k++) out.push(lines.slice(order[k], order[k + 1] ?? lines.length));
  return out;
}

/**
 * The left and right edges of the text column inside a region. A region can be
 * wider than its column (a stray label in the margin, an outdented heading), and
 * "does this line fill the column" has to be asked of the column, not the region.
 */
function columnExtent(lines: Line[], region: Region): Region {
  const width = region.x1 - region.x0;
  const wide = lines.filter((l) => l.x1 - l.x0 >= 0.5 * width);
  if (wide.length < 3) return region;
  // Most lines of a column start at its left edge, wherever a wide figure or table on the
  // same page may reach to.
  const left = mode(wide.map((l) => l.x0), 2);
  const rights = wide.filter((l) => l.x0 >= left - 2).map((l) => l.x1).sort((a, b) => a - b);
  return {
    x0: Math.min(...wide.map((l) => l.x0).filter((x) => x >= left - 2)),
    x1: rights[Math.min(rights.length - 1, Math.floor(rights.length * 0.9))],
    items: region.items,
  };
}

/** Group the lines of a region into blocks: runs of lines that share size, font and spacing. */
export function buildBlocks(lines: Line[], rawRegion: Region, regionIndex: number, bodyFonts: ReadonlySet<string>, pageHeight = 0): Block[] {
  if (!lines.length) return [];
  const region = columnExtent(lines, rawRegion);

  // A justified line of few words is spread over its column with wide gaps. It is text, not
  // a row of table cells: it fills the column from edge to edge as the prose beside it does,
  // and its gaps are all of one width.
  const edgeToEdge = (l: Line): boolean => l.x0 - region.x0 <= 1.5 && region.x1 - l.x1 <= 1.5;
  const prose = lines.map((l) => l.cells === 1 && l.wordX0.length >= 5 && edgeToEdge(l));
  lines.forEach((l, i) => {
    if (l.cells < 2 || !edgeToEdge(l)) return;
    const gaps = l.wordX0.slice(1).map((x, k) => x - l.wordX1[k]);
    const beside = (k: number): boolean => prose[k] && Math.abs(lines[k].size - l.size) < 0.3;
    // A space that does not stretch (between a figure and its unit) may stand among the wide ones.
    const wide = gaps.filter((g) => g > 0.6 * l.size);
    const fixed = gaps.length - wide.length;
    if (
      wide.length && Math.max(...wide) <= 1.4 * Math.min(...wide) + 1 && (fixed === 0 || (wide.length >= 2 && wide.length > fixed)) &&
      (beside(i - 1) || beside(i + 1))
    ) l.cells = 1;
  });

  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].base - lines[i - 1].base;
    // Lines further apart than double spacing are not one text, however evenly they are set out.
    if (d > 0 && d <= 2.6 * lines[i].size && Math.abs(lines[i].size - lines[i - 1].size) < 0.3) steps.push(d);
  }
  const commonStep = steps.length >= 2 ? lineStep(steps, lines) : 0;

  const hard: Line[][] = [];
  let current: Line[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1];
    const c = lines[i];
    const d = c.base - p.base;
    // A full line followed at an even distance by more text of its size is one paragraph,
    // however that distance compares with the rest of the region: a double-spaced manuscript
    // sitting above a single-spaced reference list. (Font ids cannot settle this: one typeface
    // is often embedded under several.) A heading is short and, as a rule, not in a body font.
    const sized = (a: Line | undefined): a is Line => !!a && Math.abs(a.size - c.size) < 0.3;
    const full = (a: Line): boolean => a.cells === 1 && region.x1 - a.x1 <= 2 * a.size;
    const evenRun =
      d <= 2.6 * c.size && sized(p) && full(p) && (full(c) || bodyFonts.has(c.font)) &&
      ((sized(lines[i - 2]) && Math.abs(p.base - lines[i - 2].base - d) <= 0.06 * d) ||
        (sized(lines[i + 1]) && Math.abs(lines[i + 1].base - c.base - d) <= 0.06 * d));
    // So is a full line that stops in mid-sentence above a line that carries the sentence on.
    const unfinished = d <= 2.2 * c.size && sized(p) && full(p) && !sentenceEnds(p.text, ':;');
    const sentenceRunsOn = unfinished && /^[a-z]/.test(c.text);
    const step = commonStep || 1.25 * Math.max(p.size, c.size);
    const bigGap = !evenRun && !sentenceRunsOn && d > Math.max(1.4 * step, step + 0.45 * c.size);
    // A line that ends in the style of the next line runs on into it, whatever opened the line
    // (a bold or larger label at the start of a paragraph must not be cut off from its paragraph).
    // So does a full line left in mid-sentence whose style still opens the next line: a run-in
    // heading too long for one line.
    const runsOn =
      (Math.abs(c.size - p.tailSize) <= 0.08 * c.size && p.tailFont === c.font) ||
      (c.leadFont !== c.font && full(p) && d <= 2.2 * c.size && !sentenceEnds(p.text, ':;') &&
        (c.leadFont === p.tailFont
          ? /^[a-z]/.test(c.text) || p.purity > 0.85
          : p.purity > 0.85 && !bodyFonts.has(p.font) && !bodyFonts.has(c.leadFont) && bodyFonts.has(c.font)));
    // A line of body text can be mostly a term quoted in smaller type. It is still part of
    // its paragraph: it is set in the paragraph's size for a good part of its length, starts
    // at the column's edge and keeps the line spacing. A display formula mixes sizes too, but
    // is set in from the edge or apart from the lines around it.
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.08 * Math.max(a, b);
    const inText = (a: Line): boolean => a.altSize > 0 && a.cells === 1 && a.x0 - region.x0 <= 2 * a.size;
    const inStep = commonStep > 0 && Math.abs(d - commonStep) <= 0.1 * commonStep;
    const oneSize =
      near(c.size, p.size) || (inStep && ((inText(p) && near(p.altSize, c.size)) || (inText(c) && near(c.altSize, p.size))));
    const sizeChange = !runsOn && !oneSize;
    // A short run of lines in a non-body font, then body text (or the reverse), is a heading boundary.
    const pSpecial = !bodyFonts.has(p.font) && p.purity > 0.85;
    const cSpecial = !bodyFonts.has(c.font) && c.purity > 0.85;
    const pShort = region.x1 - p.x1 > 1.5 * p.size || d > 1.15 * step;
    const fontBoundary =
      !runsOn &&
      p.font !== c.font &&
      ((pSpecial && !cSpecial && pShort && current.length <= 3 && current.every((l) => !bodyFonts.has(l.font))) ||
        // The last words of a sentence in a face of their own (the name of a species) are no heading.
        (cSpecial && !pSpecial && c.x1 - c.x0 < 0.8 * (region.x1 - region.x0) && !(unfinished && sentenceEnds(c.text))));
    const tableBoundary = (p.cells >= 3) !== (c.cells >= 3);
    // A page number at the head or the foot of the page is no line of the text next to it.
    const folio = (l: Line): boolean => /^\d{1,4}$/.test(l.text) && (l.bottom < 0.12 * pageHeight || l.top > 0.88 * pageHeight);
    // Numbered headings stacked without space between them: each section number opens its own.
    // A decimal that ends a sentence of the text at the start of a line ("... a value of" / "0.94. Profiles ...") is none.
    const numbered = pSpecial && cSpecial && SUBSECTION.test(c.text) && !(unfinished && !SUBSECTION.test(current[0].text));
    if (bigGap || sizeChange || fontBoundary || tableBoundary || numbered || d <= 0 || folio(p) !== folio(c)) {
      hard.push(current);
      current = [c];
    } else {
      current.push(c);
    }
  }
  hard.push(current);

  const blocks: Block[] = [];
  for (const group of hard) {
    for (const part of splitByIndent(group)) blocks.push(makeBlock(part, region, regionIndex, bodyFonts));
  }
  return blocks;
}
