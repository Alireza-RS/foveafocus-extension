/**
 * The page of settings. The settings of the reader are drawn by the plugin's own page of
 * settings, with the words the browser asks for; under them stand the settings that belong
 * to the browser: the bar in pages, the shortcuts, and files on the disk.
 */

import { ToggleComponent, makeApp } from '../host/obsidian';
import { tellLabels } from '../host/tooltip';
import type FoveaFocusPlugin from '../../core/main';
import { FoveaFocusSettingTab } from '../../core/src/settings';
import { loadPrefs, onPrefsChange, savePrefs, type Prefs } from '../shared/prefs';
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

function showBrowser(into: HTMLElement, prefs: Prefs): void {
  into.empty();

  const bar = row(into, 'Bar in pages', 'A small bar at the side of a page, with a button that starts the reader. The FoveaFocus button in the toolbar of the browser shows or hides it in a tab.');
  new ToggleComponent(bar.controlEl).setValue(prefs.bar).onChange((on) => void savePrefs({ ...prefs, bar: on }));

  const viewer = row(into, 'PDFs in the viewer of FoveaFocus', "A PDF is shown in FoveaFocus's own viewer, in which a reading starts at any word that is selected or clicked. Switched off, a PDF stays in the browser's viewer until the first button of the bar, or a reading that is asked for, lays the viewer of FoveaFocus over it.");
  new ToggleComponent(viewer.controlEl).setValue(prefs.viewer).onChange((on) => void savePrefs({ ...prefs, viewer: on }));

  const sites = row(into, 'Sites without the bar', 'One site to a line, by its name: example.org. The menu of the bar adds the site it is on.');
  const area = sites.controlEl.createEl('textarea', { cls: 'foveafocus-section-list', attr: { 'aria-label': 'Sites without the bar' } });
  area.value = prefs.hiddenOn.join('\n');
  area.addEventListener('change', () => {
    void savePrefs({ ...prefs, hiddenOn: Array.from(new Set(area.value.split('\n').map((line) => line.trim()).filter(Boolean))) });
  });

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

async function main(): Promise<void> {
  tellLabels();
  const [store, prefs] = await Promise.all([Store.load(), loadPrefs()]);

  const tab = new FoveaFocusSettingTab(makeApp(), store as unknown as FoveaFocusPlugin);
  const reader = document.getElementById('reader') as HTMLElement;
  keepWording(tab.containerEl);
  reader.appendChild(tab.containerEl);
  tab.display();
  store.follow(() => tab.refresh());
  window.addEventListener('pagehide', () => tab.hide());

  const browser = document.getElementById('browser') as HTMLElement;
  showBrowser(browser, prefs);
  onPrefsChange((now) => {
    // What is being typed is left alone: the page is drawn again only for a change made elsewhere
    if (!browser.contains(document.activeElement)) showBrowser(browser, now);
  });
}

void main();
