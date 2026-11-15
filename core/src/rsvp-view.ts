/**
 * @file rsvp-view.ts
 * @description Main view component for FoveaFocus RSVP speed reading
 *
 * ARCHITECTURE:
 * This view implements a clean separation of concerns using utility classes:
 * - ViewState: Centralized reactive state management with event emission
 * - DOMRegistry: Efficient DOM element caching and batch updates
 * - AutoLoadManager: Automatic text loading from editor with cursor tracking
 * - UI Builders: Reusable component factories for consistent UI
 *
 * OUTLINE:
 * ├─ 1. IMPORTS & CONSTANTS
 * ├─ 2. CLASS DEFINITION
 * │  ├─ Properties & Constructor
 * │  └─ Obsidian View Lifecycle
 * ├─ 3. UI CONSTRUCTION
 * │  ├─ buildUI() orchestrator
 * │  ├─ buildToggleBar()
 * │  ├─ buildDisplayArea()
 * │  ├─ buildProgressBar()
 * │  ├─ buildControls()
 * │  └─ buildInlineSettings()
 * ├─ 4. USER INTERACTIONS
 * │  ├─ changeValue() - Unified value changes
 * │  ├─ togglePanel() - Panel visibility
 * │  ├─ toggleContextDisplay()
 * │  └─ openInNewTab() - Open in fullscreen tab
 * ├─ 5. AUTO-LOAD SYSTEM
 * │  └─ setupAutoLoad() - Event registration
 * ├─ 6. HOTKEYS & KEYBOARD
 * │  ├─ setupHotkeys()
 * │  ├─ handleKeyPress()
 * │  └─ togglePlay()
 * ├─ 7. READING ENGINE CALLBACKS
 * │  ├─ onWordChange()
 * ├─ 8. TEXT LOADING
 * │  └─ loadText() - Main text loading method
 * └─ 9. SETTINGS & LIFECYCLE
 *    ├─ updateSettings()
 *    └─ onClose()
 *
 * @version 2.0.0 - Refactored for maintainability
 */

// ============================================================================
// SECTION 1: IMPORTS & CONSTANTS
// ============================================================================

import { Modal, App, EventRef, Platform, ToggleComponent } from "obsidian";
import { RSVPEngine } from './rsvp-engine';
import { FoveaFocusSettings, WordChunk, HeadingInfo } from './types';
import { parseMarkdown, tokenAtOffset } from './markdown-parser';
import { markdownFilters } from './filters';
import { ViewState } from './view-state';
import { DOMRegistry } from './dom-registry';
import { OutlineManager } from './outline-manager';
import { Turn, WordDisplay } from './word-display';
import { HotkeyHandler } from './hotkey-handler';
import { TimeoutManager } from './services/timeout-manager';
import { cssFontFamily } from './services/font-setting';
import {
  createButton,
  createNumberControl,
  createToggleControl,
  createPlayPauseButtons,
  updatePlayPauseButtons,
} from './ui-builders';
import {
  CSS_CLASSES,
  ICONS,
  TIMING,
  TEXT_LIMITS,
  INCREMENTS,
  LIMITS,
} from './constants';
import { AutoLoadManager, isNavigationKey, isSelectionKey } from './auto-load-manager';

// ============================================================================
// SECTION 2: CLASS DEFINITION
// ============================================================================

/**
 * Main view component for FoveaFocus RSVP speed reading
 *
 * Implements Obsidian's ItemView interface to provide a custom view for
 * displaying text word-by-word at configurable speeds (WPM).
 *
 * @extends ItemView
 */
export class FoveaFocusView extends Modal {

public isOpen = false;
private onModalClose?: () => void;
private onSettingsSave?: () => void;
private onContextRoom?: (lines: number, mobile: boolean) => void;

// debounce handle (so we don't write data.json 30 times in a second)
private _saveSettingsTimer: number | null = null;
  // ──────────────────────────────────────────────────────────────────────
  // Core Dependencies
  // ──────────────────────────────────────────────────────────────────────

  /** RSVP reading engine - handles word iteration and timing */
  private engine: RSVPEngine;

  /** Plugin settings (WPM, font size, colors, etc.) */
  private settings: FoveaFocusSettings;

  /** Centralized reactive state manager */
  private state: ViewState;

  /** DOM element registry for efficient updates */
  private dom: DOMRegistry;

  /** Automatic text loading from editor */
  private autoLoadManager: AutoLoadManager;

  /** The outline at the top: the path of headings and the menu of all of them */
  private outlineManager: OutlineManager;

  /** Word display manager */
  private wordDisplay: WordDisplay;

  /** Hotkey handler */
  private hotkeyHandler: HotkeyHandler;

  /** Timeout manager for preventing memory leaks */
  private timeoutManager: TimeoutManager;

  // ──────────────────────────────────────────────────────────────────────
  // DOM Element References
  // ──────────────────────────────────────────────────────────────────────

  /** Main container element */
  private mainContainerEl: HTMLElement;

  /** Toggle buttons bar (settings) */
  private toggleBar: HTMLElement;

  /** Main word display area */
  private wordEl: HTMLElement;

  /** Context before current word */
  private contextBeforeEl: HTMLElement;

  /** Context after current word */
  private contextAfterEl: HTMLElement;

  /** Settings panel (inline configuration) */
  private settingsEl: HTMLElement;

  /** Progress bar container */
  private progressEl: HTMLElement;

  /** The outline bar, showing the headings the word stands under */
  private outlineEl: HTMLElement;

  private isInitialized = false;

  private pendingLoad:
    | {
        text: string;
        isPlain?: boolean;
        source?: { fileName?: string; lineNumber?: number; cursorPosition?: number };
      }
    | null = null;

  private skipInitialAutoLoad = false;

  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  private _domUnsubs: Array<() => void> = [];

  // Keep existing call sites working:
  private _eventUnsubs: Array<() => void> = [];

  private registerEvent(emitter: { offref: (ref: EventRef) => void }, ref: EventRef): void {
    this._eventUnsubs.push(() => {
      try {
        emitter.offref(ref);
      } catch {
        // ignore
      }
    });
  }

  private registerDomEvent(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    target.addEventListener(type, listener, options);
    this._domUnsubs.push(() => target.removeEventListener(type, listener, options));
  }

  private _cleanupRegistered(): void {
    for (const unsub of this._eventUnsubs) unsub();
    this._eventUnsubs = [];

    for (const unsub of this._domUnsubs) unsub();
    this._domUnsubs = [];
  }

  private headingNav = { lastTime: 0, dir: null as ('up' | 'down' | null), cursor: null as (number | null) };
  private static readonly HEADING_NAV_WINDOW_MS = 700;

  /** Track whether we paused due to opening a panel */
  private pausedByPanelOpen = false;
  private wasPlayingBeforePanelOpen = false;

  private bottomBarEl: HTMLElement;
  private mobileControlsEl: HTMLElement;

  private isMobileUI(): boolean {
    const p = Platform as any;
    if (typeof p?.isMobileApp === "boolean") return p.isMobileApp;
    if (typeof p?.isMobile === "boolean") return p.isMobile;

    const a = this.app as any;
    if (typeof a?.isMobile === "boolean") return a.isMobile;

    // fallback only
    return window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches ?? false;
  }

  private getActiveFontSize(): number {
    return this.isMobileUI() ? this.settings.mobileFontSize : this.settings.fontSize;
  }

  // Add near other fields in the class:
  private progressBarEl: HTMLProgressElement | null = null
  private isProgressBarHovering = false;
  private progressBarHoverRaf: number | null = null;
  private progressBarLastTooltipIndex: number | null = null;
  private progressInfoLeftEl: HTMLElement | null = null;
  private progressInfoRightEl: HTMLElement | null = null;

  private suppressAutoLoadUntil = 0;


  private ignoreNextDisplayToggleClick = false;

  private _contextMeasureHostEl?: HTMLElement;
  private _contextMeasureBeforeEl?: HTMLElement;
  private _contextMeasureAfterEl?: HTMLElement;
  private _contextUpdateRaf: number | null = null;
  private _pendingContextIndex: number | null = null;
  private _contextResizeObserver?: ResizeObserver;
  private suppressContextUntilPlay = true;

  /** Lines of text that the window has room for in each of the two panels round the word */
  private contextRoom = LIMITS.contextLines.max + 1;
  private contextFewerBtn: HTMLButtonElement | null = null;
  private contextMoreBtn: HTMLButtonElement | null = null;
  /** The switches of the reader's panel, each with the setting it shows */
  private panelSwitches: Array<{ toggle: ToggleComponent; reads: () => boolean }> = [];
  /** Set while the switches are brought in step with the settings: a switch that is set tells of it as if it had been pressed */
  private syncingPanel = false;

  private lastDisplayedIndex: number | null = null;

  /** The turn of a word while the reading runs, by which the display can show a long word in parts */
  private readonly turn: Turn = {
    lasts: () => this.engine.getIsPlaying(),
    times: (shares) => this.engine.timesOfParts(shares),
  };

  // ──────────────────────────────────────────────────────────────────────
  // Constructor
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Creates a new FoveaFocusView instance
   *
   * @param leaf - Obsidian workspace leaf to attach to
   * @param settings - Plugin settings
   */
  constructor(
    app: App,
    settings: FoveaFocusSettings,
    onModalClose?: () => void,
    onSettingsSave?: () => void,
    onContextRoom?: (lines: number, mobile: boolean) => void
  ) {
    super(app);
    this.settings = settings;
    this.onModalClose = onModalClose;
    this.onSettingsSave = onSettingsSave;
    this.onContextRoom = onContextRoom;

    // Initialize state manager with curyrent settings
    this.state = new ViewState({
      currentWpm: this.isMobileUI() ? settings.mobileWpm : settings.wpm,
      currentChunkSize: this.isMobileUI() ? settings.mobileChunkSize : settings.chunkSize,
      currentFontSize: this.getActiveFontSize(),
    });

    // Initialize DOM registry for efficient element updates
    this.dom = new DOMRegistry();

    // Initialize timeout manager for memory leak prevention
    this.timeoutManager = new TimeoutManager();

    // Initialize RSVP engine with callbacks
    this.engine = new RSVPEngine(
      settings,
      this.onWordChange.bind(this) as (chunk: WordChunk) => void,
      this.timeoutManager
    );

    this.engine.setUseMobileProfile(this.isMobileUI());

    // Initialize auto-load manager for editor integration
    this.autoLoadManager = new AutoLoadManager(
      this.app,
      this.loadText.bind(this) as (text: string, source?: { fileName?: string; lineNumber?: number; cursorPosition?: number }) => void,
      () => this.mainContainerEl?.isShown() ?? false,
      this.timeoutManager,
      () => this.settings.ownSelectionLength
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Obsidian View Lifecycle
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Called when the view is opened
   * Builds UI, sets up hotkeys, and registers auto-load
   */
  async onOpen(): Promise<void> {
    this.isOpen = true;
    this.contentEl.empty();              // important if reopened
    this.modalEl.addClass('foveafocus-modal');
    this.containerEl.addClass('foveafocus-modal-container');
    this.modalEl.querySelector(".modal-header")?.remove();
    this.modalEl.setAttr('tabindex', '-1');
    this.applyAppearanceCssVars();
    this.mainContainerEl = this.contentEl.createDiv({ cls: CSS_CLASSES.container });
    // Apply font family broadly (not just the focus word).
    this.applyFoveaFocusFont(this.settings.fontFamily);
    this.buildUI();
    this.engine.setUseMobileProfile(this.isMobileUI());
    this.syncBoldColorToTheme();
    this.suppressContextUntilPlay = true;
    this.toggleContextDisplay();

    // Initialize modules after UI is built
    this.outlineManager = new OutlineManager(this.outlineEl, this.engine, this.timeoutManager, {
      onPlayStateChange: (isPlaying) => {
        updatePlayPauseButtons(this.dom, isPlaying);
        if (!isPlaying) this.wordDisplay?.showWhole();
      },
      canAutoResume: () => !this.isAnyInlinePanelOpen()
    });
    this.wordDisplay = new WordDisplay(
      this.wordEl,
      this.settings,
      this.getActiveFontSize(),
      this.engine.getChunkSize()
    );
    // A font that arrives after the reader has opened gives the letters another height, and
    // a window that changes its size moves the focus mark and the room for the word.
    const refit = (): void => {
      this.wordDisplay.refresh();
      this.fitContextToWindow();
    };
    this.registerDomEvent(document.fonts, 'loadingdone', refit);
    this.registerDomEvent(window, 'resize', refit);
    this.hotkeyHandler = new HotkeyHandler(this.settings, {
      onTogglePlay: () => this.togglePlay(),
      onRewind: () => this.engine.rewindSeconds(10),
      onForward: () => this.engine.forwardSeconds(10),
      onIncrementWpm: () => this.changeValue('wpm', INCREMENTS.wpm),
      onDecrementWpm: () => this.changeValue('wpm', -INCREMENTS.wpm),
      onQuit: () => this.engine.stop()
    });
    this.engine.setUseMobileProfile(this.isMobileUI());

    // Note: don't render the welcome message immediately. Auto-load usually
    // loads content right after open, and the immediate welcome render causes
    // a visible flicker (welcome → cleared → ready).

    // Apply initial visibility settings
    this.toggleOutlineDisplay();
    this.fitContextToWindow();
    this.setupOutsideClickToClosePanels();
    this.defocusInteractiveElements();
    requestAnimationFrame(() => this.defocusInteractiveElements());
    this.setupHotkeys();

    // Setup auto-load when layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.setupAutoLoad();

      const hasExplicitLoadQueued = !!this.pendingLoad || this.engine.getTotalWords() > 0;

      if (!this.skipInitialAutoLoad && !hasExplicitLoadQueued) {
        this.autoLoadManager.loadFromEditor(50); // load current note shortly after open
      }
      this.skipInitialAutoLoad = false;

      // If nothing gets auto-loaded (no active markdown view, empty doc, etc.),
      // show the welcome message after a short grace period.
      this.timeoutManager.setTimeout(() => {
        if (this.engine.getTotalWords() === 0) {
          const paletteHotkey = Platform.isMacOS ? 'Cmd+P' : 'Ctrl+P';
          this.wordDisplay.displayWelcomeMessage(
            ICONS.file,
            'Select text to start reading',
            `or use ${paletteHotkey} → "Read selected text"`
          );
          this.fitContextToWindow();
        }
      }, 500);
    });
    this.isInitialized = true;
    if (this.pendingLoad) {
      const { text, source, isPlain } = this.pendingLoad;
      this.pendingLoad = null;

      if (isPlain) this.loadPlainText(text, source);
      else this.loadText(text, source);
    }
  }

  /**
   * Called when the view is closed
   * Stops reading and cleans up resources
   */
  async onClose(): Promise<void> {
    this.isOpen = false;
    this._cleanupRegistered();

    this.engine.stop();
    this.timeoutManager.clearAll();
    this.dom.clear();

    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    this.contentEl.empty();
    this.onModalClose?.();
    this.requestSettingsSave();
  }

  // ============================================================================
  // SECTION 3: UI CONSTRUCTION
  // ============================================================================

  /**
   * Orchestrates the construction of all UI components
   * Called once during view initialization
   *
   * Order matters: toggle bar, outline, display, progress, controls, settings
   */
  private buildUI(): void {
    this.buildToggleBar();
    this.buildOutline();
    this.buildDisplayArea();
    this.buildProgressBar();
    this.buildInlineSettings();
  }

  /**
   * Builds the toggle bar with settings button
   * Located at the top of the view
   */
  private buildToggleBar(): void {
    this.toggleBar = this.mainContainerEl.createDiv({ cls: CSS_CLASSES.toggleBar });

    createButton(this.toggleBar, {
      icon: ICONS.settings,
      title: 'Settings (S)',
      onClick: () => this.togglePanel('controls'),
      className: CSS_CLASSES.toggleBtn,
    });
    // The reader is closed by a button of its own, beside the one for its settings: the app's
    // own button stands in the same corner and is not shown
    createButton(this.toggleBar, {
      icon: ICONS.close,
      title: 'Close',
      onClick: () => this.close(),
      className: CSS_CLASSES.toggleBtn,
    });
  }

  /**
   * Builds the outline bar
   * Shows the hierarchical position in the document (H1 > H2 > H3 etc.)
   * Updated automatically as reading progresses through headings
   */
  private buildOutline(): void {
    this.outlineEl = this.mainContainerEl.createDiv({
      cls: `foveafocus-outline ${CSS_CLASSES.hidden}`
    });
    // Initially empty, will be populated by updateOutline()
  }

  /**
   * Builds the main display area for word presentation
   * Includes context before/after if enabled
   */
  private buildDisplayArea(): void {
    const displayArea = this.mainContainerEl.createDiv({ cls: CSS_CLASSES.display });
    const showContextNow =
      this.getActiveShowContext() &&
      this.engine.getTotalWords() > 0 &&
      !this.suppressContextUntilPlay;
    // Tap/click anywhere in the display toggles play/pause.
    // Do not rely on 'click' here: the focus word DOM is rebuilt every tick.
    let displayPointerDown = false;
    let displayPointerMoved = false;
    let displayPointerX = 0;
    let displayPointerY = 0;
    let displayPointerId: number | null = null;
    let displayShouldToggle = false;

    const computeShouldToggle = (target: HTMLElement | null): boolean => {
      if (!target) return false;
      const clickedInWord = !!target.closest(`.${CSS_CLASSES.word}`);

      // Don’t toggle if user is interacting with controls/inputs/menus (outside the word area)
      if (!clickedInWord && target.closest('button, a, input, textarea, select, .foveafocus-outline-menu')) return false;

      return true;
    };

    (this.registerDomEvent as any)(displayArea, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;

      const shouldToggle = computeShouldToggle(e.target as HTMLElement | null);
      if (!shouldToggle) return;

      displayPointerDown = true;
      displayPointerMoved = false;
      displayPointerX = e.clientX;
      displayPointerY = e.clientY;
      displayPointerId = e.pointerId;
      displayShouldToggle = true;

      const t = e.target as HTMLElement | null;
      const startedInContext = !!t?.closest(
        `.${CSS_CLASSES.contextBefore}, .${CSS_CLASSES.contextAfter}`
      );

      if (!startedInContext) {
        try { displayArea.setPointerCapture(e.pointerId); } catch {}
      }
    }, { capture: true });

    this.registerDomEvent(
      displayArea,
      'pointermove',
      (e: PointerEvent) => {
        if (!displayPointerDown || displayPointerId !== e.pointerId) return;
        const dx = e.clientX - displayPointerX;
        const dy = e.clientY - displayPointerY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) displayPointerMoved = true;
      },
      { capture: true }
    );

    const resetDisplayPointer = (e?: PointerEvent) => {
      if (e && displayPointerId === e.pointerId) {
        try { displayArea.releasePointerCapture(e.pointerId); } catch {}
      }
      displayPointerDown = false;
      displayPointerMoved = false;
      displayPointerId = null;
      displayShouldToggle = false;
    };

    this.registerDomEvent(
      displayArea,
      'pointerup',
      (e: PointerEvent) => {
        if (displayPointerId !== e.pointerId) return;

        const shouldToggle = displayShouldToggle && !displayPointerMoved;
        resetDisplayPointer(e);

        if (!shouldToggle) return;
        if (this.ignoreNextDisplayToggleClick) {
          this.ignoreNextDisplayToggleClick = false;
          return;
        }

        this.togglePlay();
      },
      { capture: true }
    );

    this.registerDomEvent(
      displayArea,
      'pointercancel',
      (e: PointerEvent) => resetDisplayPointer(e),
      { capture: true }
    );

    let wheelAccum = 0;
    let wheelDir = 0;
    const WHEEL_THRESHOLD = 80;

    (this.registerDomEvent as any)(
      displayArea,
      'wheel',
      (e: WheelEvent) => {
        if (this.engine.getIsPlaying()) return;
        if (e.ctrlKey || e.metaKey) return; // don't fight zoom gestures

        const t = e.target as HTMLElement | null;
        if (t?.closest('button, a, input, textarea, select, .foveafocus-outline-menu')) return;

        e.preventDefault();

        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;      // lines -> px-ish
        else if (e.deltaMode === 2) dy *= 800; // pages -> px-ish

        const dir = Math.sign(dy);
        if (dir !== 0 && dir !== wheelDir) {
          wheelAccum = 0;
          wheelDir = dir;
        }

        wheelAccum += dy;

        // At most ONE word step per wheel event (prevents occasional double-steps)
        if (wheelAccum >= WHEEL_THRESHOLD) {
          wheelAccum -= WHEEL_THRESHOLD;
          // keep remainder bounded so it can’t trigger another step in the same event
          wheelAccum = Math.min(wheelAccum, WHEEL_THRESHOLD - 1);
          this.engine.stepWords(1);
        } else if (wheelAccum <= -WHEEL_THRESHOLD) {
          wheelAccum += WHEEL_THRESHOLD;
          wheelAccum = Math.max(wheelAccum, -(WHEEL_THRESHOLD - 1));
          this.engine.stepWords(-1);
        }
      },
      { passive: false, capture: true }
    );

    // Always create context nodes (toggle just hides/shows them)
    this.contextBeforeEl = displayArea.createDiv({
      cls: `${CSS_CLASSES.contextBefore} ${showContextNow ? '' : CSS_CLASSES.hidden}`,
    });
    this.dom.register('contextBeforeEl', this.contextBeforeEl);
    this.contextBeforeEl.style.whiteSpace = 'pre-wrap';
    this.applyContextLayout();

    this.wordEl = displayArea.createDiv({ cls: CSS_CLASSES.word });
    this.wordEl.style.setProperty("font-size", `${this.getActiveFontSize()}px`, "important");
    this.applyFoveaFocusFont(this.settings.fontFamily);
    this.wordEl.style.textShadow = "none";
    this.wordEl.style.filter = "none";
    this.dom.register('wordEl', this.wordEl);

    this.contextAfterEl = displayArea.createDiv({
      cls: `${CSS_CLASSES.contextAfter} ${showContextNow ? '' : CSS_CLASSES.hidden}`,
    });
    this.dom.register('contextAfterEl', this.contextAfterEl);
    this.contextAfterEl.style.whiteSpace = 'pre-wrap';
    for (const el of [this.contextBeforeEl, this.contextAfterEl]) {
      el.addEventListener('pointerenter', () => el.removeClass('foveafocus-context-held'));
    }
    this.applyContextLayout();
    // Ensure context scrolling state matches initial playback state
    this.setContextScrollEnabled(!this.engine.getIsPlaying());

    this.ensureContextMeasureHost();
    this.setupContextResizeObserver();
  }

  /**
   * Builds the progress bar at the bottom of display
   * Updates during reading to show progress
   */
  private buildProgressBar(): void {
    // Bottom bar wrapper: progress on top, controls beneath
    this.bottomBarEl = this.mainContainerEl.createDiv({ cls: "foveafocus-bottom-bar" });

    // Keep progressEl wrapper so other code doesn't break
    this.progressEl = this.bottomBarEl.createDiv({ cls: CSS_CLASSES.progressContainer });

    // Native progress element
    this.progressBarEl = this.progressEl.createEl("progress", {
      cls: "metadata-progress rsvp-progress-bar",
    }) as HTMLProgressElement;

    this.registerDomEvent(this.progressBarEl, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;

      const bar = this.progressBarEl;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ratio = rect.width > 0 ? (x / rect.width) : 0;

      const total = this.engine.getTotalWords();
      if (total <= 0) return;

      const targetIndex = Math.min(total - 1, Math.max(0, Math.floor(ratio * (total - 1))));
      const wasPlaying = this.engine.getIsPlaying();
      this.engine.jumpToIndex(targetIndex);

      this.updateBottomProgressInfo(targetIndex);

      if (!wasPlaying) {
        this.engine.pause();
        updatePlayPauseButtons(this.dom, false);
        this.setContextScrollEnabled(true);
        if (this.getActiveShowContext()) this.scheduleContextUpdate(this.getContextAnchorIndex());
      }
    }, { capture: true });

    this.registerDomEvent(this.progressBarEl, "pointerenter", (e: PointerEvent) => {
      this.isProgressBarHovering = true;
      this.progressBarLastTooltipIndex = null;
      this.updateProgressTooltipForClientX(e.clientX); // set immediately
    });

    this.registerDomEvent(this.progressBarEl, "pointermove", (e: PointerEvent) => {
      if (!this.isProgressBarHovering) return;
      this.updateProgressTooltipForClientX(e.clientX);
    });

    this.registerDomEvent(this.progressBarEl, "pointerleave", () => {
      this.isProgressBarHovering = false;
      this.progressBarLastTooltipIndex = null;

      if (this.progressBarHoverRaf !== null) {
        cancelAnimationFrame(this.progressBarHoverRaf);
        this.progressBarHoverRaf = null;
      }

      this.restoreProgressTooltipToPercent();
    });

    // Register under the same key so existing show/hide wiring doesn’t explode
    this.dom.register("progressBar", this.progressBarEl);

    // Respect setting without relying on CSS
    this.progressBarEl.style.display = this.settings.showProgress ? "" : "none";

    // Initialize values safely
    this.progressBarEl.max = Math.max(1, this.engine.getTotalWords());
    this.progressBarEl.value = Math.min(this.progressBarEl.max, this.getContextAnchorIndex() + 1);
    this.progressBarEl.setAttr("data-tooltip-position", "top");
    this.progressBarEl.setAttr("data-tooltip-delay", "0"); // immediate
    this.restoreProgressTooltipToPercent();

    // On-screen controls row
    this.buildMobileControls();
  }

  private applyAppearanceCssVars(): void {
    const root = this.modalEl;
    if (!root) return;

    const apply = (name: string, value: string) => {
      const v = (value ?? '').trim();
      // blank (or "theme") means: do not set -> CSS/theme/snippets decide
      if (!v || v.toLowerCase() === 'theme') root.style.removeProperty(name);
      else root.style.setProperty(name, v);
    };

    apply('--foveafocus-highlight-color', this.settings.highlightColor);
    apply('--foveafocus-font-color', this.settings.fontColor);
    apply('--foveafocus-background-color', this.settings.backgroundColor);
  }

  private ensureContextMeasureHost(): void {
    if (this._contextMeasureHostEl) return;

    const host = this.modalEl.createDiv();
    host.style.position = 'fixed';
    host.style.left = '-100000px';
    host.style.top = '0';
    host.style.visibility = 'hidden';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '-1';
    host.style.overflow = 'visible';

    const mk = () => {
      const el = host.createDiv();
      el.style.boxSizing = 'border-box';
      el.style.whiteSpace = 'pre-wrap';
      (el.style as any).overflowWrap = 'anywhere';
      el.style.wordBreak = 'break-word';
      return el;
    };

    this._contextMeasureHostEl = host;
    this._contextMeasureBeforeEl = mk();
    this._contextMeasureAfterEl = mk();
  }

  private syncMeasureStyle(fromEl: HTMLElement, measureEl: HTMLElement): void {
    const cs = getComputedStyle(fromEl);
    const w = fromEl.getBoundingClientRect().width;

    measureEl.style.width = `${Math.max(1, w)}px`;
    measureEl.style.padding = cs.padding;

    measureEl.style.fontFamily = cs.fontFamily;
    measureEl.style.fontSize = cs.fontSize;
    measureEl.style.fontWeight = cs.fontWeight;
    measureEl.style.lineHeight = cs.lineHeight;
    measureEl.style.letterSpacing = cs.letterSpacing;
  }

  private formatTime(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private getWrappedLinesSubset(
    text: string,
    targetEl: HTMLElement,
    measureEl: HTMLElement,
    count: number,
    mode: 'first' | 'last'
  ): string[] {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return [];

    this.syncMeasureStyle(targetEl, measureEl);
    measureEl.setText(text ?? '');

    const node = measureEl.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return mode === 'first' ? Array(n).fill('') : Array(n).fill('');
    }

    const textNode = node as Text;
    const full = textNode.data ?? '';
    const len = full.length;

    if (len === 0) {
      return mode === 'first' ? Array(n).fill('') : Array(n).fill('');
    }

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, len);

    const rects = Array.from(range.getClientRects());
    if (rects.length === 0) {
      return mode === 'first' ? Array(n).fill('') : Array(n).fill('');
    }

    // Unique visual line "tops"
    const tops: number[] = [];
    for (const r of rects) {
      const t = Math.round(r.top);
      if (!tops.length || Math.abs(t - tops[tops.length - 1]) > 1) tops.push(t);
    }

    const totalLines = tops.length;
    const startLine = mode === 'first' ? 0 : Math.max(0, totalLines - n);
    const endLineExcl = mode === 'first' ? Math.min(totalLines, n) : totalLines;

    const lastTopAt = (end: number): number => {
      const e = Math.max(0, Math.min(len, end));
      if (e === 0) return -Infinity;
      range.setStart(textNode, 0);
      range.setEnd(textNode, e);
      const rs = range.getClientRects();
      if (!rs.length) return -Infinity;
      return Math.round(rs[rs.length - 1].top);
    };

    const findStartOffsetForTop = (targetTop: number): number => {
      // Binary search smallest "end" where the last line top reaches targetTop
      let lo = 1;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const t = lastTopAt(mid);
        if (t < targetTop) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, lo - 1);
    };

    // Compute offsets for the contiguous subset of lines we want, plus the next-line start as end boundary
    const offsets: number[] = [];
    for (let i = startLine; i < endLineExcl; i++) {
      offsets.push(i === 0 ? 0 : findStartOffsetForTop(tops[i]));
    }
    const endOffset =
      endLineExcl < totalLines ? findStartOffsetForTop(tops[endLineExcl]) : len;
    offsets.push(endOffset);

    const lines: string[] = [];
    for (let i = 0; i < offsets.length - 1; i++) {
      let seg = full.slice(offsets[i], offsets[i + 1]);

      // Clean boundaries introduced by explicit '\n' or wrapping at spaces
      seg = seg.replace(/^\n+/, '');
      seg = seg.replace(/\n+$/, '');
      seg = seg.replace(/^\s+/, '');
      seg = seg.trimEnd();

      lines.push(seg);
    }

    // Pad to EXACTLY N line slots
    if (mode === 'first') {
      while (lines.length < n) lines.push('');
    } else {
      while (lines.length < n) lines.unshift('');
    }

    return lines;
  }

  private getContextAnchorIndex(): number {
    return this.lastDisplayedIndex ?? this.engine.getCurrentIndex();
  }

  private scheduleContextUpdate(index: number): void {
    this._pendingContextIndex = index;

    if (this._contextUpdateRaf !== null) return;
    this._contextUpdateRaf = window.requestAnimationFrame(() => {
      this._contextUpdateRaf = null;
      const idx = this._pendingContextIndex;
      this._pendingContextIndex = null;
      if (idx == null) return;

      this.updateContextByBrowserWrap(idx);
    });
  }

  private updateContextByBrowserWrap(wordIndex: number): void {
    if (!this.getActiveShowContext() || !this.contextBeforeEl || !this.contextAfterEl) return;

    const visibleLines = this.contextLinesShown();
    if (visibleLines === 0) return;

    this.ensureContextMeasureHost();
    if (!this._contextMeasureBeforeEl || !this._contextMeasureAfterEl) return;

    // Token window: big enough to cover 10+ wrapped lines even in wide layouts
    const windowTokens = Math.max(300, visibleLines * 80);
    const ctx = this.engine.getContextTokenWindow(wordIndex, windowTokens, windowTokens);

    const beforeText = this.renderContextTokens(ctx.before);
    const afterText = this.renderContextTokens(ctx.after);

    const beforeLines = this.getWrappedLinesSubset(
      beforeText,
      this.contextBeforeEl,
      this._contextMeasureBeforeEl,
      visibleLines,
      'last'
    );

    const afterLines = this.getWrappedLinesSubset(
      afterText,
      this.contextAfterEl,
      this._contextMeasureAfterEl,
      visibleLines,
      'first'
    );

    // These now contain explicit '\n' at the browser’s own wrap boundaries
    this.contextBeforeEl.setText(beforeLines.join('\n'));
    this.contextAfterEl.setText(afterLines.join('\n'));
  }

  private setupContextResizeObserver(): void {
    if (this._contextResizeObserver || !this.contextBeforeEl || !this.contextAfterEl) return;

    const ro = new ResizeObserver(() => {
      this.scheduleContextUpdate(this.getContextAnchorIndex());
    });

    ro.observe(this.contextBeforeEl);
    ro.observe(this.contextAfterEl);

    this._contextResizeObserver = ro;
    this._domUnsubs.push(() => {
      try { ro.disconnect(); } catch {}
    });
  }

  private buildMobileControls(): void {
    this.mobileControlsEl = this.bottomBarEl.createDiv({ cls: "foveafocus-mobile-controls" });

    const wrap = this.mobileControlsEl.createDiv({ cls: "foveafocus-mobile-controls-wrap" });

    this.progressInfoLeftEl = wrap.createSpan({
      cls: "foveafocus-progress-info foveafocus-progress-info-left",
    });

    const row = wrap.createDiv({ cls: "foveafocus-mobile-controls-row" });

    this.progressInfoRightEl = wrap.createSpan({
      cls: "foveafocus-progress-info foveafocus-progress-info-right",
    });

    this.updateBottomProgressInfo();

    createButton(row, {
      icon: "lucide:chevrons-left",
      title: "Jump to start (Ctrl+←)",
      onClick: () => { this.engine.jumpToStart(); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:arrow-up",
      title: "Previous heading (↑)",
      onClick: () => { this.jumpHeading("up"); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:arrow-left",
      title: "Back 10 seconds (←)",
      onClick: () => { this.engine.rewindSeconds(10); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createPlayPauseButtons(
      row,
      () => { if (!this.engine.getIsPlaying()) this.togglePlay(); else this.defocusInteractiveElements(); },
      () => { if (this.engine.getIsPlaying()) this.togglePlay(); else this.defocusInteractiveElements(); },
      this.dom
    );
    updatePlayPauseButtons(this.dom, this.engine.getIsPlaying());

    createButton(row, {
      icon: "lucide:arrow-right",
      title: "Forward 10 seconds (→)",
      onClick: () => { this.engine.forwardSeconds(10); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:arrow-down",
      title: "Next heading (↓)",
      onClick: () => { this.jumpHeading("down"); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:chevrons-right",
      title: "Jump to end (Ctrl+→)",
      onClick: () => { this.engine.jumpToEnd(); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });
  }

  /**
   * Builds the inline settings panel
   * Allows quick adjustments to WPM, acceleration, font size, etc.
   */
  private buildInlineSettings(): void {
    this.settingsEl = this.mainContainerEl.createDiv({
      cls: `${CSS_CLASSES.settings} ${CSS_CLASSES.hidden}`,
    });
    this.dom.register('settingsEl', this.settingsEl);

    // WPM control (duplicate for inline settings)
    createNumberControl(
      this.settingsEl,
      {
        label: 'Speed',
        value: this.engine.getWpm(),
        onIncrement: () => this.changeValue('wpm', INCREMENTS.wpm),
        onDecrement: () => this.changeValue('wpm', -INCREMENTS.wpm),
        increment: INCREMENTS.wpm,
        registryKey: 'wpmInlineValue',
        decrementTitle: 'Slower (-25)',
        incrementTitle: 'Faster (+25)',
        onTyped: (typed) => this.typeValue('wpm', typed),
        typedLength: String(LIMITS.wpm.max).length,
      },
      this.dom
    );

    // Font size control
    createNumberControl(
      this.settingsEl,
      {
        label: 'Text size',
        value: this.getActiveFontSize(),
        onIncrement: () => this.changeValue('fontSize', INCREMENTS.fontSize),
        onDecrement: () => this.changeValue('fontSize', -INCREMENTS.fontSize),
        registryKey: 'fontValue',
        decrementTitle: 'Smaller',
        incrementTitle: 'Larger',
        onTyped: (typed) => this.typeValue('fontSize', typed),
        typedLength: String(LIMITS.fontSize.max).length,
      },
      this.dom
    );

    // Chunk size control
    createNumberControl(
      this.settingsEl,
      {
        label: 'Words shown at once',
        value: this.engine.getChunkSize(),
        onIncrement: () => this.changeValue('chunkSize', INCREMENTS.chunkSize),
        onDecrement: () => this.changeValue('chunkSize', -INCREMENTS.chunkSize),
        registryKey: 'chunkValue',
      },
      this.dom
    );

    this.panelSwitches = [];
    const addSwitch = (label: string, reads: () => boolean, set: (checked: boolean) => void): void => {
      const onChange = (checked: boolean): void => {
        if (!this.syncingPanel) set(checked);
      };
      this.panelSwitches.push({ toggle: createToggleControl(this.settingsEl, { label, checked: reads(), onChange }), reads });
    };

    addSwitch('Ease in', () => (this.isMobileUI() ? this.settings.mobileEnableSlowStart : this.settings.enableSlowStart), (checked) => {
      if (this.isMobileUI()) this.settings.mobileEnableSlowStart = checked;
      else this.settings.enableSlowStart = checked;

      this.engine.updateSettings(this.settings);
      this.requestSettingsSave();
    });

    addSwitch('Pauses', () => (this.isMobileUI() ? this.settings.mobileEnableMicropause : this.settings.enableMicropause), (checked) => {
      if (this.isMobileUI()) this.settings.mobileEnableMicropause = checked;
      else this.settings.enableMicropause = checked;
      this.engine.updateSettings(this.settings);
      this.requestSettingsSave();
    });

    addSwitch('Outline', () => this.getActiveShowOutline(), (checked) => {
      this.setActiveShowOutline(checked);
      this.toggleOutlineDisplay();
      this.fitContextToWindow();
      this.requestSettingsSave();
    });

    // The lines of text round the word, in one control: off, or as many lines as stand above
    // the word and below it. No more can be asked for than the window has room for.
    const contextLines = createNumberControl(
      this.settingsEl,
      {
        label: 'Lines round the word',
        value: this.contextLinesSaid(),
        increment: INCREMENTS.contextLines,
        registryKey: 'contextLinesValue',
        decrementTitle: 'Fewer lines (-1)',
        incrementTitle: 'More lines (+1)',
        onIncrement: () => this.changeContextLines(INCREMENTS.contextLines),
        onDecrement: () => this.changeContextLines(-INCREMENTS.contextLines),
      },
      this.dom
    );
    this.contextFewerBtn = contextLines.decrementBtn;
    this.contextMoreBtn = contextLines.incrementBtn;
  }

  /** The most extra lines that can be asked for: what the settings allow and the window has room for */
  private mostContextLines(): number {
    return Math.max(0, Math.min(LIMITS.contextLines.max, this.contextRoom - 1));
  }

  /** What the control for the lines round the word says: how many stand above the word and below it, or that none do */
  private contextLinesSaid(): string {
    if (!this.getActiveShowContext()) return 'Off';
    if (this.contextRoom === 0) return 'No room';
    return String(Math.min(this.getActiveContextLines(), this.mostContextLines()) + 1);
  }

  /** A step on the control for the lines round the word: off lies one step under a single line */
  private changeContextLines(delta: number): void {
    const most = this.mostContextLines();
    if (!this.getActiveShowContext()) {
      if (delta < 0 || this.contextRoom === 0) return;
      this.setActiveShowContext(true);
      this.setActiveContextLines(0);
      // Lines that are asked for here are shown at once, also where the reading has not started
      this.suppressContextUntilPlay = false;
    } else {
      const next = Math.min(this.getActiveContextLines(), most) + delta;
      if (next < 0) this.setActiveShowContext(false);
      else this.setActiveContextLines(Math.min(most, next));
    }

    this.applyContextLayout();
    this.toggleContextDisplay();
    this.syncContextControls();
    if (this.getActiveShowContext()) {
      this.scheduleContextUpdate(this.getContextAnchorIndex());
    }
    this.requestSettingsSave();
  }

  /**
   * Shows in the reader's panel the settings as they are, for those that were changed
   * elsewhere while the reader is open: in the settings tab, which the app may show in a
   * window of its own beside the reader.
   */
  private syncPanel(): void {
    const wpm = this.engine.getWpm();
    this.state.update({ currentWpm: wpm, currentChunkSize: this.engine.getChunkSize(), currentFontSize: this.getActiveFontSize() });
    this.dom.updateMultipleText({ wpmValue: String(wpm), wpmInlineValue: String(wpm) });
    this.dom.updateText('fontValue', this.getActiveFontSize());
    this.dom.updateText('chunkValue', this.engine.getChunkSize());
    this.syncingPanel = true;
    for (const { toggle, reads } of this.panelSwitches) {
      if (toggle.getValue() !== reads()) toggle.setValue(reads());
    }
    this.syncingPanel = false;
  }

  /** Shows in the inline settings what the window has room for; what it has no room for cannot be chosen */
  private syncContextControls(): void {
    const most = this.mostContextLines();
    const shown = this.getActiveShowContext();
    const full = this.contextRoom === 0 || (shown && this.getActiveContextLines() >= most);
    this.dom.updateText('contextLinesValue', this.contextLinesSaid());

    if (this.contextFewerBtn) this.contextFewerBtn.disabled = !shown;
    if (this.contextMoreBtn) {
      this.contextMoreBtn.disabled = full;
      this.contextMoreBtn.setAttr('aria-label', full && most < LIMITS.contextLines.max ? 'No room for more lines' : 'More lines (+1)');
    }
  }

  private syncBoldColorToTheme(): void {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.innerHTML = '<strong>probe</strong>';

    this.modalEl.appendChild(probe);

    const strongEl = probe.querySelector('strong') as HTMLElement | null;
    const boldColor = strongEl ? getComputedStyle(strongEl).color : '';

    probe.remove();
  
    if (boldColor) {
      this.modalEl.style.setProperty('--foveafocus-bold-color', boldColor);
    }
  }

  private setContextScrollEnabled(enabled: boolean): void {
    const before = this.contextBeforeEl;
    const after = this.contextAfterEl;

    for (const el of [before, after]) {
      if (!el) continue;
      // As the lines are dimmed, neither side shows through before the pointer comes onto it: the pointer may be on
      // one side already, from the click or the tap that started the reading
      const dims = !enabled && !el.hasClass('foveafocus-context-scrollable-off');
      el.toggleClass('foveafocus-context-scrollable-on', enabled);
      el.toggleClass('foveafocus-context-scrollable-off', !enabled);
      if (dims) el.addClass('foveafocus-context-held');
      if (enabled) el.removeClass('foveafocus-context-held');
    }
  }

  private requestSettingsSave(): void {
    if (!this.onSettingsSave) return;

    if (this._saveSettingsTimer !== null) {
      this.timeoutManager.clearTimeout(this._saveSettingsTimer);
    }

    this._saveSettingsTimer = this.timeoutManager.setTimeout(() => {
      this._saveSettingsTimer = null;
      try {
        this.onSettingsSave?.();
      } catch {
        // ignore
      }
    }, 200);
  }

  // ============================================================================
  // SECTION 4: USER INTERACTIONS
  // ============================================================================

  /**
   * Unified value change handler
   * Replaces 5 separate change functions (changeWpm, changeWpmInline, etc.)
   *
   * @param type - Type of value to change
   * @param delta - Amount to change (positive or negative)
   */
  private changeValue(
    type: 'wpm' | 'chunkSize' | 'fontSize',
    delta: number
  ): void {
    switch (type) {
      case 'wpm': {
        const newWpm = this.engine.getWpm() + delta;
        this.engine.setWpm(newWpm);
        const wpm = this.engine.getWpm();
        this.state.set('currentWpm', wpm);

        this.dom.updateMultipleText({
          wpmValue: String(wpm),
          wpmInlineValue: String(wpm),
        });
        break;
      }

      case 'chunkSize': {
        const newSize = this.engine.getChunkSize() + delta;
        this.engine.setChunkSize(newSize);
        const size = this.engine.getChunkSize();
        this.state.set('currentChunkSize', size);
        this.dom.updateText('chunkValue', size);
        this.wordDisplay?.setChunkSize(size);
        break;
      }

      case 'fontSize': {
        const key: 'mobileFontSize' | 'fontSize' = this.isMobileUI() ? 'mobileFontSize' : 'fontSize';
        const next = Math.max(
          LIMITS[key].min,
          Math.min(LIMITS[key].max, this.settings[key] + delta)
        );

        this.settings[key] = next;
        this.state.set('currentFontSize', next);
        if (this.wordEl) this.wordEl.style.fontSize = `${next}px`;
        this.dom.updateText('fontValue', next);
        this.wordDisplay?.setBaseFontSize(next);
        this.fitContextToWindow();
        break;
      }
    }

    // Save after a successful change (NOT inside the switch body)
    this.requestSettingsSave();
  }

  /**
   * A number typed in the reader's panel is set as near as its steps and its limits allow,
   * and the panel then shows what it has been set to.
   */
  private typeValue(type: 'wpm' | 'fontSize', typed: number): void {
    if (isNaN(typed)) {
      this.syncPanel();
      return;
    }
    const now = type === 'wpm' ? this.engine.getWpm() : this.getActiveFontSize();
    this.changeValue(type, Math.round(typed / INCREMENTS[type]) * INCREMENTS[type] - now);
  }

  /**
   * Unified panel toggle handler
   * Replaces 3 separate toggle functions (toggleControls, etc.)
   *
   * @param panel - Panel to toggle ('controls')
   */
  private togglePanel(panel: 'controls' ): void {
    const wasAnyOpen = this.isAnyInlinePanelOpen();

    if (panel === 'controls') {
      this.state.toggle('showingControls');
      const showing = this.state.get('showingControls');
      this.settingsEl.toggleClass(CSS_CLASSES.hidden, !showing);
      this.makeRoomForPanel();
    }

    const isAnyOpenNow = this.isAnyInlinePanelOpen();

    // If we just opened any panel, pause playback (and remember state)
    if (!wasAnyOpen && isAnyOpenNow) {
      this.pausePlaybackForInlinePanel();
    }

    // If we just closed the last open panel, resume if we paused for panels
    if (wasAnyOpen && !isAnyOpenNow) {
      this.resumePlaybackAfterInlinePanelsClose();
    }

    this.defocusInteractiveElements();
  }

  private isAnyInlinePanelOpen(): boolean {
    return !!(this.state.get('showingControls'));
  }

  private pausePlaybackForInlinePanel(): void {
    if (!this.engine.getIsPlaying()) return;

    this.wasPlayingBeforePanelOpen = true;
    this.pausedByPanelOpen = true;
    this.engine.pause();
    this.wordDisplay.showWhole();
    updatePlayPauseButtons(this.dom, false);
    this.setContextScrollEnabled(true);
  }

  private resumePlaybackAfterInlinePanelsClose(): void {
    if (!this.pausedByPanelOpen || !this.wasPlayingBeforePanelOpen) return;

    this.pausedByPanelOpen = false;
    this.wasPlayingBeforePanelOpen = false;
    this.engine.play();
    updatePlayPauseButtons(this.dom, true);
    this.setContextScrollEnabled(false);
  }

  private closeInlinePanels(): void {
    const wasAnyOpen = this.isAnyInlinePanelOpen();
    if (!wasAnyOpen) return;

    this.state.set('showingControls', false);
    this.settingsEl.toggleClass(CSS_CLASSES.hidden, true);
    this.makeRoomForPanel();

    this.resumePlaybackAfterInlinePanelsClose();
  }

  /**
   * Gives the panel the height of all its rows. A reader no taller than what it shows, as on
   * a phone with no lines of text round the word, is made taller while the panel is open: by
   * the rows, the bar at the foot under them and the two buttons over them, as far as the
   * window has the room. In a window without it the panel is moved through, its rows whole.
   * The height holds for as long as the panel is open, so the reader does not close in on its
   * panel where lines of text are taken away there or the text is made smaller.
   */
  private makeRoomForPanel(): void {
    const container = this.mainContainerEl;
    container.setCssProps({ '--foveafocus-panel-room': '0px' });
    if (!this.isAnyInlinePanelOpen()) return;

    const panel = this.settingsEl;
    const under = parseFloat(getComputedStyle(panel).bottom) || 0;
    const over = this.toggleBar.offsetTop + this.toggleBar.offsetHeight + 8;
    const needs = panel.scrollHeight + (panel.offsetHeight - panel.clientHeight) + under + over;

    container.setCssProps({ '--foveafocus-panel-room': `${needs}px` });
    const tooTall = this.readerOverflow();
    if (tooTall > 1) container.setCssProps({ '--foveafocus-panel-room': `${Math.max(0, needs - Math.ceil(tooTall))}px` });
  }

  private setupOutsideClickToClosePanels(): void {
    this.registerDomEvent(
      document,
      'pointerdown',
      (evt: PointerEvent) => {
        if (!this.isAnyInlinePanelOpen()) return;

        const target = evt.target as Node | null;
        if (!target) return;
        const clickedInsidePanels =
          (this.settingsEl?.contains(target) ?? false);
        const clickedOnToggleBar = this.toggleBar?.contains(target) ?? false;

        if (clickedInsidePanels || clickedOnToggleBar) return;

        const controlsOpen = this.settingsEl && !this.settingsEl.hasClass(CSS_CLASSES.hidden);
        if (!controlsOpen) return;
        this.ignoreNextDisplayToggleClick = true;
        this.closeInlinePanels();
      },
      true
    );
  }

  private suppressAutoLoad(ms: number = 250): void {
    this.suppressAutoLoadUntil = Date.now() + ms;
  }

  private isAutoLoadSuppressed(): boolean {
    return Date.now() < this.suppressAutoLoadUntil;
  }

  private defocusInteractiveElements(): void {
    const active = document.activeElement as HTMLElement | null;

    // Only blur buttons, and only inside this modal (don’t break typing in inputs)
    if (active && this.modalEl.contains(active) && active.tagName.toLowerCase() === "button") {
      active.blur();
    }

    // Always take focus away from the first toggle button on open (mobile can focus it late)
    this.modalEl.focus();
  }

  /**
   * Toggles the visibility of context before/after current word
   */
  private toggleContextDisplay(): void {
    const hasText = this.engine.getTotalWords() > 0;

    const shouldHide =
      !this.getActiveShowContext() ||
      !hasText ||
      this.suppressContextUntilPlay ||
      this.contextRoom === 0;

    if (this.contextBeforeEl) this.contextBeforeEl.toggleClass(CSS_CLASSES.hidden, shouldHide);
    if (this.contextAfterEl) this.contextAfterEl.toggleClass(CSS_CLASSES.hidden, shouldHide);
  }

  /**
   * Toggle outline visibility
   */
  private toggleOutlineDisplay(): void {
    const shouldHide = !this.getActiveShowOutline();
    if (this.outlineEl) {
      this.outlineEl.toggleClass(CSS_CLASSES.hidden, shouldHide);
    }
  }

  private applyFoveaFocusFont(fontFamily?: string): void {
    const ff = cssFontFamily(fontFamily);
    this.mainContainerEl?.style.setProperty("font-family", ff, "important");
    this.wordEl?.style.setProperty("font-family", ff, "important");
  }

  // ============================================================================
  // SECTION 5: AUTO-LOAD SYSTEM
  // ============================================================================

  /**
   * Sets up automatic text loading from editor
   *
   * Registers event handlers for:
   * - file-open: Load text when opening a file
   * - active-leaf-change: Load text when switching files
   * - mouseup: Check for selection/cursor changes
   * - keyup: Check for navigation/selection keys
   *
   * Actual tracking logic is encapsulated in AutoLoadManager
   */
  private setupAutoLoad(): void {
    // Event: file-open - Auto-load entire page
    this.registerEvent(
      this.app.workspace,
      this.app.workspace.on('file-open', (file) => {
        if (this.isAutoLoadSuppressed()) return;   // <-- added
        if (!file) return;

        this.autoLoadManager.resetForNewFile(file.path);
        this.autoLoadManager.loadFromEditor(TIMING.autoLoadDelay);
      })
    );

    // Event: active-leaf-change - Backup loader
    this.registerEvent(
      this.app.workspace,
      this.app.workspace.on('active-leaf-change', () => {
        if (this.isAutoLoadSuppressed()) return;   // <-- added
        if (!this.mainContainerEl || !this.mainContainerEl.isShown()) return;

        const currentFile = this.app.workspace.getActiveFile();
        if (currentFile && this.autoLoadManager.hasFileChanged(currentFile.path)) {
          this.autoLoadManager.resetForNewFile(currentFile.path);
          this.autoLoadManager.loadFromEditor(TIMING.autoLoadDelayShort);
        }
      })
    );

    // Mouse events for cursor tracking
    this.registerDomEvent(document, 'mouseup', (evt: MouseEvent) => {
      if (this.isAutoLoadSuppressed()) return;

      const target = evt.target as Node | null;
      if (target && this.modalEl.contains(target)) return;

      this.timeoutManager.setTimeout(() => {
        if (this.mainContainerEl.isShown() && !this.isAutoLoadSuppressed()) {
          this.autoLoadManager.checkSelectionOrCursor();
        }
      }, TIMING.autoLoadDelayVeryShort);
    });

    // Keyboard events for navigation and selection
    this.registerDomEvent(document, 'keyup', (evt: KeyboardEvent) => {
      // If FoveaFocus just handled a hotkey, do NOT auto-reload from editor
      if (this.isAutoLoadSuppressed()) return;

      // While actively playing, never auto-load (it will constantly fight navigation hotkeys)
      if (this.engine.getIsPlaying()) return;

      const active = document.activeElement as Node | null;
      if (active && this.modalEl.contains(active)) return;

      if (isNavigationKey(evt) || isSelectionKey(evt)) {
        this.timeoutManager.setTimeout(() => {
          if (this.mainContainerEl.isShown() && !this.isAutoLoadSuppressed() && !this.engine.getIsPlaying()) {
            this.autoLoadManager.checkSelectionOrCursor();
          }
        }, TIMING.autoLoadDelayVeryShort);
      }
    });
  }

  // ============================================================================
  // SECTION 6: HOTKEYS & KEYBOARD
  // ============================================================================

  /**
   * Sets up keyboard shortcuts for playback control
   */
  private setupHotkeys(): void {
    if (this.keydownHandler) return; // prevent duplicates
    this.keydownHandler = (e: KeyboardEvent) => this.handleKeyPress(e);
    this.registerDomEvent(document, 'keydown', this.keydownHandler);
  }

  /**
   * Handles keyboard shortcuts
   *
   * Shortcuts:
   * - Ctrl/Cmd + Left or Right: to the start or the end
   * - Up, Down: previous or next heading
   * - S: the reader's settings
   * - the keys of the settings (HotkeyHandler): play or pause, back and forward, and, with
   *   Shift where the key is Up or Down, faster and slower
   *
   * @param e - Keyboard event
   */
  private handleKeyPress(e: KeyboardEvent): void {
    if (!this.mainContainerEl.isShown()) return;

    // Don’t hijack keys while typing in an input
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    const isCmd = e.ctrlKey || e.metaKey;

    // Ctrl+Left = beginning, Ctrl+Right = end
    if (isCmd && e.key === 'ArrowLeft') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.engine.jumpToStart();
      return;
    }
    if (isCmd && e.key === 'ArrowRight') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.engine.jumpToEnd();
      return;
    }

    // Up/Down = heading navigation (with repeat “latency”)
    if (!e.shiftKey && !e.altKey && !isCmd && e.key === 'ArrowUp') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.jumpHeading('up');
      return;
    }
    if (!e.shiftKey && !e.altKey && !isCmd && e.key === 'ArrowDown') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.jumpHeading('down');
      return;
    }

    // Quick toggles for panels (allow anytime; don't steal Ctrl/Cmd+C)
    if (!isCmd && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.togglePanel('controls');
      return;
    }

    // Delegate hotkey handling to HotkeyHandler
    this.hotkeyHandler.handleKeyPress(e);
    if (e.defaultPrevented) {
      this.suppressAutoLoad();
    }
  }

  /**
   * Toggles play/pause state
   * Updates UI buttons accordingly
   */
  private togglePlay(): void {
    if (this.isAnyInlinePanelOpen()) {
      this.pausedByPanelOpen = false;
      this.wasPlayingBeforePanelOpen = false;
    }

    if (this.engine.getIsPlaying()) {
      this.engine.pause();
      this.wordDisplay.showWhole();
      updatePlayPauseButtons(this.dom, false);

      // 3.2: PAUSED => context scroll ON
      this.setContextScrollEnabled(true);
      if (this.getActiveShowContext()) {
        this.scheduleContextUpdate(this.getContextAnchorIndex());
      }

    } else {
      if (this.state.get('startTime') === 0) {
        this.state.set('startTime', Date.now());
      }
      this.engine.play();
      updatePlayPauseButtons(this.dom, true);

      if (this.suppressContextUntilPlay) {
        this.suppressContextUntilPlay = false;
        this.fitContextToWindow();
        if (this.getActiveShowContext()) {
          this.scheduleContextUpdate(this.getContextAnchorIndex());
        }
      }

      // 3.2: PLAYING => context scroll OFF
      this.setContextScrollEnabled(false);
    }

    this.defocusInteractiveElements();
  }

  private getIndexFromProgressClientX(clientX: number): number | null {
    const bar = this.progressBarEl;
    if (!bar) return null;

    const rect = bar.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = rect.width > 0 ? (x / rect.width) : 0;

    const total = this.engine.getTotalWords();
    if (total <= 0) return null;

    return Math.min(total - 1, Math.max(0, Math.floor(ratio * (total - 1))));
  }

  private buildProgressHoverTooltip(targetIndex: number): string {
    const totalWords = this.engine.getTotalWords();

    // Virtual time model (accounts for acceleration/micropauses/etc. as implemented in the engine)
    const totalSec = this.engine.getVirtualTotalSeconds();
    const atSec = this.engine.getVirtualElapsedSecondsAtIndex(targetIndex);

    const ctx = this.engine.getCurrentHeadingContext(targetIndex);
    const headingText =
      (ctx?.path?.length ?? 0) > 0
        ? ctx.path
            .map(h => h.text.replace(/^\[CALLOUT:[\w-]+\]/, "").trim())
            .filter(Boolean)
            .join(" › ")
        : "Top";

    const parts: string[] = [
      headingText,
      totalWords > 0 ? `${targetIndex + 1}/${totalWords} words` : `0/0 words`,
    ];

    if (totalSec > 0) {
      parts.push(
        `${this.formatTime(atSec)}/${this.formatTime(totalSec)}`
      );
    }

    return parts.join(" • ");
  }

  private updateProgressTooltipForClientX(clientX: number): void {
    const idx = this.getIndexFromProgressClientX(clientX);
    if (idx === null || !this.progressBarEl) return;

    if (this.progressBarLastTooltipIndex === idx) return;
    this.progressBarLastTooltipIndex = idx;
  
    this.progressBarEl.setAttr("aria-label", this.buildProgressHoverTooltip(idx));
  }

  private restoreProgressTooltipToPercent(): void {
    if (!this.progressBarEl) return;

    const total = this.progressBarEl.max || (this.engine.getTotalWords() || 1);
    const current = this.progressBarEl.value || Math.min(total, this.getContextAnchorIndex() + 1);
    const percent = Math.min(100, (current / total) * 100);

    this.progressBarEl.setAttr("aria-label", `${Math.round(percent)} %`);
  }

  private updateProgressBar(chunk: WordChunk): void {
    if (!this.progressBarEl || !this.settings.showProgress) return;

    const total = this.engine.getTotalWords() || 1;

    // Advance by the *displayed* chunk size so chunkSize > 1 doesn’t lie
    const current = Math.min(total, chunk.index + 1);

    this.progressBarEl.max = total;
    this.progressBarEl.value = current;

    const percent = Math.min(100, (current / total) * 100);
    if (!this.isProgressBarHovering) {
      this.progressBarEl.setAttr("aria-label", `${Math.round(percent)} %`);
    }
    this.updateBottomProgressInfo(chunk.index);
  }

  private updateBottomProgressInfo(wordIndex?: number): void {
    if (this.engine.getTotalWords() === 0) {
      this.progressInfoLeftEl?.setText("");
      this.progressInfoRightEl?.setText("");
      return;
    }
    if (!this.progressInfoLeftEl || !this.progressInfoRightEl) return;

    const total = Math.max(1, this.engine.getTotalWords());
    const idx0 = typeof wordIndex === "number" ? wordIndex : this.getContextAnchorIndex();
    const at = Math.min(total, Math.max(1, idx0 + 1));

    // left: current word / total
    this.progressInfoLeftEl.setText(`${at}/${total}`);

    const totalSec = this.engine.getVirtualTotalSeconds();
    const atSec = this.engine.getVirtualElapsedSecondsAtCurrentIndex();

    this.progressInfoRightEl.setText(
      `${this.formatTime(atSec)}/${this.formatTime(totalSec)}`
    );
  }

  private renderContextTokens(tokens: string[]): string {
    const isBreak = (t: string) => t === '\n';

    let out = '';
    let atLineStart = true;

    for (const raw of tokens) {
      if (isBreak(raw)) {
        // Keep structure
        out = out.replace(/[ \t]+$/g, '');
        out += '\n';
        atLineStart = true;
        continue;
      }

      // Strip internal markers so context looks like the note
      const t = raw
        .replace(/^\[H\d\]/, '')
        .replace(/^\[CALLOUT:[\w-]+\]/, '');

      if (!t) continue;

      if (!atLineStart) out += ' ';
      out += t;
      atLineStart = false;
    }

    // Clean punctuation spacing
    out = out.replace(/ +([,.;:!?])/g, '$1');
    // Remove spaces right after newlines
    out = out.replace(/\n +/g, '\n');

    return out.trimEnd();
  }

  private getNavigableHeadings(): HeadingInfo[] {
    return this.engine.getHeadings().filter(h => h.level >= 1);
  }

  private getActiveShowContext(): boolean {
    return this.isMobileUI() ? this.settings.mobileShowContext : this.settings.showContext;
  }
  private setActiveShowContext(v: boolean): void {
    if (this.isMobileUI()) this.settings.mobileShowContext = v;
    else this.settings.showContext = v;
    this.requestSettingsSave();
  }

  private getActiveShowOutline(): boolean {
    return this.isMobileUI() ? this.settings.mobileShowOutline : this.settings.showOutline;
  }
  private setActiveShowOutline(v: boolean): void {
    if (this.isMobileUI()) this.settings.mobileShowOutline = v;
    else this.settings.showOutline = v;
    this.requestSettingsSave();
  }

  private getActiveContextLines(): number {
    return this.isMobileUI() ? this.settings.mobileContextLines : this.settings.contextLines;
  }
  private setActiveContextLines(v: number): void {
    if (this.isMobileUI()) this.settings.mobileContextLines = v;
    else this.settings.contextLines = v;
  }

  private getActiveContextFontSize(): number {
    return this.isMobileUI() ? this.settings.mobileContextFontSize : this.settings.contextFontSize;
  }

  private jumpHeading(dir: 'up' | 'down'): void {
    const headings = this.getNavigableHeadings();
    if (headings.length === 0) return;

    const now = Date.now();
    const withinWindow =
      this.headingNav.dir === dir &&
      (now - this.headingNav.lastTime) <= FoveaFocusView.HEADING_NAV_WINDOW_MS;

    const curWord = this.getContextAnchorIndex();

    // current heading index = last heading whose wordIndex <= curWord
    let curHeadingIdx = -1;
    for (let i = headings.length - 1; i >= 0; i--) {
      if (headings[i].wordIndex <= curWord) { curHeadingIdx = i; break; }
    }

    if (!withinWindow || this.headingNav.cursor === null) {
      if (dir === 'up') {
        let target = curHeadingIdx;
        if (target >= 0 && headings[target].wordIndex === curWord) target -= 1; // if already at start, go previous
        this.headingNav.cursor = target;
      } else {
        this.headingNav.cursor = curHeadingIdx + 1; // next heading
      }
    } else {
      this.headingNav.cursor = (this.headingNav.cursor ?? curHeadingIdx) + (dir === 'up' ? -1 : 1);
    }

    this.headingNav.dir = dir;
    this.headingNav.lastTime = now;

    const idx = this.headingNav.cursor ?? -1;

    if (dir === 'up') {
      if (idx < 0) { this.engine.jumpToStart(); return; }
    } else {
      if (idx >= headings.length) { this.engine.jumpToEnd(); return; }
    }
  this.engine.jumpToIndex(headings[idx].wordIndex);
  }

  /** Lines of text shown in each panel: the anchor line and the extra lines asked for, as far as the window has room */
  private contextLinesShown(): number {
    return Math.min(Math.max(0, this.getActiveContextLines()) + 1, this.contextRoom);
  }

  /**
   * Finds how many lines of text round the word the window has room for, and shows no more.
   * The reader is tried as it stands while it reads, with the panels at one height after
   * another, and the tallest at which nothing is pushed out of the window is the room there
   * is. All of it happens before the browser draws again, so none of the trials is seen.
   */
  private fitContextToWindow(): void {
    if (!this.contextBeforeEl || !this.contextAfterEl || !this.wordEl || !this.wordDisplay || !this.bottomBarEl || !this.modalEl.isConnected) return;

    // The reader is measured at its own height: what an open panel is given is taken away first and given anew last
    this.mainContainerEl.setCssProps({ '--foveafocus-panel-room': '0px' });
    const running = this.wordEl.getAttribute('data-running');
    this.wordEl.setAttribute('data-running', 'true');
    this.fitBandToWindow();
    this.contextBeforeEl.removeClass(CSS_CLASSES.hidden);
    this.contextAfterEl.removeClass(CSS_CLASSES.hidden);

    let room = 0;
    let most = LIMITS.contextLines.max + 1;
    while (room < most) {
      const lines = Math.ceil((room + most) / 2);
      this.applyContextLayout(lines);
      if (this.readerFitsWindow()) room = lines;
      else most = lines - 1;
    }
    this.contextRoom = room;
    this.onContextRoom?.(room, this.isMobileUI());

    if (running === null) this.wordEl.removeAttribute('data-running');
    else this.wordEl.setAttribute('data-running', running);
    this.applyContextLayout();
    this.toggleContextDisplay();
    this.syncContextControls();
    this.fitMessageToWindow();
    this.makeRoomForPanel();
  }

  /**
   * Brings the band down in a window too low for the reader even with no lines of text round
   * the word. The band may take its share of the height of the window, but it does not push
   * the bar at the foot out of it: the text is made smaller, as far as the smallest size.
   */
  private fitBandToWindow(): void {
    this.contextBeforeEl.addClass(CSS_CLASSES.hidden);
    this.contextAfterEl.addClass(CSS_CLASSES.hidden);
    this.wordDisplay.freeBand();
    let over = this.readerOverflow();
    if (over <= 1) return;
    // Measures are rounded to the pixel, so the band comes down by a pixel more than they ask
    while (over > 0 && this.wordDisplay.lowerBand(Math.ceil(over) + 1)) over = this.readerOverflow();
  }

  /**
   * Cuts the message shown before reading down where the window is too low for all of it:
   * first to what is to be read and where it is from, then to what is to be read.
   */
  private fitMessageToWindow(): void {
    if (this.wordEl.getAttribute('data-running') === 'true') return;

    const steps = ['foveafocus-brief', 'foveafocus-briefest'];
    for (const step of steps) this.wordEl.removeClass(step);
    for (const step of steps) {
      if (this.readerOverflow() <= 1) return;
      this.wordEl.addClass(step);
    }
  }

  /**
   * Whether the reader stands inside its window: nothing spills out of the display area, the
   * bar at the foot lies inside the frame, and the frame is no taller than the screen.
   */
  private readerFitsWindow(): boolean {
    return this.readerOverflow() <= 1;
  }

  /**
   * By how many pixels the reader is too tall for its window. The frame is taken as it is
   * laid out, not as it is drawn, so that a window that is still sliding or growing into
   * place as it opens is read as it will stand.
   */
  private readerOverflow(): number {
    const display = this.wordEl.parentElement;
    const spill = display ? display.scrollHeight - display.clientHeight : 0;

    const height = this.modalEl.offsetHeight;
    const frame = this.modalEl.getBoundingClientRect();
    const style = getComputedStyle(this.modalEl);
    const scale = height > 0 && frame.height > 0 ? frame.height / height : 1;
    const foot = (this.bottomBarEl.getBoundingClientRect().bottom - frame.top) / scale;
    const inside = height - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
    return Math.max(spill, height - window.innerHeight, foot - inside);
  }

  private applyContextLayout(lines: number = this.contextLinesShown()): void {
    if (!this.contextBeforeEl || !this.contextAfterEl) return;

    const fontPx = this.getActiveContextFontSize();
    const lineHeightPx = Math.round(fontPx * 1.6);
    const panelHeightPx = lines * lineHeightPx;

    for (const el of [this.contextBeforeEl, this.contextAfterEl]) {
      el.style.fontSize = `${fontPx}px`;
      el.style.lineHeight = `${lineHeightPx}px`;

      el.style.height = `${panelHeightPx}px`;
      el.style.minHeight = `${panelHeightPx}px`;
      el.style.maxHeight = `${panelHeightPx}px`;

      // IMPORTANT: prevent browser “double wrapping”
      el.style.whiteSpace = 'pre-wrap';
      (el.style as any).overflowWrap = 'anywhere';
      el.style.wordBreak = 'break-word';
      el.style.wordBreak = 'normal';
      (el.style as any).overflowWrap = 'normal';
      el.style.overflowX = 'hidden';

      el.style.textAlign = 'left';
    }
  }

  // ============================================================================
  // SECTION 7: READING ENGINE CALLBACKS
  // ============================================================================

  /**
   * Called by engine when a new word is displayed
   * Updates the UI with the current word, context, progress, and stats
   *
   * @param chunk - Word chunk with text, index, delay info
   */
  private onWordChange(chunk: WordChunk): void {
    this.lastDisplayedIndex = chunk.index;
    // A heading or a callout's title is shown as one to its last word. Its first word
    // carries the marker, [H1] to [H6] or [CALLOUT:type], which is not shown.
    const marker = /^\[(?:H\d|CALLOUT:[\w-]+)\]/;
    const opensTitle = marker.test(chunk.text);

    // Delegate word display to WordDisplay module
    this.wordDisplay.displayWord(chunk.text.replace(marker, ''), chunk.title?.level ?? 0, false, chunk.title?.calloutType, opensTitle, this.engine.getIsPlaying() ? this.turn : undefined);

    // Update the outline (only if context changed)
    if (chunk.headingContext && this.outlineManager) {
      if (this.outlineManager.hasHeadingContextChanged(chunk.headingContext)) {
        this.outlineManager.updateOutline(chunk.headingContext);
      }
    }

    // Update context
    if (this.getActiveShowContext() && this.contextBeforeEl && this.contextAfterEl) {
      this.scheduleContextUpdate(chunk.index);
    }

    // Update progress bar
    this.updateProgressBar(chunk);
  }

  // ============================================================================
  // SECTION 8: TEXT LOADING
  // ============================================================================

  /**
   * Parses markdown and calculates start position from cursor
   *
   * @param text - Raw markdown text
   * @param cursorPosition - Optional cursor position in raw text
   * @returns Object with plainText and wordIndex
   */
  private parseAndCalculateStartPosition(
    text: string,
    cursorPosition?: number
  ): { plainText: string; wordIndex?: number } {
    // The parser records where in the note every word it keeps came from, so the cursor
    // maps straight to its word: the one it stands in, or the next one that is read.
    const parsed = parseMarkdown(text, markdownFilters(this.settings));
    return {
      plainText: parsed.text,
      wordIndex: cursorPosition === undefined ? undefined : tokenAtOffset(parsed, cursorPosition),
    };
  }

  /**
   * Updates stats display and word display with ready message
   *
   * @param wordIndex - Starting word index (if resuming from cursor)
   * @param source - Optional source information (filename, line number)
   */
  private updateStatsDisplay(
    wordIndex: number | undefined,
    source?: { fileName?: string; lineNumber?: number }
  ): void {
      // Include any configured auto-start delay in "ready"-state duration displays.
      // Engine estimates cover virtual reading time; autoStartDelay is extra wait time before playback begins.
      const startDelaySec = this.settings.autoStart ? Math.max(0, Math.round(this.settings.autoStartDelay)) : 0;

      const estimatedDurationSec = this.engine.getVirtualRemainingSeconds() + startDelaySec;

      // Display ready message in main word area
      const durationText = this.formatTime(estimatedDurationSec);

    // Display ready message in main word area
    this.wordDisplay.displayReadyMessage(
      this.engine.getRemainingWords(),
      this.engine.getTotalWords(),
      wordIndex,
      durationText,
      this.isMobileUI() ? 'Tap to start' : 'Press Space to start',
      source?.fileName,
      source?.lineNumber
    );
  }

  /**
   * Builds and displays the initial outline based on starting position
   *
   * @param wordIndex - Starting word index (0 if starting from beginning)
   */
  private buildInitialOutline(wordIndex: number): void {
    // Get heading context from engine (reuses the building of the path of headings)
    const context = this.engine.getCurrentHeadingContext(wordIndex);

    // Update the outline manager if we have headings
    if (context.path.length > 0) {
      this.outlineManager.updateOutline(context);
    }
  }

  /**
   * Handles auto-start functionality if enabled in settings
   * Starts reading after the configured delay
   */
  private handleAutoStart(): void {
    if (!this.settings.autoStart) return;

    this.timeoutManager.setTimeout(() => {
      this.suppressContextUntilPlay = false;
      this.fitContextToWindow();
      this.engine.play();
      if (this.getActiveShowContext()) this.scheduleContextUpdate(this.getContextAnchorIndex());
      updatePlayPauseButtons(this.dom, true);
      this.state.set('startTime', Date.now());

      // Auto-start is playing => context scroll OFF
      this.setContextScrollEnabled(false);
    }, this.settings.autoStartDelay * 1000);
  }

  private loadPreparedText(
    plainText: string,
    wordIndexFromCursor: number | undefined,
    source?: { fileName?: string; lineNumber?: number; cursorPosition?: number }
  ): void {
    if (!this.isInitialized) {
      // Queue as plain load so we don't re-parse later
      this.pendingLoad = { text: plainText, source, isPlain: true };
      this.skipInitialAutoLoad = true;
      return;
    }

    // Always reset session state before loading new text/index (playing OR paused)
    this.engine.stop();
    updatePlayPauseButtons(this.dom, false);

    // After stopping/loading (paused state), allow context panels to be scrollable
    this.setContextScrollEnabled(true);

    // Reset the outline's context for new text
    this.outlineManager.reset();

    // Verify text length
    if (!plainText || plainText.trim().length < TEXT_LIMITS.minParsedLength) {
      return;
    }

    // Load text into engine
    this.engine.setText(plainText, undefined, wordIndexFromCursor);
    this.wordDisplay?.setDirectionFrom(plainText);
    this.state.update({ wordsRead: 0, startTime: 0 });


    // Remove welcome message
    const welcomeMsg = this.wordEl.querySelector(`.${CSS_CLASSES.welcome}`);
    if (welcomeMsg) welcomeMsg.remove();

    if (this.wordDisplay) this.wordDisplay.clear();
    else this.wordEl.empty();

    // Update stats and display ready message
    this.updateStatsDisplay(wordIndexFromCursor, source);

    // Build and display the initial outline
    this.buildInitialOutline(wordIndexFromCursor ?? 0);

    // Context should only appear after text is loaded.
    this.fitContextToWindow();
    if (this.getActiveShowContext()) {
      this.scheduleContextUpdate(this.getContextAnchorIndex());
    }

    // Auto-start reading if enabled
    this.handleAutoStart();
  }

  public loadPlainText(
    plainText: string,
    source?: { fileName?: string; lineNumber?: number; cursorPosition?: number }
  ): void {
    if (!this.isInitialized) {
      this.pendingLoad = { text: plainText, source, isPlain: true };
      this.skipInitialAutoLoad = true;
      return;
    }

    const startWordIndex = typeof source?.cursorPosition === 'number' ? source.cursorPosition : undefined;
    this.loadPreparedText(plainText, startWordIndex, source);
  }

  /**
   * Loads text for reading
   *
   * Process:
   * 1. Stop current reading if playing
   * 2. Parse markdown to plain text
   * 3. Calculate word index from cursor position (if provided)
   * 4. Validate text length
   * 5. Load into engine
   * 6. Update UI with ready message
   * 7. Auto-start if enabled
   *
   * @param text - Text to load (raw markdown)
   * @param source - Optional source information (filename, line, cursor position)
   */
  public loadText(
    text: string,
    source?: { fileName?: string; lineNumber?: number; cursorPosition?: number }
  ): void {
    if (!this.isInitialized) {
      this.pendingLoad = { text, source, isPlain: false };
      this.skipInitialAutoLoad = true;
      return;
    }

    if (!source || source.cursorPosition === undefined) {
      this.suppressAutoLoad(1000);
      this.autoLoadManager.syncStateToEditor();
    }

    // Always reset session state before loading new text/index (playing OR paused)
    this.engine.stop();
    updatePlayPauseButtons(this.dom, false);

    // After stopping/loading (paused state), allow context panels to be scrollable
    // (scrolling is disabled again automatically when playback starts).
    this.setContextScrollEnabled(true);

    // Reset the outline's context for new text
    this.outlineManager.reset();

    // Parse markdown and calculate start position
    const { plainText, wordIndex: wordIndexFromCursor } = this.parseAndCalculateStartPosition(
      text,
      source?.cursorPosition
    );

    this.loadPreparedText(plainText, wordIndexFromCursor, source);
  }

  // ============================================================================
  // SECTION 9: SETTINGS & LIFECYCLE
  // ============================================================================

  /**
   * Updates settings from plugin settings tab
   * Called when user changes settings in main settings panel
   *
   * @param settings - New settings
   */

  public requestSkipInitialAutoLoadOnce(): void {
    this.skipInitialAutoLoad = true;
  }

  public updateSettings(settings: FoveaFocusSettings): void {
    this.settings = settings;
    this.engine.updateSettings(settings);
    this.engine.setUseMobileProfile(this.isMobileUI());
    this.applyContextLayout();
    this.applyAppearanceCssVars();

    if (this.mainContainerEl) {
      this.applyFoveaFocusFont(settings.fontFamily);
    }

    if (this.wordEl) {
      this.wordEl.style.setProperty("font-size", `${this.getActiveFontSize()}px`, "important");
      this.wordDisplay?.setBaseFontSize(this.getActiveFontSize());
      this.wordDisplay?.setChunkSize(this.engine.getChunkSize());
      this.applyFoveaFocusFont(settings.fontFamily);
    }
    if (this.progressBarEl) {
      this.progressBarEl.style.display = settings.showProgress ? "" : "none";
    }
    this.wordDisplay?.updateSettings(this.settings);
    this.syncPanel();
    this.toggleOutlineDisplay();
    this.fitContextToWindow();
  }
}

export { FoveaFocusView as FoveaFocusModal };