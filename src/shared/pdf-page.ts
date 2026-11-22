/**
 * The page of the extension that shows a PDF by itself. A phone or a tablet shows no PDF as
 * a page, so there is none for a script to stand in and to lay the viewer over: a tab on its
 * way to a PDF is sent to this page instead, with the address of the PDF after its own.
 */

const PAGE = 'pdf.html';
const NAMED = '?file=';

export const pdfPage = (): string => chrome.runtime.getURL(PAGE);

/** The address of the PDF that an address of the page names, or null where it names none or is not an address of the page */
export function pdfNamedIn(address: string): string | null {
  const start = pdfPage() + NAMED;
  return address.startsWith(start) && address.length > start.length ? address.slice(start.length) : null;
}

/**
 * Sends a tab that is on its way to a PDF to the page. The PDF is known by what its site
 * says it is, as the browser knows it; a file that the site offers as a download is left to
 * the browser, and so is the answer to a form, which cannot be asked for a second time.
 */
export function pdfRule(id: number): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${pdfPage()}${NAMED}\\0` } },
    condition: {
      regexFilter: '^https?://.*',
      resourceTypes: ['main_frame'],
      requestMethods: ['get'],
      responseHeaders: [{ header: 'content-type', values: ['application/pdf*'] }],
      excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
    },
  };
}
