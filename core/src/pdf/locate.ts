/**
 * Map a place on a PDF page to one exact word of the narrative.
 *
 * The place decides; the selected text only confirms. A word is never looked up by
 * searching the document for its text, because the same word usually occurs many times
 * and a text search would land on the first one.
 *
 * There are two ways in. The exact one starts from the viewer's text layer: every span of
 * that layer is one PDF.js run, placed at the run's origin, and the narrative remembers
 * which of its words each run became. The other is plain geometry (which line is the
 * point on, which word of the line is under it) and serves when no run can be matched.
 */

import type { Block, DropReason, LineRun, PdfNarrative, UnitLine } from './types';

export interface PagePoint {
  /** Zero-based page index. */
  page: number;
  /** Position on the page as a fraction of its width and height, origin top-left. */
  xn: number;
  yn: number;
}

/**
 * One end of a selection, as read off the PDF viewer's text layer. Positions are fractions
 * of the page as the viewer shows it, which may be turned; `rotation` says by how much.
 */
export interface TextLayerAnchor {
  /** Zero-based page index. */
  page: number;
  /** Total rotation of the page as shown, in degrees, or null when the viewer does not say. */
  rotation: number | null;
  /** Bounding box of the text-layer span that holds the word. */
  span: { x0: number; y0: number; x1: number; y1: number };
  /** How many words of that span come before the word. */
  wordInSpan: number;
  /** The middle of the word's first selected character. */
  point: { x: number; y: number };
}

export type LocateResult =
  | {
      ok: true;
      token: number;
      /** The reader's token at that index. */
      word: string;
      /** True when the word was reached through its text-layer run, not by geometry alone. */
      exact: boolean;
      /** True when the token agrees with the selected text (always true if no text was given). */
      matches: boolean;
    }
  | {
      ok: false;
      reason: 'filtered';
      drop: DropReason;
      /** Which block of the narrative the word is in. */
      block: number;
      /** Token of the first word that is read after the filtered block, if there is one. */
      resume: number | null;
    }
  | { ok: false; reason: 'no-text' };

/** Stands for a private-use character: a glyph the PDF does not name, which the reader's word spells out. */
const UNNAMED = '\uE000';

const comparable = (s: string): string =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^\[h\d\]/, '')
    // eslint-disable-next-line no-control-regex -- a glyph named by a number reaches the viewer as a control character
    .replace(/[\uE000-\uF8FF\u0001-\u0008\u000E-\u001F\u007F-\u009F]/g, UNNAMED)
    .replace(/[^a-z0-9\u00C0-\u024F\u0370-\u03FF\uE000]/g, '');

/** Does the reader's token agree with the first word of the selected text? */
function agrees(token: string, wanted: string): boolean {
  if (!wanted) return true;
  const t = comparable(token);
  if (t === wanted) return true;
  // The viewer shows an unnamed glyph as it is in the file; the token has its letters, or a sign that is no letter.
  if (wanted.includes(UNNAMED)) return new RegExp(`^${wanted.split(UNNAMED).join('.{0,3}')}$`).test(t);
  return t.length >= 2 && wanted.length >= 2 && (t.includes(wanted) || wanted.includes(t));
}

/** How well a run fits a text-layer span position; Infinity when it does not. */
function runCost(run: Pick<LineRun, 'x' | 'base' | 'size'>, x: number, y: number): number {
  const dx = Math.abs(run.x - x);
  // The viewer hangs a span from its baseline, so the middle of the span sits a little above it.
  const dy = Math.abs(run.base - 0.28 * run.size - y);
  if (dx > 1.5 || dy > 0.55 * Math.max(run.size, 5)) return Infinity;
  return dx + 0.2 * dy;
}

function lineAt(narrative: PdfNarrative, page: number, x: number, y: number, slack: number): UnitLine | null {
  let best: UnitLine | null = null;
  let bestCost = Infinity;
  for (const unit of narrative.units) {
    for (const line of unit.lines) {
      if (line.page !== page) continue;
      const height = line.bottom - line.top;
      const dy = y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0;
      const dx = x < line.x0 ? line.x0 - x : x > line.x1 ? x - line.x1 : 0;
      if (dy > 0.6 * slack * height || dx > 1.5 * slack * height) continue;
      // Vertical distance dominates: lines are stacked far closer than columns sit apart.
      const cost = dy * 4 + dx + Math.abs(y - (line.top + line.bottom) / 2) * 0.05;
      if (cost < bestCost) { bestCost = cost; best = line; }
    }
  }
  return best;
}

function filtered(narrative: PdfNarrative, block: Block): LocateResult {
  const at = narrative.blocks.indexOf(block);
  let resume: number | null = null;
  for (let i = at + 1; i < narrative.blocks.length; i++) {
    const next = narrative.blocks[i];
    if (!next.drop && next.token !== undefined) { resume = next.token; break; }
  }
  return { ok: false, reason: 'filtered', drop: block.drop as DropReason, block: at, resume };
}

function found(narrative: PdfNarrative, token: number, exact: boolean, wanted: string): LocateResult {
  const word = tokenTexts(narrative)[token] ?? '';
  return { ok: true, token, word, exact, matches: agrees(word, wanted) };
}

/**
 * Find the word under a point on the page.
 *
 * @param text  The selected text. It never moves the result further than to an immediate
 *              neighbour on the same line, for when the point falls between two words.
 * @param slack How far outside a line the point may fall and still count as on it: 1 for a
 *              point picked by hand, 0 for one that is known to lie on text.
 */
export function locateWord(narrative: PdfNarrative, point: PagePoint, text?: string, slack = 1): LocateResult {
  const size = narrative.pages[point.page];
  if (!size) return { ok: false, reason: 'no-text' };
  const x = point.xn * size.width;
  const y = point.yn * size.height;
  const wanted = comparable((text ?? '').trim().split(/\s+/)[0] ?? '');

  let line = lineAt(narrative, point.page, x, y, 0);
  if (!line) {
    for (const b of narrative.blocks) {
      if (b.page !== point.page || !b.drop) continue;
      if (x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.top - 2 && y <= b.bottom + 2) return filtered(narrative, b);
    }
    if (slack > 0) line = lineAt(narrative, point.page, x, y, slack);
  }
  if (!line || !line.wordToken.length) return { ok: false, reason: 'no-text' };

  let at = 0;
  let nearest = Infinity;
  for (let i = 0; i < line.wordToken.length; i++) {
    const d = x < line.wordX0[i] ? line.wordX0[i] - x : x > line.wordX1[i] ? x - line.wordX1[i] : 0;
    if (d < nearest) { nearest = d; at = i; }
  }
  const tokens = tokenTexts(narrative);
  if (wanted && !agrees(tokens[line.wordToken[at]] ?? '', wanted)) {
    // Word positions inside a run are estimated, so the point can be a word out. Look at
    // the nearest neighbours on the same line only; never further.
    for (const step of [1, -1, 2, -2]) {
      const i = at + step;
      if (i >= 0 && i < line.wordToken.length && agrees(tokens[line.wordToken[i]] ?? '', wanted)) { at = i; break; }
    }
  }
  return found(narrative, line.wordToken[at], false, wanted);
}

/**
 * Find the word at one end of a text-layer selection: through the run its span was made
 * from when that run is known, by the position of the word itself otherwise.
 */
export function locateAnchor(narrative: PdfNarrative, anchor: TextLayerAnchor, text?: string): LocateResult {
  const size = narrative.pages[anchor.page];
  if (!size) return { ok: false, reason: 'no-text' };
  // How far the user has turned the page in the viewer, beyond the rotation the PDF asks for.
  const turn = anchor.rotation === null ? 0 : (((anchor.rotation - size.rotation) % 360) + 360) % 360;
  // A point of the page as shown, as a point of the page the right way up.
  const upright = (u: number, v: number): PagePoint =>
    turn === 90 ? { page: anchor.page, xn: v, yn: 1 - u }
    : turn === 180 ? { page: anchor.page, xn: 1 - u, yn: 1 - v }
    : turn === 270 ? { page: anchor.page, xn: 1 - v, yn: u }
    : { page: anchor.page, xn: u, yn: v };
  // A run starts at the left end of its span, on the line through the span's middle; on a
  // turned page that end points another way.
  const { x0, y0, x1, y1 } = anchor.span;
  const cu = (x0 + x1) / 2;
  const cv = (y0 + y1) / 2;
  const origin = turn === 90 ? upright(cu, y0) : turn === 180 ? upright(x1, cv) : turn === 270 ? upright(cu, y1) : upright(x0, cv);
  const x = origin.xn * size.width;
  const y = origin.yn * size.height;
  const wanted = comparable((text ?? '').trim().split(/\s+/)[0] ?? '');

  let best: { line: UnitLine; run: LineRun } | null = null;
  let bestCost = Infinity;
  for (const unit of narrative.units) {
    for (const line of unit.lines) {
      if (line.page !== anchor.page) continue;
      for (const run of line.runs) {
        // Two runs can start at one spot (an accent set over the first letter of the next
        // run). The one that has the word in it is the one the span was made from.
        const cost = runCost(run, x, y) + (anchor.wordInSpan < run.words.length ? 0 : 0.3);
        if (cost < bestCost) { bestCost = cost; best = { line, run }; }
      }
    }
  }
  // The span of a run that was taken out of the page (a stamp, words printed over a line) can
  // lie right on a line that is read. It is that run all the same, and its text is not read.
  let gone = Infinity;
  for (const run of narrative.removed) {
    if (run.page === anchor.page) gone = Math.min(gone, runCost(run, x, y));
  }
  if (best && bestCost <= gone && best.run.words.length) {
    const word = best.run.words[Math.min(anchor.wordInSpan, best.run.words.length - 1)];
    const token = best.line.wordToken[word];
    if (token !== undefined) return found(narrative, token, true, wanted);
  }

  for (const b of narrative.blocks) {
    if (b.page !== anchor.page || !b.drop) continue;
    for (const line of b.lines) {
      if (line.runs.some((run) => runCost(run, x, y) < gone)) return filtered(narrative, b);
    }
  }
  if (gone < Infinity) return { ok: false, reason: 'no-text' };
  // No run of the narrative starts where this span does: text the pipeline never took in
  // (a watermark, a margin stamp), or a viewer that cuts its spans differently. Position is
  // then trusted only where it lies on a line and that line's word agrees with the selection.
  const hit = locateWord(narrative, upright(anchor.point.x, anchor.point.y), text, 0);
  return hit.ok && !hit.matches ? { ok: false, reason: 'no-text' } : hit;
}

const tokenCache = new WeakMap<PdfNarrative, string[]>();

/** The reader's token stream for a narrative: words, with one '\n' between units. */
export function tokenTexts(narrative: PdfNarrative): string[] {
  let tokens = tokenCache.get(narrative);
  if (!tokens) {
    tokens = [];
    narrative.units.forEach((u, i) => {
      if (i) tokens!.push('\n');
      tokens!.push(...u.text.split(' '));
    });
    tokenCache.set(narrative, tokens);
  }
  return tokens;
}

/** The narrative text between two located words, both included, for "read selection". */
export function textBetween(narrative: PdfNarrative, startToken: number, endToken: number): string {
  const tokens = tokenTexts(narrative);
  const a = Math.max(0, Math.min(startToken, endToken));
  const b = Math.min(tokens.length - 1, Math.max(startToken, endToken));
  let out = '';
  for (let i = a; i <= b; i++) {
    const t = tokens[i];
    if (t === '\n') out = out.trimEnd() + '\n';
    else out += (out && !out.endsWith('\n') ? ' ' : '') + t;
  }
  return out.trim();
}
