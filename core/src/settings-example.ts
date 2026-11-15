/**
 * The live example at the head of the settings: the reader's own word area and engine on a
 * few words, so that a setting shows what it does while it is being set.
 */

import { setIcon } from 'obsidian';
import { RSVPEngine, tokenizeForEngine } from './rsvp-engine';
import { WordDisplay } from './word-display';
import { TimeoutManager } from './services/timeout-manager';
import { cssFontFamily } from './services/font-setting';
import { readDevice } from './services/settings-model';
import type { FoveaFocusSettings, WordChunk } from './types';

/** The words of the example as the engine takes them: a heading, then two paragraphs */
const EXAMPLE = '[H1]Lamps\nTrim the wick, fill the reservoir, then light it.\nIn 1853 extraordinarily bright lamps appeared.';

/** The marker before the first word of a heading or of a callout's title */
const MARKER = /^\[(?:H\d|CALLOUT:[\w-]+)\]/;

/** The most the word area of the example takes of the height of the settings, in pixels */
const TALLEST = 170;

/** Pixels of a bar for every word's own time that a word is held beyond it, and the most a bar is drawn */
const BAR = { step: 7, most: 46 };

/** The example is played again once the changing of a setting has stopped for this long, in milliseconds */
const SETTLE = 350;

/** A setup that differs from a given one in one setting, to find the words the setting bears on */
function otherwise(settings: FoveaFocusSettings, key: keyof FoveaFocusSettings): Partial<FoveaFocusSettings> {
  const value = settings[key];
  if (typeof value === 'boolean') return { [key]: !value };
  if (typeof value === 'number') return { [key]: value > 1 ? 1 : 2 };
  if (key === 'pauseStacking') return { pauseStacking: value === 'add' ? 'multiply' : 'add' };
  return {};
}

export class SettingsExample {
  private readonly timers = new TimeoutManager();
  private readonly readerEl: HTMLElement;
  private readonly containerEl: HTMLElement;
  private readonly wordEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly playEl: HTMLButtonElement;
  private readonly totalEl: HTMLElement;
  /** The cell of every word of the example in the row under the word area, by the word's place in the text */
  private readonly cells = new Map<number, HTMLElement>();
  private readonly display: WordDisplay;
  private readonly engine: RSVPEngine;
  /** The word area is fitted again when its width changes, with the window or with the room the settings leave it */
  private readonly watch: ResizeObserver;
  private width = 0;
  private settings: FoveaFocusSettings;
  /** How long each word is held, in milliseconds */
  private held: number[] = [];
  /** All that the example shows of the settings, as it was last drawn */
  private drawnAs = '';
  private again: number | null = null;
  private ending: number | null = null;

  constructor(parent: HTMLElement, settings: FoveaFocusSettings, private readonly mobile: boolean) {
    this.settings = settings;

    const root = parent.createDiv({ cls: 'foveafocus-example' });
    this.readerEl = root.createDiv({ cls: 'foveafocus-example-reader' });
    this.containerEl = this.readerEl.createDiv({ cls: 'foveafocus-container' });
    this.wordEl = this.containerEl.createDiv({ cls: 'foveafocus-display' }).createDiv({ cls: 'foveafocus-word' });
    this.noteEl = root.createDiv({ cls: 'foveafocus-example-note' });

    const strip = root.createDiv({ cls: 'foveafocus-example-strip' });
    tokenizeForEngine(EXAMPLE).forEach((word, index) => {
      if (word === '\n') return;
      const cell = strip.createDiv({ cls: 'foveafocus-example-word' });
      cell.createDiv({ cls: 'foveafocus-example-held' });
      cell.createDiv({ cls: 'foveafocus-example-own' });
      cell.createSpan({ text: word.replace(MARKER, '') });
      this.cells.set(index, cell);
    });

    const foot = root.createDiv({ cls: 'foveafocus-example-foot' });
    this.playEl = foot.createEl('button');
    this.playEl.createSpan({ cls: 'foveafocus-example-play-icon' });
    this.playEl.createSpan();
    this.playEl.addEventListener('click', () => {
      if (this.engine.getIsPlaying()) this.stop();
      else this.play();
    });
    this.totalEl = foot.createSpan({ cls: 'foveafocus-example-total' });

    this.display = new WordDisplay(this.wordEl, settings, readDevice(settings, 'fontSize', mobile), readDevice(settings, 'chunkSize', mobile));
    this.display.setDirectionFrom(EXAMPLE);
    this.engine = this.engineFor(settings, (chunk) => this.draw(chunk), this.timers);
    this.show(settings, false);
    // The observer is that of the window the example stands in: the settings may be open in a window of their own
    this.watch = new (parent.ownerDocument.defaultView ?? window).ResizeObserver(() => {
      if (this.readerEl.clientWidth === this.width) return;
      this.width = this.readerEl.clientWidth;
      this.fit();
    });
    this.watch.observe(this.readerEl);
  }

  /**
   * Takes the settings as they now stand, and plays the example once the changing has
   * stopped. A change that the example has nothing to show of leaves it as it is.
   */
  show(settings: FoveaFocusSettings, play = true): void {
    this.settings = settings;
    const font = cssFontFamily(settings.fontFamily);
    const size = readDevice(settings, 'fontSize', this.mobile);
    const chunk = readDevice(settings, 'chunkSize', this.mobile);
    this.engine.updateSettings(settings);
    const drawnAs = JSON.stringify([
      font, size, chunk, settings.minTokenFontSize, settings.largerHeadings,
      settings.highlightColor, settings.fontColor, settings.backgroundColor,
      this.engine.getWordDurationsMs(),
    ]);
    if (drawnAs === this.drawnAs) return;
    this.drawnAs = drawnAs;
    this.stop();

    this.colour('--foveafocus-highlight-color', settings.highlightColor);
    this.colour('--foveafocus-font-color', settings.fontColor);
    this.colour('--foveafocus-background-color', settings.backgroundColor);
    this.containerEl.style.setProperty('font-family', font, 'important');
    this.wordEl.style.setProperty('font-family', font, 'important');
    this.wordEl.style.setProperty('font-size', `${size}px`, 'important');

    this.display.updateSettings(settings);
    this.display.setChunkSize(chunk);
    this.display.setBaseFontSize(size);
    this.engine.jumpToIndex(0);
    this.fit();
    this.drawStrip();

    if (play) this.again = this.timers.setTimeout(() => this.play(), SETTLE);
  }

  /**
   * Marks the words a setting bears on: those held for another length of time when the
   * setting is another. With no setting named, no word is marked.
   */
  mark(key: keyof FoveaFocusSettings | null): void {
    const other = key === null ? this.held : this.heldWith(otherwise(this.settings, key));
    for (const [index, cell] of this.cells) cell.toggleClass('is-marked', Math.abs(this.held[index] - other[index]) > 0.5);
  }

  play(): void {
    this.stop();
    this.engine.play();
    this.playing(true);
  }

  /** Stops the example and gives up what it holds on to */
  destroy(): void {
    this.stop();
    this.timers.clearAll();
    this.watch.disconnect();
  }

  private stop(): void {
    for (const id of [this.again, this.ending]) if (id !== null) this.timers.clearTimeout(id);
    this.again = null;
    this.ending = null;
    this.engine.stop();
    this.playing(false);
  }

  private playing(on: boolean): void {
    setIcon(this.playEl.children[0] as HTMLElement, on ? 'square' : 'play');
    this.playEl.children[1].setText(on ? 'Stop' : 'Play');
  }

  private draw(chunk: WordChunk): void {
    this.display.displayWord(chunk.text.replace(MARKER, ''), chunk.title?.level ?? 0, false, chunk.title?.calloutType, MARKER.test(chunk.text));
    for (const [index, cell] of this.cells) cell.toggleClass('is-now', index === chunk.index);
    if (chunk.isEnd && this.engine.getIsPlaying()) this.ending = this.timers.setTimeout(() => this.stop(), this.held[chunk.index] ?? 0);
  }

  /**
   * Keeps the word area of the example low. A text too large for it is shown smaller, the
   * way the reader shows it in a low window, and a line under the area says so.
   */
  private fit(): void {
    this.display.freeBand();
    this.display.refresh();
    const over = this.wordEl.getBoundingClientRect().height - TALLEST;
    if (over > 0) this.display.lowerBand(Math.ceil(over));
    this.noteEl.setText(over > 0 ? 'A text this large is shown smaller here than in the reader.' : '');
  }

  /** Draws under every word how long it is held, and says how long the example takes */
  private drawStrip(): void {
    this.held = this.engine.getWordDurationsMs();
    const own = 60000 / readDevice(this.settings, 'wpm', this.mobile);
    for (const [index, cell] of this.cells) {
      const beyond = Math.max(0, this.held[index] / own - 1);
      cell.setCssProps({ '--foveafocus-example-held': `${Math.min(BAR.most, Math.round(beyond * BAR.step))}px` });
    }

    const seconds = (times: number[]): string => (times.reduce((sum, time) => sum + time, 0) / 1000).toFixed(1);
    const plain = this.heldWith({ enableMicropause: false, mobileEnableMicropause: false });
    this.totalEl.setText(`This example takes ${seconds(this.held)} s. Without pauses: ${seconds(plain)} s.`);
  }

  /** How long each word would be held with some of the settings other than they are */
  private heldWith(change: Partial<FoveaFocusSettings>): number[] {
    return this.engineFor({ ...this.settings, ...change }, () => undefined, new TimeoutManager()).getWordDurationsMs();
  }

  private engineFor(settings: FoveaFocusSettings, onWord: (chunk: WordChunk) => void, timers: TimeoutManager): RSVPEngine {
    const engine = new RSVPEngine(settings, onWord, timers);
    engine.setUseMobileProfile(this.mobile);
    engine.setText(EXAMPLE);
    return engine;
  }

  /** A colour of the reader's, set for the example alone; nothing set leaves the colour to the theme */
  private colour(name: string, value: string): void {
    if (value.trim()) this.readerEl.style.setProperty(name, value.trim());
    else this.readerEl.style.removeProperty(name);
  }
}
