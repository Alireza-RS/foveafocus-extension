/**
 * What the parts of the extension say to each other. A page has the script that stands in
 * it (content), the reader's frame over it, on a PDF the frame of the extension's own
 * viewer under that, and the worker behind them all (background). A frame speaks to the
 * script of its page through the worker; the script speaks to a frame by a message posted
 * to its window.
 */

/** How a reading was asked for */
export type How =
  /** By the bar or its shortcut. A web page: a long selection alone, else the page, from a short selection where there is one. A PDF in the extension's viewer: from the selection, whatever its length. */
  | 'auto'
  /** The page from the selection on, however long the selection is */
  | 'from-selection'
  /** The selection alone, however short */
  | 'selection'
  /** The page from where the menu was opened */
  | 'here'
  /** The page from its start */
  | 'page';

/** The viewer's frame to the script of its page */
export type FromViewer =
  /** Asks which PDF it is to show */
  | { type: 'viewer:what' }
  /** The PDF is on show. `edge` is the width of the scrollbar at its right and `top` the height of the strip over the pages: the bar and what the page says keep clear of them. */
  | { type: 'viewer:shown'; edge: number; top: number }
  /** The PDF could not be shown */
  | { type: 'viewer:failed' }
  /** The browser's own viewer was asked for */
  | { type: 'viewer:leave' }
  /**
   * What is to be read, in answer to a reading that was asked for or to a place that was
   * picked: the text and the index of the word it starts at, or nothing. `said` is a word
   * to the reader about it.
   */
  | { type: 'viewer:read'; reading: { text: string; startAt: number } | null; said?: string };

/** The worker to the script in a page */
export type ToPage =
  | { type: 'read'; how: How; selected?: string }
  | { type: 'pick' }
  /** The bar in this tab: shown or hidden as it says, else the other of the two */
  | { type: 'bar'; show?: boolean }
  | { type: 'reader:what' }
  | { type: 'reader:closed' }
  | FromViewer;

/** What the script in a page hands the reader's frame */
export type Reading =
  /** The text of a web page as Markdown, read from an offset in it where one is given */
  | { kind: 'text'; markdown: string; title: string; startAt?: number }
  /** Text that is played as it stands, from the word with this index: what the viewer has made of a PDF */
  | { kind: 'words'; text: string; title: string; startAt: number }
  | { kind: 'nothing' };

/**
 * A PDF at an address, as the script in its page names it to the viewer's frame. Its bytes
 * follow in a message to the frame where the page can fetch them; where it cannot, the frame
 * fetches them.
 */
export interface Pdf {
  url: string;
  title: string;
  bytesFollow: boolean;
}

/** The reader's frame, the viewer's frame and the script in a page, to the worker */
export type ToWorker =
  | { type: 'reader:what' }
  | { type: 'reader:closed' }
  | FromViewer
  | { type: 'options' }
  /** Asks what the button of the extension has made of the bar in this tab */
  | { type: 'bar:kept' }
  /** Has that kept for as long as the tab is open, or forgotten where it names nothing */
  | { type: 'bar:keep'; show?: boolean };

/** The bytes of a PDF, posted by the script in its page to the viewer's frame; null where it could not fetch them */
export interface PdfBytes {
  foveafocus: 'pdf';
  bytes: ArrayBuffer | null;
}

/** The script in a page to the viewer's frame, posted to its window */
export type ToViewer =
  | PdfBytes
  /** A reading is asked for. The viewer knows what is selected in it and where its menu was opened. */
  | { foveafocus: 'read'; how: How }
  /** A place to read from is to be picked in the pages */
  | { foveafocus: 'pick' };
