/**
 * The page of settings. The settings of the reader are drawn by the plugin's own page of
 * settings, with the words the browser asks for; one more group in its row of groups holds
 * the settings that belong to the browser: the bar in pages, PDFs and their links, the
 * shortcuts, and files on the disk.
 */

import { ToggleComponent, makeApp, onHandheld } from '../host/obsidian';
import { tellLabels } from '../host/tooltip';
import type FoveaFocusPlugin from '../../core/main';
import { FoveaFocusSettingTab } from '../../core/src/settings';
import type { ToWorker } from '../shared/messages';
import { DEFAULT_PREFS, loadPrefs, onPrefsChange, savePrefs, type Prefs } from '../shared/prefs';
import { Store } from '../shared/store';
import { keepWording } from './wording';

interface Row {
  descEl: HTMLElement;
  controlEl: HTMLElement;
}

/** A row as the settings of the reader draw theirs: a name and what is said of it on one side, its controls on the other */
function row(parent: HTMLElement, name: string, desc: string): Row {
  const rowEl = parent.createDiv({ cls: 'foveafocus-row' });
  const told = rowEl.createDiv({ cls: 'foveafocus-row-told' });
  told.createDiv({ cls: 'foveafocus-row-name', text: name });
  const descEl = told.createDiv({ cls: 'foveafocus-row-desc', text: desc });
  return { descEl, controlEl: rowEl.createDiv({ cls: 'foveafocus-row-control' }) };
}

const openTab = (url: string): void => void chrome.tabs.create({ url });
const page = (name: string): string => chrome.runtime.getURL(name);

/** The settings that belong to the browser, as they were last kept: a row keeps its own setting with the others as they are now, and not as they were when the row was drawn */
let prefs: Prefs;

function showBrowser(into: HTMLElement, handheld: boolean): void {
  into.empty();
  const heading = (text: string): void => void into.createDiv({ cls: 'foveafocus-row-heading', text });
  /** A row with a switch that keeps one of the settings */
  const switched = (name: string, desc: string, on: boolean, keep: (on: boolean) => Prefs): Row => {
    const made = row(into, name, desc);
    new ToggleComponent(made.controlEl).setValue(on).onChange((now) => void savePrefs(keep(now)));
    return made;
  };

  heading('The bar');
  switched(
    'Bar in pages',
    handheld
      ? 'A small bar at the side of a page, with a button that starts the reader.'
      : 'A small bar at the side of a page, with a button that starts the reader. The FoveaFocus button in the toolbar of the browser shows or hides it in a tab.',
    prefs.bar,
    (on) => ({ ...prefs, bar: on })
  );
  switched('Fold the bar', 'The bar rests as one round button, and shows its other buttons when that one is pressed. A press beside the bar folds it again.', prefs.fold ?? handheld, (on) => ({ ...prefs, fold: on }));
  const moved = switched('Move the bar', 'The bar can be dragged to another place at either side of the window, and rests there.', prefs.drag ?? handheld, (on) => ({ ...prefs, drag: on }));
  if (prefs.at.side !== DEFAULT_PREFS.at.side || prefs.at.y !== DEFAULT_PREFS.at.y) {
    const back = moved.controlEl.createEl('button', { text: 'Put it back' });
    moved.controlEl.prepend(back);
    back.addEventListener('click', () => void savePrefs({ ...prefs, at: DEFAULT_PREFS.at }));
  }

  const sites = row(into, 'Sites without the bar', handheld ? 'One site to a line, by its name: example.org.' : 'One site to a line, by its name: example.org. The menu of the bar adds the site it is on.');
  const area = sites.controlEl.createEl('textarea', { cls: 'foveafocus-section-list', attr: { 'aria-label': 'Sites without the bar' } });
  area.value = prefs.hiddenOn.join('\n');
  area.addEventListener('change', () => {
    void savePrefs({ ...prefs, hiddenOn: Array.from(new Set(area.value.split('\n').map((line) => line.trim()).filter(Boolean))) });
  });

  heading('PDFs');
  switched(
    'PDFs in the viewer of FoveaFocus',
    handheld
      ? "A PDF on the web is shown in FoveaFocus's own viewer, in which a reading starts at any word that is selected or tapped. Switched off, a PDF is left to the browser."
      : "A PDF is shown in FoveaFocus's own viewer, in which a reading starts at any word that is selected or clicked. Switched off, a PDF stays in the browser's viewer until the first button of the bar, or a reading that is asked for, lays the viewer of FoveaFocus over it.",
    prefs.viewer,
    (on) => ({ ...prefs, viewer: on })
  );
  if (handheld) {
    const chosen = row(into, 'A PDF on this device', 'A PDF on the web is shown when its link is followed. One that is on this device is chosen from its files.');
    chosen.controlEl.createEl('button', { text: 'Choose a PDF' }).addEventListener('click', () => openTab(page('pdf.html')));
  }

  heading('Links in a PDF');
  const web = row(into, 'Links to web pages', 'Where a link to a web page is opened.');
  const where = web.controlEl.createEl('select', { attr: { 'aria-label': 'Links to web pages' } });
  for (const [value, name] of [['tab', 'Open in a new tab'], ['same', 'Open in the same tab'], ['off', 'Do not follow']] as const) where.createEl('option', { text: name, attr: { value } });
  where.value = prefs.links.web;
  where.addEventListener('change', () => void savePrefs({ ...prefs, links: { ...prefs.links, web: where.value as Prefs['links']['web'] } }));
  switched(
    'Links that open an app',
    'A link into Obsidian, to an email address and the like. It is handed to the browser, which asks before it opens the app unless it was told to open such links always.',
    prefs.links.apps,
    (on) => ({ ...prefs, links: { ...prefs.links, apps: on } })
  );
  switched(
    handheld ? 'Links to files on this device' : 'Links to files on this computer',
    handheld ? 'Followed in the same tab, and only from a PDF that is itself on this device.' : 'Followed in the same tab, and only from a PDF that is itself on this computer.',
    prefs.links.files,
    (on) => ({ ...prefs, links: { ...prefs.links, files: on } })
  );

  heading('The browser');
  const guide = row(into, 'How it works', 'A page that shows the bar and the reader in a few steps, with a text to try them on.');
  guide.controlEl.createEl('button', { text: 'Open the page' }).addEventListener('click', () => openTab(page('guide.html')));
  // A phone has no keys for shortcuts, and no files that the browser shows as pages
  if (handheld) return;

  const keys = row(into, 'Shortcuts', 'Set in the browser, where they can be changed.');
  keys.controlEl.createEl('button', { text: 'Open the shortcuts of the browser' }).addEventListener('click', () => openTab('chrome://extensions/shortcuts'));
  const list = keys.descEl.createDiv({ cls: 'options-keys' });
  void chrome.commands.getAll().then((commands) => {
    for (const command of commands) {
      list.createEl('kbd', { text: command.shortcut || 'not set' });
      // The browser lists the button of the extension without a name of its own, as "Activate the extension"
      list.createSpan({ text: command.description || 'Show or hide the bar in a tab ("Activate the extension" in the browser)' });
    }
  });

  const files = row(into, 'Files on this computer', 'A PDF, a page or a text file opened from the disk is read once the browser lets the extension at such files: the switch "Allow access to file URLs" on the page of this extension.');
  const status = files.controlEl.createSpan({ cls: 'options-status' });
  void chrome.extension.isAllowedFileSchemeAccess().then((allowed) => status.setText(allowed ? 'Allowed' : 'Not allowed'));
  files.controlEl.createEl('button', { text: 'Open the page of this extension' }).addEventListener('click', () => openTab(`chrome://extensions/?id=${chrome.runtime.id}`));
}

/**
 * The settings of the browser as one more group of the page: a button at the end of the row
 * of the reader's groups shows them in place of a group of the reader. The button stands
 * beside the reader's own and not among them, which the plugin's page counts off against
 * its groups. What is returned puts the mark back on the button where the plugin's page,
 * drawn again, has marked the group it holds.
 */
function asGroup(readerEl: HTMLElement, browserEl: HTMLElement): () => void {
  const pageEl = browserEl.parentElement as HTMLElement;
  const theirs = readerEl.querySelector('.foveafocus-settings-groups') as HTMLElement;
  const rowEl = readerEl.createDiv({ cls: 'foveafocus-settings-groups' });
  theirs.before(rowEl);
  rowEl.append(theirs);
  theirs.addClass('options-groups');
  const ours = rowEl.createEl('button', { text: 'In the browser', cls: 'foveafocus-settings-choice' });
  const choose = (on: boolean): void => {
    pageEl.toggleClass('shows-browser', on);
    ours.toggleClass('is-chosen', on);
    ours.setAttr('aria-pressed', on);
    if (!on) return;
    for (const button of Array.from(theirs.children)) {
      button.removeClass('is-chosen');
      button.setAttr('aria-pressed', false);
    }
  };
  ours.addEventListener('click', () => choose(true));
  // A group of the reader has marked its own button by the time the press reaches the row
  theirs.addEventListener('click', (event) => {
    if ((event.target as Element).closest('button')) choose(false);
  });
  choose(false);
  return () => {
    if (ours.hasClass('is-chosen')) choose(true);
  };
}

async function main(): Promise<void> {
  tellLabels();
  const [store, kept, device] = await Promise.all([Store.load(), loadPrefs(), chrome.runtime.sendMessage<ToWorker, boolean>({ type: 'device' }).catch(() => false)]);
  prefs = kept;
  const handheld = device === true;
  if (handheld) onHandheld();

  const tab = new FoveaFocusSettingTab(makeApp(), store as unknown as FoveaFocusPlugin);
  const reader = document.getElementById('reader') as HTMLElement;
  keepWording(tab.containerEl);
  reader.appendChild(tab.containerEl);
  tab.display();
  window.addEventListener('pagehide', () => tab.hide());

  const browser = document.getElementById('browser') as HTMLElement;
  showBrowser(browser, handheld);
  const marked = asGroup(tab.containerEl, browser);
  store.follow(() => {
    tab.refresh();
    marked();
  });
  onPrefsChange((now) => {
    prefs = now;
    // What is being typed is left alone: the page is drawn again only for a change made elsewhere
    if (!browser.contains(document.activeElement)) showBrowser(browser, handheld);
  });
}

void main();
