/**
 * Step 1: pull positioned text runs out of a PDF.js document.
 *
 * This is the only step that talks to PDF.js. Everything after it is plain
 * arithmetic on the returned arrays, which is what keeps the pipeline cheap
 * and lets it run unchanged outside Obsidian.
 */

import type { PdfDocumentLike, RawItem, RawPage } from './types';

/** Runs tilted by more than this are watermarks, margin stamps or sideways tables. */
const MAX_TILT_RAD = 0.12;
/** Pages are fetched in small parallel batches so the PDF.js worker stays busy. */
const BATCH = 8;

/**
 * Presentation forms that stand for ordinary letters: ligatures above all. PDF.js folds these
 * itself unless asked not to; here the text is requested raw, so that every run is the very
 * string the viewer's text layer shows, and the folding is done in this one place.
 */
const PRESENTATION_FORMS = /[\u00B5\u037E\u2126\uFB00-\uFB06]+/g;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
/**
 * A glyph that its font names only by a number ("C3") reaches the viewer as a control
 * character. It is a sign of the text all the same (a minus, a degree, a Greek letter), so it
 * is kept, moved to the private area where `glyphs.ts` looks for characters without a name.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being looked for
const NAMELESS = /[\u0001-\u0008\u000E-\u001F\u007F-\u009F]/g;
/** Where such a glyph is kept: U+F800 plus its number. */
export const KEPT_NAMELESS = /[\uF801-\uF89F]/;
const ACCENTS_ONLY = /^[\u0300-\u036F\u00A8\u00AF\u00B4\u00B8\u02C6\u02C7\u02D8-\u02DD^`~]+$/;

function cleanString(s: string): string {
  return s
    .replace(INVISIBLE, '')
    .replace(/\u00AD$/, '-')
    .replace(/\u00AD/g, '')
    .replace(PRESENTATION_FORMS, (m) => m.normalize('NFKC'))
    .replace(NAMELESS, (c) => String.fromCharCode(0xf800 + c.charCodeAt(0)))
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
    .replace(/[\u0000-\u001F]/g, ' ')
    // Everything JavaScript counts as white space becomes a plain space, so the reader's
    // own tokeniser can never split a word that this pipeline counted as one.
    .replace(/\s/g, ' ');
}

/** True when `s` holds nothing that this pipeline would keep as part of a word. */
export function isBlankText(s: string): boolean {
  return !cleanString(s).trim();
}

/**
 * Which word of a run the character at `offset` belongs to, counting from 0, where `raw` is
 * the run's text as the viewer shows it. A position between words belongs to the word that
 * follows. Returns -1 when no word starts at or after the position.
 */
export function runWordAt(raw: string, offset: number): number {
  const before = cleanString(raw.slice(0, offset));
  const after = cleanString(raw.slice(offset));
  if (!after.trim()) return -1;
  const wordsBefore = before.split(' ').filter(Boolean).length;
  const midWord = before !== '' && !before.endsWith(' ') && !after.startsWith(' ');
  return midWord ? wordsBefore - 1 : wordsBefore;
}

/** Row-major product of two PDF affine matrices. */
function multiply(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

interface PdfJsTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  fontName?: unknown;
}

async function extractPage(doc: PdfDocumentLike, pageNumber: number): Promise<RawPage> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);

  const items: RawItem[] = [];
  let rotated = 0;
  let seq = 0;
  /** A whitespace-only run means "there is a space here" even when the geometry says otherwise. */
  let pendingSpace = false;

  for (const raw of content.items as PdfJsTextItem[]) {
    if (typeof raw.str !== 'string' || !Array.isArray(raw.transform)) continue;
    const text = cleanString(raw.str);
    const trimmed = text.trim();
    if (!trimmed) {
      if (text.length) pendingSpace = true;
      continue;
    }

    const m = multiply(viewport.transform, raw.transform as number[]);
    const size = Math.hypot(m[2], m[3]);
    if (!(size >= 2) || size > 200) continue;
    if (Math.abs(Math.atan2(m[1], m[0])) > MAX_TILT_RAD) {
      rotated++;
      continue;
    }

    const runWidth = Math.max(0, Number(raw.width) || 0);
    // A run of no width at all cannot be seen or pointed at: a marker the typesetter left in
    // the file ("[(Fig._3)TD$FIG]", a letter to a run, all at one spot). An accent is the
    // exception: it is printed over the letter beside it and takes up no room of its own.
    if (!runWidth && !ACCENTS_ONLY.test(trimmed)) continue;
    // A blank at the start of a run takes up none of the run's room: the viewer begins the run at its first visible character.
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    const perChar = runWidth / (text.length - lead);
    const x0 = m[4];
    const x1 = Math.max(x0 + 0.1, m[4] + runWidth - trail * perChar);
    if (x1 < 0 || x0 > width || m[5] < 0 || m[5] > height + size) continue;

    // Spaces that the geometry cannot show are kept as an explicit leading blank.
    const s = (lead > 0 || pendingSpace ? ' ' : '') + trimmed.replace(/\s+/g, ' ') + (trail > 0 ? ' ' : '');
    pendingSpace = false;
    const font = typeof raw.fontName === 'string' ? raw.fontName : '';
    const mono = content.styles?.[font]?.fontFamily === 'monospace';
    items.push({ s, x0, x1, origin: m[4], base: m[5], size, font, seq: seq++, mono });
  }

  return { index: pageNumber - 1, width, height, rotation: Number(page.rotate) || 0, items, rotated };
}

export async function extractRawPages(doc: PdfDocumentLike, maxPages: number): Promise<RawPage[]> {
  const total = Math.min(doc.numPages, maxPages);
  const pages: RawPage[] = [];
  for (let start = 1; start <= total; start += BATCH) {
    const batch: Array<Promise<RawPage>> = [];
    for (let n = start; n < start + BATCH && n <= total; n++) {
      batch.push(
        extractPage(doc, n).catch((): RawPage => ({ index: n - 1, width: 1, height: 1, rotation: 0, items: [], rotated: 0 }))
      );
    }
    pages.push(...(await Promise.all(batch)));
  }
  return pages;
}
