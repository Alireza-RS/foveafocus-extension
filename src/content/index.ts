/**
 * The script that stands in every page: it shows the bar where the settings and the button
 * of the extension have it shown, takes what the worker passes on from the button, the menu
 * and the shortcuts, finds what there is to read, and opens the reader's frame on it. Over
 * a PDF it lays the extension's own viewer, which then says what there is to read.
 *
 * The same script stands in two pages of the extension's own, which start it themselves:
 * the page that shows a PDF by itself, and the page that shows how the extension works.
 */

import { DEFAULT_SETTINGS } from '../../core/src/types';
import type { How, Pdf, ToPage, ToWorker } from '../shared/messages';
import { loadPrefs, onPrefsChange, savePrefs, type Prefs } from '../shared/prefs';
import { Launcher } from './launcher';
import { Overlay } from './overlay';
import { fileName, pageText, placeAt, plainText, selectionText, type PageText } from './page-text';
import { Viewer } from './viewer';

const STARTED = 'foveafocusStarted';

/** What a page of the extension's own tells the script that is to stand in it */
export interface OwnPage {
  /** The PDF that the page shows by itself */
  pdf?: Pdf;
  /** Gives the bytes of that PDF where they are not fetched from its address */
  bytes?: () => Promise<ArrayBuffer | null>;
  /** The reader asks for the PDF as a file */
  leave?: () => void;
  /** The PDF could not be shown */
  failed?: () => void;
  /** The page shows how the extension works: the bar is on show in it whatever the settings have, and does not offer the page */
  tour?: boolean;
}

/** The width that the scrollbar of the browser's own viewer of a PDF is taken to have: the bar keeps clear of it */
const BROWSER_EDGE = 16;

/** Starts the script in its page, and gives the means to say a word to the reader there */
export function start(host: OwnPage = {}): { say(text: string): void } {
  /** The PDF that this page shows, if it shows one */
  const shownHere: Pdf | null = document.contentType === 'application/pdf' ? { url: location.href, title: document.title.trim() || fileName() || location.hostname || location.protocol, bytesFollow: location.protocol !== 'file:', alone: false } : null;
  const pdf = host.pdf ?? shownHere;
  /** Whether the extension's own viewer is all that shows the PDF: there is no viewer of the browser under it */
  const alone = !!host.pdf;
  /** The name this site goes by where sites are listed: the host of the page or of the PDF it shows, or how one without a host is reached */
  const from = pdf?.url ? new URL(pdf.url) : location;
  const site = from.hostname || from.protocol;
  let prefs: Prefs | null = null;
  /** Whether the browser runs on a phone or a tablet */
  let handheld = false;
  /** What the button of the extension has made of the bar in this tab: shown, hidden, or left to the settings */
  let inTab: boolean | undefined;
  /** What the menu of the page was last opened on */
  let menuOn: Node | Range | null = null;

  const say = (message: ToWorker): void => void chrome.runtime.sendMessage(message);

  /** Whether this script is cut off from the extension, which was loaded anew while the page was open. It says so where it is. */
  const cutOff = (): boolean => {
    if (chrome.runtime?.id) return false;
    launcher.toast(handheld ? 'FoveaFocus was updated. Load this page again.' : 'FoveaFocus was updated. Load this page again, or press its button in the toolbar.');
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
    guide: () => {
      if (!cutOff()) say({ type: 'page', page: 'guide' });
    },
    choosePdf: () => {
      if (!cutOff()) say({ type: 'page', page: 'pdf' });
    },
    moved: (at) => {
      if (prefs && !cutOff()) keep({ ...prefs, at });
    },
    tipsSeen: () => {
      if (prefs?.tips && !cutOff()) keep({ ...prefs, tips: false });
    },
  }, { alone, tour: host.tour });
  const viewer = pdf && new Viewer(launcher.frameRoot, pdf, host.bytes);
  const overlay = new Overlay(launcher.frameRoot, (open) => {
    launcher.dim(open);
    viewer?.rest(open);
  });

  /** Shows the PDF in the extension's own viewer, or leaves it to the browser's */
  const showPdfIn = (own: boolean): void => {
    if (!viewer) return;
    if (own) viewer.open();
    else viewer.close();
    launcher.showsPdf(own, own || alone ? 0 : BROWSER_EDGE, 0);
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
    if (!alone && prefs?.viewer !== now.viewer) showPdfIn(now.viewer);
    prefs = now;
    // Left to the device, the bar folds and can be moved on a phone or a tablet
    launcher.behave({ fold: now.fold ?? handheld, drag: now.drag ?? handheld, at: now.at, handheld, tips: now.tips });
    launcher.showBar(shown());
  };
  /** Takes up settings that were changed here, and keeps them */
  const keep = (now: Prefs): void => {
    follow(now);
    void savePrefs(now);
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
    const ask = (message: ToWorker): Promise<boolean | undefined> => chrome.runtime.sendMessage<ToWorker, boolean | undefined>(message).catch(() => undefined);
    const [now, kept, device] = await Promise.all([loadPrefs(), ask({ type: 'bar:kept' }), ask({ type: 'device' })]);
    inTab = typeof kept === 'boolean' ? kept : host.tour ? true : undefined;
    handheld = device === true;
    follow(now);
  };
  // A page that shows a PDF by itself has no other viewer to leave it to: the PDF is shown at once, whatever the settings have
  if (alone) showPdfIn(true);
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

  chrome.runtime.onMessage.addListener((message: ToPage, sender, respond) => {
    // What a frame says comes by way of the worker. A page of the extension's own hears the frame itself as well, as it hears every frame of the extension in every tab: that is passed over.
    if (sender.tab) return;
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
    else if (message.type === 'viewer:leave') {
      if (alone) host.leave?.();
      else showPdfIn(false);
    } else if (message.type === 'viewer:failed') {
      showPdfIn(false);
      if (alone) host.failed?.();
      else launcher.toast("FoveaFocus could not show this PDF. The browser's viewer shows it.", 4000);
    } else if (message.type === 'viewer:read') {
      if (message.reading) overlay.open({ kind: 'words', text: message.reading.text, title: pdf.title, startAt: message.reading.startAt });
      if (message.said) launcher.toast(message.said, message.reading ? 6000 : 3500);
    }
  });

  return { say: (text) => launcher.toast(text, 4000) };
}

// One script to a page, also where the worker has put it into a page that was open before the extension was. A page of the extension's own starts it itself.
const world = globalThis as unknown as Record<string, unknown>;
if (!world[STARTED] && location.protocol !== 'chrome-extension:' && document.documentElement instanceof HTMLElement && !/^(?:image|video|audio)\//.test(document.contentType)) {
  world[STARTED] = true;
  start();
}
