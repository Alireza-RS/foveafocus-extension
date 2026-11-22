/**
 * The page of the extension that shows a PDF by itself: the one a tab was on its way to,
 * named after the address of this page, or one that is chosen from the device here. The
 * script that stands in every page stands in this one too, with the bar and the reader, and
 * lays the viewer over it.
 */

import { start } from '../content/index';
import type { Pdf } from '../shared/messages';
import { pdfNamedIn, pdfPage } from '../shared/pdf-page';

const page = document.querySelector('main') as HTMLElement;
const said = document.getElementById('said') as HTMLElement;
const download = document.getElementById('download') as HTMLButtonElement;
const choose = document.getElementById('choose') as HTMLButtonElement;
const field = document.getElementById('file') as HTMLInputElement;

/** The name of the file at an address */
function nameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

/** Has the browser keep the PDF at an address as a file, which is what it does with a PDF where it shows none */
async function keep(url: string): Promise<void> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`no file at ${url} (${response.status})`);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'application/pdf' }));
  link.download = nameOf(url) || 'document.pdf';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

let shown = false;

function show(pdf: Pdf, bytes?: () => Promise<ArrayBuffer | null>): void {
  shown = true;
  document.title = pdf.title;
  page.hidden = true;
  const told = start({
    pdf,
    bytes,
    leave: () => void keep(pdf.url).catch(() => told.say('This PDF could not be downloaded')),
    failed: () => {
      said.textContent = 'FoveaFocus could not show this PDF.';
      download.hidden = !pdf.url;
      page.hidden = false;
    },
  });
  download.addEventListener('click', () => void keep(pdf.url).catch(() => told.say('This PDF could not be downloaded')));
}

choose.addEventListener('click', () => {
  // A second PDF is chosen on the page as it starts out
  if (shown) location.assign(pdfPage());
  else field.click();
});
field.addEventListener('change', () => {
  const file = field.files?.[0];
  if (file) show({ url: '', title: file.name, bytesFollow: true, alone: true }, () => file.arrayBuffer());
});

/** The PDF that the address of this page names, where it names one on the web or on this device */
function named(): Pdf | null {
  try {
    const url = new URL(pdfNamedIn(location.href) ?? '');
    if (!/^(?:https?|file):$/.test(url.protocol)) return null;
    return { url: url.href, title: nameOf(url.href) || url.hostname, bytesFollow: url.protocol !== 'file:', alone: true };
  } catch {
    return null;
  }
}

// The page shows a PDF in a tab of its own, and in no frame of another page
if (window.top === window) {
  const pdf = named();
  if (pdf) {
    show(pdf);
  } else {
    said.textContent = 'A PDF from the web is shown here when its link is followed. One that is on this device is chosen here.';
    page.hidden = false;
  }
}
