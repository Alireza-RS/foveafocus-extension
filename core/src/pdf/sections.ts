/**
 * Step 5: document structure. Finds the title, where the narrative starts,
 * heading levels, and which sections (reference list, acknowledgements,
 * funding and the like) are left out.
 */

import type { Block, PdfFilterOptions } from './types';
import { TITLE_START, blockText, features, forgetFeatures } from './classify';
import { COMMON_SECTION_HEADINGS, REFERENCE_HEADINGS, headingMatches, normaliseHeading, toPhraseSet } from '../filters';

const REFERENCES = toPhraseSet(REFERENCE_HEADINGS);
const COMMON = toPhraseSet(COMMON_SECTION_HEADINGS);
const ABSTRACT = new Set(['abstract', 'summary', 'synopsis', 'author summary', 'structured abstract']);
const OPENING = new Set(['introduction', 'background', 'main', 'main text', 'overview']);
/** Labels that open the first paragraph of an abstract printed in labelled parts, without the word "Abstract". */
const ABSTRACT_PART = new Set([
  'purpose', 'background', 'objective', 'objectives', 'aim', 'aims', 'context', 'rationale', 'importance', 'motivation',
  'introduction', 'background and aims', 'background and objectives', 'background and purpose', 'aims and objectives',
  'purpose of review', 'study objective',
]);

/**
 * Headings that look alike are the same rank. The font id is deliberately not part of this:
 * one typeface is often embedded under several ids, and that must not split a rank in two.
 */
/** Capitals, capitals with small capitals, or mixed case. */
const caseOf = (b: Block): string => (!features(b).allCaps ? 'c' : b.lines[0].altSize && b.lines[0].altSize < b.lines[0].size ? 'S' : 'C');
const styleKey = (b: Block): string => `${Math.round(b.size * 2) / 2}|${b.plain ? 'p' : 'o'}|${caseOf(b)}`;

/**
 * A run-in heading: the first few words of a paragraph in a different font from
 * the paragraph itself ("Funding  This work was ..."), or a known label closed by a colon,
 * a dash or an upright bar.
 */
export function runInLabel(b: Block): { label: string; words: number } | null {
  if (b.kind !== 'paragraph' && b.kind !== 'list') return null;
  const first = b.lines[0];
  // A label opens as a title does. A term in another face that opens a line in lower case
  // ("p < 0.05", "in vitro"), or a few such words before a colon, are words of a sentence.
  if (!TITLE_START.test(first.text)) return null;
  const words = first.text.split(' ');
  // Nor is a word in another face that a comma closes a label: it is the first of a row of names.
  if (first.leadFont !== b.font && first.leadWords >= 1 && first.leadWords <= 6 && first.leadWords < words.length && !/[,;]$/.test(words[first.leadWords - 1])) {
    return { label: normaliseHeading(words.slice(0, first.leadWords).join(' ')), words: first.leadWords };
  }
  const colon = /^([A-Za-z][A-Za-z'\u2019 ]{2,48}?)\s*[:\u2014|]\s/.exec(first.text);
  if (colon) {
    const n = colon[1].trim().split(/\s+/).length;
    if (n <= 6) return { label: normaliseHeading(colon[1]), words: n };
  }
  return null;
}

/**
 * Section titles set in the plain body font have nothing typographic to mark them. When a
 * short line standing on its own is exactly a known section name, treat it as the heading it
 * is. The name has to be the whole line; the same word inside a sentence does nothing.
 */
export function promoteNamedHeadings(blocks: Block[], opts: PdfFilterOptions): void {
  const excluded = toPhraseSet(opts.excludedSections);
  const known = (text: string): boolean => {
    const name = normaliseHeading(text);
    return headingMatches(name, COMMON) || headingMatches(name, REFERENCES) || headingMatches(name, excluded);
  };
  const titleLike = (text: string): boolean =>
    text.split(' ').length <= 6 && !/[.!?,;]$/.test(text) && /^[A-Z0-9]/.test(text) && known(text);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.drop || (b.kind !== 'paragraph' && b.kind !== 'list' && b.kind !== 'fragment')) continue;
    const first = b.lines[0];
    if (first.cells > 1 || !titleLike(first.text)) continue;
    if (b.lines.length === 1) {
      b.kind = 'heading';
      b.note = 'section name on a line of its own';
      continue;
    }
    // The name opens a longer block: it must be a short line of its own to count.
    const column = b.regionX1 - b.regionX0;
    if (first.x1 - first.x0 > 0.6 * column) continue;
    const heading: Block = {
      ...b,
      lines: [first],
      x0: first.x0,
      x1: first.x1,
      bottom: first.bottom,
      kind: 'heading',
      note: 'section name on a line of its own',
    };
    b.lines = b.lines.slice(1);
    b.top = b.lines[0].top;
    forgetFeatures(b);
    blocks.splice(i, 0, heading);
    i++;
  }
}

export function assignHeadingLevels(blocks: Block[]): void {
  const heads = blocks.filter((b) => !b.drop && b.kind === 'heading');
  const styles = new Map<string, { size: number; first: number }>();
  heads.forEach((b, i) => {
    const key = styleKey(b);
    if (!styles.has(key)) styles.set(key, { size: b.size, first: i });
  });
  // Larger type ranks higher; at one size, capitals rank above small capitals, and those above mixed case.
  const caps = (key: string): number => 'CSc'.indexOf(key.slice(-1));
  const ranked = [...styles.entries()].sort(
    (a, b) => b[1].size - a[1].size || caps(a[0]) - caps(b[0]) || a[1].first - b[1].first
  );
  const rank = new Map(ranked.map(([key], i) => [key, i]));
  const byStyle = (b: Block): number => 2 + (rank.get(styleKey(b)) ?? 0);

  // Numbered headings nest by their numbers ("2", "2.1", "2.1.3"), starting from the rank
  // that the style of the single-number headings has among all the headings.
  const depthOf = (b: Block): number => {
    const m = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s/.exec(blockText(b));
    return m ? m[1].split('.').length : 0;
  };
  const top = heads.find((b) => depthOf(b) === 1);
  const base = top ? byStyle(top) : 2;
  for (const b of heads) {
    const depth = depthOf(b);
    b.level = depth ? base + depth - 1 : byStyle(b);
  }
  // The highest rank present is level 2 (level 1 is the title).
  const shift = heads.length ? Math.min(...heads.map((b) => b.level)) - 2 : 0;
  for (const b of heads) b.level = Math.min(6, b.level - shift);
}

/**
 * The article title: the most prominent phrase before the narrative starts. Journals that
 * open with a cover page print the title twice; the copy nearer the abstract wins a tie.
 */
function findTitle(blocks: Block[], limit: number, bodySize: number): Block | null {
  let best: Block | null = null;
  let bestScore = 0;
  for (let i = 0; i < limit; i++) {
    const b = blocks[i];
    if (b.drop) continue;
    const f = features(b);
    // Display type, as a rule. A title set no larger than the text (a letter to the editor
    // under a larger rubric) is still a heading of some length, with no authors' marks in it.
    const display = b.size >= 1.15 * bodySize;
    const modest =
      b.kind === 'heading' && b.size >= 0.98 * bodySize && f.words >= 5 && !/[\u00B9\u00B2\u00B3\u2070-\u2079*\u2020\u2021]/.test(f.text);
    if (!(display || modest) || f.words < 2 || f.alpha < 0.6 || f.celled > 0 || b.lines.length > 5) continue;
    // The largest type wins, but a title is a phrase: a two-word masthead has to be
    // clearly larger than a full title to beat it.
    const score = b.size * Math.min(1, 0.4 + 0.1 * f.words);
    if (score > bestScore + 0.2 || (best && b.page > best.page && score >= bestScore - 0.2)) {
      bestScore = score;
      best = b;
    }
  }
  if (!best) return null;
  // A title broken over several blocks of the same size is one title: blocks of its column,
  // or the next thing down the page (the short last line of a title set across the columns
  // can land in the first of them). A scanned page gives one typeface slightly varying sizes.
  const title = best;
  const at = blocks.indexOf(title);
  const sameSize = (b: Block): boolean =>
    Math.abs(b.size - title.size) <= (b.font === title.font ? Math.max(0.3, 0.04 * title.size) : 0.3);
  const partOfTitle = (b: Block): boolean =>
    !b.drop && b.page === title.page && b.lines.length <= 3 && sameSize(b) &&
    (b.region === title.region || (b.top >= title.bottom - 1 && b.top - title.bottom <= 0.8 * title.size));
  for (let i = at - 1; i >= 0 && partOfTitle(blocks[i]); i--) {
    title.lines.unshift(...blocks[i].lines);
    title.top = blocks[i].top;
    blocks[i].drop = 'front-matter';
    blocks[i].note = 'merged into the title';
  }
  for (let i = at + 1; i < limit && partOfTitle(blocks[i]); i++) {
    title.lines.push(...blocks[i].lines);
    title.bottom = blocks[i].bottom;
    blocks[i].drop = 'front-matter';
    blocks[i].note = 'merged into the title';
  }
  forgetFeatures(title);
  return title;
}

/**
 * An abstract can arrive in one block with the line above it: the authors' names, set in its
 * type and at nearly its line spacing. Its label then opens a line inside the block, and the
 * block is cut there.
 */
function splitAtAbstractLabel(blocks: Block[], from: number): void {
  const firstPage = blocks[from]?.page ?? 0;
  for (let i = from; i < blocks.length && blocks[i].page <= firstPage + 1; i++) {
    const b = blocks[i];
    if (b.drop || b.kind !== 'paragraph') continue;
    for (let k = 1; k < b.lines.length && k <= 3; k++) {
      const label = runInLabel({ ...b, lines: b.lines.slice(k) });
      if (!label || !ABSTRACT.has(label.label)) continue;
      const head = b.lines.slice(0, k);
      blocks.splice(i, 0, {
        ...b,
        lines: head,
        x0: Math.min(...head.map((l) => l.x0)),
        x1: Math.max(...head.map((l) => l.x1)),
        bottom: head[k - 1].bottom,
        kind: 'fragment',
        note: 'lines above the abstract',
      });
      b.lines = b.lines.slice(k);
      b.top = b.lines[0].top;
      forgetFeatures(b);
      return;
    }
  }
}

/** Index of the first block of the narrative on or after `from`, or -1. */
function findNarrativeStart(blocks: Block[], from: number, bodySize: number): { index: number; labelled: boolean } {
  const firstPage = blocks[from]?.page ?? 0;
  let opening = -1;
  let prose = -1;
  for (let i = from; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.page > firstPage + 4) break;
    if (b.drop) continue;
    // The word "Abstract" settles it even some pages in, behind a cover and a graphical
    // abstract. "Summary" does only near the front and before any "Introduction": it can
    // also head the last section of a short paper.
    const near = b.page <= firstPage + 2;
    if (b.kind === 'heading' && opening < 0) {
      const name = normaliseHeading(blockText(b));
      if (near ? ABSTRACT.has(name) : name === 'abstract') return { index: i, labelled: true };
      if (near && OPENING.has(name)) opening = i;
    }
    if (!near) continue;
    const label = runInLabel(b);
    if (label && (ABSTRACT.has(label.label) || (prose < 0 && ABSTRACT_PART.has(label.label)))) return { index: i, labelled: true };
    if (prose < 0 && b.page <= firstPage + 1 && b.kind === 'paragraph') {
      const f = features(b);
      // A real paragraph: four lines or more, or a shorter one that is plainly a sentence of the text itself.
      const inBodyStyle = b.plain && Math.abs(b.size - bodySize) <= 0.06 * bodySize;
      if (
        (b.lines.length >= 4 && f.words >= 40 && b.size >= 0.85 * bodySize) ||
        (inBodyStyle && b.lines.length >= 2 && f.words >= 20 && f.lower >= 0.6 && f.wordy >= 0.5 && f.endsSentence)
      ) prose = i;
    }
  }
  if (opening >= 0 && (prose < 0 || opening < prose)) return { index: opening, labelled: true };
  // An unlabelled abstract (Nature, Science) is simply the first real paragraph.
  return { index: prose, labelled: false };
}

const SMALL_PRINT =
  /\u00A9|\(c\)\s*(?:19|20)\d{2}|creative ?commons|all rights reserved|\breceived:?\s+\d|\baccepted:?\s+\d|published online|e-?mail:|correspondence:|correspondence(?: and requests)?(?: should be addressed)? to|\borcid\b|this article is licensed|permission to make digital|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

const SMALL_PRINT_ALL = new RegExp(SMALL_PRINT.source, 'gi');

export interface StructureResult {
  scholarly: boolean;
  title: Block | null;
}

/**
 * A journal that runs its articles on from one another prints the end of the previous article
 * on the page where this one starts: its last lines, its reference list, then the new title
 * in display type. A reference list ahead of the first display heading on the opening page is
 * that case. Nothing on the page that comes before the heading belongs to this document, nor
 * does small print that lies wholly above it in a later column.
 */
function dropPreviousArticle(blocks: Block[], bodySize: number): void {
  const first = blocks.find((b) => !b.drop);
  if (!first) return;
  const onPage = blocks.filter((b) => b.page === first.page);
  const title = onPage.find((b) => !b.drop && b.kind === 'heading' && b.size >= 1.3 * bodySize && features(b).words >= 3);
  if (!title) return;
  // The list counts whatever became of its entries: short ones under a figure pass for the figure's own text.
  const ahead = onPage.slice(0, onPage.indexOf(title));
  const before = ahead.filter((b) => !b.drop);
  const listed =
    ahead.some((b) => b.lines.length === 1 && headingMatches(normaliseHeading(blockText(b)), REFERENCES)) ||
    ahead.filter(looksLikeReference).length >= 3;
  if (!listed) return;
  for (const b of onPage) {
    if (b.drop || b === title || !(before.includes(b) || (b.bottom <= title.top && b.size <= 0.93 * bodySize))) continue;
    b.drop = 'front-matter';
    b.note = 'end of the article before this one';
  }
}

/**
 * A sheet that an archive or publisher puts in front of a download: it names the paper, and
 * the next page then prints the same title in display type, as the paper's own first page
 * does. Nothing on such a sheet belongs to the paper.
 */
function dropCoverSheet(blocks: Block[], bodySize: number): void {
  const first = blocks.find((b) => !b.drop);
  if (!first) return;
  const letters = (b: Block): string => blockText(b).toLowerCase().replace(/[^a-z0-9]/g, '');
  const titled = (b: Block): boolean => !b.drop && b.lines.length <= 4 && features(b).words >= 4;
  const cover = blocks.filter((b) => b.page === first.page && titled(b)).map(letters);
  const repeated = blocks.some(
    (b) =>
      b.page === first.page + 1 && titled(b) && b.size >= 1.15 * bodySize &&
      cover.some((c) => c.length >= 20 && (c.startsWith(letters(b)) || letters(b).startsWith(c)))
  );
  if (!repeated) return;
  for (const b of blocks) {
    if (b.page !== first.page || b.drop) continue;
    b.drop = 'front-matter';
    b.note = 'sheet added in front: names the paper that starts on the next page';
  }
}

export function applyFrontMatter(blocks: Block[], bodySize: number, opts: PdfFilterOptions): StructureResult {
  const hasReferences = blocks.some(
    (b) => !b.drop && b.kind === 'heading' && headingMatches(normaliseHeading(blockText(b)), REFERENCES)
  );
  const captions = blocks.filter((b) => b.kind === 'caption').length;
  if (opts.skipFrontMatter) {
    dropCoverSheet(blocks, bodySize);
    dropPreviousArticle(blocks, bodySize);
  }

  let from = 0;
  while (from < blocks.length && blocks[from].drop) from++;
  splitAtAbstractLabel(blocks, from);
  const start = findNarrativeStart(blocks, from, bodySize);
  const scholarly = hasReferences || start.labelled || captions >= 2;
  if (!scholarly) return { scholarly, title: null };

  const title = start.index > from ? findTitle(blocks, start.index, bodySize) : null;
  if (title) {
    title.kind = 'title';
    title.level = 1;
    if (!opts.includeTitle) {
      title.drop = 'front-matter';
      title.note = 'title (switched off)';
    }
  }
  if (!opts.skipFrontMatter) return { scholarly, title };

  // Everything before the narrative starts: mastheads, authors, affiliations, a cover page.
  for (let i = from; i < start.index; i++) {
    const b = blocks[i];
    if (b.drop || b === title) continue;
    b.drop = 'front-matter';
    b.note = 'before the abstract';
  }

  // Licence lines, received/accepted dates and correspondence notes set in small print.
  const tails: Array<{ of: Block; from: number }> = [];
  for (const b of blocks) {
    if (b.drop || b.kind === 'heading' || b.kind === 'title' || b.kind === 'caption') continue;
    if (b.size > 0.95 * bodySize || b.lines.length > 30) continue;
    // One mark is enough for a short block; a long one has to carry several.
    const marks = blockText(b).match(SMALL_PRINT_ALL)?.length ?? 0;
    if (marks < (b.lines.length <= 12 ? 1 : 3)) continue;
    // A paragraph of the text can end in such a line (the last part of an abstract, then the
    // publisher's copyright). Where the line opens with the mark, the line alone goes; where
    // the sentence ends on that line, the paragraph is read to its end.
    const at = b.lines.findIndex((l) => SMALL_PRINT.test(l.text));
    const body = features({ ...b, lines: b.lines.slice(0, at) });
    if (at >= 2 && at >= b.lines.length - 2 && body.words >= 15 && body.lower >= 0.6 && body.wordy >= 0.5) {
      if ((SMALL_PRINT.exec(b.lines[at].text)?.index ?? 0) > 12) continue;
      tails.push({ of: b, from: at });
      continue;
    }
    b.drop = 'boilerplate';
    b.note = 'licence, dates or correspondence in small print';
  }
  for (const { of, from: at } of tails) {
    const lines = of.lines.slice(at);
    const tail: Block = {
      ...of, lines, top: lines[0].top, x0: Math.min(...lines.map((l) => l.x0)), x1: Math.max(...lines.map((l) => l.x1)),
      kind: 'fragment', drop: 'boilerplate', note: 'licence, dates or correspondence in small print',
    };
    of.lines = of.lines.slice(0, at);
    of.bottom = of.lines[of.lines.length - 1].bottom;
    forgetFeatures(of);
    blocks.splice(blocks.indexOf(of) + 1, 0, tail);
  }
  return { scholarly, title };
}

/**
 * The other end of the same arrangement: the next article opens on the page where this one
 * ends, under a title set in the same display type as this document's own. Such a title
 * after this document's reference list has begun, on one of the last two pages, starts
 * something else (a collection of papers runs on for longer than that), and nothing from
 * there on belongs here. Nor does a last page that prints the title again: the sheet of terms
 * and links a publisher adds to a download.
 */
export function dropFollowingArticle(blocks: Block[], title: Block | null, bodySize: number, pageCount: number): void {
  if (!title) return;
  const listAt = blocks.findIndex(
    (b) => b.drop === 'references' || (!b.drop && b.kind === 'heading' && headingMatches(normaliseHeading(blockText(b)), REFERENCES))
  );
  const next = blocks.findIndex(
    (b, i) =>
      listAt >= 0 && i > listAt && !b.drop && b.kind === 'heading' && b.page >= pageCount - 2 &&
      title.size >= 1.3 * bodySize && Math.abs(b.size - title.size) <= 0.3
  );
  if (next >= 0) {
    for (const b of blocks.slice(next)) {
      if (b.drop) continue;
      b.drop = 'after-references';
      b.note = 'another article starts on this page';
    }
  }

  const letters = (b: Block): string => blockText(b).toLowerCase().replace(/[^a-z0-9]/g, '');
  const last = pageCount - 1;
  if (title.page === last || !blocks.some((b) => b.page === last && !b.drop && b.lines.length <= 4 && letters(b) === letters(title))) return;
  for (const b of blocks) {
    if (b.page !== last || b.drop) continue;
    b.drop = 'boilerplate';
    b.note = 'sheet added to the download: prints the title again';
  }
}

/** Drop the reference list and the listed sections; everything else stays. */
export function applySections(blocks: Block[], opts: PdfFilterOptions): void {
  const excluded = toPhraseSet(opts.excludedSections);
  const narrativeStyles = new Set<string>();
  /** Level of the heading that opened the section being skipped; 0 when reading normally. */
  let skipLevel = 0;
  let skipWhy: 'references' | 'excluded-section' | 'after-references' = 'excluded-section';
  let skipStyle = '';

  for (const b of blocks) {
    if (b.drop) continue;

    if (b.kind === 'heading' || b.kind === 'title') {
      const name = normaliseHeading(blockText(b));
      const isRefs = headingMatches(name, REFERENCES);
      const isExcluded = !isRefs && headingMatches(name, excluded);

      if (skipLevel && skipWhy !== 'after-references') {
        // Inside a skipped section: only a heading of the same or higher rank ends it. Inside a
        // reference list the heading must also be styled like the document's own headings, so
        // that a bold line inside an entry cannot reopen the text.
        const outranks = b.level <= skipLevel;
        const trusted = skipWhy !== 'references' || styleKey(b) === skipStyle || narrativeStyles.has(styleKey(b));
        if (!(outranks && trusted) && !isRefs && !isExcluded) {
          b.drop = skipWhy;
          continue;
        }
      }
      if (skipLevel && skipWhy === 'after-references') {
        b.drop = 'after-references';
        continue;
      }

      // A skipped heading nested inside a section that is already being skipped does not
      // narrow the skip: the outer section still ends only at a heading of its own rank.
      const nested = skipLevel > 0 && skipLevel < 7 && (b.level || 2) > skipLevel;
      if (isRefs) {
        if (!nested) {
          skipLevel = b.level || 2;
          skipWhy = opts.stopAtReferences ? 'after-references' : 'references';
          skipStyle = styleKey(b);
        }
        b.drop = 'references';
        b.note = 'reference list heading';
        continue;
      }
      if (isExcluded) {
        if (!nested) {
          skipLevel = b.level || 2;
          skipWhy = 'excluded-section';
          skipStyle = styleKey(b);
        }
        b.drop = 'excluded-section';
        b.note = `section "${name}" is on the skip list`;
        continue;
      }
      skipLevel = 0;
      if (b.kind === 'heading') narrativeStyles.add(styleKey(b));
      continue;
    }

    if (b.kind === 'caption') {
      // A statement under a label is a paragraph or a few. The legend of a figure after it is
      // no part of it, unless it lists what a supplement holds ("Figure S1", "Additional file 2").
      if (skipLevel === 7 && !/^(?:(?:supplementa(?:ry|l)|suppl?\.?|additional)\s|\S+\s+S\d)/i.test(b.lines[0].text)) skipLevel = 0;
      // Figure legends printed after the reference list (preprints) are still wanted;
      // captions inside a section that is itself skipped are not.
      if (skipLevel && skipWhy !== 'references') b.drop = skipWhy;
      continue;
    }

    const label = runInLabel(b);
    if (label) {
      const isRefs = headingMatches(label.label, REFERENCES);
      if (isRefs || headingMatches(label.label, excluded)) {
        // A labelled paragraph inside a section that is already being skipped changes nothing;
        // on its own it opens a skip that lasts until the next label or heading.
        if (!skipLevel) {
          skipLevel = 7;
          skipWhy = isRefs ? 'references' : 'excluded-section';
          skipStyle = '';
        }
        b.drop = skipWhy;
        b.note = `label "${label.label}" is on the skip list`;
        continue;
      }
      // Any other label ends a skip that was itself started by a label, when running text
      // follows it. A label followed by names or a word or two ("Study concept and design:
      // Example, Sample.", "Other: None.") is one more item of the statement being skipped.
      const f = features(b);
      if (skipLevel === 7 && f.words >= 8 && f.lower >= 0.5) skipLevel = 0;
      if (!skipLevel) b.runIn = label.label;
    }

    if (skipLevel) b.drop = skipWhy;
  }
}

/**
 * The formulas that open a statement printed without a heading at the end of the text, each
 * with the section on the skip list that it would otherwise stand under.
 */
const CLOSING_STATEMENTS: Array<[RegExp, string]> = [
  [
    /^(?:the )?authors? (?:have |has )?(?:declared?|disclosed?|report(?:ed)?|stated?|certif(?:y|ies))\b[^.]*\b(?:conflicts?|competing|interests?)\b/i,
    'competing interests',
  ],
  [
    /^(?:this|the|our) (?:work|project|study|research|investigation|review) (?:was|is|has been|were) (?:\w+ )?(?:supported|funded|sponsored|financed)\b/i,
    'funding',
  ],
  [
    /^(?:we|the authors?) (?:(?:also|gratefully|sincerely|would like to|wish to) )*(?:thank|acknowledge|are grateful|is grateful|are indebted)\b/i,
    'acknowledgements',
  ],
  // Pointers to material that is not in the document.
  [
    /^(?:note: )?(?:any )?(?:additional )?(?:supplementa(?:ry|l)|supporting) (?:information|materials?|data|files?)\b[^.]*\b(?:available|found)\b/i,
    'supplementary information',
  ],
  [/^[^.]{0,160}\b(?:is|are) available (?:in|at|from|with) the online version of (?:the|this) (?:paper|article)/i, 'supplementary information'],
];

/**
 * Thanks, funding and declarations of interest are often printed without a heading, as the
 * last paragraphs before the reference list. Each opens with a formula, and at that place
 * nothing else does: a paragraph that opens with one, with nothing but such paragraphs and
 * skipped end matter between it and the end of the text, goes the way of the section it
 * would stand under, when that section is on the skip list.
 */
export function dropClosingStatements(blocks: Block[], opts: PdfFilterOptions): void {
  const excluded = toPhraseSet(opts.excludedSections);
  const formulas = CLOSING_STATEMENTS.filter(([, section]) => headingMatches(normaliseHeading(section), excluded)).map(([formula]) => formula);
  if (!formulas.length) return;
  let atEnd = true;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.drop) {
      if (b.drop === 'references' || b.drop === 'excluded-section' || b.drop === 'after-references') atEnd = true;
      continue;
    }
    if (b.kind !== 'paragraph' && b.kind !== 'heading' && b.kind !== 'title' && b.kind !== 'list') continue;
    // A statement can carry a label of its own before the formula ("Funding/Support: This work was ...").
    const said = blockText(b).split(' ').slice(runInLabel(b)?.words ?? 0).join(' ');
    if (atEnd && b.kind === 'paragraph' && features(b).words <= 120 && formulas.some((formula) => formula.test(said))) {
      b.drop = 'excluded-section';
      b.note = 'closing statement: thanks, funding, interests or a pointer online';
      continue;
    }
    atEnd = false;
  }
}

/**
 * A reference list recognised by its shape alone, for documents whose list has no
 * heading the layout could find. An entry is short, dense with punctuation, and
 * carries a year together with initials, a page range or a DOI; a list is a long
 * unbroken run of such entries. Ordinary prose never forms one.
 */
function referenceScore(b: Block): number {
  if (b.kind === 'heading' || b.kind === 'title' || b.kind === 'caption') return 0;
  const f = features(b);
  const t = f.text;
  if (!/\b(?:19|20)\d{2}[a-z]?\b/.test(t)) return 0;
  let score = 0;
  if (/^\s*(?:\[[A-Za-z]?\d{1,3}\]|\(?\d{1,3}[.)]\s|\d{1,3}\s+[A-Z])/.test(t)) score += 1;
  const initials = (t.match(/\b[A-Z]\.(?:\s?[A-Z]\.)*/g) ?? []).length;
  const surnames = (t.match(/[A-Z][A-Za-z\u00C0-\u024F'-]+,?\s(?:[A-Z]\.?\s?){1,3}[,.;&]/g) ?? []).length;
  if (initials >= 2 || surnames >= 2) score += 1;
  if (/\bet al\b/i.test(t)) score += 0.5;
  if (/\b\d{1,5}\s?[\u2013-]\s?\d{1,5}\b/.test(t) || /\bdoi\b|https?:\/\//i.test(t)) score += 1;
  if ((t.match(/[.,;:]/g) ?? []).length >= 0.35 * f.words) score += 1;
  return score;
}

/** The number a block opens with, as the entries of a numbered list do ("12.", "[12]"). */
const entryNumber = (b: Block): number => Number(/^[[(]?(\d{1,3})[\]).]/.exec(b.lines[0].text)?.[1] ?? NaN);

function looksLikeReference(b: Block): boolean {
  const words = features(b).words;
  return words >= 5 && words <= 140 && referenceScore(b) >= 2.5;
}

export function dropReferenceRuns(blocks: Block[], bodySize: number): void {
  const live = blocks.filter((b) => !b.drop && b.kind !== 'caption');
  const smallPrint = (b: Block): boolean => b.kind !== 'heading' && b.kind !== 'title' && b.size <= 0.93 * bodySize;
  const hit = live.map(looksLikeReference);
  const MIN_ENTRIES = 5;
  let i = 0;
  while (i < live.length) {
    if (!hit[i]) { i++; continue; }
    // Grow the span while entries keep coming. Entries broken across a column or page leave
    // pieces that do not qualify on their own, so up to two such pieces in a row are allowed
    // (four when they are a few lines each in the small print of the entries: an entry set
    // ragged can break at every change of typeface), but a heading always ends the list.
    let end = i;
    let entries = 1;
    for (let j = i + 1; j < live.length; j++) {
      const piece = live[j];
      if (piece.kind === 'heading' || piece.kind === 'title') break;
      if (hit[j]) { end = j; entries++; continue; }
      const scrap = piece.lines.length <= 3 && smallPrint(piece) && Math.abs(piece.size - live[end].size) <= 0.3;
      if (j - end > (scrap ? 4 : 2)) break;
    }
    if (entries >= MIN_ENTRIES && entries >= 0.6 * (end - i + 1)) {
      // An entry cut in pieces by a page break leaves pieces that do not qualify, in front of
      // the first whole entry. In the small print of the entries they can only be part of the list.
      let start = i;
      while (
        start > 0 && i - start < 3 && smallPrint(live[start - 1]) && live[start - 1].page === live[i].page &&
        live[start - 1].region === live[i].region && live[start - 1].lines.length <= 3 && Math.abs(live[start - 1].size - live[i].size) <= 0.3
      ) start--;
      // Past the last whole entry the list goes on for as long as its small print does: entries
      // with too little punctuation to be told on their own, several run together, the pieces
      // of a broken one. Running text in the same print ends it: several lines with nothing of
      // an entry about them, that do not open with the next number of the list either.
      const listed = end;
      let numbered = NaN;
      for (let j = end; j >= start && Number.isNaN(numbered); j--) numbered = entryNumber(live[j]);
      while (end + 1 < live.length) {
        const next = live[end + 1];
        if (next.kind === 'heading' || next.kind === 'title' || !smallPrint(next)) break;
        const n = entryNumber(next);
        const entry = n === numbered + 1 || next.lines.length < 4 || referenceScore(next) >= 1;
        if (Math.abs(next.size - live[listed].size) > 0.3 || !entry) break;
        if (n > numbered) numbered = n;
        end++;
      }
      for (let j = start; j <= end; j++) {
        live[j].drop = 'references';
        live[j].note = j > listed ? 'in the small print of the reference list' : 'reads as a reference list entry';
      }
    }
    i = end + 1;
  }
}

/**
 * A heading left with no text under it goes too: its section was filtered out, or it was
 * never a section at all (the title printed inside a figure, with only a caption beneath).
 * So does a heading that shares its column with nothing but the pieces of a figure or table:
 * it is the head of a table column, or a label in a figure.
 */
export function dropEmptyHeadings(blocks: Block[]): void {
  const columns = new Map<string, { text: number; float: number }>();
  const columnOf = (b: Block): string => `${b.page}|${b.region}`;
  for (const b of blocks) {
    let c = columns.get(columnOf(b));
    if (!c) columns.set(columnOf(b), (c = { text: 0, float: 0 }));
    if (!b.drop && b.kind !== 'heading' && b.kind !== 'title') c.text++;
    else if (b.drop === 'figure-or-table' || b.drop === 'equation' || b.drop === 'margin') c.float++;
  }
  for (const b of blocks) {
    if (b.drop || b.kind !== 'heading') continue;
    const c = columns.get(columnOf(b));
    if (c && c.text === 0 && c.float >= 2) {
      b.drop = 'figure-or-table';
      b.note = 'heads only the pieces of a figure or table';
    }
  }

  const live = blocks.filter((b) => !b.drop);
  for (let i = live.length - 1; i >= 0; i--) {
    const b = live[i];
    if (b.kind !== 'heading') continue;
    let hasText = false;
    for (let j = i + 1; j < live.length; j++) {
      const next = live[j];
      if (next.drop || next.kind === 'caption') continue;
      // A deeper heading that survived has text of its own, so this section is not empty.
      // Nor is it when the next heading stands directly under this one: whatever their
      // styles say, the upper one is then the title of the group.
      const stacked = blocks[blocks.indexOf(b) + 1] === next && next.page === b.page && next.region === b.region;
      hasText = stacked || !((next.kind === 'heading' || next.kind === 'title') && next.level <= b.level);
      break;
    }
    if (!hasText) {
      b.drop = 'excluded-section';
      b.note = 'nothing left under this heading';
    }
  }
}
