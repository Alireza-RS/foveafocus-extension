/**
 * SettingsValidator - Validates and sanitizes plugin settings
 *
 * PURPOSE
 * ───────
 * Ensures all settings loaded from data.json are valid and within acceptable ranges.
 * Prevents crashes from corrupted settings, invalid values, or missing properties.
 *
 * KEY RESPONSIBILITIES
 * ────────────────────
 * - Validate numeric ranges (WPM, fontSize, multipliers, etc.)
 * - Validate color formats (hex colors)
 * - Apply default values for missing properties
 * - Clamp out-of-range values instead of rejecting them
 * - Silent validation (no console logs per Obsidian guidelines)
 *
 * USAGE
 * ─────
 * ```typescript
 * // In plugin onload()
 * const rawSettings = await this.loadData();
 * const validSettings = validateSettings(rawSettings);
 * ```
 */

import { LIMITS as RANGES } from '../constants';
import { FoveaFocusSettings, DEFAULT_SETTINGS } from '../types';
import { PAUSES, type PauseKey } from './settings-model';

/**
 * Validation limits for numeric settings
 */
const LIMITS = { ...RANGES, accelerationTargetWpm: RANGES.wpm } as const;

/** The strongest a pause can be set, which is what the settings offer */
const strongest = (key: PauseKey): number => PAUSES.find((pause) => pause.key === key)?.max ?? 1;

/** The colours of the letter, the background and the text that the plugin used to start with */
const FIRST_RUN_COLOURS = '#4a9eff #1e1e1e #ffffff';

/**
 * Clamps a number between min and max values
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Validates a hex color string (#RRGGBB or #RGB)
 * Returns the color if valid, otherwise returns the default
 */
function validateColor(color: unknown, defaultColor: string): string {
  if (typeof color !== 'string') return defaultColor;
  const c = color.trim();
  if (c === '' || c.toLowerCase() === 'theme') return '';

  // Match #RGB or #RRGGBB format
  if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(c)) {
    return c;
  }

  return defaultColor;
}

/**
 * Validates a number and clamps it to the specified range
 */
function validateNumber(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || isNaN(value)) {
    return defaultValue;
  }
  return clamp(value, min, max);
}

/**
 * Validates a boolean value
 */
function validateBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return defaultValue;
}

/**
 * Validates a string value
 */
function validateString(value: unknown, defaultValue: string): string {
  if (typeof value === 'string') return value;
  return defaultValue;
}

/**
 * Validates a list of phrases: strings only, trimmed, no blanks
 */
function validateStringList(value: unknown, defaultValue: string[]): string[] {
  if (!Array.isArray(value)) return [...defaultValue];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

/**
 * Validates and sanitizes FoveaFocus settings
 *
 * @param partial - Partial settings object loaded from data.json
 * @returns Fully valid FoveaFocusSettings with defaults applied
 *
 * @example
 * ```typescript
 * const rawSettings = await this.loadData();
 * const validSettings = validateSettings(rawSettings);
 * this.settings = validSettings;
 * ```
 */
export function validateSettings(partial: Partial<FoveaFocusSettings> | null | undefined): FoveaFocusSettings {
  // Handle null/undefined by returning defaults
  if (!partial || typeof partial !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }

  const settings: FoveaFocusSettings = {
    // Numeric settings with range validation
    wpm: validateNumber(
      partial.wpm,
      DEFAULT_SETTINGS.wpm,
      LIMITS.wpm.min,
      LIMITS.wpm.max
    ),
    chunkSize: validateNumber(
      partial.chunkSize,
      DEFAULT_SETTINGS.chunkSize,
      LIMITS.chunkSize.min,
      LIMITS.chunkSize.max
    ),
    fontSize: validateNumber(
      partial.fontSize,
      DEFAULT_SETTINGS.fontSize,
      LIMITS.fontSize.min,
      LIMITS.fontSize.max
    ),
    autoStartDelay: validateNumber(
      partial.autoStartDelay,
      DEFAULT_SETTINGS.autoStartDelay,
      LIMITS.autoStartDelay.min,
      LIMITS.autoStartDelay.max
    ),
    accelerationDuration: validateNumber(
      partial.accelerationDuration,
      DEFAULT_SETTINGS.accelerationDuration,
      LIMITS.accelerationDuration.min,
      LIMITS.accelerationDuration.max
    ),
    accelerationTargetWpm: validateNumber(
      partial.accelerationTargetWpm,
      DEFAULT_SETTINGS.accelerationTargetWpm,
      LIMITS.accelerationTargetWpm.min,
      LIMITS.accelerationTargetWpm.max
    ),

    // Micropause multipliers
    micropausePunctuation: validateNumber(
      partial.micropausePunctuation,
      DEFAULT_SETTINGS.micropausePunctuation,
      1,
      strongest('micropausePunctuation')
    ),
    micropauseOtherPunctuation: validateNumber(
      partial.micropauseOtherPunctuation,
      DEFAULT_SETTINGS.micropauseOtherPunctuation,
      1,
      strongest('micropauseOtherPunctuation')
    ),
    micropauseLongWords: validateNumber(
      partial.micropauseLongWords,
      DEFAULT_SETTINGS.micropauseLongWords,
      1,
      strongest('micropauseLongWords')
    ),
    micropauseParagraph: validateNumber(
      partial.micropauseParagraph,
      DEFAULT_SETTINGS.micropauseParagraph,
      1,
      strongest('micropauseParagraph')
    ),
    micropauseNumbers: validateNumber(
      partial.micropauseNumbers,
      DEFAULT_SETTINGS.micropauseNumbers,
      1,
      strongest('micropauseNumbers')
    ),
    micropauseSectionMarkers: validateNumber(
      partial.micropauseSectionMarkers,
      DEFAULT_SETTINGS.micropauseSectionMarkers,
      1,
      strongest('micropauseSectionMarkers')
    ),
    micropauseListBullets: validateNumber(
      partial.micropauseListBullets,
      DEFAULT_SETTINGS.micropauseListBullets,
      1,
      strongest('micropauseListBullets')
    ),
    micropauseCallouts: validateNumber(
      partial.micropauseCallouts,
      DEFAULT_SETTINGS.micropauseCallouts,
      1,
      strongest('micropauseCallouts')
    ),
    micropauseHeadings: validateNumber(
      partial.micropauseHeadings,
      DEFAULT_SETTINGS.micropauseHeadings,
      1,
      strongest('micropauseHeadings')
    ),
    ownSelectionLength: validateNumber(
      partial.ownSelectionLength,
      DEFAULT_SETTINGS.ownSelectionLength,
      LIMITS.ownSelectionLength.min,
      LIMITS.ownSelectionLength.max
    ),
    mobileFontSize: validateNumber(
      partial.mobileFontSize,
      DEFAULT_SETTINGS.mobileFontSize,
      LIMITS.mobileFontSize.min,
      LIMITS.mobileFontSize.max
    ),
    minTokenFontSize: validateNumber(
      partial.minTokenFontSize,
      DEFAULT_SETTINGS.minTokenFontSize,
      LIMITS.minTokenFontSize.min,
      LIMITS.minTokenFontSize.max
    ),
    mobileWpm: validateNumber(
      partial.mobileWpm,
      DEFAULT_SETTINGS.mobileWpm,
      LIMITS.wpm.min,
      LIMITS.wpm.max
    ),
    mobileChunkSize: validateNumber(
      partial.mobileChunkSize,
      DEFAULT_SETTINGS.mobileChunkSize,
      LIMITS.chunkSize.min,
      LIMITS.chunkSize.max
    ),
    contextLines: validateNumber(
      (partial as any).contextLines,
      DEFAULT_SETTINGS.contextLines,
      LIMITS.contextLines.min,
      LIMITS.contextLines.max
    ),
    mobileContextLines: validateNumber(
      (partial as any).mobileContextLines,
      DEFAULT_SETTINGS.mobileContextLines,
      LIMITS.contextLines.min,
      LIMITS.contextLines.max
    ),
    contextFontSize: validateNumber(
      (partial as any).contextFontSize,
      DEFAULT_SETTINGS.contextFontSize,
      LIMITS.contextFontSize.min,
      LIMITS.contextFontSize.max
    ),
    mobileContextFontSize: validateNumber(
      (partial as any).mobileContextFontSize,
      DEFAULT_SETTINGS.mobileContextFontSize,
      LIMITS.contextFontSize.min,
      LIMITS.contextFontSize.max
    ),

    // Color settings
    highlightColor: validateColor(partial.highlightColor, DEFAULT_SETTINGS.highlightColor),
    backgroundColor: validateColor(partial.backgroundColor, DEFAULT_SETTINGS.backgroundColor),
    fontColor: validateColor(partial.fontColor, DEFAULT_SETTINGS.fontColor),

    // String settings
    fontFamily: validateString(partial.fontFamily, DEFAULT_SETTINGS.fontFamily),
    hotkeyPlay: validateString(partial.hotkeyPlay, DEFAULT_SETTINGS.hotkeyPlay),
    hotkeyRewind: validateString(partial.hotkeyRewind, DEFAULT_SETTINGS.hotkeyRewind),
    hotkeyForward: validateString(partial.hotkeyForward, DEFAULT_SETTINGS.hotkeyForward),
    hotkeyIncrementWpm: validateString(partial.hotkeyIncrementWpm, DEFAULT_SETTINGS.hotkeyIncrementWpm),
    hotkeyDecrementWpm: validateString(partial.hotkeyDecrementWpm, DEFAULT_SETTINGS.hotkeyDecrementWpm),
    hotkeyQuit: validateString(partial.hotkeyQuit, DEFAULT_SETTINGS.hotkeyQuit),

    // Boolean settings
    showContext: validateBoolean(partial.showContext, DEFAULT_SETTINGS.showContext),
    showOutline: validateBoolean(partial.showOutline, DEFAULT_SETTINGS.showOutline),
    enableMicropause: validateBoolean(partial.enableMicropause, DEFAULT_SETTINGS.enableMicropause),
    micropauseLongWordsGrow: validateBoolean(partial.micropauseLongWordsGrow, DEFAULT_SETTINGS.micropauseLongWordsGrow),
    pauseStacking: partial.pauseStacking === 'multiply' ? 'multiply' : 'add',
    largerHeadings: validateBoolean(partial.largerHeadings, DEFAULT_SETTINGS.largerHeadings),
    splitLongCompounds: validateBoolean(partial.splitLongCompounds, DEFAULT_SETTINGS.splitLongCompounds),
    autoStart: validateBoolean(partial.autoStart, DEFAULT_SETTINGS.autoStart),
    showProgress: validateBoolean(partial.showProgress, DEFAULT_SETTINGS.showProgress),
    enableSlowStart: validateBoolean(partial.enableSlowStart, DEFAULT_SETTINGS.enableSlowStart),
    enableAcceleration: validateBoolean(partial.enableAcceleration, DEFAULT_SETTINGS.enableAcceleration),
    mobileShowContext: validateBoolean(partial.mobileShowContext, DEFAULT_SETTINGS.mobileShowContext),
    mobileShowOutline: validateBoolean(partial.mobileShowOutline, DEFAULT_SETTINGS.mobileShowOutline),
    mobileEnableSlowStart: validateBoolean(partial.mobileEnableSlowStart, DEFAULT_SETTINGS.mobileEnableSlowStart),
    mobileEnableMicropause: validateBoolean(partial.mobileEnableMicropause, DEFAULT_SETTINGS.mobileEnableMicropause),

    // Filter settings
    skipCodeBlocks: validateBoolean(partial.skipCodeBlocks, DEFAULT_SETTINGS.skipCodeBlocks),
    skipTables: validateBoolean(partial.skipTables, DEFAULT_SETTINGS.skipTables),
    readInlineMaths: validateBoolean(partial.readInlineMaths, DEFAULT_SETTINGS.readInlineMaths),
    skipTagLines: validateBoolean(partial.skipTagLines, DEFAULT_SETTINGS.skipTagLines),
    skipLinkLines: validateBoolean(partial.skipLinkLines, DEFAULT_SETTINGS.skipLinkLines),
    skipReferences: validateBoolean(partial.skipReferences, DEFAULT_SETTINGS.skipReferences),
    noteExcludedSections: validateStringList(partial.noteExcludedSections, DEFAULT_SETTINGS.noteExcludedSections),
    pdfIncludeTitle: validateBoolean(partial.pdfIncludeTitle, DEFAULT_SETTINGS.pdfIncludeTitle),
    pdfIncludeCaptions: validateBoolean(partial.pdfIncludeCaptions, DEFAULT_SETTINGS.pdfIncludeCaptions),
    pdfSkipFrontMatter: validateBoolean(partial.pdfSkipFrontMatter, DEFAULT_SETTINGS.pdfSkipFrontMatter),
    pdfSkipFootnotes: validateBoolean(partial.pdfSkipFootnotes, DEFAULT_SETTINGS.pdfSkipFootnotes),
    pdfStopAtReferences: validateBoolean(partial.pdfStopAtReferences, DEFAULT_SETTINGS.pdfStopAtReferences),
    pdfExcludedSections: validateStringList(partial.pdfExcludedSections, DEFAULT_SETTINGS.pdfExcludedSections),
  };

  // The plugin used to fill in three colours at its first run. A setup that still holds
  // exactly those three has never chosen a colour: it takes the colours of the theme.
  const colours = [settings.highlightColor, settings.backgroundColor, settings.fontColor].join(' ').toLowerCase();
  if (colours === FIRST_RUN_COLOURS) {
    settings.highlightColor = '';
    settings.backgroundColor = '';
    settings.fontColor = '';
  }

  return settings;
}
