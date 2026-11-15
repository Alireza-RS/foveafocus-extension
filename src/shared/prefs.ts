/**
 * What the extension keeps about itself, apart from the settings of the reader: where its
 * bar is shown, and what shows a PDF. Kept in the browser's storage for extensions, on this
 * computer.
 */

export interface Prefs {
  /** Whether the bar is shown on pages at all */
  bar: boolean;
  /** Sites the bar is not shown on, by host name */
  hiddenOn: string[];
  /** Whether a PDF is shown in the extension's own viewer, laid over the browser's */
  viewer: boolean;
}

export const DEFAULT_PREFS: Prefs = { bar: true, hiddenOn: [], viewer: true };

const KEY = 'prefs';

export async function loadPrefs(): Promise<Prefs> {
  const kept = (await chrome.storage.local.get(KEY))[KEY] as Partial<Prefs> | undefined;
  return {
    bar: typeof kept?.bar === 'boolean' ? kept.bar : DEFAULT_PREFS.bar,
    hiddenOn: Array.isArray(kept?.hiddenOn) ? kept.hiddenOn.filter((host): host is string => typeof host === 'string') : [],
    viewer: typeof kept?.viewer === 'boolean' ? kept.viewer : DEFAULT_PREFS.viewer,
  };
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await chrome.storage.local.set({ [KEY]: prefs });
}

/** Tells of the preferences whenever they are changed, here or in another page of the browser */
export function onPrefsChange(told: (prefs: Prefs) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) void loadPrefs().then(told);
  });
}
