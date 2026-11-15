/**
 * The extension's own viewer of a PDF, over the browser's. It is a page of the extension,
 * shown in a frame that covers the window, under the bar and under the reader's frame. The
 * browser's viewer stays where it is beneath it, and is in sight again when the frame is
 * taken away.
 */

import type { Pdf, ToViewer } from '../shared/messages';

const FRAME_STYLE = [
  'position: fixed',
  'inset: 0',
  'z-index: 2147483644',
  'width: 100%',
  'height: 100%',
  'border: 0',
  'margin: 0',
  'padding: 0',
  'color-scheme: normal',
].join('; ');

export class Viewer {
  private frame: HTMLIFrameElement | null = null;
  /** What was asked of a frame that does not listen yet: it is told when the frame asks what it is to show */
  private held: ToViewer[] | null = null;
  private readonly origin = new URL(chrome.runtime.getURL('')).origin;

  constructor(private readonly into: ShadowRoot, private readonly pdf: Pdf) {}

  get isOn(): boolean {
    return this.frame !== null;
  }

  open(): void {
    if (this.frame) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('style', FRAME_STYLE);
    frame.setAttribute('title', 'FoveaFocus PDF viewer');
    frame.className = 'viewer';
    frame.src = chrome.runtime.getURL('viewer.html');
    frame.addEventListener('load', () => frame.focus());
    this.into.appendChild(frame);
    this.frame = frame;
    this.held = [];
  }

  /** Which PDF the frame is to show, handed over when it asks. The bytes follow where the page can fetch them. */
  whatToShow(): Pdf {
    const held = this.held ?? [];
    this.held = null;
    for (const message of held) this.tell(message);
    if (this.pdf.bytesFollow) void this.sendBytes();
    return this.pdf;
  }

  /** The bytes of the PDF, fetched as the page, from the cache as a rule, and sent to the frame; where the page cannot fetch them, the frame is told so and fetches them itself */
  private async sendBytes(): Promise<void> {
    let bytes: ArrayBuffer | null = null;
    try {
      const response = await fetch(this.pdf.url, { credentials: 'include' });
      if (response.ok) bytes = await response.arrayBuffer();
    } catch {
      // Told to the frame as no bytes
    }
    this.tell({ foveafocus: 'pdf', bytes }, bytes ? [bytes] : []);
  }

  tell(message: ToViewer, handedOver: Transferable[] = []): void {
    if (this.held) this.held.push(message);
    else this.frame?.contentWindow?.postMessage(message, this.origin, handedOver);
  }

  /** Gives the frame the keys, as where a place is to be picked in it */
  focus(): void {
    this.frame?.focus();
  }

  /** Under the reader the viewer takes no keys and no clicks; it takes the keys again when the reader is closed */
  rest(under: boolean): void {
    if (!this.frame) return;
    this.frame.inert = under;
    if (!under) this.frame.focus();
  }

  close(): void {
    this.frame?.remove();
    this.frame = null;
    this.held = null;
  }
}
