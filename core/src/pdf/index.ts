/**
 * PDF reading pipeline.
 *
 *   extract   PDF.js text runs -> positioned runs            (async, the only PDF.js call)
 *   glyphs    ligatures and Symbol letters kept at private code points -> their letters
 *   layout    runs -> columns in reading order -> lines -> blocks
 *   classify  blocks -> title, heading, paragraph, caption, table, ...; page furniture out
 *   sections  front matter, reference list and listed sections out
 *   narrative blocks -> reader text, with every word traceable to its place on the page
 */

import type { DropReason, PdfDocumentLike, PdfFilterOptions, PdfNarrative, RawPage } from './types';
import { extractRawPages } from './extract';
import { nameUnnamedGlyphs } from './glyphs';
import { analyseLayout } from './analyse';
import {
  classifyBlocks, demoteOrphanHeadings, dropFloatContents, dropTableNotes, dropFootnotes, dropPageFurniture, dropSideNotes,
  joinCaptionParts, orderBands, reclaimText, splitStackedHeadings,
} from './classify';
import {
  applyFrontMatter, applySections, assignHeadingLevels, dropClosingStatements, dropEmptyHeadings, dropFollowingArticle,
  dropReferenceRuns, promoteNamedHeadings,
} from './sections';
import { buildNarrative } from './narrative';

export type { PdfNarrative, PdfFilterOptions, PdfDocumentLike, Block, DropReason, RawPage } from './types';
export { locateAnchor, locateWord, textBetween, tokenTexts } from './locate';
export type { LocateResult, PagePoint, TextLayerAnchor } from './locate';
export { readSelectionAnchors } from './selection';
export type { SelectionAnchors } from './selection';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Everything after extraction. Synchronous and free of PDF.js, so it can be tested on saved pages. */
export function analysePages(pages: RawPage[], options: PdfFilterOptions, extractMs = 0): PdfNarrative {
  const started = now();
  nameUnnamedGlyphs(pages);
  const layout = analyseLayout(pages);
  const blocks = layout.blocks;
  const sizes = pages.map((p) => ({ width: p.width, height: p.height, rotation: p.rotation }));

  classifyBlocks(blocks, layout.bodySize, layout.bodyFonts, layout.bodyMono);
  reclaimText(blocks);
  dropPageFurniture(blocks, sizes);
  joinCaptionParts(blocks, layout.bodySize);
  dropSideNotes(blocks, layout.bodySize, sizes);
  demoteOrphanHeadings(blocks);
  splitStackedHeadings(blocks);
  orderBands(blocks);
  dropTableNotes(blocks, layout.bodySize, dropFloatContents(blocks, layout.bodySize));
  if (options.skipFootnotes) dropFootnotes(blocks, layout.bodySize, sizes);

  promoteNamedHeadings(blocks, options);
  const structure = applyFrontMatter(blocks, layout.bodySize, options);
  assignHeadingLevels(blocks);
  dropReferenceRuns(blocks, layout.bodySize);
  dropFollowingArticle(blocks, structure.title, layout.bodySize, pages.length);
  applySections(blocks, options);
  dropClosingStatements(blocks, options);

  for (const b of blocks) {
    if (b.drop) continue;
    if (b.kind === 'table' || b.kind === 'fragment') b.drop = 'figure-or-table';
    else if (b.kind === 'equation') b.drop = 'equation';
    else if (b.kind === 'caption' && !options.includeCaptions) b.drop = 'caption';
  }
  dropEmptyHeadings(blocks);
  // Rank the headings again among those that survived, so that the styles of dropped
  // material (forms, supplements) do not push the real headings down the scale.
  assignHeadingLevels(blocks);

  const { text, units } = buildNarrative(blocks);

  const dropped: Partial<Record<DropReason, number>> = {};
  let keptBlocks = 0;
  for (const b of blocks) {
    if (b.drop) dropped[b.drop] = (dropped[b.drop] ?? 0) + 1;
    else keptBlocks++;
  }
  const margin = layout.marginItems.reduce((n, items) => n + items.length, 0);
  if (margin) dropped.margin = margin;

  return {
    text,
    units,
    blocks,
    removed: layout.marginItems.flatMap((items, page) => items.map((it) => ({ page, x: it.origin, base: it.base, size: it.size }))),
    pages: sizes,
    stats: {
      pageCount: pages.length,
      bodySize: layout.bodySize,
      scholarly: structure.scholarly,
      keptBlocks,
      droppedBlocks: blocks.length - keptBlocks,
      dropped,
      extractMs,
      analyseMs: now() - started,
    },
  };
}

/**
 * The same document with one block that is left out read after all, in its place. This is
 * what a start inside such a block asks for: the reader pointed at that text.
 */
export function withBlock(narrative: PdfNarrative, index: number): PdfNarrative {
  const blocks = narrative.blocks.map((b, i) => (i === index ? { ...b, drop: undefined, note: 'read because reading was started in it' } : { ...b }));
  const { text, units } = buildNarrative(blocks);
  return { ...narrative, text, units, blocks };
}

export async function parsePdf(doc: PdfDocumentLike, options: PdfFilterOptions, maxPages = 400): Promise<PdfNarrative> {
  const started = now();
  const pages = await extractRawPages(doc, maxPages);
  return analysePages(pages, options, now() - started);
}
