/**
 * The settings of the reader, kept in the browser's storage for extensions on this computer.
 *
 * They are kept in the form the plugin keeps them in its vault: the settings themselves,
 * and with them the setup that has been saved as the user's own default. The reader and
 * the page of settings are handed this as the plugin they were written for.
 */

import { validateSettings } from '../../core/src/services/settings-validator';
import type { FoveaFocusSettings } from '../../core/src/types';

const KEY = 'settings';

type Kept = Partial<FoveaFocusSettings> & {
  savedDefault?: Partial<FoveaFocusSettings> | null;
  savedDefaultOn?: { computer?: unknown; phone?: unknown } | null;
};

export class Store {
  settings!: FoveaFocusSettings;
  savedDefault: FoveaFocusSettings | null = null;
  savedDefaultOn = { computer: false, phone: false };
  /** Lines of text round the word that the reader's window had room for when it was last laid out; null until a reader has been open here */
  contextRoom: { lines: number; mobile: boolean } | null = null;
  /** What was last written or read, to tell a change made elsewhere from the echo of one made here */
  private written = '';

  private constructor(kept: Kept | null) {
    this.take(kept);
  }

  static async load(): Promise<Store> {
    const kept = ((await chrome.storage.local.get(KEY))[KEY] as Kept | undefined) ?? null;
    return new Store(kept);
  }

  private take(kept: Kept | null): void {
    this.settings = validateSettings(kept);
    this.savedDefault = kept?.savedDefault && typeof kept.savedDefault === 'object' ? validateSettings(kept.savedDefault) : null;
    const on = kept?.savedDefaultOn;
    this.savedDefaultOn = {
      computer: !!this.savedDefault && (on ? on.computer === true : true),
      phone: !!this.savedDefault && (on ? on.phone === true : true),
    };
    this.written = JSON.stringify(this.kept());
  }

  private kept(): Kept {
    return this.savedDefault ? { ...this.settings, savedDefault: this.savedDefault, savedDefaultOn: this.savedDefaultOn } : this.settings;
  }

  /** Saves the settings, and with them the setup kept as the user's own default */
  async saveSettings(): Promise<void> {
    const kept = this.kept();
    this.written = JSON.stringify(kept);
    await chrome.storage.local.set({ [KEY]: kept });
  }

  /** Takes up the settings whenever they are changed in another page of the browser, and tells of it */
  follow(changed: () => void): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const kept = (changes[KEY].newValue as Kept | undefined) ?? null;
      if (JSON.stringify(kept) === this.written) return;
      this.take(kept);
      changed();
    });
  }
}
