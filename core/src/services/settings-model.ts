/**
 * What the settings tab works out about the settings, apart from showing them: which of them a
 * device keeps for itself, the sets of pauses that one choice stands for, and in what a setup
 * differs from another. Nothing here touches the app.
 */

import { DEFAULT_SETTINGS, type FoveaFocusSettings } from '../types';

type Key = keyof FoveaFocusSettings;

/** Settings kept twice, once for the computer and once for the phone: the computer's key, then the phone's */
const DEVICE_PAIRS = {
  wpm: 'mobileWpm',
  chunkSize: 'mobileChunkSize',
  fontSize: 'mobileFontSize',
  showContext: 'mobileShowContext',
  contextLines: 'mobileContextLines',
  contextFontSize: 'mobileContextFontSize',
  showOutline: 'mobileShowOutline',
  enableSlowStart: 'mobileEnableSlowStart',
  enableMicropause: 'mobileEnableMicropause',
} as const;

export type DeviceSetting = keyof typeof DEVICE_PAIRS;

/** The key under which a device keeps a setting of its own */
export function deviceKey(key: DeviceSetting, mobile: boolean): Key {
  return mobile ? DEVICE_PAIRS[key] : key;
}

/** What a device has a setting of its own at */
export function readDevice<K extends DeviceSetting>(settings: FoveaFocusSettings, key: K, mobile: boolean): FoveaFocusSettings[K] {
  return settings[deviceKey(key, mobile)] as FoveaFocusSettings[K];
}

/** Sets a setting that a device keeps for itself */
export function writeDevice<K extends DeviceSetting>(settings: FoveaFocusSettings, key: K, mobile: boolean, value: FoveaFocusSettings[K]): void {
  (settings as unknown as Record<string, unknown>)[deviceKey(key, mobile)] = value;
}

/**
 * The setting as the computer names it: for one the phone keeps for itself, the computer's
 * key, under which the two are one setting to whoever sets them.
 */
export function sharedKey(key: Key): Key {
  const pair = (Object.keys(DEVICE_PAIRS) as DeviceSetting[]).find((own) => DEVICE_PAIRS[own] === key);
  return pair ?? key;
}

/** Whether a setting is kept twice, once for each device */
export function keptPerDevice(key: Key): boolean {
  return sharedKey(key) in DEVICE_PAIRS;
}

/** The pauses that have a strength of their own, with the most each can be set to */
export const PAUSES = [
  { key: 'micropausePunctuation', max: 5 },
  { key: 'micropauseOtherPunctuation', max: 3 },
  { key: 'micropauseParagraph', max: 5 },
  { key: 'micropauseLongWords', max: 2 },
  { key: 'micropauseNumbers', max: 3 },
  { key: 'micropauseHeadings', max: 3 },
  { key: 'micropauseCallouts', max: 3 },
  { key: 'micropauseListBullets', max: 3 },
  { key: 'micropauseSectionMarkers', max: 3 },
] as const;

export type PauseKey = (typeof PAUSES)[number]['key'];

/** The sets of pauses one choice stands for: the share that is kept of what each pause adds at first */
const SETS = { light: 0.5, standard: 1, strong: 1.5 } as const;

export type PauseSet = keyof typeof SETS;

/** What the pauses are set to: off, one of the sets, or strengths of the user's own */
export type PauseChoice = 'off' | PauseSet | 'own';

/** The strength of a pause in a set, to one decimal place and no more than the pause can be set to */
export function strengthIn(set: PauseSet, key: PauseKey): number {
  const most = PAUSES.find((pause) => pause.key === key)?.max ?? 3;
  return Math.min(most, Math.round((1 + (DEFAULT_SETTINGS[key] - 1) * SETS[set]) * 10) / 10);
}

/** The set the strengths of the pauses are those of, if they are those of one */
function setOf(settings: FoveaFocusSettings): PauseSet | null {
  const sets = Object.keys(SETS) as PauseSet[];
  return sets.find((set) => PAUSES.every(({ key }) => Math.abs(settings[key] - strengthIn(set, key)) < 0.001)) ?? null;
}

/** Whether the strengths of the pauses are the user's own, and those of none of the sets */
export function pausesAreOwn(settings: FoveaFocusSettings): boolean {
  return setOf(settings) === null;
}

/** What the pauses are set to on a device */
export function pauseChoice(settings: FoveaFocusSettings, mobile: boolean): PauseChoice {
  if (!readDevice(settings, 'enableMicropause', mobile)) return 'off';
  return setOf(settings) ?? 'own';
}

/**
 * Sets the pauses by one choice. Off switches them off on the device and leaves their
 * strengths as they are, so that they are there to come back to; a set switches them on at
 * its strengths; the user's own switches them on as they stand.
 */
export function choosePauses(settings: FoveaFocusSettings, choice: PauseChoice, mobile: boolean): void {
  writeDevice(settings, 'enableMicropause', mobile, choice !== 'off');
  if (choice === 'off' || choice === 'own') return;
  for (const { key } of PAUSES) settings[key] = strengthIn(choice, key);
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  return a === b;
}

/** The settings a device shows: its own, and those that both devices share. What the other device keeps for itself is not among them. */
export function shownOn(mobile: boolean): Key[] {
  const pairs = Object.keys(DEVICE_PAIRS) as DeviceSetting[];
  const elsewhere = new Set<Key>(pairs.map((key) => deviceKey(key, !mobile)));
  return (Object.keys(DEFAULT_SETTINGS) as Key[]).filter((key) => !elsewhere.has(key));
}

/** The settings in which two setups differ, among those a device shows */
export function differing(a: FoveaFocusSettings, b: FoveaFocusSettings, mobile: boolean): Key[] {
  return shownOn(mobile).filter((key) => !same(a[key], b[key]));
}

/** Sets in one setup what a device shows, as it stands in another. What the other device keeps for itself is left as it is. */
export function setShown(into: FoveaFocusSettings, from: FoveaFocusSettings, mobile: boolean): void {
  const copy = copyOf(from) as unknown as Record<Key, unknown>;
  for (const key of shownOn(mobile)) (into as unknown as Record<Key, unknown>)[key] = copy[key];
}

/** A copy of a setup that shares nothing with it */
export function copyOf(settings: FoveaFocusSettings): FoveaFocusSettings {
  const copy = Object.entries(settings).map(([key, value]): [string, unknown] => [key, Array.isArray(value) ? [...(value as unknown[])] : value]);
  return Object.fromEntries(copy) as unknown as FoveaFocusSettings;
}
