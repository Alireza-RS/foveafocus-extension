/**
 * The reader's frame over the page. The reader is a page of the extension, shown in a frame
 * that covers the window: the styles and scripts of the page do not reach into it, and it
 * reaches nothing of the page. The frame is see-through round the reader, so the page stays
 * in sight behind it, dimmed and out of focus; while it is open the page takes no keys and
 * no clicks.
 */

import type { Reading } from '../shared/messages';

const FRAME_STYLE = [
  'position: absolute',
  'inset: 0',
  'z-index: 4',
  'width: 100%',
  'height: 100%',
  'border: 0',
  'margin: 0',
  'padding: 0',
  'background: transparent',
  'color-scheme: normal',
  'backdrop-filter: blur(5px)',
  'pointer-events: auto',
].join('; ');

/** How long the frame is given to close its reader when the page asks it to, before it is taken away as it is */
const CLOSES_WITHIN = 600;

export class Overlay {
  private frame: HTMLIFrameElement | null = null;
  private reading: Reading = { kind: 'nothing' };
  private wasInert = false;
  private readonly origin = new URL(chrome.runtime.getURL('')).origin;

  constructor(private readonly into: ParentNode, private readonly changed: (open: boolean) => void) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.frame) this.close();
    }, true);
  }

  get isOpen(): boolean {
    return this.frame !== null;
  }

  /** Opens the reader on something to read. A reader that is open already is closed first. */
  open(reading: Reading): void {
    this.remove();
    this.reading = reading;
    const frame = document.createElement('iframe');
    frame.setAttribute('style', FRAME_STYLE);
    frame.setAttribute('title', 'FoveaFocus reader');
    frame.src = chrome.runtime.getURL('reader.html');
    frame.addEventListener('load', () => frame.focus());
    this.into.appendChild(frame);
    this.frame = frame;
    this.wasInert = document.body?.inert ?? false;
    if (document.body) document.body.inert = true;
    this.changed(true);
  }

  /** What the frame is to read, handed over when it asks */
  whatToRead(): Reading {
    this.frame?.focus();
    return this.reading;
  }

  /** Has the reader close itself, so that it keeps what it has to keep; it then says that it is closed */
  close(): void {
    const frame = this.frame;
    if (!frame) return;
    frame.contentWindow?.postMessage({ foveafocus: 'close' }, this.origin);
    window.setTimeout(() => {
      if (this.frame === frame) this.remove();
    }, CLOSES_WITHIN);
  }

  /** Takes the frame away: the reader in it has closed */
  remove(): void {
    if (!this.frame) return;
    this.frame.remove();
    this.frame = null;
    this.reading = { kind: 'nothing' };
    if (document.body) document.body.inert = this.wasInert;
    this.changed(false);
  }
}
