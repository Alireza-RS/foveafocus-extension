/**
 * @file constants.ts
 * @description Constants - Centralized CSS classes, timing, limits, and magic values
 *
 * PURPOSE
 * ───────
 * Eliminates hardcoded strings and magic numbers scattered throughout the codebase.
 * Provides a single source of truth for all configuration values.
 *
 * **Problem Solved**: Before extraction, rsvp-view.ts and other files contained
 * 50+ magic strings and numbers (e.g., 'foveafocus-btn', 300ms delays, min/max limits).
 * This caused:
 * - Inconsistency: Same values duplicated with slight variations
 * - Hard to maintain: Changing a CSS class required finding all occurrences
 * - Error-prone: Typos in string literals only discovered at runtime
 *
 * **Solution**: Centralize all constants in one file:
 * - CSS class names (CSS_CLASSES)
 * - Timing delays (TIMING)
 * - Text length limits (TEXT_LIMITS)
 * - Control increments (INCREMENTS)
 * - Value ranges (LIMITS)
 * - UI icons (ICONS)
 * - Heading multipliers (HEADING_MULTIPLIERS)
 *
 * ARCHITECTURE
 * ────────────
 * **Const Assertions**: All exports use `as const` to:
 * - Make values readonly (TypeScript enforces immutability)
 * - Enable literal type inference (e.g., 'foveafocus-btn' not just string)
 * - Provide better IDE autocomplete
 *
 * **Naming Convention**:
 * - ALL_CAPS for exported constant objects
 * - camelCase for properties within objects
 * - Semantic names that describe usage, not implementation
 *
 * **Organization**:
 * Each constant group is organized by domain:
 * - UI structure (CSS_CLASSES)
 * - Behavior timing (TIMING)
 * - Content validation (TEXT_LIMITS)
 * - User interactions (INCREMENTS, LIMITS)
 * - Visual elements (ICONS, HEADING_MULTIPLIERS)
 *
 * OUTLINE
 * ───────
 * ├─ 1. CSS_CLASSES - All CSS class names used in the plugin
 * ├─ 2. TIMING - Delays and durations in milliseconds
 * ├─ 3. TEXT_LIMITS - Minimum text lengths for various operations
 * ├─ 4. INCREMENTS - Default increment/decrement amounts for controls
 * ├─ 5. LIMITS - Min/max ranges for settings
 * ├─ 6. ICONS - Lucide icons for buttons
 * ├─ 7. HEADING_MULTIPLIERS - Font size multipliers for markdown headings
 * ├─ 8. FOCUS_BAND - Measures of the band the word is read in
 * └─ 9. LINK - What is taken for a link
 *
 * @version 1.3.1
 */

// ============================================================================
// 1. CSS_CLASSES - All CSS class names
// ============================================================================

/**
 * CSS class names used throughout the plugin
 *
 * Centralized to prevent typos and enable consistent styling.
 * When adding new UI elements, add their class names here.
 */
export const CSS_CLASSES = {
  // Main container
  container: 'foveafocus-container',

  // Toggle bar
  toggleBar: 'foveafocus-toggle-bar',
  toggleBtn: 'foveafocus-toggle-btn',

  // Display area
  display: 'foveafocus-display',
  word: 'foveafocus-word',
  welcome: 'foveafocus-welcome',
  highlight: 'foveafocus-highlight',

  // Context
  contextBefore: 'foveafocus-context-before',
  contextAfter: 'foveafocus-context-after',

  // Progress
  progressContainer: 'foveafocus-progress-container',

  // Controls
  controlGroup: 'foveafocus-control-group',
  controlLabel: 'control-label',

  // Settings
  settings: 'foveafocus-settings',
  settingGroup: 'foveafocus-setting-group',

  // Buttons
  btn: 'foveafocus-btn',
  playBtn: 'play-btn',
  pauseBtn: 'pause-btn',
  smallBtn: 'small-btn',

  // Value displays
  wpmValue: 'wpm-value',
  typedNumber: 'foveafocus-row-number',

  // State classes
  hidden: 'hidden',
} as const;

// ============================================================================
// 2. TIMING - Delays and durations
// ============================================================================

/**
 * Timing constants in milliseconds
 *
 * Used for delays, debouncing, throttling, and transitions.
 * Balances responsiveness with performance.
 */
export const TIMING = {
  /** Delay before auto-loading content from editor (file-open event) */
  autoLoadDelay: 300,
  /** Shorter delay for leaf-change events (editor already active) */
  autoLoadDelayShort: 200,
  /** Very short delay for immediate operations */
  autoLoadDelayVeryShort: 50,
  /** Throttle interval for cursor/selection checks (prevents excessive checks) */
  throttleDelay: 150,
} as const;

// ============================================================================
// 3. TEXT_LIMITS - Minimum text lengths
// ============================================================================

/**
 * Minimum text lengths for various operations
 *
 * Prevents loading empty or too-short content that wouldn't be useful for reading.
 */
export const TEXT_LIMITS = {
  /** Minimum characters in full document to load */
  minContentLength: 50,
  /** Minimum words in parsed text to display */
  minParsedLength: 10,
} as const;

// ============================================================================
// 4. INCREMENTS - Control increment amounts
// ============================================================================

/**
 * Default increment/decrement amounts for controls
 *
 * Used by +/- buttons to adjust values. Values chosen for good UX:
 * - WPM: 25 provides noticeable speed change
 * - Chunk size: 1 for fine-grained control
 * - Font size: 4 for visible but not jarring changes
 */
export const INCREMENTS = {
  /** WPM increment (25 = noticeable speed change) */
  wpm: 25,
  /** Chunk size increment (1 word at a time) */
  chunkSize: 1,
  /** Font size increment in pixels (4px = visible change) */
  fontSize: 4,
  contextLines: 1,
} as const;

// ============================================================================
// 5. LIMITS - Min/max ranges for settings
// ============================================================================

/**
 * Range limits for settings validation
 *
 * Prevents users from setting values that would cause poor UX:
 * - Too fast WPM (>2000) = 30 ms a word, two frames of a common screen
 * - Too slow WPM (<50) = frustrating
 * - Font size must fit viewport
 */
export const LIMITS = {
  /** Font size range in pixels (20 = readable minimum, 120 = fills viewport) */
  fontSize: { min: 20, max: 120 },
  /** On a phone the text may be smaller */
  mobileFontSize: { min: 12, max: 120 },
  /** WPM range (50 = very slow, 2000 = as fast as a screen shows every word for more than a frame) */
  wpm: { min: 50, max: 2000 },
  /** Words shown at once */
  chunkSize: { min: 1, max: 5 },
  contextLines: { min: 0, max: 10 },
  contextFontSize: { min: 10, max: 32 },
  /** The smallest size a long word is made, in pixels */
  minTokenFontSize: { min: 8, max: 48 },
  /** Seconds before reading starts by itself */
  autoStartDelay: { min: 1, max: 10 },
  /** Seconds the climb to a higher speed takes */
  accelerationDuration: { min: 10, max: 120 },
  /** Characters up to which a selection only marks where to start */
  ownSelectionLength: { min: 0, max: 200 },
} as const;

// ============================================================================
// 6. ICONS - Lucide icons for buttons
// ============================================================================

/**
 * Names of the Lucide icons used in UI buttons and displays
 */
export const ICONS = {
  play: 'lucide:play',
  pause: 'lucide:pause',
  increment: 'lucide:plus',
  decrement: 'lucide:minus',
  settings: 'lucide:settings',
  close: 'lucide:x',
  file: 'lucide:file-text',
} as const;

// ============================================================================
// 7. HEADING_MULTIPLIERS - Font size for markdown headings
// ============================================================================

/**
 * Font size multipliers for markdown headings (H1-H6)
 *
 * Applied to base font size when displaying headings during RSVP reading.
 * Provides visual hierarchy that matches markdown document structure.
 *
 * Example: If base font is 48px:
 * - H1 displays at 72px (1.5x)
 * - H2 displays at 62.4px (1.3x)
 * - H3 displays at 57.6px (1.2x)
 * - etc.
 */
export const HEADING_MULTIPLIERS = {
  /** H1 heading multiplier (1.5x base font = major section) */
  h1: 1.5,
  /** H2 heading multiplier (1.3x base font) */
  h2: 1.3,
  /** H3 heading multiplier (1.2x base font) */
  h3: 1.2,
  /** H4 heading multiplier (1.1x base font) */
  h4: 1.1,
  /** H5 heading multiplier (1.05x base font) */
  h5: 1.05,
  /** H6 heading multiplier (1x base font = same as body text) */
  h6: 1.0,
} as const;

// ============================================================================
// 8. FOCUS_BAND - Measures of the band the word is read in
// ============================================================================

/**
 * Measures of the focus band: the two lines the word is read between, each with a tick
 * that marks the letter the eye rests on.
 *
 * The band is fitted to the font and its size, never to the word, and every measure of it
 * is a part of the font size, so that it looks the same round small text as round large.
 * Between the ticks the letters of the font get their own height and `clearance` above and
 * below.
 */
export const FOCUS_BAND = {
  /** Length of a tick, as a part of the font size */
  tickRatio: 1 / 3,
  /** Room between the letters and a tick, as a part of the font size */
  clearance: 0.2,
  /** Pixels kept free between any ink and a tick or a line: a browser paints a little past what it measures */
  spare: 3,
  /** The most of the height of the window that the band may take */
  share: 0.4,
} as const;

// ============================================================================
// 9. LINK - What is taken for a link
// ============================================================================

/**
 * A link: a word with a web address in it. It is not read letter by letter, so it is
 * neither made small to be shown whole nor held the longer for its length.
 */
export const LINK = /:\/\/|^[^A-Za-z0-9]*www\./i;
