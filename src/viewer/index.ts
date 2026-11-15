/**
 * The viewer's frame. The script in the page of a PDF lays it over the browser's own
 * viewer, and it shows the same file with PDF.js: the pages, their text that can be
 * selected, and over them a strip with the page number, the size and a search.
 *
 * The browser's viewer lets no extension see where in a PDF a selection or a click lies.
 * Here the pages are the extension's own, so a reading can start at the very word that is
 * selected or clicked. The viewer says what is to be read, and the script of the page opens
 * the reader on it.
 */

import { ChevronDown, ChevronUp, Minus, Plus, createElement } from 'lucide';
import type { IconNode } from 'lucide';
import type * as PdfJs from 'pdfjs-dist';
import type * as PdfJsViewer from 'pdfjs-dist/web/pdf_viewer.mjs';
import { pdfFilters } from '../../core/src/filters';
import { parsePdf, type PdfNarrative } from '../../core/src/pdf';
import type { FromViewer, How, Pdf, ToViewer } from '../shared/messages';
import { Store } from '../shared/store';
import { loadPdfJs, openPdf, pdfBytes } from './pdf-file';
import { fromPoint, fromSelection, selected, selectionAlone, wordAt, type Answer } from './place';

const say = <T>(message: FromViewer): Promise<T> => chrome.runtime.sendMessage(message);
const file = (path: string): string => chrome.runtime.getURL(path);

/** The sizes a page can be shown in: fitted to the window, or a share of its own size */
const SIZES: [string, string][] = [
  ['auto', 'Automatic'],
  ['page-width', 'Page width'],
  ['page-fit', 'Whole page'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
  ['4', '400%'],
];

function el<K extends keyof HTMLElementTagNameMap>(parent: Node, tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (cls) made.className = cls;
  if (text) made.textContent = text;
  parent.appendChild(made);
  return made;
}

function iconButton(parent: Node, label: string, icon: IconNode, does: () => void): HTMLButtonElement {
  const made = el(parent, 'button', 'viewer-icon');
  made.type = 'button';
  made.title = label;
  made.setAttribute('aria-label', label);
  made.appendChild(createElement(icon));
  made.addEventListener('click', does);
  return made;
}

/** What the page can ask of the viewer */
interface Asked {
  read(how: How): void;
  pick(): void;
}

/** Sets the viewer up and has the PDF shown; null where no script of a page has laid this frame over a PDF */
async function show(): Promise<Asked | null> {
  const [store, pdf] = await Promise.all([Store.load(), say<Pdf | undefined>({ type: 'viewer:what' })]);
  if (!pdf) return null;
  store.follow(() => undefined);

  // ---- the strip over the pages ----------------------------------------------------------
  const top = el(document.body, 'div', 'viewer-top');
  const pageGroup = el(top, 'div', 'viewer-group');
  const pageField = el(pageGroup, 'input', 'viewer-page');
  pageField.type = 'number';
  pageField.min = '1';
  pageField.setAttribute('aria-label', 'Page');
  const pageCount = el(pageGroup, 'span', 'viewer-muted');

  const sizeGroup = el(top, 'div', 'viewer-group');
  iconButton(sizeGroup, 'Smaller', Minus, () => viewer?.decreaseScale());
  const sizeField = el(sizeGroup, 'select', 'viewer-size');
  sizeField.setAttribute('aria-label', 'Size');
  for (const [value, name] of SIZES) el(sizeField, 'option', '', name).value = value;
  const ownSize = el(sizeField, 'option', '');
  ownSize.value = 'own';
  ownSize.hidden = true;
  iconButton(sizeGroup, 'Larger', Plus, () => viewer?.increaseScale());

  const findGroup = el(top, 'div', 'viewer-group');
  const findField = el(findGroup, 'input', 'viewer-find');
  findField.type = 'search';
  findField.placeholder = 'Find in this PDF';
  findField.setAttribute('aria-label', 'Find in this PDF');
  const findBack = iconButton(findGroup, 'Previous', ChevronUp, () => find('again', true));
  const findOn = iconButton(findGroup, 'Next', ChevronDown, () => find('again', false));
  const findCount = el(findGroup, 'span', 'viewer-muted viewer-count');

  el(top, 'div', 'viewer-space');
  const leave = el(top, 'button', '', "Browser's viewer");
  leave.type = 'button';
  leave.title = "Show this PDF in the browser's own viewer";
  leave.addEventListener('click', () => void say({ type: 'viewer:leave' }));

  const container = el(document.body, 'div', 'viewer-pages');
  container.tabIndex = 0;
  const pages = el(container, 'div', 'pdfViewer');
  const word = el(document.body, 'div', 'viewer-word');
  word.hidden = true;
  const hints = el(document.body, 'div', 'viewer-hints');
  /** Says a word under the strip until it is taken away */
  const tell = (text: string): HTMLElement => el(hints, 'div', 'viewer-hint', text);
  /** Says a word under the strip once something has taken longer than a moment; what it gives takes the word away */
  const tellWhenSlow = (text: string): (() => void) => {
    const said = tell(text);
    said.hidden = true;
    const slow = window.setTimeout(() => {
      said.hidden = false;
    }, 300);
    return () => {
      window.clearTimeout(slow);
      said.remove();
    };
  };

  // ---- the PDF ---------------------------------------------------------------------------
  let viewer: PdfJsViewer.PDFViewer | null = null;
  let bus: PdfJsViewer.EventBus | null = null;
  let narrative: { filters: string; text: Promise<PdfNarrative>; known: PdfNarrative | null } | null = null;

  const opening = tellWhenSlow('Opening the PDF');
  const opened = (async (): Promise<PdfJs.PDFDocumentProxy> => {
    const pdfjs = await loadPdfJs();
    // The part of PDF.js that shows pages takes the part that reads files from the window
    (globalThis as unknown as { pdfjsLib: typeof PdfJs }).pdfjsLib = pdfjs;
    const parts = (await import(file('pdfjs/pdf_viewer.mjs'))) as typeof PdfJsViewer;
    const doc = await openPdf(pdfjs, await pdfBytes(pdf)).promise;

    const eventBus = new parts.EventBus();
    const linkService = new parts.PDFLinkService({ eventBus, externalLinkTarget: parts.LinkTarget.BLANK });
    const findController = new parts.PDFFindController({ eventBus, linkService });
    const shown = new parts.PDFViewer({
      container,
      viewer: pages,
      eventBus,
      linkService,
      findController,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      imageResourcesPath: file('pdfjs/images/'),
    });
    linkService.setViewer(shown);

    eventBus.on('pagesinit', () => {
      shown.currentScaleValue = 'auto';
      // An address can name the page to open at, as #page=3
      const hash = new URL(pdf.url).hash.slice(1);
      if (hash) linkService.setHash(hash);
      pageField.max = String(shown.pagesCount);
      pageField.value = String(shown.currentPageNumber);
      pageCount.textContent = `of ${shown.pagesCount}`;
    });
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      if (document.activeElement !== pageField) pageField.value = String(pageNumber);
    });
    eventBus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      const named = presetValue ?? String(scale);
      if (SIZES.some(([value]) => value === named)) {
        sizeField.value = named;
      } else {
        ownSize.textContent = `${Math.round(scale * 100)}%`;
        sizeField.value = 'own';
      }
    });
    eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => showFound(matchesCount));
    eventBus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
      showFound(matchesCount, state === parts.FindState.NOT_FOUND);
    });
    let told = false;
    eventBus.on('pagerendered', () => {
      if (told) return;
      told = true;
      opening();
      void say({ type: 'viewer:shown', edge: container.offsetWidth - container.clientWidth, top: container.offsetTop });
      // The text is read to the end while nothing else is asked of the viewer, so that a reading starts at once
      window.requestIdleCallback(() => void reading().catch(() => undefined));
    });

    viewer = shown;
    bus = eventBus;
    shown.setDocument(doc);
    linkService.setDocument(doc, null);
    container.focus();
    return doc;
  })();
  opened.catch((error) => {
    opening();
    console.error('FoveaFocus: could not show the PDF', error);
    void say({ type: 'viewer:failed' });
  });

  /** The reading text of the PDF under the settings as they are: made once, and again when they change what is left out */
  const reading = async (): Promise<PdfNarrative> => {
    const doc = await opened;
    const filters = pdfFilters(store.settings);
    const key = JSON.stringify(filters);
    if (narrative?.filters !== key) {
      const text = parsePdf(doc, filters);
      const made = { filters: key, text, known: null as PdfNarrative | null };
      narrative = made;
      // A reading that failed is not kept as the answer
      text.then(
        (known) => {
          made.known = known;
        },
        () => {
          if (narrative === made) narrative = null;
        }
      );
    }
    return narrative.text;
  };

  // ---- the strip at work -----------------------------------------------------------------
  pageField.addEventListener('change', () => {
    const page = Math.round(Number(pageField.value));
    if (viewer && page >= 1 && page <= viewer.pagesCount) viewer.currentPageNumber = page;
    else if (viewer) pageField.value = String(viewer.currentPageNumber);
  });
  sizeField.addEventListener('change', () => {
    if (viewer && sizeField.value !== 'own') viewer.currentScaleValue = sizeField.value;
  });
  // Fitted to the window, a page follows the window when it changes
  window.addEventListener('resize', () => {
    const size = viewer?.currentScaleValue;
    if (viewer && (size === 'auto' || size === 'page-width' || size === 'page-fit')) viewer.currentScaleValue = size;
  });
  /** What is left over of two fingers drawn apart or together, where it was too little to change the size */
  let pinched = 1;
  container.addEventListener('wheel', (event) => {
    if (!event.ctrlKey || !viewer) return;
    event.preventDefault();
    const origin = [event.clientX, event.clientY];
    if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < 20) {
      // Fingers on a touchpad reach the page as many small turns of a wheel: the size follows them as finely
      pinched *= Math.exp(-event.deltaY / 100);
      const size = viewer.currentScale;
      const next = Math.round(size * pinched * 100) / 100;
      if (next === size) return;
      pinched = (size * pinched) / next;
      viewer.updateScale({ scaleFactor: next / size, origin });
    } else {
      // A notch of a wheel is a step
      pinched = 1;
      viewer.updateScale({ steps: event.deltaY < 0 ? 1 : -1, origin });
    }
  }, { passive: false });

  function find(type: '' | 'again', back: boolean): void {
    const query = findField.value;
    findBack.disabled = findOn.disabled = !query;
    if (!query) {
      findCount.textContent = '';
      bus?.dispatch('findbarclose', { source: null });
      return;
    }
    bus?.dispatch('find', { source: null, type, query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: back, matchDiacritics: false });
  }
  function showFound(found: { current: number; total: number }, none = false): void {
    findCount.textContent = !findField.value ? '' : none || !found.total ? 'Not found' : `${found.current} of ${found.total}`;
  }
  findBack.disabled = findOn.disabled = true;
  findField.addEventListener('input', () => find('', false));
  findField.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') find('again', event.shiftKey);
  });

  // ---- a place picked in the pages ---------------------------------------------------------
  let hint: HTMLElement | null = null;
  const frame = (x: number, y: number): void => {
    const under = wordAt(x, y, narrative?.known)?.getBoundingClientRect();
    word.hidden = !under;
    if (!under) return;
    word.style.left = `${under.left - 3}px`;
    word.style.top = `${under.top - 2}px`;
    word.style.width = `${under.width + 6}px`;
    word.style.height = `${under.height + 4}px`;
  };
  const onMove = (event: PointerEvent): void => frame(event.clientX, event.clientY);
  // The pages move under a pointer that stands still: the frame would stay where the word was
  const onScroll = (): void => {
    word.hidden = true;
  };
  // While a place is picked, a press selects nothing and a click follows no link
  const onPress = (event: Event): void => event.preventDefault();
  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!wordAt(event.clientX, event.clientY)) return;
    stopPicking();
    void answer('here', { x: event.clientX, y: event.clientY });
  };
  const stopPicking = (): void => {
    if (!hint) return;
    hint.remove();
    hint = null;
    word.hidden = true;
    document.body.classList.remove('is-picking');
    container.removeEventListener('pointermove', onMove, true);
    container.removeEventListener('scroll', onScroll);
    container.removeEventListener('mousedown', onPress, true);
    container.removeEventListener('click', onClick, true);
  };
  /** Has a place in the pages picked for the reading to start from: the word under the pointer is framed, and a click starts the reading at it. Escape leaves it. */
  const pick = (): void => {
    if (hint) {
      stopPicking();
      return;
    }
    hint = tell('Click the word the reading is to start at. Esc leaves it.');
    document.body.classList.add('is-picking');
    container.addEventListener('pointermove', onMove, true);
    container.addEventListener('scroll', onScroll);
    container.addEventListener('mousedown', onPress, true);
    container.addEventListener('click', onClick, true);
    container.focus();
  };

  // ---- what is read ----------------------------------------------------------------------
  /** Where the menu of the page was last opened in the pages */
  let menuAt: { x: number; y: number } | null = null;
  container.addEventListener('contextmenu', (event) => {
    menuAt = { x: event.clientX, y: event.clientY };
  }, true);

  async function answer(how: How, at: { x: number; y: number } | null = menuAt): Promise<void> {
    stopPicking();
    // Read to the end the first time; a long PDF takes a while, and a word says so
    const waited = tellWhenSlow('Reading the PDF');
    let said: Answer;
    try {
      const text = await reading();
      const selection = how === 'page' || how === 'here' ? null : selected();
      if (!text.units.length) said = { reading: null, said: 'No readable text was found in this PDF' };
      else if (how === 'selection') said = selection?.text ? selectionAlone(text, selection) : { reading: null, said: 'Select some text in the PDF first' };
      else if (selection) said = fromSelection(text, selection);
      else if (how === 'from-selection') said = { reading: null, said: 'Select some text in the PDF first' };
      else if (how === 'here' && at) said = fromPoint(text, at.x, at.y);
      else said = { reading: { text: text.text, startAt: 0 } };
      // A PDF of more pages than are read: the reading ends where the reading of its pages does, and the page says so
      const pages = (await opened).numPages;
      if (how !== 'selection' && said.reading && !said.said && pages > text.pages.length) said = { ...said, said: `This PDF has ${pages} pages. The first ${text.pages.length} are read.` };
    } catch (error) {
      console.error('FoveaFocus: could not read the PDF', error);
      said = { reading: null, said: 'Could not read this PDF' };
    }
    waited();
    void say({ type: 'viewer:read', ...said });
  }

  document.addEventListener('keydown', (event) => {
    const command = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape' && hint) {
      stopPicking();
    } else if (event.key === 'Escape' && findField.value) {
      findField.value = '';
      find('', false);
      container.focus();
    } else if (command && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      findField.focus();
      findField.select();
    } else if (command && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      viewer?.increaseScale();
    } else if (command && event.key === '-') {
      event.preventDefault();
      viewer?.decreaseScale();
    } else if (command && event.key === '0') {
      event.preventDefault();
      if (viewer) viewer.currentScaleValue = 'auto';
    }
  });

  return { read: (how) => void answer(how), pick };
}

// What the page asks for is heard from the start, and done once the viewer is set up
const setUp = show();
window.addEventListener('message', (event) => {
  const told = event.data as ToViewer | null;
  if (event.source !== window.parent || !told) return;
  if (told.foveafocus === 'read') void setUp.then((asked) => asked?.read(told.how));
  else if (told.foveafocus === 'pick') void setUp.then((asked) => asked?.pick());
});
