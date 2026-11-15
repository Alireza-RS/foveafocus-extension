/**
 * From a place on a page of the viewer to what is read from there.
 *
 * The pages are drawn here, so a selection and a click have a place on them: a page, and a
 * spot on it. The plugin's own code (core/src/pdf) reads that place off the text layer and
 * finds the one word of the reading text that lies there. A word is never looked up by what
 * it says, since the same word stands in a document many times.
 *
 * What is done with the word that is found is what the plugin does in its app: a start in
 * a part that is left out puts that part back and says so, and a selection that is read
 * alone is played as the cleaned text between its two ends.
 */

import {
  locateAnchor, locateWord, readSelectionAnchors, textBetween, withBlock,
  type DropReason, type LocateResult, type PagePoint, type PdfNarrative, type SelectionAnchors,
} from '../../core/src/pdf';
import { isBlankText } from '../../core/src/pdf/extract';

/** What is read: the text and the index of the word it starts at, or nothing; and a word to the reader about it */
export interface Answer {
  reading: { text: string; startAt: number } | null;
  said?: string;
}

/** What a part that is left out is called, as the plugin says it */
const DROPPED_AS: Record<DropReason, string> = {
  'header-footer': 'a running header or footer',
  'page-number': 'a page number',
  margin: 'a note in the margin',
  'line-number': 'a line number',
  'front-matter': 'the title-page details',
  footnote: 'a footnote',
  'figure-or-table': 'part of a figure or table',
  equation: 'a displayed equation',
  references: 'the reference list',
  'excluded-section': 'a section on the skip list',
  'after-references': 'text after the reference list',
  caption: 'a caption',
  boilerplate: 'publisher small print',
};

const NO_WORD: Answer = { reading: null, said: 'Could not tell which word that is. Click or select a word in the text.' };

/** A PDF is read up to a number of pages, and no further. Of a word on a later page, the page says so. */
const beyond = (narrative: PdfNarrative, page: number): Answer | null =>
  page < narrative.pages.length ? null : { reading: null, said: `FoveaFocus reads the first ${narrative.pages.length} pages of a PDF. That word is on page ${page + 1}.` };

/** What is selected in the pages, as its two ends on them; null where nothing is */
export function selected(): SelectionAnchors | null {
  const selection = document.getSelection();
  return selection && !selection.isCollapsed ? readSelectionAnchors(selection) : null;
}

/**
 * The words of the text under a point of the window, the uppermost first, each as a range. More
 * than one run of the text can lie at a point: a stamp that is printed across a page lies over
 * every word of it. A link lies over the words it is drawn on as well, and is no text.
 */
function wordsAt(x: number, y: number): Range[] {
  const words: Range[] = [];
  for (const element of document.elementsFromPoint(x, y)) {
    if (!element.closest('.textLayer')) continue;
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = (node as Text).data;
      for (let from = 0; from < text.length; from++) {
        if (isBlankText(text[from])) continue;
        let to = from + 1;
        while (to < text.length && !isBlankText(text[to])) to += 1;
        const word = document.createRange();
        word.setStart(node, from);
        word.setEnd(node, to);
        const box = word.getBoundingClientRect();
        if (x >= box.left - 2 && x <= box.right + 2 && y >= box.top - 2 && y <= box.bottom + 2) words.push(word);
        from = to;
      }
    }
  }
  return words;
}

/** The two ends of a range on the pages, as the ends of a selection are read */
function anchorsOf(range: Range): SelectionAnchors | null {
  return readSelectionAnchors({ rangeCount: 1, getRangeAt: () => range, toString: () => range.toString() } as unknown as Selection);
}

/**
 * The word under a point of the window that is meant, as a range; null where the point lies on
 * no word. It is the uppermost word that is part of the text, read or left out: a stamp is no
 * part of it, and the word beneath the stamp is meant. Until the text is known, it is the
 * uppermost word.
 */
export function wordAt(x: number, y: number, narrative?: PdfNarrative | null): Range | null {
  const words = wordsAt(x, y);
  const inText = (word: Range): boolean => {
    const anchors = narrative && anchorsOf(word);
    if (!anchors) return false;
    const hit = locateAnchor(narrative, anchors.start, anchors.text);
    return hit.ok || hit.reason === 'filtered';
  };
  return words.find(inText) ?? words[0] ?? null;
}

/** A point of the window as a point of the page it lies on. The page is what lies inside the border of its element. */
function pagePoint(x: number, y: number): PagePoint | null {
  const page = document.elementFromPoint(x, y)?.closest('.page[data-page-number]');
  if (!page || !(page.clientWidth > 0 && page.clientHeight > 0)) return null;
  const box = page.getBoundingClientRect();
  return {
    page: Number(page.getAttribute('data-page-number')) - 1,
    xn: (x - box.left - page.clientLeft) / page.clientWidth,
    yn: (y - box.top - page.clientTop) / page.clientHeight,
  };
}

/** The text from a word that was found; where the word lies in a part that is left out, that part put back, as `again` finds the word in it */
function from(narrative: PdfNarrative, hit: LocateResult, again: (widened: PdfNarrative) => LocateResult): Answer {
  if (hit.ok) return { reading: { text: narrative.text, startAt: hit.token } };
  if (hit.reason !== 'filtered') return NO_WORD;
  // The word was pointed at, so it is read: its block is put back in its place, and reading goes on from it into the text that follows
  const widened = withBlock(narrative, hit.block);
  const found = again(widened);
  if (!found.ok) return NO_WORD;
  return { reading: { text: widened.text, startAt: found.token }, said: `That word is in ${DROPPED_AS[hit.drop]}, which is normally left out. Reading it from there.` };
}

/** The whole text, from the first word of what is selected */
export function fromSelection(narrative: PdfNarrative, selection: SelectionAnchors): Answer {
  return (
    beyond(narrative, selection.start.page) ??
    from(narrative, locateAnchor(narrative, selection.start, selection.text), (widened) => locateAnchor(widened, selection.start, selection.text))
  );
}

/** What is selected, and no more: the cleaned text between its two ends where both are read, else the words as they are selected */
export function selectionAlone(narrative: PdfNarrative, selection: SelectionAnchors): Answer {
  const first = locateAnchor(narrative, selection.start, selection.text);
  const last = locateAnchor(narrative, selection.end);
  return { reading: { text: first.ok && last.ok ? textBetween(narrative, first.token, last.token) : selection.text, startAt: 0 } };
}

/**
 * The whole text, from the word at a point of the window: the word that the point lies
 * on, or else the nearest one of the line it lies beside. A point on no text at all is no
 * place to start from, and the text is read from its start.
 */
export function fromPoint(narrative: PdfNarrative, x: number, y: number): Answer {
  const word = wordAt(x, y, narrative);
  const anchors = word && anchorsOf(word);
  if (anchors) return fromSelection(narrative, anchors);
  const point = pagePoint(x, y);
  const late = point && beyond(narrative, point.page);
  if (late) return late;
  const hit: LocateResult = point ? locateWord(narrative, point) : { ok: false, reason: 'no-text' };
  if (!hit.ok && hit.reason === 'no-text') return { reading: { text: narrative.text, startAt: 0 } };
  return from(narrative, hit, (widened) => locateWord(widened, point as PagePoint));
}
