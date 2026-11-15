/**
 * Step 3: document-level analysis. Runs the page geometry with document-wide
 * knowledge (body font, margins, gutter positions) and returns every block of
 * the document in reading order, not yet filtered.
 */

import type { Block, RawItem, RawPage } from './types';
import { features } from './classify';
import { buildBlocks, buildLines, pageGutters, splitIntoRegions, type GutterHint, type LayoutContext } from './layout';

export interface DocumentLayout {
  blocks: Block[];
  bodySize: number;
  bodyFonts: Set<string>;
  /** True when the body text itself is set in a fixed-pitch font (typescripts). */
  bodyMono: boolean;
  /** Runs removed before layout because they sit in a page margin, per page. */
  marginItems: RawItem[][];
  gutterHints: GutterHint[];
}

/**
 * The body size is the font size that carries the most text. The body fonts are
 * the fonts that carry most of the body-size text on at least one page: PDF
 * files assembled from parts embed the same typeface several times under
 * different ids, so there can be more than one.
 */
function dominantStyle(pages: RawPage[], known?: number): { size: number; fonts: Set<string>; mono: boolean } {
  const sizeVotes = new Map<number, number>();
  for (const p of pages) {
    for (const it of p.items) {
      const k = Math.round(it.size * 4) / 4;
      sizeVotes.set(k, (sizeVotes.get(k) ?? 0) + it.s.length);
    }
  }
  let size = 10, best = -1;
  for (const [k, v] of sizeVotes) if (v > best) { best = v; size = k; }
  if (known) size = known;

  const fonts = new Set<string>();
  let monoChars = 0, allChars = 0;
  for (const p of pages) {
    const votes = new Map<string, number>();
    let total = 0;
    for (const it of p.items) {
      if (Math.abs(it.size - size) > 0.3) continue;
      votes.set(it.font, (votes.get(it.font) ?? 0) + it.s.length);
      total += it.s.length;
      allChars += it.s.length;
      if (it.mono) monoChars += it.s.length;
    }
    for (const [font, n] of votes) if (n >= 0.4 * total && n >= 200) fonts.add(font);
  }
  return { size, fonts, mono: monoChars > 0.5 * allChars };
}

/**
 * Text in the side margins: line numbers, and the notes and key terms that some books and
 * journals print beside the lines they belong to. Summed over the pages, the text block is
 * a band of heavy coverage with sharp edges; margin text lies beyond an edge, across a
 * strip that stays clear on every page. It counts as margin text when it is a narrow strip,
 * or when it is sparse and in smaller type than the body (a heading hung in the margin is
 * neither). Returns the x-range of the text block proper, or null when nothing lies outside it.
 */
interface TextBlockRange {
  x0: number;
  x1: number;
  /** A side whose margin holds notes, not a strip of line numbers: see `isNotes`. */
  notesLeft: boolean;
  notesRight: boolean;
}

/** How far outside the block a run has to stand, and how far across its edge one has to reach. */
const MARGIN_GAP = 4;

function textBlockRange(pages: RawPage[], bodySize: number): TextBlockRange | null {
  const width = Math.ceil(Math.max(...pages.map((p) => p.width)));
  const coverage = new Float64Array(width + 2);
  let total = 0;
  for (const p of pages) {
    for (const it of p.items) {
      // Running headers and footers span the page and would bridge the gap being looked for.
      if (it.base < 0.1 * p.height || it.base > 0.9 * p.height) continue;
      const a = Math.max(0, Math.floor(it.x0));
      const b = Math.min(width, Math.ceil(it.x1));
      for (let x = a; x < b; x++) coverage[x] += it.size;
      total += (b - a) * it.size;
    }
  }
  if (!total) return null;
  const peak = Math.max(...coverage);
  const floor = peak * 0.02;
  const GAP = MARGIN_GAP;

  // Bands of covered x separated by clear strips.
  const bands: Array<{ x0: number; x1: number; mass: number }> = [];
  let start = -1, gap = 0, mass = 0;
  for (let x = 0; x <= width; x++) {
    if (coverage[x] > floor) {
      if (start < 0) { start = x; mass = 0; }
      gap = 0;
      mass += coverage[x];
    } else if (start >= 0 && ++gap >= GAP) {
      bands.push({ x0: start, x1: x - gap + 1, mass });
      start = -1;
    }
  }
  if (start >= 0) bands.push({ x0: start, x1: width, mass });
  if (!bands.length) return null;

  type Band = { x0: number; x1: number; mass: number };
  const strip = (b: Band): boolean => b.x1 - b.x0 <= 0.06 * width && b.mass <= 0.08 * total;
  const light = (b: Band): boolean => b.mass <= 0.04 * total;
  let first = 0, last = bands.length - 1;
  while (first < last && (strip(bands[first]) || light(bands[first]))) first++;
  while (last > first && (strip(bands[last]) || light(bands[last]))) last--;
  const block = { x0: bands[first].x0 - 1, x1: bands[last].x1 + 1 };

  // What lies wholly beyond the block, clear of it, on each side: how much, and in what size.
  // And how much reaches across the edge: where captions and figures are set wider than the
  // text, the space beside the block is theirs and holds no notes.
  const beyond = { left: { mass: 0, sized: 0, across: 0 }, right: { mass: 0, sized: 0, across: 0 } };
  for (const p of pages) {
    for (const it of p.items) {
      if (it.base < 0.1 * p.height || it.base > 0.9 * p.height) continue;
      const m = (it.x1 - it.x0) * it.size;
      if (it.x0 < block.x0 - GAP && it.x1 > block.x0 + GAP) beyond.left.across += Math.min(m, (block.x0 - it.x0) * it.size);
      if (it.x1 > block.x1 + GAP && it.x0 < block.x1 - GAP) beyond.right.across += Math.min(m, (it.x1 - block.x1) * it.size);
      const side = it.x1 <= block.x0 - GAP + 1 ? beyond.left : it.x0 >= block.x1 + GAP - 1 ? beyond.right : null;
      if (!side) continue;
      side.mass += m;
      side.sized += m * it.size;
    }
  }
  type Beyond = { mass: number; sized: number; across: number };
  const isStrip = (outer: Band[], s: Beyond): boolean => s.mass > 0 && outer.length > 0 && outer.every(strip);
  const isNotes = (s: Beyond): boolean =>
    s.mass > 0 && s.mass <= 0.04 * total && s.sized / s.mass <= 0.93 * bodySize && s.across <= 0.2 * s.mass;
  const stripLeft = isStrip(bands.slice(0, first), beyond.left);
  const stripRight = isStrip(bands.slice(last + 1), beyond.right);
  const notesLeft = !stripLeft && isNotes(beyond.left);
  const notesRight = !stripRight && isNotes(beyond.right);
  if (!stripLeft && !stripRight && !notesLeft && !notesRight) return null;
  return {
    x0: stripLeft || notesLeft ? block.x0 : -Infinity,
    x1: stripRight || notesRight ? block.x1 : Infinity,
    notesLeft,
    notesRight,
  };
}

/**
 * A watermark or stamp printed upright: the same words at the same spot on most of the
 * pages, away from the head and foot of the page (running heads are found later, as blocks).
 * Text of the document itself never stands at one spot on half its pages.
 */
function stamps(pages: RawPage[]): Set<RawItem> {
  const found = new Set<RawItem>();
  if (pages.length < 3) return found;
  const spots = new Map<string, { pages: Set<number>; items: RawItem[] }>();
  for (const p of pages) {
    for (const it of p.items) {
      if (it.base < 0.1 * p.height || it.base > 0.9 * p.height || !/[A-Za-z]{3}/.test(it.s)) continue;
      const key = `${it.s.trim()}|${Math.round(it.x0)}|${Math.round(it.base)}|${Math.round(it.size)}`;
      let spot = spots.get(key);
      if (!spot) spots.set(key, (spot = { pages: new Set(), items: [] }));
      spot.pages.add(p.index);
      spot.items.push(it);
    }
  }
  const need = Math.max(3, Math.ceil(0.5 * pages.length));
  for (const spot of spots.values()) if (spot.pages.size >= need) for (const it of spot.items) found.add(it);
  return found;
}

/**
 * Words printed over a line of text: a short string in a size or on a baseline of its own,
 * lying across the words of a longer line and nearer to it than half the way to the next
 * line. Two things cannot be read at one spot, so the short one is not on the page as it is
 * seen: the credit inside a figure's artwork, hidden behind a line of the legend, is one. A
 * string found so twice is the same thing wherever else the document has it. (In a scan, a
 * word that the recognition set a little off its line overlaps nothing on that line, and
 * the lines beside it are a whole line away.)
 */
function overprints(pages: RawPage[]): Set<RawItem> {
  const found = new Set<RawItem>();
  interface Stretch { items: RawItem[]; x0: number; x1: number; base: number; size: number; words: number }
  const label = (s: Stretch): string => `${s.items.map((it) => it.s.trim()).join(' ')}|${s.size.toFixed(1)}`;
  const short: Stretch[] = [];
  const times = new Map<string, number>();
  for (const page of pages) {
    // A stretch: runs of one baseline and one size that follow one another closely.
    const stretches: Stretch[] = [];
    const byLine = page.items.slice().sort((p, q) => p.base - q.base);
    for (let from = 0; from < byLine.length; ) {
      let to = from + 1;
      while (to < byLine.length && byLine[to].base - byLine[from].base <= 0.05) to++;
      const row = byLine.slice(from, to).sort((p, q) => p.x0 - q.x0);
      from = to;
      let open: Stretch | null = null;
      for (const it of row) {
        if (!open || Math.abs(it.size - open.size) > 0.05 || it.x0 - open.x1 > 1.5 * it.size) {
          stretches.push((open = { items: [], x0: it.x0, x1: it.x1, base: it.base, size: it.size, words: 0 }));
        }
        open.items.push(it);
        open.x1 = Math.max(open.x1, it.x1);
        open.words += (it.s.match(/\S*[A-Za-z]\S*/g) ?? []).length;
      }
    }
    /** Distance from a line to the nearest other line of text above or below it. */
    const pitch = (b: Stretch, at: number): number => {
      const beside = (c: Stretch): boolean =>
        c.words >= 5 && Math.abs(c.base - b.base) > 0.12 * b.size && Math.min(b.x1, c.x1) - Math.max(b.x0, c.x0) > 0.5 * Math.min(b.x1 - b.x0, c.x1 - c.x0);
      for (let up = at - 1, down = at + 1; up >= 0 || down < stretches.length; ) {
        const above = up >= 0 ? b.base - stretches[up].base : Infinity;
        const below = down < stretches.length ? stretches[down].base - b.base : Infinity;
        if (Math.min(above, below) > 3 * b.size) break;
        const c = above <= below ? stretches[up--] : stretches[down++];
        if (beside(c)) return Math.abs(c.base - b.base);
      }
      return Infinity;
    };
    stretches.forEach((a, i) => {
      if (a.words < 1 || a.words > 6 || !a.items.some((it) => /[A-Za-z]{3}/.test(it.s))) return;
      short.push(a);
      const width = a.x1 - a.x0;
      const covers = (b: Stretch, at: number): boolean => {
        const size = Math.max(a.size, b.size);
        const apart = Math.abs(a.base - b.base);
        if (b.words < Math.max(5, a.words + 2) || b.x1 - b.x0 <= width || apart >= 0.6 * size || Math.min(a.size, b.size) < 0.75 * size) return false;
        let over = 0;
        for (const it of b.items) over += Math.max(0, Math.min(a.x1, it.x1) - Math.max(a.x0, it.x0));
        return over >= 0.6 * width && apart <= 0.5 * pitch(b, at);
      };
      let hit = false;
      for (let j = i - 1; j >= 0 && !hit && a.base - stretches[j].base < 0.8 * a.size; j--) hit = covers(stretches[j], j);
      for (let j = i + 1; j < stretches.length && !hit && stretches[j].base - a.base < 0.8 * a.size; j++) hit = covers(stretches[j], j);
      if (!hit) return;
      for (const it of a.items) found.add(it);
      times.set(label(a), (times.get(label(a)) ?? 0) + 1);
    });
  }
  const repeated = new Set(Array.from(times).filter(([, n]) => n >= 2).map(([text]) => text));
  if (repeated.size) {
    for (const a of short) if (a.words >= 2 && repeated.has(label(a))) for (const it of a.items) found.add(it);
  }
  return found;
}

/**
 * Line numbers, wherever they stand: in a side margin, in both, or in the gutter beside the
 * second column. They are a column of bare numbers, lined up on one edge, that count up
 * steadily (by one, or by fives) at the pace of the lines of text beside them. The numbers
 * of a list count up too, but its entries run to several lines, so they fall behind the lines.
 */
function lineNumbers(page: RawPage): Set<RawItem> {
  const found = new Set<RawItem>();
  const bare = page.items.filter((it) => /^\d{1,4}$/.test(it.s.trim()));
  if (bare.length < 8) return found;
  const median = (values: number[]): number => values.slice().sort((a, b) => a - b)[values.length >> 1];

  for (const edge of ['x1', 'x0'] as const) {
    const byEdge = bare.filter((it) => !found.has(it)).sort((a, b) => a[edge] - b[edge]);
    for (let from = 0; from < byEdge.length; ) {
      let to = from + 1;
      while (to < byEdge.length && byEdge[to][edge] - byEdge[to - 1][edge] <= 2.5) to++;
      const column = byEdge.slice(from, to).sort((a, b) => a.base - b.base);
      from = to;
      if (column.length < 8) continue;

      const counts: number[] = [];
      const drops: number[] = [];
      for (let i = 1; i < column.length; i++) {
        counts.push(Number(column[i].s) - Number(column[i - 1].s));
        drops.push(column[i].base - column[i - 1].base);
      }
      const step = median(counts);
      const drop = median(drops);
      if (step < 1 || step > 10 || counts.filter((c) => c === step).length < 0.9 * counts.length) continue;

      // The pace of the text beside the column: the usual distance from one line to the next.
      const x0 = Math.min(...column.map((it) => it.x0));
      const x1 = Math.max(...column.map((it) => it.x1));
      const bases = page.items
        .filter((it) => !/^\d{1,4}$/.test(it.s.trim()) && it.base >= column[0].base - 1 && it.base <= column[column.length - 1].base + 1)
        .filter((it) => (it.x0 >= x1 && it.x0 - x1 <= 60) || (it.x1 <= x0 && x0 - it.x1 <= 60))
        .map((it) => it.base)
        .sort((a, b) => a - b);
      const paces: number[] = [];
      for (let i = 1; i < bases.length; i++) if (bases[i] - bases[i - 1] > 2) paces.push(bases[i] - bases[i - 1]);
      if (paces.length < 4 || Math.abs(drop - step * median(paces)) > 0.15 * median(paces)) continue;
      for (const it of column) found.add(it);
    }
  }
  return found;
}

/**
 * A run past the edge of the text block that carries on a line of the block belongs to that
 * line: the end of an overlong line, the label hung in front of a caption. It touches its
 * neighbour, or follows it at a word space in the same type. Margin text stands clear of the
 * line beside it and is set in a type of its own. Moves such runs from `outside` to `inside`.
 */
function reattach(inside: RawItem[], outside: RawItem[]): void {
  const joins = (o: RawItem, it: RawItem): boolean => {
    const small = Math.min(o.size, it.size);
    const overlap = Math.min(o.base + 0.22 * o.size, it.base + 0.22 * it.size) - Math.max(o.base - 0.78 * o.size, it.base - 0.78 * it.size);
    if (overlap < 0.5 * small) return false;
    const gap = Math.max(o.x0 - it.x1, it.x0 - o.x1);
    if (gap < -0.5 * small) return false;
    const sameType = it.font === o.font || Math.abs(it.size - o.size) <= 0.08 * Math.max(it.size, o.size);
    return gap <= 0.2 * small + 0.5 || (sameType && gap <= 0.45 * small);
  };
  for (let moved = true; moved && outside.length; ) {
    moved = false;
    for (let k = outside.length - 1; k >= 0; k--) {
      const o = outside[k];
      if (!inside.some((it) => joins(o, it))) continue;
      inside.push(o);
      outside.splice(k, 1);
      moved = true;
    }
  }
}

/**
 * Headings hung in the margin beside the paragraphs they head, as some textbooks set them:
 * a narrow column holding nothing but a few words here and there in the type of the text,
 * each level with the top of a paragraph in the column to its right. Read as a column they
 * would all come before the text; each is moved in front of its own paragraph instead.
 */
function hangSideHeads(side: Block[], text: Block[], bodySize: number, pageWidth: number): void {
  if (!side.length || !text.length || side[0].regionX1 > text[0].regionX0 + 2) return;
  if (side[0].regionX1 - side[0].regionX0 > 0.25 * pageWidth) return;
  const words = (b: Block): number => b.lines.reduce((n, l) => n + l.wordX0.length, 0);
  if (!side.every((b) => b.lines.length <= 3 && words(b) <= 10 && b.size >= 0.95 * bodySize)) return;
  const homes = side.map((b) => text.findIndex((t) => Math.abs(t.top - b.top) <= 0.8 * b.size));
  if (homes.some((at) => at < 0)) return;
  const region = text[0];
  const merged: Block[] = [];
  text.forEach((t, at) => {
    side.forEach((b, k) => {
      if (homes[k] === at) merged.push({ ...b, region: region.region, regionX0: region.regionX0, regionX1: region.regionX1 });
    });
    merged.push(t);
  });
  side.length = 0;
  text.splice(0, text.length, ...merged);
}

function clusterHints(found: Array<{ x: number; height: number; width: number; page: number }>): GutterHint[] {
  const sorted = found.slice().sort((a, b) => a.x - b.x);
  const clusters: Array<{ x: number; width: number; weight: number; pages: Set<number> }> = [];
  for (const g of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && g.x - last.x <= 10) {
      last.x = (last.x * last.weight + g.x * g.height) / (last.weight + g.height);
      last.width = Math.min(last.width, g.width);
      last.weight += g.height;
      last.pages.add(g.page);
    } else {
      clusters.push({ x: g.x, width: g.width, weight: g.height, pages: new Set([g.page]) });
    }
  }
  return clusters.filter((c) => c.pages.size >= 2).map((c) => ({ x: c.x, width: c.width }));
}

/**
 * The size that carries the most characters can be that of the tables or of the reference
 * list, where a paper has much of either. The body is what the long paragraphs are set in:
 * blocks of six lines or more that fill their column with mostly lower-case words.
 */
function proseSize(blocks: Block[], bodySize: number): number {
  const words = new Map<number, number>();
  for (const b of blocks) {
    if (b.lines.length < 6) continue;
    const f = features(b);
    if (f.fill < 0.8 || f.celled >= 0.2 || f.lower < 0.6 || f.wordy < 0.4) continue;
    const k = Math.round(b.size * 4) / 4;
    words.set(k, (words.get(k) ?? 0) + f.words);
  }
  let size = bodySize, best = 1.2 * (words.get(bodySize) ?? 0);
  for (const [k, n] of words) if (n > best) { best = n; size = k; }
  return size;
}

export function analyseLayout(source: RawPage[]): DocumentLayout {
  const first = layoutIn(source, dominantStyle(source));
  const size = proseSize(first.blocks, first.bodySize);
  return Math.abs(size - first.bodySize) <= 0.06 * first.bodySize ? first : layoutIn(source, dominantStyle(source, size));
}

function layoutIn(source: RawPage[], style: { size: number; fonts: Set<string>; mono: boolean }): DocumentLayout {
  const { size: bodySize, fonts: bodyFonts, mono: bodyMono } = style;
  // Line numbers, stamps and words printed over a line are taken out before anything is measured.
  const stamped = stamps(source);
  const removed = source.map(lineNumbers);
  const overprinted = overprints(source);
  for (const p of source) for (const it of p.items) if (stamped.has(it) || overprinted.has(it)) removed[p.index].add(it);
  const pages = source.map((p, i) => (removed[i].size ? { ...p, items: p.items.filter((it) => !removed[i].has(it)) } : p));

  // Mirrored margins: odd and even pages are measured separately when there are enough of each.
  const parity = pages.length >= 6;
  const ranges = parity
    ? [textBlockRange(pages.filter((p) => p.index % 2 === 0), bodySize), textBlockRange(pages.filter((p) => p.index % 2 === 1), bodySize)]
    : [textBlockRange(pages, bodySize), textBlockRange(pages, bodySize)];

  const marginItems: RawItem[][] = [];
  const kept: RawItem[][] = [];
  for (const p of pages) {
    const range = ranges[p.index % 2];
    const inside: RawItem[] = [];
    const outside: RawItem[] = [];
    // On a page where a caption or a figure reaches across the edge of the block, the space
    // beside the block is theirs: what stands there is part of them, not a note.
    const side = { left: { out: 0, across: 0 }, right: { out: 0, across: 0 } };
    for (const it of p.items) {
      const mid = (it.x0 + it.x1) / 2;
      if (!range) continue;
      if (mid < range.x0) side.left.out += (it.x1 - it.x0) * it.size;
      else if (it.x0 < range.x0 - MARGIN_GAP) side.left.across += (range.x0 - it.x0) * it.size;
      if (mid > range.x1) side.right.out += (it.x1 - it.x0) * it.size;
      else if (it.x1 > range.x1 + MARGIN_GAP) side.right.across += (it.x1 - range.x1) * it.size;
    }
    const keepLeft = !!range && range.notesLeft && side.left.across > 0.2 * side.left.out;
    const keepRight = !!range && range.notesRight && side.right.across > 0.2 * side.right.out;
    for (const it of p.items) {
      const mid = (it.x0 + it.x1) / 2;
      if (range && ((mid < range.x0 && !keepLeft) || (mid > range.x1 && !keepRight))) outside.push(it);
      else inside.push(it);
    }
    if (outside.length) reattach(inside, outside);
    kept.push(inside);
    marginItems.push([...outside, ...removed[p.index]]);
  }

  const found: Array<{ x: number; height: number; width: number; page: number }> = [];
  pages.forEach((p, i) => {
    const ctx: LayoutContext = { pageWidth: p.width, pageHeight: p.height, bodySize, gutterHints: [] };
    for (const g of pageGutters(kept[i], ctx)) found.push({ ...g, page: i });
  });
  const gutterHints = clusterHints(found);

  const blocks: Block[] = [];
  pages.forEach((p, i) => {
    const before = found.filter((g) => g.page === i - 1).map((g) => ({ x: g.x, width: g.width }));
    const ctx: LayoutContext = { pageWidth: p.width, pageHeight: p.height, bodySize, gutterHints, before };
    const regions = splitIntoRegions(kept[i], ctx);
    const perRegion = regions.map((region, r) => buildBlocks(buildLines(region, p.index), region, r, bodyFonts, p.height));
    for (let r = 0; r + 1 < perRegion.length; r++) hangSideHeads(perRegion[r], perRegion[r + 1], bodySize, p.width);
    for (const list of perRegion) blocks.push(...list);
  });

  return { blocks, bodySize, bodyFonts, bodyMono, marginItems, gutterHints };
}
