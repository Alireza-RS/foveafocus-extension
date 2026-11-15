/**
 * @file ui-builders.ts
 * @description Reusable UI component factories for FoveaFocus
 *
 * PURPOSE:
 * Provides a collection of factory functions for building consistent,
 * reusable UI components. Eliminates 150+ lines of duplicated control-building
 * code across the view, enforcing consistent styling and behavior.
 *
 * DESIGN PRINCIPLES:
 * - Configuration objects over multiple parameters
 * - Optional DOM registry integration for automatic updates
 * - Consistent return types (container + specific elements)
 * - CSS class constants for styling consistency
 *
 * OUTLINE:
 * ├─ 1. IMPORTS & TYPE DEFINITIONS
 * │  ├─ Configuration interfaces
 * │  └─ Return type interfaces
 * ├─ 2. BASIC UI COMPONENTS
 * │  ├─ createButton() - Icon buttons
 * │  ├─ createNumberControl() - Increment/decrement controls
 * │  └─ createToggleControl() - Switches
 * └─ 3. PLAYBACK CONTROLS
 *    ├─ createPlayPauseButtons() - Dual button for play/pause
 *    └─ updatePlayPauseButtons() - Update button visibility
 *
 * @version 2.0.0
 */

// ============================================================================
// SECTION 1: IMPORTS & TYPE DEFINITIONS
// ============================================================================

import { CSS_CLASSES, ICONS } from './constants';
import { setIcon, ToggleComponent } from "obsidian";
import { DOMRegistry, DOMElementKey } from './dom-registry';

// ──────────────────────────────────────────────────────────────────────
// Button Configuration
// ──────────────────────────────────────────────────────────────────────

/**
 * Configuration for creating a button
 */
export interface ButtonConfig {
  /** Icon to display */
  icon: string;
  /** Tooltip text */
  title: string;
  /** Click handler */
  onClick: () => void;
  /** Optional additional CSS class */
  className?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Number Control Configuration
// ──────────────────────────────────────────────────────────────────────

/**
 * Configuration for creating a number control (increment/decrement)
 */
export interface NumberControlConfig {
  /** Label text (e.g., "WPM: ") */
  label: string;
  /** Current value, or a word that stands for it */
  value: number | string;
  /** Handler for increment button */
  onIncrement: () => void;
  /** Handler for decrement button */
  onDecrement: () => void;
  /** Increment amount (for tooltip) */
  increment?: number;
  /** Key for DOM registry auto-update */
  registryKey?: DOMElementKey;
  /** Custom icon for decrement button */
  decrementIcon?: string;
  /** Custom icon for increment button */
  incrementIcon?: string;
  /** Custom tooltip for decrement button */
  decrementTitle?: string;
  /** Custom tooltip for increment button */
  incrementTitle?: string;
  /** Handler for a number typed where the value is shown; with it the value stands in a field that can be typed over */
  onTyped?: (typed: number) => void;
  /** The most characters a typed value comes to, which is the width of its field */
  typedLength?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Toggle Control Configuration
// ──────────────────────────────────────────────────────────────────────

/**
 * Configuration for creating a toggle (a switch)
 */
export interface ToggleControlConfig {
  /** Label text */
  label: string;
  /** Initial checked state */
  checked: boolean;
  /** Handler when value changes */
  onChange: (checked: boolean) => void;
}

// ============================================================================
// SECTION 2: BASIC UI COMPONENTS
// ============================================================================

/**
 * Creates a button element with consistent styling
 *
 * Creates an icon button with Obsidian-compatible styling and event handling.
 * Used throughout the UI for actions like play, pause, rewind, etc.
 *
 * @param parent - Parent element to append button to
 * @param config - Button configuration
 * @returns Created button element
 *
 * @example
 * ```typescript
 * createButton(container, {
 *   icon: ICONS.play,
 *   title: 'Play (Space)',
 *   onClick: () => engine.play(),
 *   className: 'play-btn'
 * });
 * ```
 */
export function createButton(parent: HTMLElement, config: ButtonConfig): HTMLButtonElement {
  const className = config.className || CSS_CLASSES.btn;

  const btn = parent.createEl("button", {
    cls: className,
    attr: {
      "aria-label": config.title,
      type: "button",
    },
  });

  // Icon handling:
  // - "lucide:play" -> renders Obsidian/Lucide SVG (monochrome, uses currentColor)
  // - anything else -> falls back to text (existing behavior)
  if (config.icon?.startsWith("lucide:")) {
    setIcon(btn, config.icon.slice("lucide:".length));
  } else if (config.icon) {
    btn.setText(config.icon);
  }

  btn.addEventListener("click", config.onClick);
  return btn;
}

/**
 * Creates a number control with increment/decrement buttons
 *
 * Builds a control group with label, decrement button, value display, and
 * increment button. Commonly used for WPM, font size, chunk size controls.
 * Eliminates ~30 lines of duplicated code per control.
 *
 * @param parent - Parent element to append control to
 * @param config - Number control configuration
 * @param registry - Optional DOM registry for auto-update
 * @returns Object with container and value element
 *
 * @example
 * ```typescript
 * createNumberControl(panel, {
 *   label: 'Speed',
 *   value: 300,
 *   onIncrement: () => changeWpm(25),
 *   onDecrement: () => changeWpm(-25),
 *   registryKey: 'wpmValue'
 * }, domRegistry);
 * ```
 */
export function createNumberControl(
  parent: HTMLElement,
  config: NumberControlConfig,
  registry?: DOMRegistry
): { container: HTMLElement; valueEl: HTMLElement; decrementBtn: HTMLButtonElement; incrementBtn: HTMLButtonElement } {
  const container = parent.createDiv({ cls: CSS_CLASSES.controlGroup });

  // Label
  container.createEl('span', {
    text: config.label,
    cls: CSS_CLASSES.controlLabel
  });

  // Decrement button
  const decrementBtn = createButton(container, {
    icon: config.decrementIcon || ICONS.decrement,
    title: config.decrementTitle || `Decrease (-${config.increment || 1})`,
    onClick: config.onDecrement,
    className: CSS_CLASSES.smallBtn
  });

  // Value display: a field where the number can be typed over, plain text otherwise
  const valueEl = config.onTyped
    ? createTypedValue(container, config, config.onTyped)
    : container.createEl('span', {
        text: String(config.value),
        cls: config.registryKey || 'value-display'
      });

  // Register in DOM registry if key provided
  if (config.registryKey && registry) {
    registry.register(config.registryKey, valueEl);
  }

  // Increment button
  const incrementBtn = createButton(container, {
    icon: config.incrementIcon || ICONS.increment,
    title: config.incrementTitle || `Increase (+${config.increment || 1})`,
    onClick: config.onIncrement,
    className: CSS_CLASSES.smallBtn
  });

  return { container, valueEl, decrementBtn, incrementBtn };
}

/**
 * Creates the field a number control shows its value in where the number can be typed. A
 * click in the field marks the number, so that what is typed takes its place. Enter sets
 * it and leaves the field, which gives the keys back to the reader; that Enter itself is
 * kept from the reader's keys.
 */
function createTypedValue(container: HTMLElement, config: NumberControlConfig, onTyped: (typed: number) => void): HTMLInputElement {
  const field = container.createEl('input', {
    type: 'text',
    value: String(config.value),
    cls: [config.registryKey || 'value-display', CSS_CLASSES.typedNumber],
    attr: { inputmode: 'numeric', 'aria-label': config.label },
  });
  field.setCssProps({ '--foveafocus-number-length': String(config.typedLength ?? 3) });
  field.addEventListener('focus', () => field.select());
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.stopPropagation();
    field.blur();
  });
  field.addEventListener('change', () => onTyped(parseFloat(field.value)));
  return field;
}

/**
 * Creates a toggle control: the name of a setting with the app's switch beside it, as a
 * switch stands in the settings tab.
 *
 * @param parent - Parent element to append toggle to
 * @param config - Toggle configuration
 * @returns The switch, which can be set again when the setting is changed elsewhere
 *
 * @example
 * ```typescript
 * createToggleControl(panel, {
 *   label: 'Ease in',
 *   checked: settings.enableSlowStart,
 *   onChange: (checked) => {
 *     settings.enableSlowStart = checked;
 *   }
 * });
 * ```
 */
export function createToggleControl(
  parent: HTMLElement,
  config: ToggleControlConfig
): ToggleComponent {
  const container = parent.createDiv({ cls: CSS_CLASSES.settingGroup });
  container.createEl('span', { text: config.label, cls: CSS_CLASSES.controlLabel });
  return new ToggleComponent(container).setValue(config.checked).onChange(config.onChange);
}

// ============================================================================
// SECTION 3: PLAYBACK CONTROLS
// ============================================================================

/**
 * Creates play and pause buttons with visibility toggle
 *
 * Creates two buttons (play and pause) that toggle visibility based on
 * playback state. Only one is visible at a time.
 *
 * @param parent - Parent element to append buttons to
 * @param onPlay - Handler for play button click
 * @param onPause - Handler for pause button click
 * @param registry - DOM registry for button references
 *
 * @example
 * ```typescript
 * createPlayPauseButtons(
 *   controlsPanel,
 *   () => engine.play(),
 *   () => engine.pause(),
 *   domRegistry
 * );
 * ```
 */
export function createPlayPauseButtons(
  parent: HTMLElement,
  onPlay: () => void,
  onPause: () => void,
  registry: DOMRegistry
): void {
  const playBtn = createButton(parent, {
    icon: ICONS.play,
    title: 'Play (Space)',
    onClick: onPlay,
    className: `${CSS_CLASSES.toggleBtn} ${CSS_CLASSES.playBtn}`,
  });

  const pauseBtn = createButton(parent, {
    icon: ICONS.pause,
    title: 'Pause (Space)',
    onClick: onPause,
    className: `${CSS_CLASSES.toggleBtn} ${CSS_CLASSES.pauseBtn} ${CSS_CLASSES.hidden}`,
  });

  registry.register('playBtn', playBtn);
  registry.register('pauseBtn', pauseBtn);
}

/**
 * Updates play/pause button visibility based on playing state
 *
 * Shows pause button when playing, shows play button when paused.
 *
 * @param registry - DOM registry containing button references
 * @param isPlaying - Whether currently playing
 *
 * @example
 * ```typescript
 * updatePlayPauseButtons(domRegistry, engine.isPlaying());
 * ```
 */
export function updatePlayPauseButtons(
  registry: DOMRegistry,
  isPlaying: boolean
): void {
  registry.toggleClass('playBtn', CSS_CLASSES.hidden, isPlaying);
  registry.toggleClass('pauseBtn', CSS_CLASSES.hidden, !isPlaying);
}
