/**
 * The script that stands in every page: it shows the bar where the settings and the button
 * of the extension have it shown, takes what the worker passes on from the button, the menu
 * and the shortcuts, finds what there is to read, and opens the reader's frame on it. Over
 * a PDF it lays the extension's own viewer, which then says what there is to read.
 */

import { DEFAULT_SETTINGS } from '../../core/src/types';
import type { How, Pdf, ToPage, ToWorker } from '../shared/messages';
import { loadPrefs, onPrefsChange, savePrefs, type Prefs } from '../shared/prefs';
import { Launcher } from './launcher';
import { Overlay } from './overlay';
import { fileName, pageText, placeAt, plainText, selectionText, type PageText } from './page-text';
import { Viewer } from './viewer';

const STARTED = 'foveafocusStarted';

/** The width that the scrollbar of the browser's own viewer of a PDF is taken to have: the bar keeps clear of it */
const BROWSER_EDGE = 16;

function start(): void {
  /** The name this site goes by where sites are listed: its host, or how a page without one is reached */
  const site = location.hostname || location.protocol;
  /** The PDF that this page shows, if it shows one */
  const pdf: Pdf | null = document.contentType === 'application/pdf' ? { url: location.href, title: document.title.trim() || fileName() || site, bytesFollow: location.protocol !== 'file:' } : null;
  let prefs: Prefs | null = null;
  /** What the button of the extension has made of the bar in this tab: shown, hidden, or left to the settings */
  let inTab: boolean | undefined;
  /** What the menu of the page was last opened on */
  let menuOn: Node | Range | null = null;

  const say = (message: ToWorker): void => void chrome.runtime.sendMessage(message);

  /** Whether this script is cut off from the extension, which was loaded anew while the page was open. It says so where it is. */
  const cutOff = (): boolean => {
    if (chrome.runtime?.id) return false;
    launcher.toast('FoveaFocus was updated. Load this page again, or press its button in the toolbar.');
    return true;
  };

  const launcher = new Launcher({
    read: () => void read('auto'),
    readSelection: () => void read('selection'),
    readFrom: (block, x, y) => void read('here', placeAt(block, x, y) ?? undefined),
    pickInViewer: () => {
      if (!cutOff()) pickInViewer();
    },
    otherViewer: () => {
      if (!cutOff()) showPdfIn(!viewer?.isOn);
    },
    hideHere: () => {
      if (prefs && !cutOff()) hide({ ...prefs, hiddenOn: Array.from(new Set([...prefs.hiddenOn, site])) }, 'Hidden on this site. The FoveaFocus button in the toolbar shows it again.');
    },
    hideEverywhere: () => {
      if (prefs && !cutOff()) hide({ ...prefs, bar: false }, 'Hidden on every site. The FoveaFocus button in the toolbar shows it again.');
    },
    settings: () => {
      if (!cutOff()) say({ type: 'options' });
    },
  });
  const viewer = pdf && new Viewer(launcher.frameRoot, pdf);
  const overlay = new Overlay(launcher.frameRoot, (open) => {
    launcher.dim(open);
    viewer?.rest(open);
  });

  /** Shows the PDF in the extension's own viewer, or leaves it to the browser's */
  const showPdfIn = (own: boolean): void => {
    if (!viewer) return;
    if (own) viewer.open();
    else viewer.close();
    launcher.showsPdf(own, own ? 0 : BROWSER_EDGE, 0);
  };
  /** Has a place picked in the viewer, which takes the keys for it */
  const pickInViewer = (): void => {
    viewer?.focus();
    viewer?.tell({ foveafocus: 'pick' });
  };

  /** Whether the bar is on show: as the button of the extension has it in this tab, else as the settings have it for the site */
  const shown = (): boolean => inTab ?? (!!prefs && prefs.bar && !prefs.hiddenOn.includes(site));
  const follow = (now: Prefs): void => {
    // Which viewer shows a PDF goes by its setting when the page is first taken up and when that setting is changed; between the two it is the reader's to say
    if (prefs?.viewer !== now.viewer) showPdfIn(now.viewer);
    prefs = now;
    launcher.showBar(shown());
  };
  /** Hides the bar by the settings. They hold in this tab again, whatever the button had made of the bar. */
  const hide = (now: Prefs, told: string): void => {
    launcher.toast(told);
    inTab = undefined;
    say({ type: 'bar:keep' });
    follow(now);
    void savePrefs(now);
    // The bar had the keys, and is gone: over a PDF they go to its viewer, not to the browser's viewer under it
    viewer?.focus();
  };
  /** Takes up the settings, and what the button of the extension has made of the bar in this tab */
  const takeUp = async (): Promise<void> => {
    const [now, kept] = await Promise.all([loadPrefs(), chrome.runtime.sendMessage<ToWorker, boolean | undefined>({ type: 'bar:kept' }).catch(() => undefined)]);
    inTab = typeof kept === 'boolean' ? kept : undefined;
    follow(now);
  };
  const ready = takeUp();
  onPrefsChange(follow);
  // A page that the browser kept and shows again, as on going back, has the bar as it was when the page was left
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && chrome.runtime?.id) void takeUp();
  });

  document.addEventListener('contextmenu', (event) => {
    menuOn = placeAt(event.target instanceof Node ? event.target : null, event.clientX, event.clientY);
  }, true);

  /** A selection of more characters than this is read on its own; a shorter one marks where the page is read from */
  async function ownSelectionLength(): Promise<number> {
    const kept = (await chrome.storage.local.get('settings')).settings as { ownSelectionLength?: unknown } | undefined;
    const length = kept?.ownSelectionLength;
    return typeof length === 'number' && Number.isFinite(length) ? length : DEFAULT_SETTINGS.ownSelectionLength;
  }

  async function read(how: How, from?: Node | Range, selected?: string): Promise<void> {
    if (cutOff()) return;
    // Asked for again while it is open, as by its shortcut, the reader closes
    if (overlay.isOpen) {
      overlay.close();
      return;
    }
    // The extension's own viewer of a PDF knows what is selected in it and where its menu was opened: it says what is read
    if (viewer?.isOn) {
      viewer.tell({ foveafocus: 'read', how });
      return;
    }
    const selection = window.getSelection();
    const range = selection && !selection.isCollapsed && selection.toString().trim() ? selection.getRangeAt(0) : null;

    let text: PageText | null = null;
    if (how === 'selection') {
      if (selection && range) text = selectionText(selection);
      else if (selected?.trim()) text = plainText(selected);
    } else if (viewer) {
      // The browser's viewer shows the PDF. It hands over the words of a selection, and not where they lie: they are read alone
      if (how === 'from-selection' && selected?.trim()) {
        text = plainText(selected);
      } else {
        // A PDF is read in the extension's own viewer: it is laid over the browser's, and reads the PDF from its start
        showPdfIn(true);
        viewer.tell({ foveafocus: 'read', how: 'page' });
        return;
      }
    } else if (how === 'here' && from) {
      text = pageText(from);
    } else if (how === 'from-selection') {
      // A selection in a frame of the page is no place in the page itself: it is read alone
      if (range) text = pageText(range);
      else if (selected?.trim()) text = plainText(selected);
    } else if (how === 'auto' && selection && range) {
      text = selection.toString().trim().length > (await ownSelectionLength()) ? selectionText(selection) : pageText(range);
    } else {
      text = pageText();
    }

    if (!text?.markdown.trim()) {
      launcher.toast(how === 'selection' || how === 'from-selection' ? 'Nothing is selected' : 'No text to read was found here');
      return;
    }
    overlay.open({ kind: 'text', markdown: text.markdown, title: text.title, startAt: text.startAt });
  }

  chrome.runtime.onMessage.addListener((message: ToPage, _sender, respond) => {
    // A script that has just been put into its page takes up the settings first: they say what shows a PDF
    if (message.type === 'read') void ready.then(() => read(message.how, message.how === 'here' ? menuOn ?? undefined : undefined, message.selected));
    else if (message.type === 'pick') {
      void ready.then(() => {
        if (overlay.isOpen) return;
        if (!viewer) launcher.pick();
        else {
          // A word is picked in the extension's own viewer of a PDF, which is laid over the browser's for it
          showPdfIn(true);
          pickInViewer();
        }
      });
    } else if (message.type === 'bar') {
      // Behind the reader the bar is out of sight, shown or not
      void ready.then(() => {
        if (overlay.isOpen) return;
        inTab = message.show ?? !shown();
        say({ type: 'bar:keep', show: inTab });
        launcher.showBar(inTab);
      });
    } else if (message.type === 'reader:what') respond(overlay.whatToRead());
    else if (message.type === 'reader:closed') overlay.remove();
    // A frame of the viewer that this script has not laid over its page is told nothing, and nothing it says is taken up
    else if (!pdf || !viewer?.isOn) return;
    else if (message.type === 'viewer:what') respond(viewer.whatToShow());
    else if (message.type === 'viewer:shown') {
      launcher.showsPdf(true, message.edge, message.top);
      // The browser gives the keys to its own viewer when that has loaded the PDF, which can be after this one was laid over it
      if (!overlay.isOpen) viewer.focus();
    }
    else if (message.type === 'viewer:leave') showPdfIn(false);
    else if (message.type === 'viewer:failed') {
      showPdfIn(false);
      launcher.toast("FoveaFocus could not show this PDF. The browser's viewer shows it.", 4000);
    } else if (message.type === 'viewer:read') {
      if (message.reading) overlay.open({ kind: 'words', text: message.reading.text, title: pdf.title, startAt: message.reading.startAt });
      if (message.said) launcher.toast(message.said, message.reading ? 6000 : 3500);
    }
  });
}

// One script to a page, also where the worker has put it into a page that was open before the extension was
const world = globalThis as unknown as Record<string, unknown>;
if (!world[STARTED] && document.documentElement instanceof HTMLElement && !/^(?:image|video|audio)\//.test(document.contentType)) {
  world[STARTED] = true;
  start();
}
