/**
 * Shared types for the PDF reading pipeline.
 *
 * Coordinates are in PDF points in viewport space at scale 1: origin top-left,
 * x to the right, y downwards. `base` is always a text baseline.
 */

/** One text run as delivered by PDF.js, converted to viewport space. */
export interface RawItem {
  s: string;
  x0: number;
  x1: number;
  /** Where the run starts as PDF.js places it, before blanks are trimmed off. */
  origin: number;
  /** Baseline y. */
  base: number;
  /** Font size in points. */
  size: number;
  /** PDF.js font id. Stable within one document, meaningless across documents. */
  font: string;
  /** Position in the content stream; used only as a stable tie-breaker. */
  seq: number;
  /** True when PDF.js reports the font as fixed-pitch (code listings). */
  mono: boolean;
}

export interface RawPage {
  index: number;
  width: number;
  height: number;
  /** Rotation stored in the PDF for this page, in degrees. Sizes and positions already allow for it. */
  rotation: number;
  items: RawItem[];
  /** Number of runs dropped at extraction because they were rotated. */
  rotated: number;
}

/** Minimal slice of a PDF.js document that the extractor needs. */
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export interface PdfPageLike {
  rotate?: number;
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(params?: { includeMarkedContent?: boolean; disableNormalization?: boolean }): Promise<{
    items: unknown[];
    styles?: Record<string, { fontFamily?: string } | undefined>;
  }>;
}

/** One PDF.js run inside a line: the unit the PDF viewer's text layer is built from. */
export interface LineRun {
  /** Where the run starts on the page. The viewer places its text-layer span at the same point. */
  x: number;
  base: number;
  size: number;
  /** For each word of the run in turn, the index of the line's word that it is, or is part of. */
  words: number[];
}

export interface Line {
  page: number;
  x0: number;
  x1: number;
  base: number;
  top: number;
  bottom: number;
  /** Dominant font size, weighted by characters. */
  size: number;
  /**
   * The size of the line's second style when that style sets at least a quarter of the
   * line; 0 for a line in one size. A body line that quotes a long term in smaller type
   * can have that type as its dominant size and the body size here.
   */
  altSize: number;
  /** Dominant font id, weighted by characters. */
  font: string;
  /** Share of the line's characters set in the dominant font, 0..1. */
  purity: number;
  text: string;
  /** Number of cells when the line is cut by wide horizontal gaps (1 for ordinary prose). */
  cells: number;
  /** True when most of the line is set in a fixed-pitch font. */
  mono: boolean;
  /** Left and right edge of each word, used to anchor a selection. Parallel to `text.split(' ')`. */
  wordX0: number[];
  wordX1: number[];
  runs: LineRun[];
  /** Size and font of the last run on the line: the style the text carries into the next line. */
  tailSize: number;
  tailFont: string;
  /** Font of the first word, for run-in heading detection. */
  leadFont: string;
  /** Number of leading words set in `leadFont` before the font changes. */
  leadWords: number;
}

export type BlockKind =
  | 'title'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'caption'
  | 'fragment'
  | 'table'
  | 'equation';

export type DropReason =
  | 'header-footer'
  | 'page-number'
  | 'margin'
  | 'line-number'
  | 'front-matter'
  | 'footnote'
  | 'figure-or-table'
  | 'equation'
  | 'references'
  | 'excluded-section'
  | 'after-references'
  | 'caption'
  | 'boilerplate';

export interface Block {
  page: number;
  /** Index of the single-column region on its page, in reading order. */
  region: number;
  /** Width of that region, for fill-ratio tests. */
  regionX0: number;
  regionX1: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  lines: Line[];
  size: number;
  font: string;
  /** True when the block is set in one of the document's body fonts. */
  plain: boolean;
  kind: BlockKind;
  /** Heading level 1..6 when `kind` is 'title' or 'heading'. */
  level: number;
  /** Set when the block is filtered out, with the rule that removed it. */
  drop?: DropReason;
  /** Short human-readable note on why the block was classified this way (debug report only). */
  note?: string;
  /** Words at the start of a paragraph that form a run-in heading, e.g. "Funding". */
  runIn?: string;
  /** Index in the reader's token stream of the block's first word, once the block is read. */
  token?: number;
}

export interface PdfFilterOptions {
  /** Keep the article title as a top-level heading. */
  includeTitle: boolean;
  /** Keep figure and table captions. */
  includeCaptions: boolean;
  /** Drop authors, affiliations and other first-page metadata. */
  skipFrontMatter: boolean;
  /**
   * Treat the reference list as the end of the document. The list itself is never read;
   * with this off, whatever follows it (methods, appendices, figure legends) still is.
   */
  stopAtReferences: boolean;
  /** Drop footnotes and small print. */
  skipFootnotes: boolean;
  /** Section headings whose sections are dropped, one phrase each. */
  excludedSections: string[];
}

/** One source line of a narrative unit, with the reader token each of its words became. */
export interface UnitLine {
  page: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** Left and right edge of each word of the line. */
  wordX0: number[];
  wordX1: number[];
  /** Index in the reader's token stream of each word of the line. */
  wordToken: number[];
  runs: LineRun[];
}

/** A paragraph or heading of the final narrative, with enough geometry to anchor a selection. */
export interface NarrativeUnit {
  /** Text exactly as handed to the reader, including a `[Hn]` prefix for headings. */
  text: string;
  /** Index of this unit's first token in the reader's token stream. */
  tokenStart: number;
  tokenCount: number;
  kind: BlockKind;
  lines: UnitLine[];
}

export interface PdfNarrative {
  /** Text for the reader: one unit per line. */
  text: string;
  units: NarrativeUnit[];
  blocks: Block[];
  /**
   * Where the runs stood that were taken out before the text was laid out: notes in the
   * margin, stamps, line numbers, words printed over a line. The viewer still has a span for
   * each; a selection in one of them is in no text that is read, wherever on the page it lies.
   */
  removed: Array<{ page: number; x: number; base: number; size: number }>;
  pages: Array<{ width: number; height: number; rotation: number }>;
  stats: {
    pageCount: number;
    bodySize: number;
    scholarly: boolean;
    keptBlocks: number;
    droppedBlocks: number;
    dropped: Partial<Record<DropReason, number>>;
    extractMs: number;
    analyseMs: number;
  };
}
