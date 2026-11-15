/**
 * Read a selection, or a caret, off the PDF viewer's text layer.
 *
 * PDF.js builds that layer from the same runs this pipeline reads: one span per run, hung
 * at the run's origin. The span a selection starts in, together with the number of words
 * of that span that come before the selection, therefore identifies one exact word. Nothing
 * here looks at what the word says.
 *
 * This file touches the DOM only. It knows nothing of Obsidian, so it runs unchanged in a
 * plain browser, which is how it is tested.
 */

import type { TextLayerAnchor } from './locate';
import { isBlankText, runWordAt } from './extract';

export interface SelectionAnchors {
  /** The first and the last selected word. The same word for a caret or a one-word selection. */
  start: TextLayerAnchor;
  end: TextLayerAnchor;
  /** The selected text, trimmed. Empty for a caret. */
  text: string;
}

interface TextPosition {
  node: Text;
  offset: number;
}

/** A letter of a run, with the layer and the page the run is on. */
interface Settled extends TextPosition {
  layer: Element;
  page: number;
}

// Node kinds are told apart by `nodeType`: `instanceof` fails for nodes of another window.
const isText = (node: Node | null): node is Text => node?.nodeType === 3;
const isElement = (node: Node | null): node is Element => node?.nodeType === 1;

const TEXT_LAYER = '.textLayer';

/** The span PDF.js made for one run: the child of the layer, or of a marked-content wrapper, that holds `node`. */
function runSpanOf(node: Node, layer: Element): HTMLElement | null {
  let el: Element | null = node.parentElement;
  while (el && el !== layer) {
    const parent: Element | null = el.parentElement;
    if (parent === layer || parent?.classList.contains('markedContent')) return el as HTMLElement;
    el = parent;
  }
  return null;
}

/** The first letter of `node` at or after `from` (`forward`), or the last one at or before it. */
function letterIn(node: Text, from: number, forward: boolean): TextPosition | null {
  for (let i = from; i >= 0 && i < node.length; i += forward ? 1 : -1) {
    if (!isBlankText(node.data[i])) return { node, offset: i };
  }
  return null;
}

/**
 * The first letter of a selection (`forward`), or its last. A selection often starts or
 * stops in the blank between two words, or on an element rather than in text: on the layer
 * after a drag into the margin, on the page or beyond it when it runs over a page break.
 * From that end this walks towards the other one, through as many layers as it takes, to
 * the first letter of a run on the way.
 */
function settle(range: Range, forward: boolean): Settled | null {
  const container = forward ? range.startContainer : range.endContainer;
  const offset = forward ? range.startOffset : range.endOffset;
  const root = range.commonAncestorContainer;
  const walker = (container.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const step = (): Text | null => (forward ? walker.nextNode() : walker.previousNode()) as Text | null;

  // The text node to look in first, and from where in it: the one the end is in, or else
  // the nearest one beyond the end.
  let node: Text | null;
  let from: number | null = null;
  if (isText(container)) {
    node = container;
    from = forward ? offset : offset - 1;
    walker.currentNode = container;
  } else if (forward) {
    // The end lies in front of child `offset`, or behind the last child.
    let next: Node | null = container.childNodes[offset] ?? null;
    for (let up: Node | null = container; !next && up && up !== root; up = up.parentNode) next = up.nextSibling;
    if (!next) return null;
    walker.currentNode = next;
    node = isText(next) ? next : step();
  } else if (offset > 0) {
    let last: Node = container.childNodes[offset - 1];
    while (last.lastChild) last = last.lastChild;
    walker.currentNode = last;
    node = isText(last) ? last : step();
  } else {
    walker.currentNode = container;
    node = step();
  }

  const view = (container.ownerDocument ?? document).defaultView ?? window;
  for (; node; node = step(), from = null) {
    // Nothing beyond the other end of the selection belongs to it.
    if (forward ? range.comparePoint(node, 0) > 0 : range.comparePoint(node, node.length) < 0) return null;
    const home = layerOf(node);
    const span = home && runSpanOf(node, home.layer);
    // Text the viewer has made unselectable (the inside of a tagged figure) is never part of a selection, whatever the range spans.
    if (!home || !span || (node !== container && view.getComputedStyle(span).userSelect === 'none')) continue;
    const found = letterIn(node, from ?? (forward ? 0 : node.length - 1), forward);
    if (!found) continue;
    if (forward ? node === range.endContainer && found.offset >= range.endOffset : node === range.startContainer && found.offset < range.startOffset) return null;
    return { ...found, ...home };
  }
  return null;
}

function anchorAt(layer: Element, page: number, at: TextPosition): TextLayerAnchor | null {
  const span = runSpanOf(at.node, layer);
  if (!span) return null;
  const layerBox = layer.getBoundingClientRect();
  if (!(layerBox.width > 0 && layerBox.height > 0)) return null;

  // Offset of the character within the whole run, whatever the viewer has wrapped parts of it in.
  let before = 0;
  const walker = layer.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && n !== at.node; n = walker.nextNode()) before += (n as Text).length;
  const wordInSpan = runWordAt(span.textContent ?? '', before + at.offset);
  if (wordInSpan < 0) return null;

  const u = (x: number): number => (x - layerBox.left) / layerBox.width;
  const v = (y: number): number => (y - layerBox.top) / layerBox.height;
  const box = span.getBoundingClientRect();
  const letter = layer.ownerDocument.createRange();
  letter.setStart(at.node, at.offset);
  letter.setEnd(at.node, Math.min(at.node.length, at.offset + 1));
  const letterBox = letter.getBoundingClientRect();
  const shown = layer.getAttribute('data-main-rotation');

  return {
    page,
    rotation: shown === null ? null : Number(shown) || 0,
    span: { x0: u(box.left), y0: v(box.top), x1: u(box.right), y1: v(box.bottom) },
    wordInSpan,
    point: { x: u((letterBox.left + letterBox.right) / 2), y: v((letterBox.top + letterBox.bottom) / 2) },
  };
}

function layerOf(node: Node | null): { layer: Element; page: number } | null {
  const el = isElement(node) ? node : node?.parentElement;
  const layer = el?.closest(TEXT_LAYER);
  const holder = layer?.closest('[data-page-number]');
  const page = Number(holder?.getAttribute('data-page-number'));
  return layer && Number.isInteger(page) && page >= 1 ? { layer, page: page - 1 } : null;
}

/**
 * @param pressed What the pointer last went down on, when the caller keeps track of that.
 * @returns null when there is no selection in a PDF text layer, and for a caret that no
 *   click on a word has put there.
 */
export function readSelectionAnchors(selection: Selection | null, pressed?: Node | null): SelectionAnchors | null {
  if (!selection || selection.rangeCount < 1) return null;
  const range = selection.getRangeAt(0);
  const text = selection.toString().trim();

  if (range.collapsed || !text) {
    // A caret counts in the text of a run, and only in the run that was pressed. A click on
    // an empty part of the page leaves a caret as well, wherever the browser finds a place
    // for one in the document, and that place has nothing to do with where the click was.
    const node = range.startContainer;
    const home = layerOf(node);
    if (!home || !isText(node)) return null;
    const span = runSpanOf(node, home.layer);
    if (!span || (pressed !== undefined && !(pressed && span.contains(pressed)))) return null;
    // The word the caret stands in or touches; failing that, the nearest one in the run.
    const offset = range.startOffset;
    const inWord = offset < node.length && !isBlankText(node.data[offset]);
    const afterWord = offset > 0 && !isBlankText(node.data[offset - 1]);
    const at = inWord ? { node, offset } : afterWord ? { node, offset: offset - 1 } : letterIn(node, offset, true) ?? letterIn(node, offset - 1, false);
    const anchor = at && anchorAt(home.layer, home.page, at);
    return anchor ? { start: anchor, end: anchor, text: '' } : null;
  }

  const first = settle(range, true);
  const last = settle(range, false);
  const start = first && anchorAt(first.layer, first.page, first);
  const end = last && anchorAt(last.layer, last.page, last);
  if (!start) return null;
  return { start, end: end ?? start, text };
}
