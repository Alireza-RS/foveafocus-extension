/**
 * The worker behind the pages: it puts the extension's lines into the menu of a page,
 * listens for its button and its shortcuts, tells the script in the page what was asked
 * for, keeps what its button has made of the bar in a tab, and passes on what the reader's
 * frame and the script of its page have to say to each other. It knows what kind of device
 * the browser runs on, and on a phone or a tablet sends a tab that is on its way to a PDF to
 * the page of the extension that shows one.
 */

import type { How, ToPage, ToWorker } from './shared/messages';
import { pdfNamedIn, pdfRule } from './shared/pdf-page';
import { loadPrefs, onPrefsChange } from './shared/prefs';

const MENU = {
  fromSelection: 'read-from-selection',
  selection: 'read-selection',
  here: 'read-here',
  start: 'read-start',
} as const;

/** Whether the browser runs on a phone or a tablet: as it names itself, or as it says of the system it runs on */
const handheld = async (): Promise<boolean> => /\bAndroid\b/.test(navigator.userAgent) || (await chrome.runtime.getPlatformInfo()).os === 'android';

// The browser keeps the lines of the menu from one start to the next, also those of an
// earlier build, and does not always tell the extension that it was changed. So the lines
// are made anew whenever the worker starts. A phone or a tablet gets none of them: it has no
// button for the menu of a page, a long press brings the menu up there, and a long press is
// also what selects a word.
chrome.contextMenus.removeAll(() => {
  void handheld().catch(() => false).then((phone) => {
    if (phone) return;
    chrome.contextMenus.create({ id: MENU.fromSelection, title: 'Read from the selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU.selection, title: 'Read only the selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU.here, title: 'Read from here', contexts: ['page', 'link', 'image'] });
    chrome.contextMenus.create({ id: MENU.start, title: 'Read from the start', contexts: ['page', 'link', 'image', 'selection'] });
  });
});

const PDF_RULE = 1;

/** Has PDFs shown in the page of the extension where the browser shows none as a page, and the settings have the extension show them */
async function sendPdfsToViewer(): Promise<void> {
  const on = (await handheld()) && (await loadPrefs()).viewer;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PDF_RULE], addRules: on ? [pdfRule(PDF_RULE)] : [] });
}

void sendPdfsToViewer().catch(() => undefined);
onPrefsChange(() => void sendPdfsToViewer().catch(() => undefined));

/** Says for a moment, on the button of the extension, that a page cannot be read */
function cannotRead(tabId: number): void {
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#b3261e' });
  void chrome.action.setBadgeText({ tabId, text: '!' });
  void chrome.action.setTitle({ tabId, title: 'FoveaFocus cannot read this page' });
  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: '' });
    void chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action?.default_title ?? '' });
  }, 4000);
}

/**
 * Tells the script in a page what was asked for. A page that was open before the extension
 * was installed has no script yet: it is put in, and told what a script that has just
 * started is to hear. A file on the disk is out of reach until the browser is told to let
 * the extension at such files: a page says how. Other pages that cannot be reached are the
 * browser's own, which no extension may read.
 */
async function tell(tab: chrome.tabs.Tab | undefined, message: ToPage, toNew: ToPage = message): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    return;
  } catch {
    // No script in the page yet
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, toNew, { frameId: 0 });
  } catch {
    const onDisk = (tab?.url ?? tab?.pendingUrl ?? '').startsWith('file:');
    if (onDisk && !(await chrome.extension.isAllowedFileSchemeAccess())) void chrome.tabs.create({ url: chrome.runtime.getURL('files.html') });
    else cannotRead(tabId);
  }
}

const read = (tab: chrome.tabs.Tab | undefined, how: How, selected?: string): Promise<void> => tell(tab, { type: 'read', how, selected });

// The button shows the bar in its tab, or hides it. A script that has just started has no bar to hide: there the button shows it.
chrome.action.onClicked.addListener((tab) => void tell(tab, { type: 'bar' }, { type: 'bar', show: true }));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU.fromSelection) void read(tab, 'from-selection', info.selectionText);
  else if (info.menuItemId === MENU.selection) void read(tab, 'selection', info.selectionText);
  // Where the menu was opened is known in the page itself and in the extension's own viewer of a PDF, not in other frames
  else if (info.menuItemId === MENU.here) void read(tab, info.frameId && info.frameUrl !== chrome.runtime.getURL('viewer.html') ? 'page' : 'here');
  else if (info.menuItemId === MENU.start) void read(tab, 'page');
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'read') void read(tab, 'auto');
  else if (command === 'read-from-a-place') void tell(tab, { type: 'pick' });
});

/** Under what name it is kept what the button has made of the bar in a tab */
const barOf = (tabId: number): string => `bar:${tabId}`;

chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(barOf(tabId)));

/** Whether an address is that of a file on this device */
const onDevice = (address: string): boolean => address.startsWith('file:');

chrome.runtime.onMessage.addListener((message: ToWorker, sender, respond) => {
  if (message.type === 'options') {
    // Where the browser has no way of its own to the page of settings, it is opened as any page is
    void Promise.resolve()
      .then(() => chrome.runtime.openOptionsPage())
      .catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }));
    return;
  }
  if (message.type === 'page') {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`${message.page}.html`) });
    return;
  }
  if (message.type === 'device') {
    handheld().then(respond, () => respond(false));
    return true;
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  if (message.type === 'follow') {
    // A file on this device is opened from a PDF that is itself on this device, and from no other
    const tab = sender.tab?.url ?? '';
    if (onDevice(message.url) && onDevice(pdfNamedIn(tab) ?? tab)) void chrome.tabs.update(tabId, { url: message.url });
    return;
  }
  if (message.type === 'bar:kept') {
    chrome.storage.session.get(barOf(tabId)).then((kept) => respond(kept[barOf(tabId)]), () => respond(undefined));
    return true;
  }
  if (message.type === 'bar:keep') {
    if (message.show === undefined) void chrome.storage.session.remove(barOf(tabId));
    else void chrome.storage.session.set({ [barOf(tabId)]: message.show });
    return;
  }
  // The reader's frame speaks to the script of the page it lies over
  chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).then(respond, () => respond(undefined));
  return true;
});
