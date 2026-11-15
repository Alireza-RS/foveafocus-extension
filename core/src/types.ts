import { DEFAULT_EXCLUDED_SECTIONS } from './filters';

export interface FoveaFocusSettings {
  wpm: number;
  chunkSize: number;
  fontSize: number;
  highlightColor: string;
  backgroundColor: string;
  fontColor: string;
  fontFamily: string;
  showContext: boolean;
  showOutline: boolean;
  enableMicropause: boolean;
  micropausePunctuation: number;
  micropauseOtherPunctuation: number;
  micropauseLongWords: number;
  micropauseParagraph: number;
  micropauseNumbers: number;
  micropauseSectionMarkers: number;
  micropauseListBullets: number;
  micropauseCallouts: number;
  /** How long the first word of a first-level heading is held; a lower heading by a share of it */
  micropauseHeadings: number;
  /** Whether the pause for a long word grows with the length of the word */
  micropauseLongWordsGrow: boolean;
  /** How the pauses that fall on one word are put together */
  pauseStacking: 'add' | 'multiply';
  autoStart: boolean;
  autoStartDelay: number;
  showProgress: boolean;
  hotkeyPlay: string;
  hotkeyRewind: string;
  hotkeyForward: string;
  hotkeyIncrementWpm: string;
  hotkeyDecrementWpm: string;
  hotkeyQuit: string;
  enableSlowStart: boolean;
  enableAcceleration: boolean;
  accelerationDuration: number;
  accelerationTargetWpm: number;
  mobileFontSize: number;
  /** Minimum font size (px) when shrinking a single long token to fit */
  minTokenFontSize: number;
  /** Whether a word with hyphens that is too long for the area is shown part by part while reading */
  splitLongCompounds: boolean;
  /** Whether the words of a heading, and of a callout's title, are shown larger than the text */
  largerHeadings: boolean;
  /** A selection of more characters than this is read on its own; a shorter one marks where the note is read from */
  ownSelectionLength: number;
  mobileWpm: number;
  mobileChunkSize: number;
  mobileShowContext: boolean;
  mobileShowOutline: boolean;
  mobileEnableSlowStart: boolean;
  mobileEnableMicropause: boolean;
  // Context is now line-based:
  // 0 = only the anchor line (before/after on the current line)
  // 1..10 = that many full lines above + below, plus anchor lines
  contextLines: number;
  mobileContextLines: number;
  // Context font size (px), separate profiles
  contextFontSize: number;
  mobileContextFontSize: number;

  // What is left out of a note
  skipCodeBlocks: boolean;
  skipTables: boolean;
  readInlineMaths: boolean;
  skipTagLines: boolean;
  skipLinkLines: boolean;
  skipReferences: boolean;
  /** Headings of note sections that are not read, one phrase each */
  noteExcludedSections: string[];

  // What is left out of a PDF
  pdfIncludeTitle: boolean;
  pdfIncludeCaptions: boolean;
  pdfSkipFrontMatter: boolean;
  pdfSkipFootnotes: boolean;
  pdfStopAtReferences: boolean;
  /** Headings of PDF sections that are not read, one phrase each */
  pdfExcludedSections: string[];
}

export const DEFAULT_SETTINGS: FoveaFocusSettings = {
  wpm: 600, // Increased from 300 (inspired by Stutter: 400-800 range)
  chunkSize: 1,
  fontSize: 48,
  mobileFontSize: 32,
  minTokenFontSize: 12,
  splitLongCompounds: true,
  largerHeadings: true,
  ownSelectionLength: 30,
  mobileWpm: 600,
  mobileChunkSize: 1,
  mobileShowContext: false,
  mobileShowOutline: true,
  mobileEnableSlowStart: true,
  mobileEnableMicropause: true,
  contextLines: 0,
  mobileContextLines: 0,
  contextFontSize: 14,
  mobileContextFontSize: 14,
  // Empty: the colours of the theme
  highlightColor: '',
  backgroundColor: '',
  fontColor: '',
  fontFamily: 'inherit',
  showContext: false,
  showOutline: true,
  enableMicropause: true,
  micropausePunctuation: 2.5, // Sentence-ending punctuation (.,!?) - Stutter-inspired
  micropauseOtherPunctuation: 1.5, // Other punctuation (;:,) - lighter pause
  micropauseLongWords: 1.4, // Words of 9 to 12 letters, and as much again for every four letters more
  micropauseParagraph: 2.5, // Paragraph breaks - better section separation
  micropauseNumbers: 1.8, // Numbers and dates - comprehension aid
  micropauseSectionMarkers: 2.0, // Section numbers (1., I., etc.)
  micropauseListBullets: 1.8, // List bullets (-, *, +, •)
  micropauseCallouts: 2.0, // Obsidian callouts
  micropauseHeadings: 2.0, // The first word of an H1; H2 to H6 by a share of it
  micropauseLongWordsGrow: true,
  pauseStacking: 'add',
  autoStart: false,
  autoStartDelay: 3,
  showProgress: true,
  hotkeyPlay: 'Space',
  hotkeyRewind: 'ArrowLeft',
  hotkeyForward: 'ArrowRight',
  hotkeyIncrementWpm: 'ArrowUp',
  hotkeyDecrementWpm: 'ArrowDown',
  hotkeyQuit: 'Escape',
  enableSlowStart: true, // Enable slow start by default
  enableAcceleration: false,
  accelerationDuration: 30,
  accelerationTargetWpm: 600, // Increased from 450 (Stutter suggests 600-800)
  skipCodeBlocks: true,
  skipTables: true,
  readInlineMaths: true,
  skipTagLines: true,
  skipLinkLines: true,
  skipReferences: true,
  noteExcludedSections: [],
  pdfIncludeTitle: true,
  pdfIncludeCaptions: true,
  pdfSkipFrontMatter: true,
  pdfSkipFootnotes: true,
  pdfStopAtReferences: false,
  pdfExcludedSections: DEFAULT_EXCLUDED_SECTIONS
};

export interface HeadingInfo {
  /** Heading level (1-6); a callout ranks below every heading, at 7 */
  level: number;
  /** How many headings this one is nested under: its indentation in the outline */
  depth: number;
  /** Heading text (without [H1] or [CALLOUT:type] marker) */
  text: string;
  /** Word index where this heading appears */
  wordIndex: number;
  /** Callout type if this is a callout (note, abstract, info, etc.) */
  calloutType?: string;
}

export interface HeadingContext {
  /** The headings the word stands under, from H1 down to the current heading */
  path: HeadingInfo[];
  /** Current heading (last item in the path) */
  current: HeadingInfo | null;
}

export interface WordChunk {
  text: string;
  index: number;
  delay: number;
  isEnd: boolean;
  /** The heading (its level, 1 to 6) or callout title (level 0, with the callout's type) the word is part of */
  title?: { level: number; calloutType?: string };
  /** Current heading context (the path of headings) - optional */
  headingContext?: HeadingContext;
}
