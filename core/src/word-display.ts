/**
 * WordDisplay - Manages word display with highlighting and formatting
 *
 * Responsibilities:
 * - Display words with center character highlighting
 * - Handle heading display with dynamic font sizes
 * - Handle callout display with icons
 * - Show visual separators before headings
 * - Escape HTML to prevent XSS
 * - Fit the focus band to the font, and every word into the band
 */

import { FoveaFocusSettings } from './types';
import { calloutLook, drawCalloutIcon } from './callout-icon';
import { FOCUS_BAND, HEADING_MULTIPLIERS, ICONS, LIMITS, LINK } from './constants';
import { setIcon } from "obsidian";

/** The letters and figures by which the height of a font is taken */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Font size in pixels at which text is measured */
const RULER_SIZE = 1000;

/**
 * A piece of a word between the signs it can be parted at: hyphens, dashes and slashes. The
 * signs that follow a piece stay with it, and so do signs the word begins with.
 */
const PIECE = /[-\u2010-\u2015/]*[^-\u2010-\u2015/]+[-\u2010-\u2015/]*/g;

/** A word made smaller than this part of its size, to fit the area, is shown in parts where it can be parted */
const SMALLEST_WHOLE = 0.5;

/** How a word is drawn: its step up from the size of the text, its weight, and what stands before it */
interface Look {
  multiplier: number;
  weight: string;
  showSeparator: boolean;
  calloutType?: string;
}

/** A word as it has been drawn, with what is needed to fit it into the area */
interface Drawn {
  text: string;
  look: Look;
  wordContainer: HTMLElement;
  viewport: HTMLElement;
  line: HTMLElement;
  focusWordEl: HTMLElement | null;
  orpEl: HTMLElement | null;
  /** The font size the word is set at before it is fitted across the area */
  size: number;
}

/**
 * The turn of a word while the reading runs: whether it still lasts, and, for a word shown
 * in parts with these shares of its time, how long each part is on show in milliseconds.
 */
export interface Turn {
  lasts: () => boolean;
  times: (shares: number[]) => number[];
}

interface CharacterSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}
const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => CharacterSegmenter }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** For a browser without a segmenter: a character, in one or two code units, with the marks set on it */
const CHARACTER = /(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S])[\u0300-\u036F\u20D0-\u20F0\uFE00-\uFE0F\u200D]*/g;

/**
 * Splits text into what a reader takes for single characters: a letter together with the
 * marks set on it, and a character that the text stores in two code units, in one piece.
 */
function characters(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
  return text.match(CHARACTER) ?? [];
}

export class WordDisplay {
  private wordEl: HTMLElement;
  private settings: FoveaFocusSettings;
  private overlayEl: HTMLElement;
  private contentEl: HTMLElement;
  private focusLinesEl: HTMLElement;
  private focusDashesEl: HTMLElement;
  private baseFontSizePx: number;
  private baseChunkSize: number;

  /** Measures text in the reader's font; null where the browser has no means to */
  private ruler: CanvasRenderingContext2D | null = null;

  /** The font, font size and window height the band was last fitted to */
  private fittedTo = '';

  /** The font size of the text: the size set, or less where the window is too low for it */
  private textSize: number;

  /** The height of the band in pixels, and the most it may have in a window that has not the room for its share */
  private band = 0;
  private held = Infinity;

  /** How far the letters of the font reach above and below the baseline, as parts of the font size */
  private reach = { up: 0.74, down: 0.22 };

  /**
   * Room in pixels from the middle of the band to the end of a tick, and to a line, less the
   * pixels to spare. Until the band is fitted there is nothing to hold a word to.
   */
  private room = { ticks: Infinity, lines: Infinity };

  /** The size words are shown at, by their step up from the text; worked out once for a fitted band */
  private sizes = new Map<number, number>();

  /** Whether the text is, in the main, in a script written from right to left */
  private rightToLeft = false;

  /** The share of the area that lies before the focus mark, on the side a word starts from */
  private lead = 0.48;

  /** The word on show, kept so that it can be drawn again when the font or its size changes */
  private shown: { word: string; headingLevel: number; showSeparator: boolean; calloutType?: string; opensTitle: boolean } | null = null;

  /** The timers of the parts still to come of a word that is being shown in parts */
  private partsToCome: number[] = [];

  /** Whether a part of the word stands in the area, not the word itself */
  private inParts = false;

  constructor(wordEl: HTMLElement, settings: FoveaFocusSettings, baseFontSizePx: number, baseChunkSize: number) {
    this.wordEl = wordEl;
    this.settings = settings;

    // Build a permanent overlay + a content host so focus bars never get removed
    this.wordEl.empty();
    this.wordEl.style.position = 'relative';
    this.wordEl.setAttribute('data-running', 'false'); // prevents focus-bar flash on first paint
    this.baseFontSizePx = baseFontSizePx;
    this.textSize = baseFontSizePx;
    this.baseChunkSize = Math.max(1, baseChunkSize);
    this.overlayEl = this.wordEl.createDiv({ cls: 'foveafocus-focus-overlay' });
    this.focusLinesEl = this.overlayEl.createDiv({ cls: 'foveafocus-focus-lines' });
    this.focusDashesEl = this.overlayEl.createDiv({ cls: 'foveafocus-focus-dashes' });

    this.contentEl = this.wordEl.createDiv({ cls: 'foveafocus-word-content' });

    // default (single-word) focus position: near center
    this.wordEl.style.setProperty('--foveafocus-focus-left', '48%');
    this.fitBand();
  }

  public setBaseFontSize(px: number): void {
    this.baseFontSizePx = px;
    this.redraw();
  }

  /**
   * Sets the side the reading starts from, by the letters of the text. For a text that is in
   * the main in a script written from right to left, the focus mark and the room for the
   * words that follow change sides. It is settled once for the text, so the mark stays put.
   */
  public setDirectionFrom(text: string): void {
    // The markers of headings and callouts are not letters of the text
    const read = text.replace(/\[H\d\]|\[CALLOUT:[\w-]+\]/g, '');
    const count = (letters: RegExp): number => (read.match(letters) ?? []).length;
    this.rightToLeft = count(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/g) > count(/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u052F]/g);
    this.wordEl.toggleClass('foveafocus-rtl', this.rightToLeft);
  }

  /**
   * Fits the band again and redraws the word. For what the reader cannot see for itself: a
   * font that has only now loaded, which gives the letters another height, and a window that
   * has changed its size.
   */
  public refresh(): void {
    this.fittedTo = '';
    this.redraw();
  }

  /**
   * Brings the band down by a number of pixels and holds it there, for a window too low for
   * the reader with the band at its share of the height. Says whether the text can be made
   * smaller still: at the smallest font size the band has no more to give.
   */
  public lowerBand(px: number): boolean {
    this.held = Math.max(1, Math.min(this.held, this.band) - px);
    this.refresh();
    return this.textSize > LIMITS.fontSize.min;
  }

  /** Lets the band take its share of the height of the window again */
  public freeBand(): void {
    if (this.held === Infinity) return;
    this.held = Infinity;
    this.refresh();
  }

  private redraw(): void {
    this.fitBand();
    if (this.shown) this.displayWord(this.shown.word, this.shown.headingLevel, this.shown.showSeparator, this.shown.calloutType, this.shown.opensTitle);
  }

  /** Shows whole a word of which a part is on show: for a reading that stops on the word */
  public showWhole(): void {
    if (this.inParts) this.redraw();
  }

  /**
   * Fits the band to the font and the font size in use.
   *
   * The band belongs to the settings, not to the word: it is as tall as the letters of this
   * font need at this size, and it stays as it is from word to word, so that nothing moves
   * while reading. A word that needs more room than the band has is made smaller instead.
   */
  private fitBand(): void {
    const family = getComputedStyle(this.wordEl).fontFamily;
    const windowHeight = this.wordEl.ownerDocument.defaultView?.innerHeight ?? 0;
    const key = `${family}|${this.baseFontSizePx}|${windowHeight}`;
    if (!family || key === this.fittedTo) return;
    this.fittedTo = key;

    const rise = this.measureFont(family);
    // The height of the band as a part of the font size: the letters, clear room above and
    // below them, and the two ticks.
    const letters = this.reach.up + this.reach.down;
    const height = letters + 2 * FOCUS_BAND.clearance + 2 * FOCUS_BAND.tickRatio;

    // The band takes no more than its share of the height of the window, nor more than the
    // reader has found room for in a low one. A font size that asks for more is brought down
    // to the largest that fits, for every word alike.
    const most = Math.min(windowHeight * FOCUS_BAND.share, this.held);
    const size = most > 0 && height * this.baseFontSizePx > most
      ? Math.min(this.baseFontSizePx, Math.max(LIMITS.fontSize.min, most / height))
      : this.baseFontSizePx;
    this.textSize = size;

    // The clear room never falls under the pixels kept to spare, or the text itself would
    // have to give way at the smallest sizes. Nor does it fall under what the line under the
    // letter needs, which reaches below the letters in a font that has no tails to speak of.
    const tick = Math.round(size * FOCUS_BAND.tickRatio);
    const under = this.underlineAt(size) - this.reach.down * size;
    const clear = Math.max(size * FOCUS_BAND.clearance, FOCUS_BAND.spare + 1, under + FOCUS_BAND.spare + 1);
    const band = 2 * Math.round((letters * size + 2 * clear + 2 * tick) / 2);
    const line = parseFloat(getComputedStyle(this.focusLinesEl).borderTopWidth) || 0;
    this.band = band;
    this.room = { ticks: band / 2 - tick - FOCUS_BAND.spare, lines: band / 2 - line - FOCUS_BAND.spare };
    this.sizes.clear();
    this.wordEl.setCssProps({
      '--foveafocus-focus-band': `${band}px`,
      '--foveafocus-focus-tick': `${tick}px`,
      '--foveafocus-ink-rise': rise.toFixed(3),
    });
  }

  /**
   * Takes the measures of the font: how far its letters and figures reach above and below
   * the baseline, and by how much of the font size text has to be raised for the letters to
   * stand in the middle of their line. The browser centres a line on the ascent and descent
   * that the font declares, which leave more room over the letters than under them in most
   * fonts, and less in some.
   */
  private measureFont(family: string): number {
    const ruler = this.ruler ?? (this.ruler = this.wordEl.ownerDocument.createElement('canvas').getContext('2d'));
    if (!ruler) return 0;

    let up = 0;
    let down = 0;
    let lineMiddle = NaN;
    // The heavier weight comes last: the ruler keeps it for the words it measures later.
    for (const weight of [500, 700]) {
      ruler.font = `${weight} ${RULER_SIZE}px ${family}`;
      const letters = ruler.measureText(LETTERS);
      up = Math.max(up, letters.actualBoundingBoxAscent);
      down = Math.max(down, letters.actualBoundingBoxDescent);
      if (weight === 500) lineMiddle = (letters.fontBoundingBoxAscent - letters.fontBoundingBoxDescent) / 2;
    }
    if (!(up > 0)) return 0;

    this.reach = { up: up / RULER_SIZE, down: down / RULER_SIZE };
    const rise = (lineMiddle - (up - down) / 2) / RULER_SIZE;
    return isFinite(rise) ? rise : 0;
  }

  /** How far under the baseline the line under the letter the eye rests on ends, at a font size */
  private underlineAt(size: number): number {
    const probe = this.contentEl.createSpan({ cls: 'foveafocus-highlight' });
    probe.style.fontSize = `${size}px`;
    const style = getComputedStyle(probe);
    const foot = (parseFloat(style.textUnderlineOffset) || 0) + (parseFloat(style.textDecorationThickness) || 0);
    probe.remove();
    return foot;
  }

  /**
   * The size a heading or a callout is shown at: its step up from the size of the text, as
   * far as the letters, and the line under the one the eye rests on, still stand clear of
   * the ticks.
   */
  private sizeFor(multiplier: number): number {
    const known = this.sizes.get(multiplier);
    if (known !== undefined) return known;

    let size = Math.min(this.textSize * multiplier, (2 * this.room.ticks) / (this.reach.up + this.reach.down));
    // The letters stand in the middle of the band, so the baseline lies this far under it
    const baseline = (this.reach.up - this.reach.down) / 2;
    const underline = this.underlineAt(size);
    if (baseline > 0 && baseline * size + underline > this.room.ticks) {
      size = Math.max(Math.min(size, this.textSize), (this.room.ticks - underline) / baseline);
    }
    this.sizes.set(multiplier, size);
    return size;
  }

  /**
   * The largest size, no larger than the one wanted, at which this text stays inside the
   * band. Letters and figures do, by the way the band is fitted. Anything else (a bracket, a
   * capital with an accent, a sign taken from another font) is measured: it may reach as far
   * as the lines, and where the eye rests only as far as the ticks.
   */
  private sizeThatFits(text: string, orp: string, wanted: number): number {
    const ruler = this.ruler;
    if (!ruler || !/[^A-Za-z0-9\s]/.test(text)) return wanted;

    // The letters stand in the middle of the band, so the baseline lies this far under it
    const baseline = (this.reach.up - this.reach.down) / 2;
    let size = wanted;
    const hold = (part: string, room: number): void => {
      const ink = ruler.measureText(part);
      const up = ink.actualBoundingBoxAscent / RULER_SIZE - baseline;
      const down = ink.actualBoundingBoxDescent / RULER_SIZE + baseline;
      if (up > 0) size = Math.min(size, room / up);
      if (down > 0) size = Math.min(size, room / down);
    };
    hold(text, this.room.lines);
    if (/[^A-Za-z0-9]/.test(orp)) hold(orp, this.room.ticks);
    return size;
  }

  public setChunkSize(n: number): void {
    this.baseChunkSize = Math.max(1, n);
  }

  /**
   * Updates settings (when user changes font size, etc.)
   *
   * @param settings - New settings to apply
   */
  updateSettings(settings: FoveaFocusSettings): void {
    this.settings = settings;
  }

  /**
   * Displays a word with optional heading level or callout type
   * Handles font size adjustment, icons, and separators
   *
   * @param word - The word to display
   * @param headingLevel - Heading level (1-6) or 0 for normal text/callouts
   * @param showSeparator - Whether to show separator line before heading/callout
   * @param calloutType - Callout type (note, abstract, info, etc.) if this is a callout
   * @param opensTitle - Whether the word is the first of its title: a callout's icon stands before that word alone
   * @param turn - The turn of the word while the reading runs: a word too long for the area can then be shown in parts
   */
  displayWord(word: string, headingLevel: number, showSeparator: boolean = false, calloutType?: string, opensTitle: boolean = true, turn?: Turn): void {
    this.dropParts();
    this.shown = { word, headingLevel, showSeparator, calloutType, opensTitle };
    this.fitBand();

    // Calculate font size based on heading level or callout
    let fontSizeMultiplier = 1.0;
    let fontWeight = 'normal';

    if (calloutType) {
      // Callouts: slightly larger font, with the icon of their type in front
      fontSizeMultiplier = 1.2;
      fontWeight = 'bold';
    } else if (headingLevel > 0) {
      // Headings: size based on level
      const multipliers = [
        0,
        HEADING_MULTIPLIERS.h1,
        HEADING_MULTIPLIERS.h2,
        HEADING_MULTIPLIERS.h3,
        HEADING_MULTIPLIERS.h4,
        HEADING_MULTIPLIERS.h5,
        HEADING_MULTIPLIERS.h6
      ];
      fontSizeMultiplier = multipliers[headingLevel] || 1.0;
      fontWeight = 'bold';
    }

    // With larger headings switched off, a title is told from the text by its weight alone
    if (!this.settings.largerHeadings) fontSizeMultiplier = 1.0;

    const cleaned = this.stripMarkers(word).trim();

    // Focus position depends ONLY on configured chunk size (stationary for a fixed setting)
    const chunkSize = Math.max(1, this.baseChunkSize || 1);

    // 1 word => near centre, 2/3/4... progressively more left, capped at 6+
    const center = 48;
    const left = 15;
    const maxChunkForFullShift = 5;

    const t = Math.min(1, Math.max(0, (chunkSize - 1) / (maxChunkForFullShift - 1)));
    const focus = center - t * (center - left);
    this.lead = focus / 100;

    this.wordEl.style.setProperty('--foveafocus-focus-left', `${this.rightToLeft ? 100 - focus : focus}%`);
    this.wordEl.setAttribute('data-running', 'true');

    // Remove any old welcome/ready nodes that were appended to wordEl in older versions
    this.wordEl
      .querySelectorAll('.foveafocus-welcome-message, .foveafocus-ready-message')
      .forEach(el => el.remove());

    const drawn = this.draw(cleaned, { multiplier: fontSizeMultiplier, weight: fontWeight, showSeparator, calloutType: opensTitle ? calloutType : undefined });

    // Defer measurement until layout is available. The frames are those of the window the word
    // stands in, which is not the main window where the settings are open in a window of their own.
    const frame = (run: () => void): void => {
      (this.wordEl.ownerDocument.defaultView ?? window).requestAnimationFrame(run);
    };
    frame(() => {
      if (drawn.viewport.clientWidth > 0) this.settle(drawn, turn);
      else frame(() => this.settle(drawn, turn));
    });
  }

  /**
   * Draws a word into the area, in place of what stands there, at the size its kind and its
   * letters allow. It is not yet fitted across the area, nor is its letter on the mark.
   */
  private draw(text: string, look: Look): Drawn {
    // Clear and rebuild using DOM API (not innerHTML)
    this.contentEl.empty();

    // Add separator if needed
    if (look.showSeparator) {
      this.contentEl.createDiv({ cls: 'foveafocus-heading-separator' });
    }

    // Create word container
    const wordContainer = this.contentEl.createDiv({ cls: 'foveafocus-word-with-heading' });
    wordContainer.style.fontWeight = look.weight;

    // ORP viewport + line (measured + shifted)
    // Use a dedicated viewport so ORP anchoring is stable frame-to-frame.
    const viewport = wordContainer.createDiv({ cls: 'foveafocus-orp-viewport' });
    // The words of a chunk follow one another in the direction of its own first letters
    const line = viewport.createDiv({ cls: 'foveafocus-orp-line', attr: { dir: 'auto' } });

    const chunkMode = (this.baseChunkSize || 1) > 1;
    const orpEl = (chunkMode && /\s/.test(text))
      ? this.buildChunkSpans(line, text)
      : this.buildWordSpans(line, text);

    const focusWordEl = line.querySelector('.foveafocus-focus-word') as HTMLElement | null;

    const size = this.sizeThatFits(text, orpEl?.textContent ?? '', this.sizeFor(look.multiplier));
    wordContainer.style.fontSize = `${size}px`;

    // A callout's title opens with the icon Obsidian gives its type. The icon is part of the
    // first word, so that it stays on the word's line, shrinks with a long word and is kept in
    // view with it.
    if (look.calloutType) {
      const holder = focusWordEl ?? line;
      const icon = holder.createSpan({ cls: 'foveafocus-callout-icon' });
      holder.prepend(icon);
      drawCalloutIcon(icon, calloutLook(look.calloutType, this.contentEl));
    }

    return { text, look, wordContainer, viewport, line, focusWordEl, orpEl, size };
  }

  /**
   * Fits a drawn word across the area and puts its letter on the mark. While the reading
   * runs, a word that would have to be made smaller than half its size, or that fits the
   * area at no size, is shown in parts instead where it can be parted.
   */
  private settle(drawn: Drawn, turn?: Turn): void {
    const { wordContainer, viewport, line, focusWordEl, orpEl, size, text } = drawn;
    // Reset to intended size first
    wordContainer.style.fontSize = `${size}px`;

    // Only shrink for a single token (no whitespace) and not for line breaks
    if (text !== '\n') {
      const minSize = Math.max(8, this.settings.minTokenFontSize || 12);
      const applied = this.shrinkFocusWordToFit(viewport, line, focusWordEl, orpEl, size, minSize);

      if (turn?.lasts() && this.settings.splitLongCompounds && focusWordEl && orpEl && (applied < size * SMALLEST_WHOLE || !this.fits(viewport, focusWordEl, orpEl))) {
        // Of several words shown together, the one the eye rests on is parted
        const [word, ...sequel] = text.split(/\s+/);
        const pieces = LINK.test(word) ? [] : word.match(PIECE) ?? [];
        if (pieces.length > 1) {
          this.showInParts(pieces, sequel.join(' '), drawn.look, turn);
          return;
        }
      }
    }

    // After any shrink, anchor ORP
    this.applyOrpAnchoring(line, orpEl);
  }

  /**
   * Shows a word part by part over its turn, in place of the whole word made very small.
   *
   * The word is parted at its hyphens, dashes and slashes, into as few parts as fit the
   * area at the size of the text; each part but the last ends in the sign it was parted at,
   * which says that the word goes on. A part that is one piece too long for the area is
   * made smaller as any long word is. What stands before the word, the icon of a callout
   * or a separator, stands before its first part, and the words shown after it come with
   * its last.
   *
   * The parts share the time of the word by their length, with something over, so that a
   * short part is not gone before it is seen. A reading that stops on the word shows it
   * whole: at once where the reader says so (`showWhole()`), and when the next part falls
   * due at the latest.
   */
  private showInParts(pieces: string[], sequel: string, look: Look, turn: Turn): void {
    const later: Look = { ...look, showSeparator: false, calloutType: undefined };
    const fitsWhole = (text: string, first: boolean): boolean => {
      const { viewport, focusWordEl, orpEl } = this.draw(text, first ? look : later);
      return !focusWordEl || !orpEl || this.fits(viewport, focusWordEl, orpEl);
    };

    const parts: string[] = [];
    let part = '';
    for (const piece of pieces) {
      if (part === '' || fitsWhole(part + piece, parts.length === 0)) {
        part += piece;
      } else {
        parts.push(part);
        part = piece;
      }
    }
    parts.push(part);

    const times = turn.times(parts.map((text) => 8 + characters(text).length));
    const show = (index: number): void => {
      const text = sequel && index === parts.length - 1 ? `${parts[index]} ${sequel}` : parts[index];
      this.settle(this.draw(text, index === 0 ? look : later));
    };
    this.inParts = true;

    show(0);
    let due = 0;
    for (let index = 1; index < parts.length; index++) {
      due += times[index - 1];
      this.partsToCome.push(window.setTimeout(() => {
        if (!this.wordEl.isConnected) return;
        if (turn.lasts()) show(index);
        else this.redraw();
      }, due));
    }
  }

  /** Gives up the parts of a word that is being shown in parts */
  private dropParts(): void {
    for (const timer of this.partsToCome) window.clearTimeout(timer);
    this.partsToCome = [];
    this.inParts = false;
  }

  private stripMarkers(rawWord: string): string {
    return rawWord.replace(/^\[H\d\]/, '').replace(/^\[CALLOUT:[\w-]+\]/, '');
  }

  private renderIcon(into: HTMLElement, icon: string): void {
    if (icon.startsWith("lucide:")) setIcon(into, icon.slice("lucide:".length));
    else into.setText(icon);
  }

  /**
   * The place in a word of the letter the eye rests on, counted in characters as a reader
   * sees them: one place further in for every four characters the word has, which keeps the
   * letter a little under a third of the way into the word. Up to 17 characters this is the
   * table of the Squirt reader (squirtSquirt.js, getORPIndex). That table ends at the fifth
   * letter, which leaves nearly all of a long word on one side of the mark; here the step
   * carries on, though no further into the word than the mark stands into the area, so
   * that what comes before the letter has its room there.
   */
  private getORPIndex(str: string[]): number {
    const len = str.length;
    if (len <= 0) return 0;

    let point = Math.min(Math.floor((len + 2) / 4), Math.max(4, Math.floor(this.lead * len)));

    if (!this.readAsLetter(str[point])) {
      if (this.readAsLetter(str[point - 1])) point--;
      else if (this.readAsLetter(str[point + 1])) point++;
    }

    if (point < 0) point = 0;
    if (point >= str.length) point = str.length - 1;
    return point;
  }

  /** A letter or a figure, which the eye can rest on, as against a sign */
  private readAsLetter(ch: string | undefined): boolean {
    return !!ch && (/\d/.test(ch) || ch.toLowerCase() !== ch.toUpperCase());
  }

  /**
   * Builds the word into `lineEl` and returns the ORP span.
   *
   * The word is three runs of ordinary text: what stands before the letter the eye rests on,
   * that letter, and what follows it. Within a run the browser sets the text as it would
   * anywhere, so letters that join stay joined, a mark stays on its letter, and a script
   * that runs from right to left is set that way.
   */
  private buildFocusWord(lineEl: HTMLElement, word: string): HTMLElement | null {
    const parts = characters(word);
    if (parts.length === 0) return null;

    const focusWordEl = lineEl.createSpan({ cls: 'foveafocus-focus-word', attr: { dir: 'auto' } });
    const orpIndex = this.getORPIndex(parts);
    const before = parts.slice(0, orpIndex).join('');
    const after = parts.slice(orpIndex + 1).join('');

    if (before) focusWordEl.createSpan({ text: before });
    const orpEl = focusWordEl.createSpan({ text: parts[orpIndex], cls: 'foveafocus-highlight foveafocus-orp' });
    if (after) focusWordEl.createSpan({ text: after });
    return orpEl;
  }

  private buildWordSpans(lineEl: HTMLElement, displayWord: string): HTMLElement | null {
    lineEl.empty();
    if (!displayWord || displayWord === '\n') return null;

    return this.buildFocusWord(lineEl, displayWord);
  }

  private buildChunkSpans(lineEl: HTMLElement, chunkText: string): HTMLElement | null {
    lineEl.empty();
    if (!chunkText || chunkText === '\n') return null;

    const parts = chunkText.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;

    const main = parts[0];
    const sequel = parts.slice(1).join(' ');

    const orpEl = this.buildFocusWord(lineEl, main);

    if (sequel.length) {
      // Hard space that won’t collapse / disappear inside an inline-flex row
      lineEl.appendChild(document.createTextNode('\u00A0'));
      lineEl.createSpan({ text: sequel, cls: 'foveafocus-inline-context' });
    }

    return orpEl;
  }

  /** Where the focus mark stands across the window */
  private focusX(): number {
    const mark = this.focusDashesEl.getBoundingClientRect();
    return mark.left + mark.width / 2;
  }

  /**
   * Applies ORP anchoring by measuring the ORP span and shifting the whole line, so that the
   * middle of the span comes to stand on the focus mark.
   */
  private applyOrpAnchoring(lineEl: HTMLElement, orpEl: HTMLElement | null): void {
    lineEl.style.transform = 'translateX(0px)';
    if (!orpEl) return;

    const orp = orpEl.getBoundingClientRect();
    const delta = this.focusX() - (orp.left + orp.width / 2);
    lineEl.style.transform = `translateX(${Math.round(delta)}px)`;
    this.keepWordClearOfFade(lineEl, orpEl);
  }

  /**
   * The area fades out towards the side on which the words that follow lie. The word the eye
   * rests on is not one of them: where it stands inside the area, the fade begins no sooner
   * than the word ends. A word too long for the area at the smallest size, and a link too
   * long for it, run out into the fade as the words after them do.
   */
  private keepWordClearOfFade(lineEl: HTMLElement, orpEl: HTMLElement): void {
    const viewportEl = lineEl.parentElement;
    const focusWordEl = orpEl.parentElement;
    if (!viewportEl || !focusWordEl) return;

    const viewport = viewportEl.getBoundingClientRect();
    const word = focusWordEl.getBoundingClientRect();
    const reach = this.rightToLeft ? viewport.right - word.left : word.right - viewport.left;
    if (viewport.width <= 0 || reach > viewport.width + 1) return;

    const share = Math.min(100, Math.ceil((reach / viewport.width) * 1000) / 10);
    viewportEl.setCssProps({ '--foveafocus-word-end': `${share}%` });
  }

  /**
   * Binary-search shrink for a single token if it overflows the viewport, down to the
   * smallest size in the settings. A link keeps its size. A word that still does not fit
   * is given another letter to rest on, so that it starts inside the area; where even its
   * first letter leaves its start out, with the icon of a callout before it, the word is
   * made smaller until its start is inside. Returns the font size actually applied.
   */
  private shrinkFocusWordToFit(
    viewportEl: HTMLElement,
    lineEl: HTMLElement,
    focusWordEl: HTMLElement | null,
    orpEl: HTMLElement | null,
    startSize: number,
    minSize: number
  ): number {
    if (!focusWordEl || !orpEl) return startSize;

    const prevTransition = focusWordEl.style.transition;
    focusWordEl.style.transition = 'none';

    const fitsFocusWord = (): boolean => this.fits(viewportEl, focusWordEl, orpEl);

    // Reset focus word to requested size
    focusWordEl.style.fontSize = `${startSize}px`;
    lineEl.getBoundingClientRect();

    if (fitsFocusWord()) {
      focusWordEl.style.transition = prevTransition;
      return startSize;
    }

    // The largest size, from the smallest in the settings up to a given one, at which a test holds
    const largest = (holds: () => boolean, top: number): number => {
      let lo = Math.min(top, Math.max(8, minSize));
      let hi = top;
      let size = lo;

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        focusWordEl.style.fontSize = `${mid}px`;
        lineEl.getBoundingClientRect();

        if (holds()) {
          size = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      focusWordEl.style.fontSize = `${size}px`;
      lineEl.getBoundingClientRect();
      return size;
    };

    let best = LINK.test(focusWordEl.textContent ?? '') ? startSize : largest(fitsFocusWord, startSize);
    if (!fitsFocusWord()) {
      this.keepStartInView(viewportEl, focusWordEl, orpEl);
      const startsInside = (): boolean => this.startsInside(viewportEl, focusWordEl, orpEl);
      if (!startsInside()) best = largest(startsInside, best);
    }
    focusWordEl.style.transition = prevTransition;

    return best;
  }

  /** Whether a word, with its letter on the mark, stays inside the area on both sides */
  private fits(viewportEl: HTMLElement, focusWordEl: HTMLElement, orpEl: HTMLElement): boolean {
    const viewport = viewportEl.getBoundingClientRect();
    if (viewport.width <= 0) return true;

    const focusX = this.focusX();
    const orp = orpEl.getBoundingClientRect();
    const word = focusWordEl.getBoundingClientRect();
    const orpCenter = orp.left + orp.width / 2;

    return focusX - (orpCenter - word.left) >= viewport.left && focusX + (word.right - orpCenter) <= viewport.right;
  }

  /** Whether a word, with its letter on the mark, starts inside the area */
  private startsInside(viewportEl: HTMLElement, focusWordEl: HTMLElement, orpEl: HTMLElement): boolean {
    const viewport = viewportEl.getBoundingClientRect();
    const word = focusWordEl.getBoundingClientRect();
    const letter = orpEl.getBoundingClientRect();
    const middle = (letter.left + letter.right) / 2;
    return getComputedStyle(focusWordEl).direction === 'rtl'
      ? word.right - middle <= viewport.right - this.focusX()
      : middle - word.left <= this.focusX() - viewport.left;
  }

  /**
   * For a word that does not fit the area with its letter on the mark and cannot be made
   * smaller (a link, or a word at the smallest size): takes another letter for the eye to
   * rest on, so that the word starts inside the area and as much of it as can be is in
   * view. The letter is taken further into the word where the end of the word runs out and
   * there is room before its start, and less far in where its start would be lost.
   */
  private keepStartInView(viewportEl: HTMLElement, focusWordEl: HTMLElement, orpEl: HTMLElement): void {
    // The runs of the word's own text; the icon of a callout is not among them
    const textRuns = (): Element[] =>
      Array.from(focusWordEl.children).filter((run) => !run.classList.contains('foveafocus-callout-icon'));
    const runs = textRuns();
    const parts = characters(runs.map((run) => run.textContent ?? '').join(''));
    const word = focusWordEl.getBoundingClientRect();
    const viewport = viewportEl.getBoundingClientRect();
    const forward = getComputedStyle(focusWordEl).direction !== 'rtl';
    const lead = forward ? this.focusX() - viewport.left : viewport.right - this.focusX();
    const trail = viewport.width - lead;

    // The letter on the mark as the word stands, the last letter that leaves room before the
    // mark for all that precedes it, and the first that leaves room after it for all that follows
    let now = 0;
    let most = 0;
    let least = parts.length - 1;

    const range = focusWordEl.ownerDocument.createRange();
    let run = 0;
    let offset = 0;
    for (let index = 0; index < parts.length; index++) {
      while (run < runs.length && offset >= (runs[run].textContent ?? '').length) {
        run++;
        offset = 0;
      }
      const node = runs[run]?.firstChild;
      if (!node) break;

      range.setStart(node, offset);
      range.setEnd(node, offset + parts[index].length);
      offset += parts[index].length;

      const box = range.getBoundingClientRect();
      const middle = (box.left + box.right) / 2;
      const from = forward ? middle - word.left : word.right - middle;
      if (runs[run] === orpEl) now = index;
      if (from <= lead) most = index;
      if (least === parts.length - 1 && word.width - from <= trail - 1) least = index;
    }

    const restOn = (index: number): void => {
      for (const other of textRuns()) {
        if (other !== orpEl) other.remove();
      }
      const before = parts.slice(0, index).join('');
      const after = parts.slice(index + 1).join('');
      if (before) orpEl.before(focusWordEl.createSpan({ text: before }));
      orpEl.setText(parts[index]);
      if (after) focusWordEl.createSpan({ text: after });
    };
    // A sign is not rested on where a letter or figure stands before it
    const letterAt = (place: number): number => {
      let at = place;
      while (at > 0 && !this.readAsLetter(parts[at])) at--;
      return this.readAsLetter(parts[at]) ? at : place;
    };
    let next = letterAt(Math.min(Math.max(now, least), most));
    // The letter before a sign may let the end of the word run out after all: the letter
    // after the sign is taken where that leaves the start of the word in
    if (next < least) {
      let after = next + 1;
      while (after < most && !this.readAsLetter(parts[after])) after++;
      if (after <= most && this.readAsLetter(parts[after])) next = after;
    }
    if (next === now) return;
    restOn(next);
    // The letter rested on is set in bold, which is wider: where that puts the start of the
    // word out after all, the letter before it is taken
    while (next > 0 && !this.startsInside(viewportEl, focusWordEl, orpEl)) {
      next = letterAt(next - 1);
      restOn(next);
    }
  }

  /**
   * Displays a welcome message (no text loaded)
   * Uses DOM API to build the message instead of innerHTML
   *
   * @param icon - Icon to display
   * @param mainText - Main message text
   * @param subText - Instruction text
   */
  displayWelcomeMessage(icon: string, mainText: string, subText: string): void {
    this.dropParts();
    this.shown = null;
    this.contentEl.empty();
    this.wordEl.setAttribute('data-running', 'false');

    const welcomeDiv = this.contentEl.createDiv({ cls: 'foveafocus-welcome-message' });

    const header = welcomeDiv.createDiv({ cls: 'foveafocus-welcome-icon' });
    const iconSpan = header.createSpan({ cls: 'foveafocus-inline-icon' });
    this.renderIcon(iconSpan, icon);
    header.createSpan({ text: ` ${mainText}` });

    welcomeDiv.createDiv({
      text: subText,
      cls: 'foveafocus-welcome-instruction'
    });
  }

  /**
   * Displays a ready message (text loaded, ready to start)
   * Uses DOM API to build the message instead of innerHTML
   *
   * @param wordsToRead - Number of words to read
   * @param totalWords - Total words in document
   * @param startIndex - Starting word index (if resuming)
   * @param durationText - Formatted estimated duration
   * @param toStart - What starts the reading on this device, in words
   * @param fileName - Optional source file name
   * @param lineNumber - Optional source line number
   */
  displayReadyMessage(
    wordsToRead: number,
    totalWords: number,
    startIndex: number | undefined,
    durationText: string,
    toStart: string,
    fileName?: string,
    lineNumber?: number
  ): void {
    this.dropParts();
    this.shown = null;
    this.contentEl.empty();
    this.wordEl.setAttribute('data-running', 'false');
    const readyDiv = this.contentEl.createDiv({ cls: 'foveafocus-ready-message' });

    // Add source info if provided
    if (fileName) {
      const sourceDiv = readyDiv.createDiv({ cls: 'foveafocus-ready-source' });
      const iconSpan = sourceDiv.createSpan({ cls: 'foveafocus-inline-icon' });
          setIcon(
            iconSpan,
            ICONS.file.startsWith('lucide:')
              ? ICONS.file.slice('lucide:'.length)
              : ICONS.file
          );
          sourceDiv.createSpan({ text: ' ' });
          sourceDiv.createSpan({ text: fileName });
      if (lineNumber) {
        sourceDiv.createSpan({ text: ` (line ${lineNumber})` });
      }
    }

    // Build main message
    const mainText = readyDiv.createSpan();
    mainText.createSpan({ text: `Ready to read ${wordsToRead} words` });

    if (startIndex !== undefined && startIndex > 0) {
      const startInfo = mainText.createSpan({ cls: 'foveafocus-ready-start-info' });
      startInfo.setText(` (starting at word ${startIndex + 1}/${totalWords})`);
    }

    readyDiv.createEl('br');
    readyDiv.createSpan({
      text: `Estimated time: ~${durationText}`,
      cls: 'foveafocus-ready-duration'
    });
    readyDiv.createEl('br');
    readyDiv.createSpan({
      text: toStart,
      cls: 'foveafocus-ready-duration'
    });
  }

  /**
   * Clears the word display
   */
  clear(): void {
    this.dropParts();
    this.shown = null;
    this.contentEl.empty();
    this.wordEl.setAttribute('data-running', 'false');
  }
}
