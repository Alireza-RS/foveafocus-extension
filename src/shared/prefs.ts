/**
 * What the extension keeps about itself, apart from the settings of the reader: where its
 * bar is shown and how it rests there, what shows a PDF, and which links of a PDF are
 * followed. Kept in the browser's storage for extensions, on this device.
 */

/** Where the bar rests: at which side of the window, and how far down that side, as a share of its height */
export interface Rest {
  side: 'left' | 'right';
  y: number;
}

/** Which links of a PDF the extension's own viewer follows */
export interface Links {
  /** A link to a web page: opened in a tab of its own, in the tab of the PDF, or not at all */
  web: 'tab' | 'same' | 'off';
  /** Whether a link that an app opens, as obsidian:// and mailto: do, is handed to the browser */
  apps: boolean;
  /** Whether a link to a file on this device is followed, from a PDF that is itself on this device */
  files: boolean;
}

export interface Prefs {
  /** Whether the bar is shown on pages at all */
  bar: boolean;
  /** Sites the bar is not shown on, by host name */
  hiddenOn: string[];
  /** Whether a PDF is shown in the extension's own viewer */
  viewer: boolean;
  /** Whether the bar folds into one button until it is asked for. Null leaves it to the device: it folds on a phone or a tablet, and not on a computer. */
  fold: boolean | null;
  /** Whether the bar can be moved to another place. Null leaves it to the device, as with the folding. */
  drag: boolean | null;
  at: Rest;
  links: Links;
  /** Whether the bar has yet to say what its buttons do */
  tips: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  bar: true,
  hiddenOn: [],
  viewer: true,
  fold: null,
  drag: null,
  at: { side: 'right', y: 0.5 },
  links: { web: 'tab', apps: true, files: true },
  tips: true,
};

const KEY = 'prefs';

const flag = (kept: unknown, otherwise: boolean): boolean => (typeof kept === 'boolean' ? kept : otherwise);

export async function loadPrefs(): Promise<Prefs> {
  const kept = (await chrome.storage.local.get(KEY))[KEY] as Partial<Prefs> | undefined;
  const at = kept?.at as Partial<Rest> | undefined;
  const links = kept?.links as Partial<Links> | undefined;
  return {
    bar: flag(kept?.bar, DEFAULT_PREFS.bar),
    hiddenOn: Array.isArray(kept?.hiddenOn) ? kept.hiddenOn.filter((host): host is string => typeof host === 'string') : [],
    viewer: flag(kept?.viewer, DEFAULT_PREFS.viewer),
    fold: typeof kept?.fold === 'boolean' ? kept.fold : null,
    drag: typeof kept?.drag === 'boolean' ? kept.drag : null,
    at: {
      side: at?.side === 'left' ? 'left' : 'right',
      y: typeof at?.y === 'number' && at.y >= 0 && at.y <= 1 ? at.y : DEFAULT_PREFS.at.y,
    },
    links: {
      web: links?.web === 'same' || links?.web === 'off' ? links.web : 'tab',
      apps: flag(links?.apps, DEFAULT_PREFS.links.apps),
      files: flag(links?.files, DEFAULT_PREFS.links.files),
    },
    tips: flag(kept?.tips, DEFAULT_PREFS.tips),
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
