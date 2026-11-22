/**
 * The links of a PDF. PDF.js draws a link to a web page and one to a place in the PDF
 * itself, and draws none that leads elsewhere: to an app, as obsidian:// does, or to a
 * file on the device. Those are drawn here. What a click on a link does goes by the kind of
 * the link and by the settings as they are when it is clicked.
 */

import type * as PdfJsViewer from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { Links } from '../shared/prefs';

type Kind = 'web' | 'app' | 'file';

/** Never followed: an address that runs a script, that shows what the PDF itself has brought, or that names a page of the browser's own */
const NEVER = /^(?:javascript|vbscript|data|blob|about|view-source|filesystem|chrome|chrome-extension|chrome-untrusted|devtools):$/;

function kindOf(url: URL): Kind | null {
  if (url.protocol === 'http:' || url.protocol === 'https:') return 'web';
  if (url.protocol === 'file:') return 'file';
  return NEVER.test(url.protocol) ? null : 'app';
}

/** The address that a link names as a PDF writes it: whole, or as a path from where the PDF itself is */
function addressOf(written: string, base: string): URL | null {
  let address = written.trim();
  // An address is written in plain letters. One that was written in UTF-8 all the same comes as a byte to a letter, and is taken as it was meant.
  if (/[\x80-\xff]/.test(address) && !/[^\x00-\xff]/.test(address)) {
    try {
      address = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(address, (letter) => letter.charCodeAt(0)));
    } catch {
      // Not UTF-8: it stands as it is written
    }
  }
  // A path that starts at a drive is that of a file, and no address of a kind named by one letter
  if (/^[a-z]:[\\/]/i.test(address)) address = `file:///${address}`;
  try {
    return base ? new URL(address, base) : new URL(address);
  } catch {
    return null;
  }
}

export interface LinkWays {
  /** The address of the PDF, from which a path in a link starts; empty for a file that has none */
  base: string;
  /** The settings for links, as they are now */
  links(): Links;
  /** Whether a place to read from is being picked in the pages: a click follows no link then */
  picking(): boolean;
  /** Says a word to the reader for a moment */
  say(text: string): void;
  /** Has a file on this device shown in the tab of the PDF */
  openFile(url: string): void;
}

export function followLinks(container: HTMLElement, viewer: PdfJsViewer.PDFViewer, bus: PdfJsViewer.EventBus, ways: LinkWays): void {
  const onDevice = ways.base.startsWith('file:');

  // PDF.js draws the links of a page, and says when it has: those it left out are drawn after it
  const draw = async (pageNumber: number): Promise<void> => {
    const page = viewer.getPageView(pageNumber - 1) as PdfJsViewer.PDFPageView | undefined;
    const layer = page?.annotationLayer?.div;
    if (!page?.pdfPage || !layer) return;
    for (const annotation of (await page.pdfPage.getAnnotations()) as Array<{ id: string; subtype?: string; url?: string; unsafeUrl?: unknown }>) {
      if (annotation.subtype !== 'Link' || annotation.url || typeof annotation.unsafeUrl !== 'string') continue;
      const at = layer.querySelector(`[data-annotation-id="${CSS.escape(annotation.id)}"]`);
      const url = addressOf(annotation.unsafeUrl, ways.base);
      if (!at || at.querySelector('a') || !url || !kindOf(url)) continue;
      const link = document.createElement('a');
      link.href = link.title = url.href;
      link.rel = 'noopener noreferrer nofollow';
      at.appendChild(link);
    }
  };
  bus.on('annotationlayerrendered', ({ pageNumber }: { pageNumber: number }) => void draw(pageNumber).catch(() => undefined));

  const onClick = (event: MouseEvent): void => {
    // Of the other buttons of a mouse only the wheel follows a link, into a tab of its own
    if (event.type === 'auxclick' && event.button !== 1) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.annotationLayer a:not(.internalLink)') : null;
    if (!link || ways.picking()) return;
    const url = addressOf(link.href, '');
    const kind = url && kindOf(url);
    const links = ways.links();
    /** Leaves the link unfollowed, and says why where it was clicked */
    const leave = (why?: string): void => {
      event.preventDefault();
      if (why && event.type === 'click') ways.say(why);
    };
    if (!url || !kind) leave();
    else if (kind === 'web') {
      if (links.web === 'off') leave('Links to web pages are switched off in the settings of FoveaFocus');
      else link.target = links.web === 'same' ? '_top' : '_blank';
    } else if (event.type === 'auxclick') {
      // What an app or the device opens needs no tab of its own
      leave();
    } else if (kind === 'app') {
      if (!links.apps) leave('Links that open an app are switched off in the settings of FoveaFocus');
      // The frame itself hands the address to the browser, which asks before it opens the app
      else link.removeAttribute('target');
    } else if (!links.files) leave('Links to files on this device are switched off in the settings of FoveaFocus');
    else if (!onDevice) leave('A link to a file on this device is followed only from a PDF that is on this device');
    else {
      event.preventDefault();
      ways.openFile(url.href);
    }
  };
  container.addEventListener('click', onClick, true);
  container.addEventListener('auxclick', onClick, true);
}
