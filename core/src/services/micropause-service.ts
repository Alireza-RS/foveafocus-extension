/**
 * MicropauseService - Calculates reading delay multipliers based on word characteristics
 *
 * PURPOSE
 * ───────
 * Centralizes micropause logic using Strategy Pattern to eliminate duplication.
 * Previously duplicated across calculateDelay() and calculateAccurateRemainingTime().
 *
 * ARCHITECTURE
 * ────────────
 * Uses Strategy Pattern:
 * - Each micropause type is a strategy with getMultiplier(word) method
 * - MicropauseService orchestrates all strategies
 * - The pauses of a word add up: each adds its own share of a word's time, whatever else
 *   applies to the word (heading + punctuation + long word = 1 + 1.0 + 1.5 + 0.4). They can
 *   be set to multiply instead, which makes a pause the longer the more others it meets
 *
 * MICROPAUSE TYPES
 * ────────────────
 * 1. Headings [H1-H6] - Visual hierarchy (H1 as set, 2.0x at first; H2 to H6 by a share of it)
 * 2. Callouts [CALLOUT:type] - Obsidian callout blocks
 * 3. Section markers (1., 2.1, IV., a), (3)) - What counts off sections or items, first on its line
 * 4. List bullets (-, *, +, •) - A bullet on its own, first on its line
 * 5. Sentence punctuation (. ! ? …) - The end of a sentence, also inside closing quotes or brackets
 * 6. Other punctuation (; : ,) - Lighter pauses
 * 7. Numbers (contains digits) - Dates, stats, years
 * 8. Long words (>8 letters) - Longer words need more time: as much again for every four letters more,
 *    unless that is switched off
 * 9. Paragraph breaks (\n) - Section separators
 *
 * A pause goes by the word as it is read. The marker of a heading or callout is not part of
 * that word, so its figure does not make the word a number, nor its length a long word.
 * What counts off a section is neither the end of a sentence nor a number to be read.
 *
 * USAGE
 * ─────
 * ```typescript
 * const service = new MicropauseService(settings);
 * const multiplier = service.calculateMultiplier("Hello!", "And", false);
 * const delay = baseDelay * multiplier;
 * ```
 */

import { LINK } from '../constants';
import { FoveaFocusSettings } from '../types';

/** The marker the parser puts before the first word of a heading or of a callout's title */
const MARKER = /^\[(?:H\d|CALLOUT:[\w-]+)\]/;

/** Quotation marks and brackets that may close a sentence after its stop */
const CLOSERS = '["\'\u201D\u2019)\\]]*';
const STOP = new RegExp(`([.!?\u2026])${CLOSERS}$`);
const LESSER_STOP = new RegExp(`[;:,]${CLOSERS}$`);

/** Titles and shorthand that end in a stop and go on to a capital without ending a sentence */
const SHORTHAND = /^(?:dr|prof|mr|mrs|ms|st|mt|vs|cf|viz|ca|fig|figs|eq|eqs|ref|refs|approx)\.$/i;

/** The letters and figures of a word. The signs on it are not read, and do not make it longer. */
const LETTER = /[\p{L}\p{M}\p{N}]/gu;

/**
 * A word as the pauses see it
 */
interface PauseWord {
  /** The word as the engine holds it: with its marker, and with the line break that follows it */
  raw: string;
  /** The word as it is read: without marker or line break */
  read: string;
  /** The word that follows it on its line; empty at the end of the line */
  next: string;
  /** Whether it is the first word of its line */
  startsLine: boolean;
}

/** Whether a word counts off a section or the items of a list: "1.", "2.1", "IV.", "a)", "(3)" */
function countsOff(word: PauseWord): boolean {
  return word.startsLine && /^\(?(?:\d{1,3}(?:\.\d{1,3})+[.)]?|\d{1,3}[.)]|[IVXLCDM]+[.)]|[A-Za-z][.)])$/.test(word.read);
}

/**
 * Whether a sentence ends with a word. "!", "?" and an ellipsis end one wherever they stand, and
 * so does a full stop at the end of a line. Elsewhere a full stop ends a sentence only where
 * the next one begins: a small letter or a figure after it goes on with the sentence the
 * stop stands in ("e.g. in", "Fig. 2", "et al. (2020)"), and before a capital a run of
 * initials, a title or other shorthand does not end one either ("U.S. Senate", "Dr. Lee"). A
 * single letter with a stop is taken for the end of a sentence ("in group B. The"), which
 * it is more often than it is an initial.
 */
function endsSentence(word: PauseWord): boolean {
  const stop = STOP.exec(word.read);
  if (!stop) return false;
  if (stop[1] !== '.' || !word.next) return true;

  const first = word.next.replace(/^[("'\u201C\u2018[]+/, '').charAt(0);
  if (/\d/.test(first) || (first !== first.toUpperCase() && first === first.toLowerCase())) return false;

  const body = word.read.slice(0, stop.index + 1);
  return !(/^(?:[A-Za-z]\.){2,}$/.test(body) || SHORTHAND.test(body));
}

/**
 * Strategy interface for micropause calculation
 */
interface MicropauseStrategy {
  /**
   * Calculates the delay multiplier for a given word
   * @param word - The word to analyze
   * @returns Multiplier (1.0 = no pause, >1.0 = longer pause)
   */
  getMultiplier(word: PauseWord): number;
}

/**
 * Strategy for heading markers [H1], [H2], etc.
 * The multiplier is that of a first-level heading; a lower heading adds a share of what
 * that one adds, for visual hierarchy.
 */
class HeadingStrategy implements MicropauseStrategy {
  private static readonly SHARES = [0, 1, 0.8, 0.5, 0.3, 0.2, 0.1];

  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    const match = word.raw.trim().match(/^\[H(\d)\]/);
    if (!match) return 1.0;

    const level = parseInt(match[1]);
    return 1 + (this.multiplier - 1) * (HeadingStrategy.SHARES[level] ?? 0.5);
  }
}

/**
 * Strategy for Obsidian callouts [CALLOUT:type]
 */
class CalloutStrategy implements MicropauseStrategy {
  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    return /^\[CALLOUT:[\w-]+\]/.test(word.raw.trim()) ? this.multiplier : 1.0;
  }
}

/**
 * Strategy for section markers (1., 2.1, IV., a), (3)) at the start of a line
 */
class SectionMarkerStrategy implements MicropauseStrategy {
  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    return countsOff(word) ? this.multiplier : 1.0;
  }
}

/**
 * Strategy for list bullets (-, *, +, •): a bullet on its own at the start of a line
 */
class ListBulletStrategy implements MicropauseStrategy {
  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    return word.startsLine && /^[-*+\u2022]$/.test(word.read) ? this.multiplier : 1.0;
  }
}

/**
 * Strategy for the end of a sentence
 */
class SentencePunctuationStrategy implements MicropauseStrategy {
  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    return !countsOff(word) && endsSentence(word) ? this.multiplier : 1.0;
  }
}

/**
 * Strategy for other punctuation (;:,), also inside closing quotes or brackets
 */
class OtherPunctuationStrategy implements MicropauseStrategy {
  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    return LESSER_STOP.test(word.read) ? this.multiplier : 1.0;
  }
}

/**
 * Strategy for words containing numbers
 */
class NumberStrategy implements MicropauseStrategy {
  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    return !countsOff(word) && /\d/.test(word.read) ? this.multiplier : 1.0;
  }
}

/**
 * Strategy for long words (more than 8 letters). The longer the word, the longer it is held:
 * the pause of a word of 9 to 12 letters, and as much again for every four letters more, up
 * to 40. What is longer than that is no word to be read letter by letter (a sequence, an
 * identifier) and is held as a word of 40 is; nor is a link, held as a word of 9 to 12 is.
 * With the growth switched off, every long word is held as one of 9 to 12 letters is.
 */
class LongWordStrategy implements MicropauseStrategy {
  constructor(private multiplier: number, private grows: boolean) {}

  getMultiplier(word: PauseWord): number {
    const letters = word.read.match(LETTER)?.length ?? 0;
    if (letters <= 8) return 1.0;
    const steps = !this.grows || LINK.test(word.read) ? 1 : Math.min(Math.ceil((letters - 8) / 4), 8);
    return 1 + (this.multiplier - 1) * steps;
  }
}

/**
 * Strategy for paragraph breaks (line breaks)
 */
class ParagraphBreakStrategy implements MicropauseStrategy {
  constructor(private multiplier: number) {}

  getMultiplier(word: PauseWord): number {
    return word.raw.includes('\n') ? this.multiplier : 1.0;
  }
}

/**
 * MicropauseService orchestrates all micropause strategies
 */
export class MicropauseService {
  private strategies: MicropauseStrategy[] = [];
  private enabled = true;
  private adds = true;

  constructor(settings: FoveaFocusSettings, enabledOverride?: boolean) {
    this.updateSettings(settings, enabledOverride);
  }

  /**
   * Calculates the total multiplier for a word
   * Applies all strategies and adds up what each holds the word longer by, or multiplies
   * the multipliers where the settings ask for that
   *
   * @param word - The word to analyze, with its marker if it has one, and with the line break after it if its line ends there
   * @param next - The word that follows it on its line; empty at the end of the line
   * @param startsLine - Whether the word is the first of its line
   * @returns Total multiplier (1.0 = no pause, >1.0 = longer pause)
   *
   * @example
   * ```typescript
   * const service = new MicropauseService(settings);
   *
   * service.calculateMultiplier("Hello");          // 1.0 (no special characteristics)
   * service.calculateMultiplier("Hello!", "And");  // 2.5 (sentence punctuation)
   * service.calculateMultiplier("e.g.", "in");     // 1.0 (the sentence goes on)
   * service.calculateMultiplier("[H1]Title");      // 2.0 (heading)
   * service.calculateMultiplier("Hello!\n");       // 4.0 (1 + 1.5 + 1.5 = punctuation and paragraph)
   * ```
   */
  calculateMultiplier(word: string, next = '', startsLine = false): number {
    if (!this.enabled) return 1.0;

    const seen: PauseWord = { raw: word, read: word.trim().replace(MARKER, ''), next, startsLine };
    let totalMultiplier = 1.0;

    // Each strategy adds its own share of a word's time, or multiplies what the others make of it
    for (const strategy of this.strategies) {
      const multiplier = strategy.getMultiplier(seen);
      totalMultiplier = this.adds ? totalMultiplier + multiplier - 1 : totalMultiplier * multiplier;
    }

    return totalMultiplier;
  }

  /**
   * Updates service with new settings
   * Recreates strategies with updated multipliers
   *
   * @param settings - New settings
   */
  updateSettings(settings: FoveaFocusSettings, enabledOverride?: boolean): void {
    this.enabled = enabledOverride ?? settings.enableMicropause;
    this.adds = settings.pauseStacking !== 'multiply';

    // All strategies in detection order: headings first, then callouts, then markers, etc.
    this.strategies = [
      new HeadingStrategy(settings.micropauseHeadings),
      new CalloutStrategy(settings.micropauseCallouts),
      new SectionMarkerStrategy(settings.micropauseSectionMarkers),
      new ListBulletStrategy(settings.micropauseListBullets),
      new SentencePunctuationStrategy(settings.micropausePunctuation),
      new OtherPunctuationStrategy(settings.micropauseOtherPunctuation),
      new NumberStrategy(settings.micropauseNumbers),
      new LongWordStrategy(settings.micropauseLongWords, settings.micropauseLongWordsGrow),
      new ParagraphBreakStrategy(settings.micropauseParagraph)
    ];
  }
}
