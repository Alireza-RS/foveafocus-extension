/**
 * The file of the PDF that the viewer shows. The script in the page sends the bytes where
 * it can fetch them; where it cannot, as with a file on the disk, the frame fetches them
 * itself. PDF.js is a file of the extension, and so is what a PDF can ask for without
 * bringing it: fonts, character maps, colour profiles and the decoders of some pictures.
 */

import type * as PdfJs from 'pdfjs-dist';
import type { Pdf, PdfBytes } from '../shared/messages';

/** How long the page is given to send the bytes of the PDF before they are fetched from here */
const BYTES_WITHIN = 20000;

/**
 * The bytes of the PDF as the page sends them, or null where it could not fetch them. The
 * page may send them before the frame is ready for them, so they are listened for from the
 * start.
 */
const sentBytes = new Promise<ArrayBuffer | null>((resolve) => {
  const onMessage = (event: MessageEvent): void => {
    const sent = event.data as PdfBytes | null;
    if (event.source !== window.parent || sent?.foveafocus !== 'pdf') return;
    window.removeEventListener('message', onMessage);
    resolve(sent.bytes);
  };
  window.addEventListener('message', onMessage);
});

/** The bytes of a file at an address, fetched by the extension itself: a file on the disk, or one the page could not fetch */
function fetchBytes(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.withCredentials = true;
    request.onload = () => {
      const body = request.response as ArrayBuffer | null;
      if (body && body.byteLength && (request.status === 0 || (request.status >= 200 && request.status < 300))) resolve(body);
      else reject(new Error(`no file at ${url} (${request.status})`));
    };
    request.onerror = () => reject(new Error(`could not fetch ${url}`));
    request.send();
  });
}

/** The bytes of a PDF: those the page sends where it can fetch them, else fetched from here */
export async function pdfBytes(pdf: Pdf): Promise<ArrayBuffer> {
  const late = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), BYTES_WITHIN));
  const sent = pdf.bytesFollow ? await Promise.race([sentBytes, late]) : null;
  return sent ?? fetchBytes(pdf.url);
}

const file = (path: string): string => chrome.runtime.getURL(path);

export async function loadPdfJs(): Promise<typeof PdfJs> {
  const pdfjs = (await import(file('pdfjs/pdf.min.mjs'))) as typeof PdfJs;
  pdfjs.GlobalWorkerOptions.workerSrc = file('pdfjs/pdf.worker.min.mjs');
  return pdfjs;
}

/** Opens a PDF from its bytes */
export function openPdf(pdfjs: typeof PdfJs, data: ArrayBuffer): PdfJs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: file('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: file('pdfjs/standard_fonts/'),
    wasmUrl: file('pdfjs/wasm/'),
    iccUrl: file('pdfjs/iccs/'),
  });
}
