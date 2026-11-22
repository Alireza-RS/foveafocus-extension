/**
 * The reader's frame. It is laid over a page by the script in that page, asks what it is to
 * read, and shows it in the reader of the plugin: the text of a web page as it is handed
 * over, or what the viewer has made of a PDF. When the reader is closed the frame says so,
 * and the page takes it away.
 */

import { makeApp, onHandheld } from '../host/obsidian';
import { tellLabels } from '../host/tooltip';
import { FoveaFocusModal } from '../../core/src/rsvp-view';
import { TEXT_LIMITS } from '../../core/src/constants';
import { markdownFilters } from '../../core/src/filters';
import { parseMarkdown } from '../../core/src/markdown-parser';
import { Store } from '../shared/store';
import type { Reading, ToWorker } from '../shared/messages';

const say = <T>(message: ToWorker): Promise<T> => chrome.runtime.sendMessage(message);
const closed = (): void => void say({ type: 'reader:closed' });

/** A small window with a word in it, over the same ground as the reader. Its button, Escape or a click beside it closes the frame. */
function note(text: string): void {
  const container = document.body.createDiv({ cls: 'modal-container foveafocus-modal-container' });
  container.createDiv({ cls: 'modal-bg' }).addEventListener('click', closed);
  const card = container.createDiv({ cls: 'modal reader-note' });
  card.createDiv({ cls: 'reader-note-text', text });
  card.createEl('button', { text: 'Close' }).addEventListener('click', closed);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closed();
  });
}

async function main(): Promise<void> {
  tellLabels();
  const [store, reading, handheld] = await Promise.all([Store.load(), say<Reading | undefined>({ type: 'reader:what' }), say<boolean | undefined>({ type: 'device' })]);
  if (!reading || reading.kind === 'nothing') {
    closed();
    return;
  }
  if (handheld) onHandheld();

  let reader: FoveaFocusModal | null = null;
  const open = (): FoveaFocusModal => {
    // The reader saves a moment after a change. The frame is gone by then when it is closed,
    // so what was set in it is saved as it closes.
    reader = new FoveaFocusModal(
      makeApp(),
      store.settings,
      () => void store.saveSettings().then(closed, closed),
      () => void store.saveSettings(),
      (lines, mobile) => {
        store.contextRoom = { lines, mobile };
      }
    );
    reader.requestSkipInitialAutoLoadOnce();
    reader.open();
    return reader;
  };
  store.follow(() => reader?.updateSettings(store.settings));
  // The page asks the reader to close, as where Escape is pressed with the page in focus
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || (event.data as { foveafocus?: string } | null)?.foveafocus !== 'close') return;
    if (reader) reader.close();
    else closed();
  });

  // Code, tables and lines of links are left out of a reading, and can be all that a page holds
  const text = (reading.kind === 'text' ? parseMarkdown(reading.markdown, markdownFilters(store.settings)).text : reading.text).trim();
  if (!text) {
    note('The settings leave out all there is to read here, such as code, tables and lines of links.');
    return;
  }
  // The reader takes up nothing shorter than this, and would show a word of welcome in its place
  if (text.length < TEXT_LIMITS.minParsedLength) {
    note(`There is too little here to read: a reading takes ${TEXT_LIMITS.minParsedLength} characters or more.`);
    return;
  }
  if (reading.kind === 'text') open().loadText(reading.markdown, { fileName: reading.title, cursorPosition: reading.startAt });
  else open().loadPlainText(reading.text, { fileName: reading.title, cursorPosition: reading.startAt });
}

void main();
