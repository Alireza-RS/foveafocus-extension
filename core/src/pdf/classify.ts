/**
 * Step 4: decide what each block is (title, heading, paragraph, caption, list,
 * table, equation, loose fragment) and remove page furniture: running headers
 * and footers, page numbers and footnotes.
 *
 * Every test here is about shape: how many lines, how full they are, which
 * font and size, where on the page. The only words consulted are the caption
 * labels ("Figure 3", "Table 2"), which open a caption in every publisher's style.
 */

import type { Block, Line } from './types';
import { BULLET, SUBSECTION, sentenceEnds } from './layout';

export interface BlockFeatures {
  text: string;
  words: number;
  /** Share of words that contain at least two letters. */
  alpha: number;
  /** Share of words that read as ordinary words (three or more letters, nothing else). */
  wordy: number;
  /**
   * Share of lettered words that start in lower case. Running prose is mostly lower-case
   * words; lists of names, affiliations and keywords are mostly capitalised ones.
   */
  lower: number;
  wordsPerLine: number;
  /** Median line width as a share of the region width, last line excluded. */
  fill: number;
  /** Share of lines cut into two or more cells by wide gaps. */
  celled: number;
  /** Share of words that contain a digit. */
  digits: number;
  endsSentence: boolean;
  startsUpper: boolean;
  allCaps: boolean;
}

const featureCache = new WeakMap<Block, BlockFeatures>();

/** Call after changing a block's lines, so that its features are measured again. */
export function forgetFeatures(b: Block): void {
  featureCache.delete(b);
}

export function blockText(b: Block): string {
  return b.lines.map((l) => l.text).join(' ');
}

export function features(b: Block): BlockFeatures {
  const cached = featureCache.get(b);
  if (cached) return cached;

  const text = blockText(b);
  const tokens = text.split(' ').filter(Boolean);
  let alpha = 0, wordy = 0, lettered = 0, lower = 0;
  for (const t of tokens) {
    const initial = /[A-Za-z\u00C0-\u024F]/.exec(t);
    if (initial) {
      lettered++;
      if (initial[0] === initial[0].toLowerCase() && initial[0] !== initial[0].toUpperCase()) lower++;
    }
    if (/[A-Za-z\u00C0-\u024F]{2}/.test(t)) alpha++;
    if (/^[("'\u201C\u2018[]?[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\u2019-]{2,}[)"'\u201D\u2019\].,;:!?]*$/.test(t)) wordy++;
  }
  const regionWidth = Math.max(1, b.regionX1 - b.regionX0);
  const widths = (b.lines.length > 1 ? b.lines.slice(0, -1) : b.lines).map((l) => (l.x1 - l.x0) / regionWidth).sort((x, y) => x - y);
  const letters = text.replace(/[^A-Za-z\u00C0-\u024F]/g, '');
  const f: BlockFeatures = {
    text,
    words: tokens.length,
    alpha: tokens.length ? alpha / tokens.length : 0,
    wordy: tokens.length ? wordy / tokens.length : 0,
    lower: lettered ? lower / lettered : 0,
    wordsPerLine: tokens.length / b.lines.length,
    fill: widths[widths.length >> 1] ?? 0,
    celled: b.lines.filter((l) => l.cells >= 2).length / b.lines.length,
    digits: tokens.length ? tokens.filter((t) => /\d/.test(t)).length / tokens.length : 0,
    endsSentence: sentenceEnds(text),
    startsUpper: /^["'\u201C\u2018([]?[A-Z0-9]/.test(text),
    allCaps: letters.length >= 4 && letters === letters.toUpperCase(),
  };
  featureCache.set(b, f);
  return f;
}

const CAPTION_LABEL =
  /^(?:(?:extended data|supplementa(?:ry|l)|supp\.?|suppl\.?|additional|appendix)\s+)?(?:fig(?:ure)?s?|table|scheme|chart|box|plate|algorithm|listing|video|movie|graph|diagram|exhibit)\.?\s*((?:S|A|B)?\d+(?:\.\d+)*[A-Za-z]?|[IVXL]{1,6})\b/i;

/** The float label that opens a line ("Figure 3", "Table S2", "TABLE IV"), if any. A Roman number counts in capitals only. */
function floatLabel(text: string): RegExpExecArray | null {
  const m = CAPTION_LABEL.exec(text);
  return m && (/\d/.test(m[1]) || m[1] === m[1].toUpperCase()) ? m : null;
}

/** A caption opens with a float label and is set off from the text it sits beside. */
function isCaption(b: Block, bodySize: number, bodyFonts: ReadonlySet<string>): boolean {
  // "(See figure on next page.)" on a line of its own, above the legend it speaks of.
  const first = b.lines.length > 1 && /^\((?:see|continued)[^)]{3,40}\)$/i.test(b.lines[0].text) ? b.lines[1] : b.lines[0];
  const m = floatLabel(first.text);
  if (!m) return false;
  const after = first.text.slice(m[0].length);
  // "Figure 3 shows that ..." opening an ordinary paragraph is not a caption.
  const punctuated = /^\s*[.:|\u2014\u2013-]/.test(after) || after.trim() === '';
  const styled = !bodyFonts.has(first.leadFont) || b.size < 0.95 * bodySize || b.size > 1.05 * bodySize;
  const labelOnly = first.leadWords <= 3 && first.leadFont !== b.font;
  return punctuated || labelOnly || (styled && /^\s+[A-Z]/.test(after));
}

const CONTENTS_ENTRY = /(?:[.\u00B7\u2026] ?){5,} ?(?:\d{1,4}|[ivxlc]{1,7})$/;
const NUMBERED = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVX]{1,5}\.|[A-Z]\.)\s+[A-Za-z]/;

const NUMBER_PREFIX = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVX]{1,5}\.|[A-Z]\.)\s+/;
/** Opens as a title does: with a capital or a figure, or with a term that carries its capital further in ("mRNA", "iPSC"). */
export const TITLE_START = /^["'\u201C\u2018([]?(?:[A-Z0-9\u0391-\u03A9]|[a-z\u03B1-\u03C9]{1,5}[A-Z0-9-])/;

interface HeadingContext {
  bodySize: number;
  bodyFonts: ReadonlySet<string>;
  /** Left and right edge of the text on each page. */
  span: ReadonlyMap<number, { x0: number; x1: number }>;
}

function looksLikeHeading(b: Block, prev: Block | undefined, next: Block | undefined, ctx: HeadingContext): boolean {
  const { bodySize, bodyFonts } = ctx;
  const f = features(b);
  // Three lines at most, or five in display type, which wraps sooner in a narrow column.
  if (b.lines.length > (b.size >= 1.2 * bodySize ? 5 : 3) || f.words > 20 || f.words < 1) return false;
  // A numbered heading often has a wide gap after its number; that gap is not a table cell.
  const gapAfterNumber = b.lines.every((l) => l.cells <= 2) && NUMBERED.test(f.text);
  if ((f.celled > 0 && !gapAfterNumber) || f.alpha < 0.5) return false;
  if (!/[A-Za-z\u00C0-\u024F]{3}/.test(f.text)) return false;
  if (/[,;]$/.test(f.text) || /[;@]|https?:|\bdoi\b/i.test(f.text)) return false;
  // A line that ends in a colon announces what follows it; a title of a few words may.
  if (f.text.endsWith(':') && f.words > 4) return false;
  // Terms set apart by bars or dots are a line of key words.
  if ((f.text.match(/\s[|\u00B7\u2022\uFFFD]\s/g) ?? []).length >= 2) return false;
  // Mostly figures, the section number aside: a row of a table, not a title.
  const title = f.text.replace(NUMBER_PREFIX, '');
  if ((title.match(/\d/g) ?? []).length > 0.25 * title.replace(/\s/g, '').length) return false;
  // A run of initials and commas is a list of authors: a reference entry, not a title. So
  // are names that carry the marks of their affiliations ("A. Writer\u00B9, B. Author\u00B2*").
  if ((f.text.match(/\b[A-Z]\.(?=[,\s])/g) ?? []).length >= 3 || (f.text.match(/,/g) ?? []).length > 4) return false;
  if ((f.text.match(/[a-z\u00DF-\u024F][\u00B9\u00B2\u00B3\u2070-\u2079\u2020\u2021*,]*[\u00B9\u00B2\u00B3\u2070-\u2079\u2020\u2021*](?=,| and | & |$)/g) ?? []).length >= 2) return false;
  const numbered = NUMBERED.test(f.text) && f.words <= 12;
  // A number with lower case after it ("2. calculation of the weights") marks a step in a
  // list; the title of a numbered section opens as a title does.
  if (/^\d{1,2}\.\s/.test(f.text) && !TITLE_START.test(title)) return false;
  // A full stop closes a sentence, not a heading, except after a very short numbered title
  // ("4.1. Model architecture."). Numbered statements in a list are sentences. A heading can ask a question.
  const closed = /[.!]["'\u201D\u2019)\]]?$/.test(f.text);
  if (closed && (f.words > (numbered ? 5 : 3) || !TITLE_START.test(f.text))) return false;
  // Nor does a heading run from one sentence into the next.
  if (/[a-z)][.!?]\s+[A-Z]/.test(f.text.replace(NUMBERED, 'x '))) return false;

  const beside = (o: Block | undefined): o is Block => !!o && o.page === b.page && o.region === b.region;
  // The last words of a text left in mid-sentence, in that text's own face, are no heading.
  if (prev && prev.page === b.page && prev.font === b.font && Math.abs(prev.size - b.size) < 0.3 && prev.lines.length >= 2) {
    const pf = features(prev);
    if (pf.words >= 8 && pf.lower >= 0.35 && !pf.endsSentence) return false;
  }
  // One of a run of numbered items ("2. ...", "3. ...", "4. ...") is an item of a list.
  const itemNumber = (o: Block | undefined): number => Number(/^\(?(\d{1,2})[.)]\s/.exec(o?.lines[0].text ?? '')?.[1] ?? NaN);
  if ([prev, next].some((o) => beside(o) && Math.abs(o.x0 - b.x0) <= 2 && Math.abs(itemNumber(o) - itemNumber(b)) === 1)) return false;
  /** Running text in the heading's own column. */
  const prose = (o: Block | undefined): o is Block => {
    if (!beside(o)) return false;
    const of = features(o);
    return of.words >= 8 && of.lower >= 0.35 && of.wordy >= 0.3 && of.celled === 0 && !floatLabel(o.lines[0].text);
  };
  const em = b.size;
  const columnWidth = b.regionX1 - b.regionX0;
  const lastLine = b.lines[b.lines.length - 1];
  const short = b.lines.length === 1 || lastLine.x1 - b.regionX0 < 0.85 * columnWidth;
  const pure = b.lines.every((l) => l.purity > 0.8);
  // In a face of its own: one that the body is not set in; or several, none of them the body's
  // (a term in italics inside a bold title); or one that the text right under it is not set in.
  const offBody = b.lines.every((l) => !bodyFonts.has(l.font) && !bodyFonts.has(l.leadFont) && !bodyFonts.has(l.tailFont));
  const otherFont =
    (pure && !b.plain) || offBody ||
    (pure && prose(next) && next.font !== b.font && TITLE_START.test(f.text) && lastLine.x1 - b.regionX0 < 0.85 * columnWidth);
  const below = beside(next) ? next.top - b.bottom : Infinity;
  const above = beside(prev) ? b.top - prev.bottom : Infinity;

  // A label in the style of the text itself, alone on its line: a few words that open as a
  // title does and close with no stop, set off from what stands above and close over the
  // paragraph they head, at its left edge.
  const bare =
    b.lines.length === 1 && b.plain && Math.abs(b.size - bodySize) <= 0.08 * bodySize && f.words <= 8 && TITLE_START.test(f.text) &&
    !/[.,;:!?)]$/.test(f.text) && b.x1 - b.regionX0 < 0.7 * columnWidth && prose(next) && below <= 1.5 * bodySize &&
    Math.abs(b.x0 - next.x0) <= 2 * em && (!beside(prev) || ((prev.kind !== 'heading' || above > 1.5 * bodySize) && above >= below + 0.3 * bodySize));
  if (bare) return true;

  // "3.2.1. Calibration": a section number of several parts marks a heading in any size, where
  // it heads running text or the subsection it is the parent of. Figures and a word in the
  // column of a table ("5.9 Housing") head neither.
  const section = !b.plain && f.words <= 16 && SUBSECTION.test(f.text) ? /^[\d.]+\d/.exec(f.text)?.[0] : undefined;
  const heads = (o: Block | undefined): boolean => {
    if (!section || !beside(o)) return false;
    const of = features(o);
    return of.text.startsWith(`${section}.`) || (of.words >= 6 && of.lower >= 0.35 && of.wordy >= 0.3);
  };
  if (b.size < 0.92 * bodySize && !heads(next)) {
    // Smaller than the body. Small labels inside figures head nothing. A heading heads small
    // print of its own size (end matter is often set this way), or is only a little smaller
    // than the text and stands close over it in a face of its own, with a number or in capitals.
    const overText = b.size >= 0.85 * bodySize && (otherFont || numbered || f.allCaps) && prose(next) && below <= 2 * bodySize;
    if (!overText) {
      if (!next || b.size < 0.7 * bodySize || b.size < 0.95 * next.size) return false;
      const nf = features(next);
      if (nf.words < 6 || nf.lower < 0.35 || nf.wordy < 0.3) return false;
    }
  }

  // At the left edge of its column or of the text it heads, or centred: in its column, over
  // the paragraph next to it, or on the page.
  const mid = (o: { x0: number; x1: number }): number => (o.x0 + o.x1) / 2;
  const over = (o: Block | undefined): boolean =>
    beside(o) && o.lines.length >= 2 && o.x1 - o.x0 >= 1.5 * (b.x1 - b.x0) && Math.abs(mid(b) - mid(o)) < 0.06 * (o.x1 - o.x0);
  const page = ctx.span.get(b.page);
  const atLeft = b.x0 - b.regionX0 < 2.5 * em || (prose(next) && Math.abs(b.x0 - next.x0) <= em);
  const centred =
    Math.abs(mid(b) - (b.regionX0 + b.regionX1) / 2) < 0.06 * columnWidth || over(next) || over(prev) ||
    (!!page && Math.abs(mid(b) - mid(page)) < 0.03 * (page.x1 - page.x0));
  if (!atLeft && !centred) return false;

  const bigger = b.size >= 1.08 * bodySize;
  if (!(bigger || otherFont || f.allCaps || numbered)) return false;
  // A title in a face of its own may fill its last line. It does not close as a sentence
  // does, and the text that follows is set in another face.
  if (!short && !bigger && !(otherFont && !closed && b.lines.length <= 3 && prose(next) && next.font !== b.font)) return false;

  // A heading stands out from the text it heads, not merely from the document's body size:
  // an abstract set a little larger than the body is not a run of headings.
  const standsOut =
    !next || numbered || f.allCaps || next.size <= 0.96 * b.size || next.font !== b.font || next.lines.length <= 2;
  if (!standsOut) return false;

  // Set apart from what precedes it: first in its region, after a gap, or after another heading.
  // A line in a face of its own that follows a finished paragraph needs no gap to stand apart.
  const apart =
    !prev || !beside(prev) ||
    prev.kind === 'heading' || prev.kind === 'title' ||
    above > 0.45 * bodySize ||
    (otherFont && b.lines.length === 1 && TITLE_START.test(f.text) && features(prev).endsSentence);
  return apart || bigger;
}

const sizeKey = (b: Block): number => Math.round(b.size * 4) / 4;

/**
 * The sizes the running text is set in. A document may set part of its text smaller than the
 * rest (the methods of many journals): a size that carries long paragraphs in a body face,
 * forty lines of them or more, is text and not small print.
 */
export function runningSizes(blocks: Block[]): Set<number> {
  const lines = new Map<number, number>();
  for (const b of blocks) {
    if (b.lines.length < 6 || !b.plain) continue;
    const f = features(b);
    if (f.fill < 0.8 || f.celled >= 0.2 || f.lower < 0.6 || f.wordy < 0.4) continue;
    lines.set(sizeKey(b), (lines.get(sizeKey(b)) ?? 0) + b.lines.length);
  }
  return new Set([...lines].filter(([, n]) => n >= 40).map(([size]) => size));
}

/** "CI, confidence interval; NA, not applicable; SD = standard deviation": entry after entry of a key. */
function isKey(text: string): boolean {
  const entries = text.split(/;\s+/).map((e) => e.trim());
  // The term that is explained carries a capital or a figure ("CI", "5hmC"); "however, ..." is no entry.
  const keyed = entries.filter((e) => /^(?=[^\s,=:]*[A-Z0-9])[^\s,=:]{1,15}(?:\s[^\s,=:]{1,10})?\s?[,=:\uFFFD]\s+\S/.test(e)).length;
  if (entries.length >= 3) return keyed >= 0.6 * entries.length;
  // A key of two entries: both are entries, and neither term is a word that merely opens a sentence.
  return entries.length === 2 && keyed === 2 && entries.every((e) => /^[^\s,=:]*(?:\d|[^\s,=:][A-Z])/.test(e));
}

/** Give every block a kind. Does not drop anything. */
export function classifyBlocks(blocks: Block[], bodySize: number, bodyFonts: ReadonlySet<string>, bodyMono: boolean): void {
  const span = new Map<number, { x0: number; x1: number }>();
  for (const b of blocks) {
    if (b.lines.length < 2) continue;
    const s = span.get(b.page);
    if (s) {
      s.x0 = Math.min(s.x0, b.regionX0);
      s.x1 = Math.max(s.x1, b.regionX1);
    } else span.set(b.page, { x0: b.regionX0, x1: b.regionX1 });
  }
  const ctx: HeadingContext = { bodySize, bodyFonts, span };
  const running = runningSizes(blocks);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const f = features(b);
    const prev = blocks[i - 1];

    // Leader dots running to a page number: entries of a list of contents, figures or tables.
    const listed = b.lines.filter((l) => CONTENTS_ENTRY.test(l.text)).length;
    if (listed > 0 && listed >= b.lines.length / 3) {
      b.kind = 'fragment';
      b.drop = 'front-matter';
      b.note = 'entries of a list of contents';
      continue;
    }
    if (isCaption(b, bodySize, bodyFonts)) {
      b.kind = 'caption';
      continue;
    }
    if (floatLabel(b.lines[0].text) && f.words <= 8 && !f.endsSentence) {
      // "Table 3 (Continued)" and similar: the label of a float, with nothing to read in it.
      // It still marks where its float is.
      b.kind = 'caption';
      b.drop = 'figure-or-table';
      b.note = 'label of a figure or table';
      continue;
    }
    if (!bodyMono && b.lines.filter((l) => l.mono).length > b.lines.length / 2) {
      b.kind = 'fragment';
      b.note = 'fixed-pitch font (code listing)';
      continue;
    }
    // A page number at the head of a column is not the text that a heading under it follows.
    const heading = looksLikeHeading(b, prev && prev.lines.length === 1 && /^\d{1,4}$/.test(prev.lines[0].text) ? undefined : prev, blocks[i + 1], ctx);
    // The gap after the number of a heading that wraps is not the edge of a table column.
    const numberGap = heading && b.lines[0].cells === 2 && b.lines.slice(1).every((l) => l.cells === 1);
    if (!numberGap && ((b.lines.length >= 2 && f.celled >= 0.5) || (b.lines.some((l) => l.cells >= 3) && f.celled >= 0.34))) {
      b.kind = 'table';
      b.note = 'lines cut into cells';
      continue;
    }
    if (heading) {
      b.kind = 'heading';
      continue;
    }

    if ((f.text.match(/\s[|\u00B7\u2022]\s/g) ?? []).length >= 3 && !f.endsSentence) {
      b.kind = 'fragment';
      b.note = 'list of terms, not prose';
      continue;
    }
    if (b.size < 0.93 * bodySize && isKey(f.text)) {
      b.kind = 'fragment';
      b.note = 'key of abbreviations';
      continue;
    }
    const bulleted = BULLET.test(f.text);
    // Prose is mostly lower-case words. Capitals throughout can still be prose (a notice set
    // in capitals), but not when every other word is a number: that is a column of codes.
    const sentenceLike = f.alpha >= 0.55 && f.wordy >= 0.3 && (f.lower >= 0.35 || (f.allCaps && f.digits < 0.25));
    // Several lines of prose either fill their column or contain the end of a sentence.
    // Stacked table cells and labels do neither.
    const sentenceInside = /[a-z]{3}[.!?]["'\u201D\u2019)\]]?\s+[A-Z]/.test(f.text);
    const flows = b.lines.length === 1 || f.fill >= 0.7 || f.endsSentence || sentenceInside;
    // Short pieces: keep only what reads as a sentence in the body style.
    const bodyLike = Math.abs(b.size - bodySize) <= 0.08 * bodySize;
    // A column of a table can hold words: a few to a line, line after line, and never the
    // end of a sentence. Prose that narrow, outside the body style, does not go on like that.
    const stacked =
      b.lines.length >= 3 && f.wordsPerLine < 4.5 && b.size <= 1.05 * bodySize && !(bodyLike && b.plain) && !f.endsSentence && !sentenceInside;
    // Small print in a size the running text is not set in: a line or three that stop
    // without a full stop are the words of a label, a box of a chart, a cell of a table.
    // (Text that only pauses at the foot of its column fills every line it has, from one
    // left edge; the lines of a label are centred or ragged.)
    const second = b.lines[1];
    const pauses =
      !!second && b.lines.every((l) => b.regionX1 - l.x1 <= 2 * l.size) && b.lines.slice(2).every((l) => Math.abs(l.x0 - second.x0) <= 1) &&
      b.lines[0].x0 - second.x0 >= -1 && b.lines[0].x0 - second.x0 <= 2.5 * b.size;
    const label =
      b.size < 0.9 * bodySize && !running.has(sizeKey(b)) && b.lines.length <= 3 && !f.endsSentence && !sentenceInside && !bulleted &&
      !f.text.endsWith(':') && !pauses;
    if (f.words >= 8 && sentenceLike && flows && !stacked && !label && (b.lines.length === 1 || f.wordsPerLine >= 2.6)) {
      b.kind = bulleted ? 'list' : 'paragraph';
      continue;
    }
    if (f.words >= 2 && sentenceLike && bodyLike && (f.endsSentence || bulleted || f.text.endsWith(':')) && f.celled === 0) {
      b.kind = bulleted ? 'list' : 'paragraph';
      continue;
    }
    // Lines of the text itself, in its face and size and as wide as the column, stay text
    // however many figures and bracketed asides they carry.
    if (b.plain && bodyLike && b.lines.length >= 2 && f.fill >= 0.85 && f.celled === 0 && f.alpha >= 0.4 && f.wordy >= 0.2 && f.lower >= 0.5) {
      b.kind = bulleted ? 'list' : 'paragraph';
      continue;
    }
    if (f.wordy < 0.3 && f.words <= 40) {
      b.kind = 'equation';
      b.note = 'few ordinary words';
    } else {
      b.kind = 'fragment';
      b.note = 'too short to be prose';
    }
  }
}

/**
 * Second thoughts on the pieces that did not read as prose on their own. Two kinds are text
 * after all, and what stands next to them shows it. The item of a list is short and may be
 * all names and numbers ("4. Bench lamp (Example Works, cat. no. 840)"), but it stands in
 * a row of items, some of which do read as prose. And a line or two under a paragraph that
 * stops in mid-sentence, at the paragraph's own edge and line spacing, is the rest of the
 * sentence: its last words, or a parenthesis of figures that looked like a row of a table.
 * So are a few such lines at the head of a column, where the text at the foot of the column
 * before was left in mid-sentence and these lines carry it on in lower case.
 */
export function reclaimText(blocks: Block[]): void {
  const loose = (b: Block): boolean => !b.drop && (b.kind === 'fragment' || b.kind === 'equation');
  const beside = (a: Block, b: Block): boolean =>
    a.page === b.page && a.region === b.region && Math.abs(a.x0 - b.x0) <= 2 && Math.abs(a.size - b.size) < 0.3;
  const item = (b: Block): boolean => !b.drop && b.lines.length <= 4 && BULLET.test(b.lines[0].text) && (b.kind === 'list' || loose(b));

  for (let i = 0; i < blocks.length; ) {
    let j = i + 1;
    if (item(blocks[i])) {
      while (j < blocks.length && item(blocks[j]) && beside(blocks[j - 1], blocks[j])) j++;
      const row = blocks.slice(i, j);
      if (row.length >= 2 && row.some((b) => b.kind === 'list')) {
        for (const b of row) {
          if (b.kind === 'list') continue;
          b.kind = 'list';
          b.note = 'item of a list';
        }
      }
    }
    i = j;
  }

  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const above = blocks[i - 1];
    if (!(loose(b) || (b.kind === 'table' && !b.drop)) || b.lines.length > 2) continue;
    if (above.drop || (above.kind !== 'paragraph' && above.kind !== 'list') || above.page !== b.page) continue;
    const last = above.lines[above.lines.length - 1];
    const follows = Math.abs(b.x0 - above.x0) <= 2 && Math.abs(b.size - above.size) < 0.3 && b.top - last.bottom <= 0.9 * b.size && b.top > last.top;
    if (!follows || sentenceEnds(last.text, ':;')) continue;
    // A row of a table has more rows under it; the end of a sentence has not.
    const next = blocks[i + 1];
    if (next && next.page === b.page && next.region === b.region && !next.drop && (next.kind === 'table' || loose(next))) continue;
    b.kind = 'paragraph';
    b.note = 'carries on the sentence above';
  }

  const numbers = (o: Block): boolean => o.lines.every((l) => /^[([]\d{1,3}(?:\.\d{1,3})?[a-z]?[)\]]$/.test(l.text));
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (!loose(b) || b.lines.length > 3) continue;
    // It heads its column: nothing stands over it there but the numbers of formulas.
    let head = i - 1;
    while (head >= 0 && blocks[head].page === b.page && blocks[head].region === b.region && numbers(blocks[head])) head--;
    if (head >= 0 && blocks[head].page === b.page && blocks[head].region === b.region) continue;
    const f = features(b);
    if (f.alpha < 0.5 || f.celled > 0 || !/^[a-z\u00DF-\u00FF]/.test(f.text)) continue;
    // The last text before it, past whatever stands at the foot of that column and the head of this one.
    let k = i - 1;
    while (k >= 0 && k >= i - 6 && blocks[k].kind !== 'paragraph' && blocks[k].kind !== 'list' && blocks[k].kind !== 'heading') k--;
    const open = blocks[k];
    if (!open || blocks[k].kind === 'heading' || open.drop || b.page - open.page > 1 || Math.abs(open.size - b.size) >= 0.3) continue;
    if (sentenceEnds(open.lines[open.lines.length - 1].text, ':;')) continue;
    b.kind = 'paragraph';
    b.note = 'carries on the sentence from the column before';
  }

  // A sentence set out in steps: its opening words, then each step on a line of its own with
  // a formula under it, and then the sentence goes on in lower case. The short lines between
  // a finished text (or a heading) and that lower case, at its left edge and in its print,
  // none of them closing a sentence, are the sentence's own words.
  for (let i = 1; i < blocks.length; i++) {
    const rest = blocks[i];
    if (rest.drop || rest.kind !== 'paragraph' || !/^[a-z\u00DF-\u00FF]/.test(rest.lines[0].text)) continue;
    const inColumn = (o: Block | undefined): o is Block => !!o && o.page === rest.page && o.region === rest.region;
    const words = (o: Block): boolean => {
      const f = features(o);
      return (
        !o.drop && (o.kind === 'fragment' || o.kind === 'paragraph' || o.kind === 'list') && o.lines.length <= 3 && Math.abs(o.x0 - rest.x0) <= 2 &&
        Math.abs(o.size - rest.size) < 0.3 && o.plain === rest.plain && f.alpha >= 0.5 && f.celled === 0 && !sentenceEnds(o.lines[o.lines.length - 1].text)
      );
    };
    let k = i - 1;
    while (k >= i - 6 && inColumn(blocks[k]) && (loose(blocks[k]) || words(blocks[k]))) k--;
    const before = blocks[k];
    const opening = blocks[k + 1];
    if (k === i - 1 || !inColumn(before) || !words(opening) || !/^[A-Z]/.test(opening.lines[0].text)) continue;
    const finished = (before.kind === 'paragraph' || before.kind === 'list') && !before.drop && sentenceEnds(before.lines[before.lines.length - 1].text);
    if (before.kind !== 'heading' && !finished) continue;
    for (const o of blocks.slice(k + 1, i)) {
      if (o.kind !== 'fragment' || !words(o)) continue;
      o.kind = 'paragraph';
      o.note = 'words of a sentence set out in steps';
    }
  }
}

const FIGURE_LABEL = /^(?:\S+\s+){0,2}fig/i;
const CONTINUED = /\bcontinued on (?:the )?next page\b/i;

/**
 * A figure legend seldom arrives as one block. Its label is often set in another face or
 * size than its text, a long legend is set in two columns under its figure, and some
 * journals run a legend on over the page. Gather the pieces: small print in the legend's
 * own size that follows straight on from it.
 */
export function joinCaptionParts(blocks: Block[], bodySize: number): void {
  const loosePiece = (n: Block, like: Line, orHeading = false): boolean =>
    !n.drop && (n.kind === 'paragraph' || n.kind === 'list' || n.kind === 'fragment' || n.kind === 'equation' || (orHeading && n.kind === 'heading')) &&
    Math.abs(n.size - like.size) <= 0.6 && n.lines.every((l) => l.cells <= 2);
  // Small print, or another face than the text; print only a little smaller than the text counts when it is the legend's own.
  const legendText = (n: Block, like: Line): boolean =>
    loosePiece(n, like) && (n.size <= 0.93 * bodySize || !n.plain || (n.size < 0.97 * bodySize && Math.abs(n.size - like.size) <= 0.1));
  const lastLine = (b: Block): Line => b.lines[b.lines.length - 1];
  const runsOn = (b: Block): boolean => !sentenceEnds(lastLine(b).text);
  /** The size most of the text of a page is set in, its legends aside. */
  const printOf = (page: number): number => {
    const lines = new Map<number, number>();
    for (const b of blocks) {
      if (b.page === page && !b.drop && b.plain && (b.kind === 'paragraph' || b.kind === 'list')) lines.set(sizeKey(b), (lines.get(sizeKey(b)) ?? 0) + b.lines.length);
    }
    return [...lines].sort((a, z) => z[1] - a[1])[0]?.[0] ?? 0;
  };

  const absorb = (c: Block, at: number): void => {
    const n = blocks[at];
    c.lines.push(...n.lines);
    c.x0 = Math.min(c.x0, n.x0);
    c.x1 = Math.max(c.x1, n.x1);
    c.bottom = Math.max(c.bottom, n.bottom);
    forgetFeatures(c);
    blocks.splice(at, 1);
  };
  /** Take the blocks at `at` onwards for as long as they follow the legend at its own line spacing. */
  const absorbBelow = (c: Block, at: number, region: number, figure: boolean): void => {
    for (;;) {
      const n = blocks[at];
      const last = lastLine(c);
      // Straight below means in the same column, or at least starting at the same left edge.
      const below = !!n && n.page === c.page && (n.region === region || Math.abs(n.x0 - last.x0) <= 2);
      if (!below || n.top - last.bottom > 0.75 * Math.max(last.size, n.size)) return;
      // A label standing alone ("FIGURE 2") may be set in a size of its own; its text follows it.
      const labelOnly = c.lines.length === 1 && features(c).words <= 3;
      if (CONTINUED.test(blockText(n))) return;
      // A sentence left hanging that the next line carries on is one text, whatever its style
      // and whatever those few words alone were taken for.
      const carriesOn = runsOn(c) && /^[a-z(]/.test(n.lines[0].text) && loosePiece(n, last, true);
      // A table's title may wrap; what follows a finished title is the table. Under a label that
      // stands alone ("Table 2"), the title is the line or two of words that come next.
      const titled =
        labelOnly && !n.drop && (n.kind === 'paragraph' || n.kind === 'fragment') && n.lines.length <= 4 && n.lines.every((l) => l.cells <= 2) &&
        features(n).wordy >= 0.5 && /^[A-Z]/.test(n.lines[0].text);
      // The part of a legend that describes one panel ("(b) Box plot of ...", "c, The same after ...")
      // stands right under the part before it in the legend's own size, whatever that size is.
      const panel =
        !n.drop && (n.kind === 'paragraph' || n.kind === 'list') && Math.abs(n.size - last.size) <= 0.3 && n.lines.every((l) => l.cells <= 2) &&
        /^(?:\([a-zA-Z]\)|[a-zA-Z][,.)])\s/.test(n.lines[0].text);
      if (figure ? carriesOn || panel || legendText(n, labelOnly ? n.lines[0] : last) : titled || (carriesOn && n.lines.length <= 2)) {
        absorb(c, at);
        continue;
      }
      // The last line of a title can arrive glued to the first row of its float. A title left
      // in mid-sentence takes the line that finishes the sentence, and no more; a label that
      // stands alone takes the one line that is its title.
      const tail = n.lines[0];
      const glued = { ...n, lines: [tail] };
      if (
        n.lines.length > 1 && !n.drop && tail.cells <= 2 && Math.abs(tail.size - last.size) <= 0.6 &&
        (labelOnly && !figure
          ? /^[A-Z]/.test(tail.text) && !runsOn(glued) && features(glued).wordy >= 0.5
          : runsOn(c) && /^[a-z(]/.test(tail.text) && !runsOn(glued))
      ) {
        c.lines.push(tail);
        c.x1 = Math.max(c.x1, tail.x1);
        c.bottom = Math.max(c.bottom, tail.bottom);
        n.lines = n.lines.slice(1);
        n.top = n.lines[0].top;
        forgetFeatures(c);
        forgetFeatures(n);
      }
      return;
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const c = blocks[i];
    if (c.kind !== 'caption' || c.drop) continue;
    const figure = FIGURE_LABEL.test(c.lines[0].text);
    // The text of a legend can lie in another strip of the page than its title: straight under
    // it all the same, at its left edge, though not next to it in order.
    let below = i + 1;
    if (figure) {
      const title = lastLine(c);
      const under = (n: Block | undefined): boolean =>
        !!n && !n.drop && n.page === c.page && Math.abs(n.x0 - title.x0) <= 2 && n.top >= title.bottom - 0.3 * title.size &&
        n.top - title.bottom <= 0.75 * Math.max(title.size, n.size);
      if (!under(blocks[below])) {
        const k = blocks.findIndex((n, j) => j > i + 1 && j <= i + 16 && n.kind !== 'caption' && under(n));
        if (k > 0) below = k;
      }
    }
    absorbBelow(c, below, c.region, figure);
    // A label with no text to it ("Figure 2." under a figure whose legend is on another page)
    // says nothing, and nor does one that only points to where the legend is.
    const label = floatLabel(blockText(c));
    if (label && /^[^A-Za-z0-9]*(?:see (?:the )?(?:next|previous|following|facing|opposite) page for (?:the )?(?:caption|legend)[^A-Za-z0-9]*)?$/i.test(blockText(c).slice(label[0].length))) {
      c.drop = 'figure-or-table';
      c.note = 'label of a figure or table, with no text';
    }
    if (!figure) continue;

    // The second column of a legend starts level with the first, to its right, and is about as long.
    const firstColumn = c.lines.length;
    const beside = blocks.findIndex(
      (n, k) =>
        k > i && n.page === c.page && n.region !== c.region && n.x0 > c.x1 &&
        Math.abs(n.top - c.top) <= 0.6 * c.size && n.lines.length <= firstColumn + 1 &&
        // In small print; or in the legend's own size, where that is not the size of the text of
        // the page or where it carries on in lower case the sentence the first column left unfinished.
        (legendText(n, lastLine(c)) ||
          (loosePiece(n, lastLine(c)) && Math.abs(n.size - lastLine(c).size) <= 0.3 &&
            (Math.abs(n.size - printOf(c.page)) > 0.6 || (runsOn(c) && /^[a-z\u00DF-\u00FF]/.test(n.lines[0].text)))))
    );
    if (beside > 0) {
      const region = blocks[beside].region;
      absorb(c, beside);
      absorbBelow(c, beside, region, true);
    }

    // A legend that stops in mid-sentence at the end of a full line goes on elsewhere: in the
    // next text in its own print that opens in lower case, further on or over the page, with
    // no other legend before it.
    const stop = lastLine(c);
    if (c.lines.length >= 2 && runsOn(c) && stop.x1 - c.regionX0 > 0.9 * (c.regionX1 - c.regionX0)) {
      for (let k = i + 1; k < blocks.length && blocks[k].page <= c.page + 1 && blocks[k].kind !== 'caption'; k++) {
        const n = blocks[k];
        if (n.kind !== 'paragraph' || Math.abs(n.size - stop.size) > 0.3 || !loosePiece(n, stop) || !/^[a-z\u00DF-\u00FF]/.test(n.lines[0].text)) continue;
        // In the legend's print, which is small print or at least not the print of the text it
        // stands in. The first text that could carry the sentence on does so, or nothing does.
        const around = [blocks[k - 1], blocks[k + 1]].filter((o) => o && o.page === n.page && !o.drop && (o.kind === 'paragraph' || o.kind === 'list'));
        if (legendText(n, stop) || (around.length && around.every((o) => Math.abs(o.size - n.size) > 0.6))) {
          n.kind = 'caption';
          n.note = 'legend carried on from where it was cut';
        }
        break;
      }
    }

    // "(legend continued on next page)", somewhere under the legend and before the next one,
    // or on the last line of the legend itself.
    let cue: Block | undefined;
    for (let k = i + 1; k <= i + 16 && k < blocks.length && blocks[k].page === c.page && blocks[k].kind !== 'caption' && !cue; k++) {
      if (blocks[k].lines.length <= 2 && CONTINUED.test(blockText(blocks[k]))) cue = blocks[k];
    }
    const end = lastLine(c);
    const inLegend = !cue && c.lines.length > 1 && CONTINUED.test(end.text);
    if (inLegend && end.wordX0.length <= 8) {
      // A line that holds the cue and nothing else is no part of the legend's text.
      c.lines.pop();
      c.x0 = Math.min(...c.lines.map((l) => l.x0));
      c.x1 = Math.max(...c.lines.map((l) => l.x1));
      c.bottom = lastLine(c).bottom;
      forgetFeatures(c);
      cue = { ...c, lines: [end], x0: end.x0, x1: end.x1, top: end.top, bottom: end.bottom };
      blocks.splice(i + 1, 0, cue);
    }
    if (!cue && !inLegend) continue;
    if (cue) {
      cue.kind = 'fragment';
      cue.note = 'legend runs on over the page';
    }
    // The rest is over the page. Where the legend is told panel by panel it opens with the
    // panel after the last one told ("(D)" after "(C)"); else it is the first loose small print.
    const told = /.*(?:^|[\s(])([A-Ya-y])[),.]\s/.exec(blockText(c))?.[1];
    const next = told ? new RegExp(`^\\(?${String.fromCharCode(told.charCodeAt(0) + 1)}[),.]\\s`) : null;
    const over = (n: Block, k: number): boolean =>
      n.page === c.page + 1 && (n.kind === 'paragraph' || n.kind === 'list') && n.lines.length >= 2 && loosePiece(n, lastLine(c)) &&
      !(blocks[k - 1]?.kind === 'caption' && blocks[k - 1].region === n.region && blocks[k - 1].page === n.page);
    let rest = next ? blocks.findIndex((n, k) => over(n, k) && next.test(n.lines[0].text)) : -1;
    if (rest < 0) rest = blocks.findIndex((n, k) => over(n, k) && legendText(n, lastLine(c)));
    if (rest > 0) {
      const part = blocks[rest];
      part.kind = 'caption';
      part.note = 'legend continued from the previous page';
      absorbBelow(part, rest + 1, part.region, true);
    }
  }
}

/**
 * Two headings set one directly under the other ("Materials and methods" then "Plant
 * material") arrive as one block. A heading that wraps has a full first line and keeps its
 * typeface; stacked headings are short lines that each start afresh, or lines that change
 * typeface from one to the next.
 */
export function splitStackedHeadings(blocks: Block[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'heading' || b.lines.length < 2) continue;
    const column = b.regionX1 - b.regionX0;
    const fresh = b.lines.every((l) => /^[A-Z0-9]/.test(l.text));
    const short = b.lines.every((l) => l.x1 - b.regionX0 < 0.6 * column);
    const groups: Line[][] = [[b.lines[0]]];
    for (let k = 1; k < b.lines.length; k++) {
      const above = b.lines[k - 1];
      const line = b.lines[k];
      const restyled = above.font !== line.font && above.purity > 0.85 && line.purity > 0.85;
      if (fresh && (short || restyled)) groups.push([line]);
      else groups[groups.length - 1].push(line);
    }
    if (groups.length < 2) continue;
    const parts = groups.map((lines): Block => ({
      ...b,
      lines,
      x0: Math.min(...lines.map((l) => l.x0)),
      x1: Math.max(...lines.map((l) => l.x1)),
      top: lines[0].top,
      bottom: lines[lines.length - 1].bottom,
      font: lines[0].font,
    }));
    blocks.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}

/**
 * A heading heads something. One with no text under it in its own column, and no text above
 * it either, is a label that only looks like a heading (an axis title, a panel label).
 */
export function demoteOrphanHeadings(all: Block[]): void {
  const blocks = all.filter((b) => !b.drop);
  const texty = (b: Block | undefined): boolean =>
    !!b && (b.kind === 'paragraph' || b.kind === 'list' || b.kind === 'heading' || b.kind === 'title');
  // Reference entries are not prose, but a heading above a column of them does head text.
  const wordy = (o: Block): boolean => features(o).words >= 8 && features(o).alpha >= 0.5 && features(o).celled < 0.5;
  const style = (b: Block): string => `${Math.round(b.size * 2) / 2}|${b.plain ? 'p' : 'o'}|${features(b).allCaps ? 'C' : 'c'}`;

  // Three or more would-be headings of one style, one under the other with no text between
  // them, are the cells of a table column or the labels of a figure. Numbered sections can
  // stack ("3", "3.1", "3.1.1"); these do not count.
  for (let i = 0; i < blocks.length; ) {
    const first = blocks[i];
    let j = i + 1;
    if (first.kind === 'heading' && !NUMBERED.test(features(first).text)) {
      while (
        j < blocks.length && blocks[j].kind === 'heading' && blocks[j].page === first.page && blocks[j].region === first.region &&
        style(blocks[j]) === style(first) && !NUMBERED.test(features(blocks[j]).text)
      ) j++;
      if (j - i >= 3) {
        for (const b of blocks.slice(i, j)) {
          b.kind = 'fragment';
          b.note = 'one of a stack of labels';
        }
      }
    }
    i = j;
  }

  // So are three or more of one style that stand level with one another across the page, none
  // of them over running text: the heads of the columns of a table.
  const level = new Map<string, Block[]>();
  blocks.forEach((b, i) => {
    const next = blocks[i + 1];
    const headsProse = !!next && next.page === b.page && next.region === b.region && (next.kind === 'paragraph' || next.kind === 'list');
    if (b.kind !== 'heading' || b.lines.length > 1 || headsProse || NUMBERED.test(features(b).text)) return;
    const key = `${b.page}|${Math.round(b.lines[0].base)}|${style(b)}`;
    level.set(key, [...(level.get(key) ?? []), b]);
  });
  for (const row of level.values()) {
    if (row.length < 3) continue;
    for (const b of row) {
      b.kind = 'fragment';
      b.note = 'one of a row of column heads';
    }
  }

  const orphans: Block[] = [];
  const proven = new Map<string, number>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'heading') continue;
    const same = (o: Block | undefined): boolean => !!o && o.page === b.page && o.region === b.region;
    const next = blocks[i + 1];
    const prev = blocks[i - 1];
    const headsText = same(next) && (texty(next) || wordy(next));
    const endsColumn = !same(next) && same(prev) && texty(prev) && texty(next);
    const opensColumn = !same(prev) && !same(next) && texty(next);
    if (headsText || endsColumn || opensColumn) proven.set(style(b), (proven.get(style(b)) ?? 0) + 1);
    else orphans.push(b);
  }
  for (const b of orphans) {
    // A heading in the style the document's proven headings use is still a heading
    // (an appendix title above a page of equations, say).
    if ((proven.get(style(b)) ?? 0) >= 2) continue;
    b.kind = 'fragment';
    b.note = 'looks like a heading but heads no text';
  }
}

// ------------------------- headers, footers, page numbers -------------------------

const signature = (text: string): string => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export function dropPageFurniture(blocks: Block[], pages: Array<{ width: number; height: number }>): void {
  const band = 0.12;
  const inBand = (b: Block): 'top' | 'bottom' | null => {
    const h = pages[b.page].height;
    if (b.bottom < band * h) return 'top';
    if (b.top > (1 - band) * h) return 'bottom';
    return null;
  };

  // Text that recurs at the same height on several pages is a running header or footer.
  const seen = new Map<string, Set<number>>();
  for (const b of blocks) {
    const where = inBand(b);
    if (!where || b.lines.length > 3) continue;
    const key = `${where}|${signature(blockText(b))}`;
    if (key.length < where.length + 3) continue;
    let set = seen.get(key);
    if (!set) seen.set(key, (set = new Set()));
    set.add(b.page);
  }
  const need = Math.max(2, Math.ceil(pages.length * 0.25));
  // In a long document the running head changes with the chapter and never reaches that share
  // of the pages; it does stand on page after page, or on every other page, three times at least.
  const running = (on: Set<number> | undefined): boolean => {
    if (!on) return false;
    if (on.size >= need) return true;
    const sorted = [...on].sort((a, b) => a - b);
    let chain = 1;
    for (let i = 1; i < sorted.length; i++) {
      chain = sorted[i] - sorted[i - 1] <= 2 ? chain + 1 : 1;
      if (chain >= 3) return true;
    }
    return false;
  };

  for (const b of blocks) {
    if (b.drop) continue;
    const where = inBand(b);
    if (!where) continue;
    const h = pages[b.page].height;
    const text = blockText(b).trim();
    const f = features(b);

    if (/^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/|\|)\s*\d{1,4})?$/i.test(text) || /^[ivxlc]{1,7}$/i.test(text)) {
      b.drop = 'page-number';
      continue;
    }
    if (b.lines.length <= 3 && running(seen.get(`${where}|${signature(text)}`))) {
      b.drop = 'header-footer';
      b.note = 'repeats across pages';
      continue;
    }
    const extreme = b.bottom < 0.055 * h || b.top > 0.945 * h;
    if (extreme && b.lines.length <= 2 && f.words <= 16) {
      b.drop = 'header-footer';
      b.note = 'at the page edge';
    }
  }
}

// --------------------------------- side notes ---------------------------------

/**
 * Notes set beside the text: a narrow column of small print at the side of a page whose
 * body text runs in wider columns. The glossary of a review, the affiliations beside a
 * title page. They have no place in the running text. A caption set in such a column is
 * still a caption.
 */
export function dropSideNotes(blocks: Block[], bodySize: number, pages: Array<{ width: number; height: number }>): void {
  const width = (b: Block): number => b.regionX1 - b.regionX0;
  const bodyPages = new Set<number>();
  for (const b of blocks) {
    if (b.drop || b.kind !== 'paragraph') continue;
    if (Math.abs(b.size - bodySize) <= 0.08 * bodySize && width(b) >= 0.3 * pages[b.page].width) bodyPages.add(b.page);
  }
  for (const b of blocks) {
    if (b.drop || b.kind === 'caption' || !bodyPages.has(b.page)) continue;
    const page = pages[b.page].width;
    const atSide = b.regionX1 < 0.34 * page || b.regionX0 > 0.66 * page;
    if (!atSide || width(b) > 0.26 * page || b.size > 0.88 * bodySize) continue;
    b.drop = 'margin';
    b.note = 'small print in a narrow column at the side of the page';
  }
}

// --------------------------------- footnotes ---------------------------------

/**
 * Footnotes: a short tail of small print at the foot of a column, under body-size
 * text or opening with a note mark. A long run of small print under a heading is a
 * section (methods, references), not a footnote, and is left alone.
 */
export function dropFootnotes(blocks: Block[], bodySize: number, pages: Array<{ width: number; height: number }>): void {
  const small = (b: Block): boolean => b.size <= 0.9 * bodySize;
  let i = 0;
  while (i < blocks.length) {
    // One region at a time.
    let j = i;
    while (j < blocks.length && blocks[j].page === blocks[i].page && blocks[j].region === blocks[i].region) j++;
    const region = blocks.slice(i, j).filter((b) => !b.drop);
    i = j;
    if (region.length < 2) continue;

    let tail = region.length;
    while (tail > 0 && small(region[tail - 1]) && region[tail - 1].kind !== 'caption' && region[tail - 1].kind !== 'heading') tail--;
    if (tail === region.length) continue;
    // Under the text of its column, as a rule. A note that opens with its mark is one whatever
    // stands over it: the notes then start at the first block that does.
    const before = region[tail - 1];
    if (!before || (before.kind !== 'paragraph' && before.kind !== 'list') || small(before)) {
      tail = region.findIndex((b, k) => k >= tail && /^[\u2606\u2605\u204E*\u2020\u2021\u00A7\u00B6]/.test(b.lines[0].text));
      if (tail < 0) continue;
    }
    const notes = region.slice(tail);
    const lines = notes.reduce((n, b) => n + b.lines.length, 0);
    if (lines > 18) continue;
    const h = pages[notes[0].page].height;
    if (notes[0].top < 0.45 * h) continue;
    // A quotation in small print is set in from the edge of its column on every line and opens
    // with no mark. A note starts at the edge, or with its mark.
    const setIn = notes.every((b) => b.lines.every((l) => l.x0 - b.regionX0 >= 1.5 * l.size));
    if (setIn && !/^(?:\d{1,3}\b|[\u00B9\u00B2\u00B3\u2070-\u2079*\u2020\u2021\u00A7\u00B6#]|[a-z]\))/.test(notes[0].lines[0].text)) continue;
    for (const b of notes) {
      b.drop = 'footnote';
      b.note = 'small print at the foot of the column';
    }
  }
}

/**
 * A page can hold two texts one over the other, each set in two columns: an abstract over the
 * start of the article. Read as two columns from top to bottom of the page, the first half of
 * each text would be followed by the first half of the other. What gives the upper text away
 * is that it stops in mid-sentence at the end of a full line with a heading under it, where
 * no sentence can go on: it goes on at the head of the next column, in the same print, and
 * that column too breaks off at the level of the heading, where its lower text begins. The
 * upper part of the next column is read straight after the text over the heading. Where that
 * text was too full of names and figures to read as prose, what carries it on shows that it is.
 */
export function orderBands(blocks: Block[]): void {
  for (let i = 0; i + 1 < blocks.length; i++) {
    const over = blocks[i];
    const heading = blocks[i + 1];
    if (over.drop || heading.drop || heading.kind !== 'heading' || heading.page !== over.page || heading.region !== over.region) continue;
    if ((over.kind !== 'paragraph' && over.kind !== 'fragment') || over.lines.length < 2 || features(over).words < 8) continue;
    const last = over.lines[over.lines.length - 1];
    if (sentenceEnds(last.text, ':;')) continue;
    // The next column: the nearest one to the right. None of its blocks may straddle the break.
    const right = blocks.filter((b, k) => k > i + 1 && b.page === over.page && b.region !== over.region && b.x0 > over.regionX1 - 2);
    const region = right.length ? right.reduce((a, b) => (b.x0 < a.x0 ? b : a)).region : -1;
    const column = right.filter((b) => b.region === region);
    const upper = column.filter((b) => b.bottom <= heading.top + 1);
    if (!upper.length || upper.length === column.length || column.some((b) => b.bottom > heading.top + 1 && b.top < over.bottom - 1)) continue;
    // The lower text starts at one level in both columns, and under the heading it starts as a text does.
    const under = blocks[i + 2];
    if (Math.abs(column[upper.length].top - heading.top) > 4 * over.size || !under || under.region !== over.region || !/^[A-Z]/.test(under.lines[0].text)) continue;
    const first = upper[0];
    if (first.drop || first.kind !== 'paragraph' || Math.abs(first.size - over.size) > 0.3 || first.plain !== over.plain) continue;
    // The line the text stops on is full: it reaches the edge, or has no room for the word that comes next.
    const word = first.lines[0].wordX1[0] - first.lines[0].wordX0[0];
    if (over.regionX1 - last.x1 > Math.max(2 * over.size, word + 0.3 * over.size)) continue;
    if (over.kind === 'fragment') {
      over.kind = 'paragraph';
      over.note = 'carried on at the head of the next column';
    }
    const from = blocks.indexOf(first);
    blocks.splice(i + 1, 0, ...blocks.splice(from, upper.length));
    i += upper.length;
  }
}

// ---------------------------- figures and tables ----------------------------

/**
 * Text that belongs to a figure or table sits next to its caption and does not
 * look like the body text: other font, other size, or broken into pieces.
 * Walk outwards from each caption and take such blocks with it. The walk stops
 * at the first block of ordinary body text, so body text is never taken.
 */
export function dropFloatContents(blocks: Block[], bodySize: number): Map<Block, Block> {
  /** What the captions of tables took, each with its caption. */
  const ofTables = new Map<Block, Block>();
  const textSizes = runningSizes(blocks);
  // In the print of the body, or in a larger one that the running text is set in (the main
  // text of a journal whose methods, in smaller print, are the greater part of the paper).
  const bodyStyle = (b: Block): boolean =>
    (b.kind === 'paragraph' || b.kind === 'list') && b.plain &&
    (Math.abs(b.size - bodySize) <= 0.06 * bodySize || (b.size > bodySize && textSizes.has(sizeKey(b))));
  const solidProse = (b: Block): boolean =>
    (b.kind === 'paragraph' || b.kind === 'list') && b.lines.length >= 3 && features(b).fill >= 0.8 && b.size >= 0.7 * bodySize;
  const loose = (b: Block): boolean => b.kind === 'fragment' || b.kind === 'table' || b.kind === 'equation';

  const walk = (from: number, step: 1 | -1, isTable: boolean): void => {
    const page = blocks[from].page;
    let taken = 0;
    let notes = 0;
    /** The size the float's own pieces are set in. */
    let print = 0;
    for (let j = from + step; j >= 0 && j < blocks.length; j += step) {
      const b = blocks[j];
      if (b.page !== page) break;
      if (b.drop) continue;
      if (b.kind === 'caption' || b.kind === 'title') break;
      const beyond = blocks[j + step];
      const looseBeyond = !!beyond && beyond.page === page && loose(beyond);
      // A line or two in the style of the text can stand inside a figure: the title of an axis,
      // a row of a list drawn in it. It lies over the legend, straight after a piece of the
      // figure in its own column, and closes no sentence. Text that a figure interrupts has
      // text beyond it, not more of the figure.
      const before = blocks[j - step];
      const label =
        !isTable && taken > 0 && b.lines.length <= 2 && b.bottom <= blocks[from].top + 1 && before.drop === 'figure-or-table' &&
        before.region === b.region && !sentenceEnds(blockText(b)) && (step === 1 || looseBeyond);
      if (bodyStyle(b) && !label) break;
      const small = b.size <= 0.93 * bodySize;
      if (b.kind === 'heading') {
        // A heading is float text when more float text lies beyond it, or when it is in
        // small print right beside the float (a table's column header). One that opens
        // with a section number is the document's own, in any print.
        if (SUBSECTION.test(blockText(b)) || (!(small && (taken > 0 || isTable)) && !looseBeyond)) break;
      } else if (solidProse(b)) {
        // Notes to a table are small print set against the table body, on either side of it:
        // a few lines, no larger than the table's own print. The running text of the
        // document, in whatever size, is not among them.
        if (textSizes.has(sizeKey(b)) && b.lines.length >= 6) break;
        if (!(isTable && small && (taken > 0 || looseBeyond) && b.lines.length <= 12 && (!print || b.size <= print + 0.3) && ++notes <= 2)) break;
      } else if (loose(b)) print = Math.max(print, b.size);
      b.drop = 'figure-or-table';
      b.note = 'beside a figure or table caption';
      if (isTable) ofTables.set(b, blocks[from]);
      taken++;
    }
  };

  blocks.forEach((b, i) => {
    if (b.kind !== 'caption' || (b.drop && b.drop !== 'figure-or-table')) return;
    // A float's own text can lie on either side of its caption, so look both ways. Each walk
    // stops at the first block of body text, which bounds how far it can reach.
    // What stands under the title of a box is its text, not the pieces of a figure.
    if (/^box\s*\d/i.test(b.lines[0].text)) return;
    const isTable = /^(?:\S+\s+)?table\b/i.test(b.lines[0].text);
    walk(i, 1, isTable);
    walk(i, -1, isTable);
  });
  return ofTables;
}

/** Opens as a note does: with a reference mark, or with the word that names a note. */
const NOTE_START = /^(?:[*\u2020\u2021\u00A7\u00B6#\u00B9\u00B2\u00B3\u2070-\u2079]|[a-e]\s?[A-Z]|(?:notes?|abbreviations?|key|sources?|legend)\b\s*[:.])/i;

/**
 * Small print that stands right over or under the body of a table, within its width and no
 * larger than its print, belongs to the table: a note, a key. So does small print in a column
 * of the table that starts on the line of a piece in another column of the same table: a cell
 * that holds a sentence, however much room the row above it left empty.
 * What is taken becomes part of the table in turn, so a note under a note goes too. The body
 * of a table is what its caption took, and any block of three rows or more cut into cells:
 * a table whose title was not recognised still has its notes taken. A whole column of cells
 * that hold sentences is found by its rows.
 */
export function dropTableNotes(blocks: Block[], bodySize: number, ofTables: ReadonlyMap<Block, Block>): void {
  const running = runningSizes(blocks);
  const pages = new Map<number, Block[]>();
  for (const b of blocks) {
    const list = pages.get(b.page);
    if (list) list.push(b);
    else pages.set(b.page, [b]);
  }
  for (const page of pages.values()) {
    /** Each piece of a table with the table it is of: the caption that took it, or itself where none did. */
    const table = new Map<Block, Block>();
    for (const b of page) {
      const caption = ofTables.get(b);
      if (caption || (b.kind === 'table' && b.lines.length >= 3 && (!b.drop || b.drop === 'figure-or-table'))) table.set(b, caption ?? b);
    }
    // A column of a table whose cells hold sentences. Half its lines or more stand on the lines
    // of the loose pieces beside it, and those are the lines its cells start on: they open
    // with a capital or a figure, where the lines of running text open as the words fall.
    // Its lines stop short of the edge as cells do.
    const loose = page.filter((b) => (b.kind === 'table' || b.kind === 'fragment' || b.kind === 'equation') && (!b.drop || b.drop === 'figure-or-table'));
    for (const n of page) {
      if (n.drop || (n.kind !== 'paragraph' && n.kind !== 'list') || n.size >= 0.97 * bodySize || n.lines.length < 3) continue;
      if (n.lines.filter((l) => n.regionX1 - l.x1 <= 2).length >= 0.5 * n.lines.length) continue;
      const bases = loose.filter((t) => Math.abs(t.size - n.size) < 0.3 && (t.x1 <= n.x0 || t.x0 >= n.x1)).flatMap((t) => t.lines.map((l) => l.base));
      const inRows = n.lines.filter((l) => bases.some((y) => Math.abs(y - l.base) <= 0.5));
      if (inRows.length < Math.max(3, 0.5 * n.lines.length) || inRows.filter((l) => /^[^a-z]/.test(l.text)).length < 0.8 * inRows.length) continue;
      n.drop = 'figure-or-table';
      n.note = 'column of a table';
      table.set(n, n);
    }
    if (!table.size) continue;
    const candidates = page.filter(
      (b) => !b.drop && (b.kind === 'paragraph' || b.kind === 'list') && b.size < 0.97 * bodySize && b.lines.length <= 12 &&
        (!running.has(sizeKey(b)) || NOTE_START.test(b.lines[0].text))
    );
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of [...loose, ...candidates]) {
        const text = n.kind === 'paragraph' || n.kind === 'list';
        if (table.has(n) || (text && n.drop)) continue;
        const pieces = [...table].filter(([t]) => n.size <= t.size + 0.3);
        const across = (t: Block): number => Math.min(n.x1, t.x1) - Math.max(n.x0, t.x0);
        const column = pieces.filter(([t]) => across(t) > 0.3 * Math.min(n.x1 - n.x0, t.x1 - t.x0));
        const beside = column.find(([t]) => {
          const apart = Math.max(n.top - t.bottom, t.top - n.bottom);
          return apart >= -1 && apart <= 2.5 * n.size;
        });
        const inRow = beside || !text ? undefined : pieces.find(
          ([t, of]) => across(t) <= 0 && t.lines.some((l) => Math.abs(l.base - n.lines[0].base) <= 0.5) && column.some(([, own]) => own === of)
        );
        const found = beside ?? inRow;
        if (!found) continue;
        table.set(n, found[1]);
        grew = true;
        // A row or a stray cell right under the table is one more piece of it; text is taken out here.
        if (!text) continue;
        n.drop = 'figure-or-table';
        n.note = 'note or cell of a table';
      }
    }
  }
}
