import { App, Platform, PluginSettingTab, SliderComponent, ToggleComponent, setIcon } from 'obsidian';
import FoveaFocusPlugin from '../main';
import { LIMITS } from './constants';
import { getInstalledFontFamilies } from './services/font-family';
import {
  PAUSES,
  choosePauses,
  copyOf,
  deviceKey,
  differing,
  keptPerDevice,
  pauseChoice,
  setShown,
  pausesAreOwn,
  readDevice,
  sharedKey,
  type DeviceSetting,
  type PauseChoice,
  type PauseKey,
} from './services/settings-model';
import { SettingsExample } from './settings-example';
import { DEFAULT_SETTINGS, type FoveaFocusSettings } from './types';

type Settings = FoveaFocusSettings;
type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type NumberSetting = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type ColourSetting = 'highlightColor' | 'fontColor' | 'backgroundColor';
type ListSetting = 'noteExcludedSections' | 'pdfExcludedSections';

/** A row of the tab: where its description and its controls stand */
interface Row {
  rowEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
}

/** The app's slider, which from 1.13 on shows what it is set to beside itself */
type SliderThatSays = SliderComponent & { setDisplayFormat?: (format: (value: number) => string) => unknown };

/** The measure a number is typed in, where it is not the one its slider counts in */
interface TypedAs {
  said: (value: number) => number;
  kept: (typed: number) => number;
}

/** The groups the settings are shown in, one at a time */
const GROUPS = [
  ['reading', 'Reading'],
  ['pauses', 'Pauses'],
  ['look', 'Look'],
  ['read', 'What is read'],
  ['starting', 'Starting'],
  ['keys', 'Shortcuts'],
] as const;

type Group = (typeof GROUPS)[number][0];

/**
 * What the settings are called. A setting that the phone keeps for itself goes by the name
 * of the computer's.
 */
const NAMES: Partial<Record<keyof Settings, string>> = {
  wpm: 'Speed',
  fontSize: 'Text size',
  chunkSize: 'Words shown at once',
  minTokenFontSize: 'Smallest size for a long word',
  splitLongCompounds: 'Long hyphenated words in parts',
  fontFamily: 'Font',
  enableMicropause: 'How much to pause',
  micropausePunctuation: 'End of a sentence',
  micropauseOtherPunctuation: 'Comma, colon, semicolon',
  micropauseParagraph: 'End of a paragraph',
  micropauseLongWords: 'Long words',
  micropauseLongWordsGrow: 'Longer still for longer words',
  micropauseNumbers: 'Numbers',
  pauseStacking: 'Two pauses on one word',
  micropauseHeadings: 'Start of a heading',
  micropauseCallouts: 'Start of a callout',
  micropauseListBullets: 'List bullets',
  micropauseSectionMarkers: 'Section numbers',
  highlightColor: 'Colour of the marked letter',
  fontColor: 'Colour of the text',
  backgroundColor: 'Colour of the background',
  showContext: 'Lines round the word',
  contextLines: 'How many lines',
  contextFontSize: 'Size of those lines',
  showProgress: 'Progress bar',
  showOutline: 'Outline',
  largerHeadings: 'Larger headings',
  skipCodeBlocks: 'Read code blocks',
  skipTables: 'Read tables',
  readInlineMaths: 'Read inline maths',
  skipTagLines: 'Read lines of tags',
  skipLinkLines: 'Read lines of links',
  skipReferences: 'Read the reference list',
  noteExcludedSections: 'Sections of notes to skip',
  pdfIncludeTitle: 'Read the title',
  pdfIncludeCaptions: 'Read captions of figures and tables',
  pdfSkipFrontMatter: 'Read title-page details',
  pdfSkipFootnotes: 'Read footnotes',
  pdfStopAtReferences: 'Read what follows the reference list',
  pdfExcludedSections: 'Sections of PDFs to skip',
  autoStart: 'Start by itself',
  autoStartDelay: 'Wait before starting',
  enableSlowStart: 'Ease in',
  enableAcceleration: 'Speed up while reading',
  accelerationTargetWpm: 'Speed to reach',
  accelerationDuration: 'Time to reach it',
  ownSelectionLength: 'A few selected words',
};

/** What each pause is told by, under its name */
const PAUSE_TOLD_BY: Record<PauseKey, string> = {
  micropausePunctuation: 'After a full stop, ! or ?',
  micropauseOtherPunctuation: 'A shorter stop inside a sentence.',
  micropauseParagraph: 'Before the next paragraph starts.',
  micropauseLongWords: 'Words of nine letters or more.',
  micropauseNumbers: 'Any word with a figure in it: years, amounts, measurements.',
  micropauseHeadings: 'The first word of a heading. A lower heading pauses less.',
  micropauseCallouts: 'The first word of the title of a callout.',
  micropauseListBullets: 'A bullet at the start of a line: - * + •',
  micropauseSectionMarkers: 'What counts off a section at the start of a line: 1. 2.1 IV. a)',
};

/** The pauses that are seldom set: folded away until they are asked for */
const LESSER_PAUSES: ReadonlySet<PauseKey> = new Set<PauseKey>(['micropauseHeadings', 'micropauseCallouts', 'micropauseListBullets', 'micropauseSectionMarkers']);

/** The file of settings is written once the changing has stopped for this long, in milliseconds */
const SAVE_AFTER = 400;

/** How a key of the reader is named to the user */
function keyName(code: string): string {
  const arrow = /^Arrow(Left|Right|Up|Down)$/.exec(code);
  if (arrow) return `${arrow[1]} arrow`;
  return code === 'Escape' ? 'Esc' : code.replace(/^Key|^Digit/, '');
}

/** A colour of the theme, as the six-figure code a colour field takes */
function themeColour(variable: string, doc: Document): string {
  const probe = doc.body.createSpan();
  probe.style.setProperty('color', `var(${variable})`);
  const parts = /(\d+)\D+(\d+)\D+(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  return parts ? `#${parts.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}` : '#000000';
}

function cssQuoteFont(name: string): string {
  const t = name.trim();
  if (!t) return t;
  if (/^["'].*["']$/.test(t)) return t;
  return /\s/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
}

class FontFamilySuggest {
  private suggestEl: HTMLDivElement;
  private isOpen = false;
  private items: string[] = [];
  private filtered: string[] = [];
  private selectedIndex = -1;

  private ignoreBlurUntil = 0;
  private markIgnoreBlur(ms = 500): void {
    this.ignoreBlurUntil = Date.now() + ms;
  }
  private shouldIgnoreBlur(): boolean {
    return Date.now() < this.ignoreBlurUntil;
  }

  private onDocPointerDown = (evt: PointerEvent) => {
    const t = evt.target as Node | null;
    if (!t) return;
    if (t === this.inputEl || this.inputEl.contains(t)) return;
    if (t === this.suggestEl || this.suggestEl.contains(t)) return;
    this.close();
  };

  private onWinResize = () => this.position();

  /** The document and the window the field stands in: not the main ones where the settings are open in a window of their own */
  private get doc(): Document {
    return this.inputEl.ownerDocument;
  }
  private get win(): Window {
    return this.doc.defaultView ?? window;
  }

  constructor(
    private inputEl: HTMLInputElement,
    private getItems: () => string[],
    private onSelect: (value: string) => void
  ) {
    this.suggestEl = this.doc.body.createDiv({
      cls: "foveafocus-font-suggest",
    });
    this.suggestEl.style.display = "none";

    // Mobile + desktop: open full list on focus/tap
    this.inputEl.addEventListener("focus", () => this.open("all"));
    this.inputEl.addEventListener("pointerdown", () => {
      // ensures tap opens even if already focused (mobile)
      if (!this.isOpen) queueMicrotask(() => this.open("all"));
    });

    // Keep search narrowing when the user types
    this.inputEl.addEventListener("input", () => this.open("filter"));

    // Keyboard navigation
    this.inputEl.addEventListener("keydown", (e) => this.onKeydown(e));

    // Close when leaving the input (touch-safe: don't rely on :hover)
    this.inputEl.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (this.shouldIgnoreBlur()) return;
        this.close();
      }, 120);
    });

    // If user taps/scrolls inside dropdown, don't let blur-close win
    this.suggestEl.addEventListener("pointerdown", () => this.markIgnoreBlur(700));
  }

  destroy(): void {
    this.close();
    this.suggestEl.remove();
  }

  private open(mode: "all" | "filter"): void {
    this.items = this.getItems();
    this.filterAndRender(mode);

    if (!this.filtered.length) {
      this.close();
      return;
    }

    if (!this.isOpen) {
      this.isOpen = true;
      if (this.suggestEl.parentElement !== this.doc.body) this.doc.body.appendChild(this.suggestEl);
      this.suggestEl.style.display = "block";
      this.doc.addEventListener("pointerdown", this.onDocPointerDown);
      this.win.addEventListener("resize", this.onWinResize);
    }

    this.position();
    this.refreshSelection();
  }

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.suggestEl.style.display = "none";
    this.suggestEl.empty();
    this.doc.removeEventListener("pointerdown", this.onDocPointerDown);
    this.win.removeEventListener("resize", this.onWinResize);
  }

  private position(): void {
    if (!this.isOpen) return;

    const r = this.inputEl.getBoundingClientRect();
    const margin = 6;
    const maxH = 320;

    const spaceBelow = this.win.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;

    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    const height = Math.min(maxH, openUp ? spaceAbove : spaceBelow);

    this.suggestEl.style.left = `${Math.round(r.left)}px`;
    this.suggestEl.style.width = `${Math.round(r.width)}px`;
    this.suggestEl.style.maxHeight = `${Math.max(120, height)}px`;

    if (openUp) {
      this.suggestEl.style.top = `${Math.round(r.top - margin)}px`;
      this.suggestEl.style.transform = "translateY(-100%)";
    } else {
      this.suggestEl.style.top = `${Math.round(r.bottom + margin)}px`;
      this.suggestEl.style.transform = "translateY(0)";
    }
  }

  private currentSelectionKey(): string {
    // Compare against the first family name, unquoted, lowercased.
    const raw = (this.inputEl.value.split(",")[0] ?? "").trim();
    const unquoted = raw.replace(/^["']|["']$/g, "");
    return unquoted.toLowerCase();
  }

  private filterAndRender(mode: "all" | "filter"): void {
    const q = mode === "all" ? "" : this.inputEl.value.trim().toLowerCase();
    const all = this.items;

    const filtered = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;

    // Cap to keep UI snappy with huge font lists
    this.filtered = filtered.slice(0, 400);

    const selKey = this.currentSelectionKey();
    const exactIdx = selKey
      ? this.filtered.findIndex((f) => f.toLowerCase() === selKey)
      : -1;

    this.selectedIndex = exactIdx >= 0 ? exactIdx : (this.filtered.length ? 0 : -1);

    this.render();
  }

  private render(): void {
    this.suggestEl.empty();

    if (!this.filtered.length) {
      this.suggestEl.createDiv({
        cls: "foveafocus-font-suggest-empty",
        text: "No matches",
      });
      return;
    }

    // Optional preview: keep it cheap on mobile by limiting when list is large
    const enablePreview = this.filtered.length <= 120;
    const fallback = getComputedStyle(this.inputEl).fontFamily;

    this.filtered.forEach((font, idx) => {
      const item = this.suggestEl.createDiv({
        cls: "foveafocus-font-suggest-item",
        text: font,
      });

      if (enablePreview) {
        item.style.fontFamily = `${cssQuoteFont(font)}, ${fallback}`;
      }

      if (idx === this.selectedIndex) item.classList.add("is-selected");

      item.addEventListener("mouseenter", () => {
        this.selectedIndex = idx;
        this.refreshSelection();
      });

      item.addEventListener("click", () => {
        this.onSelect(font);
        this.close();
        this.inputEl.focus();
      });
    });
  }

  private refreshSelection(): void {
    const children = Array.from(this.suggestEl.children) as HTMLElement[];
    children.forEach((el, i) => {
      el.classList.toggle("is-selected", i === this.selectedIndex);
    });

    const selected = children[this.selectedIndex];
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.isOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      this.open("all");
      e.preventDefault();
      return;
    }

    if (!this.isOpen) return;

    if (e.key === "Escape") {
      this.close();
      e.preventDefault();
      return;
    }

    if (e.key === "ArrowDown") {
      this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + 1);
      this.refreshSelection();
      e.preventDefault();
      return;
    }

    if (e.key === "ArrowUp") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refreshSelection();
      e.preventDefault();
      return;
    }

    if (e.key === "Enter") {
      if (this.selectedIndex >= 0 && this.filtered[this.selectedIndex]) {
        this.onSelect(this.filtered[this.selectedIndex]);
      }
      this.close();
      e.preventDefault();
    }
  }
}

export class FoveaFocusSettingTab extends PluginSettingTab {
  plugin: FoveaFocusPlugin;

  /** The group of settings on show; kept from one opening of the settings to the next */
  private group: Group = 'reading';
  /** Whether the pauses that are seldom set are on show */
  private lesserPauses = false;
  private example: SettingsExample | null = null;
  private fontSuggest: FontFamilySuggest | null = null;
  private groupsEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private defaultEl!: HTMLElement;
  private defaultLineEl!: HTMLElement;
  /** What is shown of a setting, drawn again after every change; those of the head come first */
  private following: Array<() => void> = [];
  private inHead = 0;
  /** The setup as it stood before the last going back, so that the going back can be undone */
  private before: Settings | null = null;
  /** What the line about the saved default says once, in place of what it says as a rule */
  private said = '';
  private saving: number | null = null;

  constructor(app: App, plugin: FoveaFocusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private get settings(): Settings {
    return this.plugin.settings;
  }

  /** Whether the settings are shown on a phone, which keeps some of them for itself. The reader goes by the same. */
  private get mobile(): boolean {
    return Platform.isMobileApp;
  }

  private get device(): 'phone' | 'computer' {
    return this.mobile ? 'phone' : 'computer';
  }

  /** The saved default, where this device has saved one: a computer and a phone each save their own */
  private get savedHere(): Settings | null {
    return this.plugin.savedDefaultOn[this.device] ? this.plugin.savedDefault : null;
  }

  /** The key under which this device keeps a setting of its own */
  private own<K extends DeviceSetting>(key: K): K {
    return deviceKey(key, this.mobile) as K;
  }

  private nameOf(key: keyof Settings): string {
    return NAMES[sharedKey(key)] ?? key;
  }

  display(): void {
    const { containerEl } = this;
    this.example?.destroy();
    containerEl.empty();
    containerEl.addClass('foveafocus-settings-tab');
    this.following = [];

    const head = containerEl.createDiv({ cls: 'foveafocus-settings-head' });
    this.addNumber(head, this.own('wpm'), {
      min: LIMITS.wpm.min,
      max: LIMITS.wpm.max,
      step: 25,
      unit: 'words a minute',
      beside: (speed) => `${Math.round(60000 / speed)} ms a word`,
    });
    this.example = new SettingsExample(head, this.settings, this.mobile);
    this.inHead = this.following.length;

    this.groupsEl = containerEl.createDiv({ cls: 'foveafocus-settings-groups' });
    for (const [group, name] of GROUPS) {
      const button = this.groupsEl.createEl('button', { text: name, cls: 'foveafocus-settings-choice' });
      button.addEventListener('click', () => {
        this.group = group;
        this.showGroup();
      });
    }
    this.bodyEl = containerEl.createDiv({ cls: 'foveafocus-settings-body' });
    this.defaultEl = containerEl.createDiv({ cls: 'foveafocus-settings-default' });

    this.showGroup();
    this.showDefault();
    this.showDefaultLine();
  }

  hide(): void {
    this.example?.destroy();
    this.example = null;
    this.fontSuggest?.destroy();
    this.fontSuggest = null;
    if (this.saving !== null) {
      window.clearTimeout(this.saving);
      this.saving = null;
      void this.plugin.saveSettings();
    }
    super.hide();
  }

  /**
   * Shows the settings as they are now, where the tab is on show and they have been changed
   * elsewhere: in the reader, which may be open beside the settings.
   */
  refresh(): void {
    if (!this.bodyEl?.isConnected) return;
    this.showGroup();
    for (const follow of this.following) follow();
    this.example?.show(this.settings, false);
    this.showDefaultLine();
  }

  /**
   * A setting has been changed. Everything on show follows it at once, the example with it;
   * the file of settings is written once the changing has stopped.
   */
  private changed(): void {
    for (const follow of this.following) follow();
    this.example?.show(this.settings);
    this.showDefaultLine();

    if (this.saving !== null) window.clearTimeout(this.saving);
    this.saving = window.setTimeout(() => {
      this.saving = null;
      void this.plugin.saveSettings();
    }, SAVE_AFTER);
  }

  // ------------------------------------------------------------------------------------
  // The groups
  // ------------------------------------------------------------------------------------

  private showGroup(): void {
    Array.from(this.groupsEl.children).forEach((button, index) => {
      button.toggleClass('is-chosen', GROUPS[index][0] === this.group);
      button.setAttr('aria-pressed', GROUPS[index][0] === this.group);
    });
    this.following.length = this.inHead;
    this.example?.mark(null);
    this.fontSuggest?.destroy();
    this.fontSuggest = null;

    const body = this.bodyEl;
    body.empty();
    if (this.group === 'reading') this.showReading(body);
    else if (this.group === 'pauses') this.showPauses(body);
    else if (this.group === 'look') this.showLook(body);
    else if (this.group === 'read') this.showWhatIsRead(body);
    else if (this.group === 'starting') this.showStarting(body);
    else this.showKeys(body);
  }

  private showReading(body: HTMLElement): void {
    this.addNumber(body, this.own('fontSize'), {
      desc: 'How large a word is shown.',
      ...LIMITS[this.own('fontSize')],
      step: 4,
      unit: 'px',
    });
    this.addNumber(body, this.own('chunkSize'), {
      desc: 'One word at a time is the easiest to follow.',
      ...LIMITS.chunkSize,
      step: 1,
    });
    this.addNumber(body, 'minTokenFontSize', {
      desc: 'A word too long for the window is made smaller, but never smaller than this. A link keeps its size.',
      ...LIMITS.minTokenFontSize,
      step: 1,
      unit: 'px',
    });
    this.addSwitch(body, 'splitLongCompounds', 'While reading, a word joined by hyphens or slashes is shown part by part where it would otherwise be made smaller than half its size. Each part keeps its hyphen.');
    this.addFont(body);
  }

  private showPauses(body: HTMLElement): void {
    this.addPauseChoice(body);
    if (pauseChoice(this.settings, this.mobile) === 'off') return;

    // A pause is kept as how many times as long a word is shown. It is set as the time it adds: typed in milliseconds
    // at the speed that is set, and said in words, the measure in which it keeps pace with the speed.
    const wordMs = (): number => 60000 / readDevice(this.settings, 'wpm', this.mobile);
    const add = (key: PauseKey, max: number): void => {
      this.addNumber(body, key, {
        desc: PAUSE_TOLD_BY[key],
        min: 0,
        max: max - 1,
        step: 0.1,
        over: -1,
        unit: 'ms',
        typedAs: { said: (words) => Math.round(words * wordMs()), kept: (ms) => ms / wordMs() },
        beside: (words) => (words === 0 ? 'no pause' : `the time of ${words.toFixed(1)} words`),
        marks: true,
      });
      if (key === 'micropauseLongWords') {
        this.addSwitch(body, 'micropauseLongWordsGrow', 'Every four letters more add the same pause again.', { marks: true });
      }
    };

    for (const { key, max } of PAUSES) if (!LESSER_PAUSES.has(key)) add(key, max);

    // What either way comes to on the word the row speaks of, in the measure the pauses above are set in
    const stacking = this.row(body, this.nameOf('pauseStacking'));
    const comesTo = (): void => {
      const { micropausePunctuation: sentence, micropauseParagraph: paragraph } = this.settings;
      const adds = (times: number): number => Math.round((times - 1) * wordMs());
      stacking.descEl.setText(`Such as the last word of a paragraph, which ends a sentence too: added, its two pauses come to ${adds(sentence + paragraph - 1)} ms; multiplied, to ${adds(sentence * paragraph)} ms.`);
    };
    this.following.push(comesTo);
    comesTo();
    stacking.controlEl.addClass('foveafocus-settings-choices');
    for (const [way, name] of [['add', 'Add them'], ['multiply', 'Multiply them']] as const) {
      const button = stacking.controlEl.createEl('button', { text: name, cls: 'foveafocus-settings-choice' });
      button.toggleClass('is-chosen', this.settings.pauseStacking === way);
      button.setAttr('aria-pressed', this.settings.pauseStacking === way);
      button.addEventListener('click', () => {
        this.settings.pauseStacking = way;
        this.changed();
        this.showGroup();
      });
    }
    this.marksWords(stacking.rowEl, 'pauseStacking');

    const lesser = this.row(body, 'Headings, callouts, lists, section numbers', 'Four more pauses, which are seldom set.');
    lesser.controlEl.createEl('button', { text: this.lesserPauses ? 'Hide' : 'Show' }).addEventListener('click', () => {
      this.lesserPauses = !this.lesserPauses;
      this.showGroup();
    });
    if (this.lesserPauses) for (const { key, max } of PAUSES) if (LESSER_PAUSES.has(key)) add(key, max);
  }

  private showLook(body: HTMLElement): void {
    this.addColour(body, 'highlightColor', 'The letter the eye rests on, and the marks above and below it.', '--interactive-accent');
    this.addColour(body, 'fontColor', 'The words.', '--text-normal');
    this.addColour(body, 'backgroundColor', 'The window of the reader.', '--background-primary');

    this.addSwitch(body, this.own('showContext'), 'The lines before and after the word, dimmed while reading.', { redraw: true });
    if (readDevice(this.settings, 'showContext', this.mobile)) {
      this.addNumber(body, this.own('contextLines'), {
        desc: 'Lines shown above the word, and as many below it. The reader shows no more than its window has room for.',
        min: 1,
        max: this.mostContextLines() + 1,
        step: 1,
        over: 1,
      });
      this.addNumber(body, this.own('contextFontSize'), {
        desc: 'How large those lines are shown.',
        min: LIMITS.contextFontSize.min,
        max: LIMITS.contextFontSize.max,
        step: 1,
        unit: 'px',
      });
    }

    this.addSwitch(body, 'showProgress', 'A line that fills as the text is read.');
    this.addSwitch(body, this.own('showOutline'), 'At the top of the reader: the headings the word being read stands under. A heading there jumps to its place, and the arrow opens the outline of the whole text.');
    this.addSwitch(body, 'largerHeadings', 'The words of a heading, and of the title of a callout, are shown larger than the text.');
  }

  private showWhatIsRead(body: HTMLElement): void {
    body.createDiv({ cls: 'foveafocus-row-heading', text: 'In notes' });
    this.addSwitch(body, 'skipCodeBlocks', 'Diagram and query blocks (Mermaid, Dataview) are never read.', { reversed: true });
    this.addSwitch(body, 'skipTables', 'A caption line above a table is always read.', { reversed: true });
    this.addSwitch(body, 'readInlineMaths', 'Maths between single dollar signs is read as symbols. Display maths is never read.');
    this.addSwitch(body, 'skipTagLines', 'Lines that hold only tags, such as "Tags: #topic #subtopic".', { reversed: true });
    this.addSwitch(body, 'skipLinkLines', 'Lines that hold only links, such as "Related: [[Note A]] [[Note B]]".', { reversed: true });
    this.addSwitch(body, 'skipReferences', 'A section headed "References" or "Bibliography".', { reversed: true });
    this.addSectionList(body, 'noteExcludedSections',
      'One heading to a line. A section is skipped only when its whole heading is on this list; the same words inside a sentence or a longer heading are read as usual.');

    body.createDiv({ cls: 'foveafocus-row-heading', text: 'In PDF files' });
    this.addSwitch(body, 'pdfIncludeTitle', 'An article starts with its title.');
    this.addSwitch(body, 'pdfIncludeCaptions', 'A caption that interrupts a sentence is read after the paragraph it interrupts.');
    this.addSwitch(body, 'pdfSkipFrontMatter', 'Authors, affiliations, dates and licence lines.', { reversed: true });
    this.addSwitch(body, 'pdfSkipFootnotes', 'Small print at the foot of a column.', { reversed: true });
    this.addSwitch(body, 'pdfStopAtReferences',
      'The reference list itself is never read. Leave this on for journals that print their methods after the references.', { reversed: true });
    this.addSectionList(body, 'pdfExcludedSections',
      'One heading to a line. A section is skipped only when its whole heading, or the bold label that opens a paragraph, is on this list; the same words inside a sentence or a longer heading are read as usual.');
  }

  private showStarting(body: HTMLElement): void {
    this.addSwitch(body, 'autoStart', 'Reading starts when the text has loaded.', { redraw: true });
    if (this.settings.autoStart) {
      this.addNumber(body, 'autoStartDelay', { desc: 'Time between loading and starting.', ...LIMITS.autoStartDelay, step: 1, unit: 's' });
    }

    this.addSwitch(body, this.own('enableSlowStart'), 'The first five words are shown more slowly.', { marks: true });

    this.addSwitch(body, 'enableAcceleration', 'Reading starts at the speed that is set and climbs to a higher one.', { redraw: true });
    if (this.settings.enableAcceleration) {
      this.addNumber(body, 'accelerationTargetWpm', {
        desc: 'Words a minute at the end of the climb.',
        min: LIMITS.wpm.min,
        max: LIMITS.wpm.max,
        step: 25,
      });
      this.addNumber(body, 'accelerationDuration', { desc: 'How long the climb takes.', ...LIMITS.accelerationDuration, step: 5, unit: 's' });
    }

    this.addNumber(body, 'ownSelectionLength', {
      desc: 'With no more characters than this selected in a note, the note is read from the first selected word. A longer selection is read on its own.',
      ...LIMITS.ownSelectionLength,
      step: 5,
    });
  }

  private showKeys(body: HTMLElement): void {
    // Up and Down alone step through the headings, so a key for the speed takes Shift where it is one of the two
    const forSpeed = (code: string): string => (/^Arrow(Up|Down)$/.test(code) ? `Shift + ${keyName(code)}` : keyName(code));
    const command = Platform.isMacOS ? 'Cmd' : 'Ctrl';
    const keys: Array<[string, string]> = [
      [keyName(this.settings.hotkeyPlay), 'Play or pause'],
      [keyName(this.settings.hotkeyRewind), 'Back 10 seconds'],
      [keyName(this.settings.hotkeyForward), 'Forward 10 seconds'],
      [keyName('ArrowUp'), 'Previous heading'],
      [keyName('ArrowDown'), 'Next heading'],
      [`${command} + ${keyName('ArrowLeft')}`, 'Jump to start'],
      [`${command} + ${keyName('ArrowRight')}`, 'Jump to end'],
      [forSpeed(this.settings.hotkeyIncrementWpm), 'Faster'],
      [forSpeed(this.settings.hotkeyDecrementWpm), 'Slower'],
      ['S', 'Settings of the reader'],
      [keyName(this.settings.hotkeyQuit), 'Close the reader'],
    ];
    for (const [key, does] of keys) this.row(body, does).controlEl.createEl('kbd', { text: key });
    body.createDiv({
      cls: 'foveafocus-row-desc foveafocus-settings-aside',
      text: 'These work while the reader is open. The commands that open it can be given shortcuts in the settings of the app, under hotkeys.',
    });
  }

  // ------------------------------------------------------------------------------------
  // The kinds of setting
  // ------------------------------------------------------------------------------------

  /**
   * A row of the tab: the name of a setting and what is said of it on one side, its controls
   * on the other. The rows are the tab's own, so that they stand as one plain list whatever
   * a theme makes of the rows of the app's settings. A setting that the device keeps for
   * itself says so beside its name, with a small picture of the device, which takes less
   * room than the words; the words are told on pointing at it.
   */
  private row(parent: HTMLElement, name: string, desc = '', ofDevice = false): Row {
    const rowEl = parent.createDiv({ cls: 'foveafocus-row' });
    const told = rowEl.createDiv({ cls: 'foveafocus-row-told' });
    told.createDiv({ cls: 'foveafocus-row-name', text: name });
    if (ofDevice) {
      const device = told.createSpan({
        cls: 'foveafocus-row-device',
        attr: { 'aria-label': this.mobile ? 'Kept for this phone. A computer has its own, set on the computer.' : 'Kept for this computer. A phone has its own, set on the phone.' },
      });
      setIcon(device, this.mobile ? 'smartphone' : 'monitor');
    }
    const descEl = told.createDiv({ cls: 'foveafocus-row-desc', text: desc });
    const controlEl = rowEl.createDiv({ cls: 'foveafocus-row-control' });
    return { rowEl, descEl, controlEl };
  }

  /**
   * A number, set with the app's slider or typed over where it is shown beside the slider.
   * The number, the slider and what is said of the number follow it while the slider is
   * dragged, and so does the example. A number may be typed in another measure than its
   * slider counts in: a pause is kept as a length in words and typed in milliseconds.
   */
  private addNumber(
    parent: HTMLElement,
    key: NumberSetting,
    look: { desc?: string; min: number; max: number; step: number; unit?: string; over?: number; typedAs?: TypedAs; beside?: (value: number) => string; marks?: boolean }
  ): void {
    const name = this.nameOf(key);
    const { rowEl, controlEl } = this.row(parent, name, look.desc, keptPerDevice(key));
    rowEl.addClass('has-slider');

    // The number shown may be other than the number kept: the lines round the word are kept as those beyond the first
    const over = look.over ?? 0;
    const places = (String(look.step).split('.')[1] ?? '').length;
    const exact = (value: number): number => parseFloat(value.toFixed(places));
    const within = (value: number): number => Math.max(look.min, Math.min(look.max, exact(Math.round(value / look.step) * look.step)));
    const typed = (value: number): number => (look.typedAs ? look.typedAs.said(value) : value);
    const set = (value: number): void => {
      const kept = exact(value - over);
      if (this.settings[key] === kept) return;
      this.settings[key] = kept;
      this.changed();
    };

    // The app's own slider, which draws itself as the app does. It tells of its number once it is let go unless it is
    // asked to tell while it is dragged, and from 1.13 on it shows the number beside itself: here the row shows the
    // number, which can be typed over. What it tells while the row sets it is no change made by hand.
    let shows = false;
    const slider: SliderThatSays = new SliderComponent(controlEl.createDiv({ cls: 'foveafocus-row-slider' })).setLimits(look.min, look.max, look.step);
    if (slider.setInstant) slider.setInstant(true);
    slider.setDisplayFormat?.(() => '');
    slider.sliderEl.setAttr('aria-label', name);
    slider.onChange((value) => {
      if (!shows) set(within(value));
    });

    const said = controlEl.createDiv({ cls: 'foveafocus-row-said' });
    const field = said.createEl('input', { type: 'text', cls: 'foveafocus-row-number', attr: { inputmode: places && !look.typedAs ? 'decimal' : 'numeric', 'aria-label': name } });
    if (look.unit) said.createSpan({ text: look.unit });
    const besideEl = look.beside ? said.createSpan({ cls: 'foveafocus-settings-beside' }) : null;

    // A click in the field marks the number, so that what is typed takes its place
    field.addEventListener('focus', () => field.select());
    field.addEventListener('change', () => {
      const number = parseFloat(field.value);
      if (!isNaN(number)) set(within(look.typedAs ? look.typedAs.kept(number) : number));
      follow();
    });

    const follow = (): void => {
      const value = within(this.settings[key] + over);
      const ends = [look.min, look.max];
      field.value = String(typed(value));
      shows = true;
      slider.setValue(value);
      shows = false;
      // The field and what is said beside it keep the room of the longest they come to, so that the slider keeps its
      // length while it is dragged
      field.setCssProps({ '--foveafocus-number-length': String(Math.max(...ends.map((end) => String(typed(end)).length))) });
      if (besideEl && look.beside) {
        const longest = ends.map(look.beside).reduce((longer, says) => (says.length > longer.length ? says : longer));
        besideEl.setText(look.beside(value));
        besideEl.setAttr('data-longest', longest);
      }
    };
    this.following.push(follow);
    follow();
    if (look.marks) this.marksWords(rowEl, key);
  }

  /**
   * A switch. Those that say what is read are all named for reading, whichever way the
   * setting itself is kept; one that other settings hang on draws its group again.
   */
  private addSwitch(parent: HTMLElement, key: BooleanSetting, desc: string, look: { reversed?: boolean; redraw?: boolean; marks?: boolean } = {}): void {
    const { rowEl, controlEl } = this.row(parent, this.nameOf(key), desc, keptPerDevice(key));
    new ToggleComponent(controlEl)
      .setValue(this.settings[key] !== !!look.reversed)
      .onChange((on) => {
        this.settings[key] = on !== !!look.reversed;
        this.changed();
        if (look.redraw) this.showGroup();
      });
    if (look.marks) this.marksWords(rowEl, key);
  }

  /** A colour: one chosen here, or the theme's, which the field shows until one is chosen */
  private addColour(parent: HTMLElement, key: ColourSetting, desc: string, themeVariable: string): void {
    const name = this.nameOf(key);
    const { controlEl } = this.row(parent, name, desc);
    const saysEl = controlEl.createSpan({ cls: 'foveafocus-settings-beside' });
    const field = controlEl.createEl('input', { type: 'color', cls: 'foveafocus-settings-colour', attr: { 'aria-label': name } });
    field.addEventListener('input', () => {
      this.settings[key] = field.value;
      this.changed();
    });
    const theme = controlEl.createEl('button', { text: 'Use the theme' });
    theme.addEventListener('click', () => {
      this.settings[key] = '';
      this.changed();
    });

    const follow = (): void => {
      const chosen = this.settings[key].trim();
      const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(chosen);
      field.value = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : chosen || themeColour(themeVariable, field.ownerDocument);
      saysEl.setText(chosen ? 'Chosen here' : 'From the theme');
      // the way back to the theme is offered once a colour has been chosen
      theme.toggleClass('foveafocus-row-unused', !chosen);
    };
    this.following.push(follow);
    follow();
  }

  private addFont(parent: HTMLElement): void {
    let installedFonts: string[] = [];
    const { controlEl } = this.row(parent, this.nameOf('fontFamily'), 'The font of the whole reader. Left empty, it is the font of the theme.');
    const input = controlEl.createEl('input', {
      type: 'text',
      placeholder: 'Font of the theme',
      value: this.settings.fontFamily === 'inherit' ? '' : this.settings.fontFamily,
      attr: { spellcheck: 'false', autocomplete: 'off' },
    });
    const set = (value: string): void => {
      this.settings.fontFamily = value.trim() || 'inherit';
      this.changed();
    };
    this.fontSuggest = new FontFamilySuggest(
      input,
      () => installedFonts, // only installed fonts (no hard-coded generics)
      (value) => {
        input.value = value;
        set(value);
      }
    );
    input.addEventListener('input', () => set(input.value));

    void (async () => {
      const fonts = await getInstalledFontFamilies();

      // Only real installed fonts; de-dupe is already handled in getInstalledFontFamilies()
      installedFonts = fonts.map((f) => f.trim()).filter(Boolean);

      // Mobile often can't enumerate installed families; provide a sane fallback list
      if (installedFonts.length === 0) {
        installedFonts = ['system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'sans-serif', 'serif', 'monospace'];
      }
    })();
  }

  /** A list of section headings, edited one to a line */
  private addSectionList(parent: HTMLElement, key: ListSetting, desc: string): void {
    const { controlEl } = this.row(parent, this.nameOf(key), desc);
    const area = controlEl.createEl('textarea', { cls: 'foveafocus-section-list', attr: { 'aria-label': this.nameOf(key) } });
    area.value = this.settings[key].join('\n');
    area.addEventListener('input', () => {
      this.settings[key] = area.value.split('\n').map((line) => line.trim()).filter(Boolean);
      this.changed();
    });
    controlEl.createEl('button', { text: 'Restore the list', attr: { 'aria-label': 'Restore the list the plugin starts with' } }).addEventListener('click', () => {
      this.settings[key] = [...DEFAULT_SETTINGS[key]];
      this.changed();
      this.showGroup();
    });
  }

  /**
   * One choice for all the pauses: off, one of three sets of strengths, or the strengths as
   * the user has set them, which is offered while they are those of none of the sets.
   */
  private addPauseChoice(parent: HTMLElement): void {
    const setting = this.row(
      parent,
      this.nameOf('enableMicropause'),
      `One choice sets every pause below. Off is kept for this ${this.device} alone; the strengths are the same on both.`,
      true
    );
    setting.controlEl.addClass('foveafocus-settings-choices');
    const draw = (): void => {
      const now = pauseChoice(this.settings, this.mobile);
      const choices: Array<[PauseChoice, string]> = [['off', 'Off'], ['light', 'Light'], ['standard', 'Standard'], ['strong', 'Strong']];
      if (pausesAreOwn(this.settings)) choices.push(['own', 'Your own']);

      setting.controlEl.empty();
      for (const [choice, name] of choices) {
        const button = setting.controlEl.createEl('button', { text: name, cls: 'foveafocus-settings-choice' });
        button.toggleClass('is-chosen', choice === now);
        button.setAttr('aria-pressed', choice === now);
        button.addEventListener('click', () => {
          choosePauses(this.settings, choice, this.mobile);
          this.changed();
          this.showGroup();
        });
      }
    };
    this.following.push(draw);
    draw();
  }

  /** While the pointer is on a setting, or the setting is being changed, the example marks the words it bears on */
  private marksWords(row: HTMLElement, key: keyof Settings): void {
    row.addEventListener('pointerenter', () => this.example?.mark(key));
    row.addEventListener('pointerleave', () => this.example?.mark(null));
    row.addEventListener('input', () => this.example?.mark(key));
    row.addEventListener('change', () => this.example?.mark(key));
  }

  /**
   * The most extra lines of context that can be chosen. On the device the reader has been
   * open on, that is what its window had room for; a window that has no room for a line
   * cannot be asked for it.
   */
  private mostContextLines(): number {
    const room = this.plugin.contextRoom;
    return room && room.mobile === this.mobile ? Math.max(0, Math.min(LIMITS.contextLines.max, room.lines - 1)) : LIMITS.contextLines.max;
  }

  // ------------------------------------------------------------------------------------
  // The default of the user's own
  // ------------------------------------------------------------------------------------

  /** The setup to go back to: one the user has saved, or the one the plugin starts with */
  private showDefault(): void {
    this.defaultEl.empty();
    const { descEl, controlEl } = this.row(this.defaultEl, 'Your default', '', true);
    controlEl.addClass('foveafocus-settings-choices');
    this.defaultLineEl = descEl;
    const button = (text: string, does: () => void): void => {
      controlEl.createEl('button', { text }).addEventListener('click', does);
    };

    // The default is saved for what this device shows: its own settings and those both devices
    // share. What the other device keeps for itself has a default of that device's saving.
    button('Save as my default', () => {
      const saved = this.plugin.savedDefault ?? copyOf(this.settings);
      setShown(saved, this.settings, this.mobile);
      this.plugin.savedDefault = saved;
      this.plugin.savedDefaultOn[this.device] = true;
      this.before = null;
      this.said = `Saved. This is the default of this ${this.device} now.`;
      this.showDefault();
      this.showDefaultLine();
      void this.plugin.saveSettings();
    });
    const saved = this.savedHere;
    if (saved) button('Restore my default', () => this.goBackTo(saved, 'Back to your saved default.'));
    button('Original settings', () => {
      this.goBackTo(DEFAULT_SETTINGS, saved ? 'Back to the original settings. Your saved default is kept.' : 'Back to the original settings.');
    });
    const before = this.before;
    if (before) {
      button('Undo', () => {
        Object.assign(this.settings, before);
        this.before = null;
        this.said = 'Undone: the settings are as they were.';
        this.redraw();
      });
    }
  }

  /** Goes back to another setup in what this device shows; what the other device keeps for itself is left as it is */
  private goBackTo(setup: Settings, said: string): void {
    this.before = copyOf(this.settings);
    setShown(this.settings, setup, this.mobile);
    this.said = said;
    this.redraw();
  }

  /** Draws everything again after the whole setup has changed */
  private redraw(): void {
    this.showGroup();
    this.showDefault();
    this.changed();
  }

  /** Says in what the settings differ from the saved default, or what has just been done about it */
  private showDefaultLine(): void {
    const saved = this.savedHere;
    let line = this.said;
    this.said = '';
    if (!line && !saved) line = `No default is saved for this ${this.device} yet.`;
    if (!line && saved) {
      const names = Array.from(new Set(differing(this.settings, saved, this.mobile).map((key) => this.nameOf(key))));
      const shown = names.slice(0, 3).join(', ');
      if (names.length === 0) line = 'Same as your saved default.';
      else if (names.length === 1) line = `1 setting differs from your saved default: ${shown}.`;
      else line = `${names.length} settings differ from your saved default: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}.`;
    }
    this.defaultLineEl.setText(line);
  }
}
