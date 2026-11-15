/**
 * OutlineManager - Manages the outline at the top of the reader and its heading menus
 *
 * Responsibilities:
 * - Display the path of headings the word stands under (H1 > H2 > H3)
 * - Show outline button (≡) for full document structure
 * - Show dropdown (▼) for sibling navigation
 * - Navigate to headings with play/pause handling
 */

import { HeadingContext } from './types';
import { setIcon } from "obsidian";
import { MenuBuilder } from './menu-builder';
import { RSVPEngine } from './rsvp-engine';
import { TimeoutManager } from './services/timeout-manager';

type OutlineManagerOptions = {
  onPlayStateChange?: (isPlaying: boolean) => void;
  canAutoResume?: () => boolean;
};

export class OutlineManager {
  private outlineEl: HTMLElement;
  private engine: RSVPEngine;
  private timeoutManager: TimeoutManager;
  private lastHeadingContext: HeadingContext | null = null;
  private onPlayStateChange?: (isPlaying: boolean) => void;
  private canAutoResume?: () => boolean;
  private activeOutlineMenu: import('./menu-builder').MenuHandle | null = null;

  constructor(
    outlineEl: HTMLElement,
    engine: RSVPEngine,
    timeoutManager: TimeoutManager,
    opts: OutlineManagerOptions = {}
  ) {
    this.outlineEl = outlineEl;
    this.engine = engine;
    this.timeoutManager = timeoutManager;
    this.onPlayStateChange = opts.onPlayStateChange;
    this.canAutoResume = opts.canAutoResume;
  }

  /**
   * Updates the outline bar with current heading context
   * Shows hierarchical path (H1 > H2 > H3) and makes it clickable for navigation
   *
   * @param context - Current heading context from engine
   */
  updateOutline(context: HeadingContext): void {
    const hasAnyHeadings = this.engine.getHeadings().length > 0;

    this.outlineEl.empty();

    // Lucide icon
    const docIcon = this.outlineEl.createSpan({ cls: "foveafocus-outline-icon" });
    setIcon(docIcon, "file-text");
    if (hasAnyHeadings) {
      docIcon.addEventListener("click", () => this.showOutlineMenu(docIcon));
    }

    // NEW: wrapper that will shrink (ellipsis) while icons stay visible
    const pathEl = this.outlineEl.createSpan({ cls: "foveafocus-outline-path" });

    // PDF / plain-text docs have no headings: keep the bar stable with a placeholder.
    if (!hasAnyHeadings) {
      pathEl.createSpan({
        text: "Document",
        cls: "foveafocus-outline-item foveafocus-outline-item--last"
      });
      return;
    }

    // If we’re before the first heading, show a placeholder instead of hiding
    if (!context || context.path.length === 0) {
      pathEl.createSpan({
        text: "Top",
        cls: "foveafocus-outline-item foveafocus-outline-item--last"
      });
    } else {
      const lastIdx = context.path.length - 1;
      
      // the path of headings, outermost first
      context.path.forEach((heading, index) => {
        if (index > 0) {
          pathEl.createSpan({ text: "›", cls: "foveafocus-outline-separator" });
        }

        const itemSpan = pathEl.createSpan({
          cls: `foveafocus-outline-item ${index === lastIdx ? "foveafocus-outline-item--last" : ""}`.trim()
        });

        const displayText = heading.text.replace(/^\[CALLOUT:[\w-]+\]/, "").trim();
        itemSpan.textContent = displayText;

        itemSpan.addEventListener("click", () => this.navigateToHeading(heading.wordIndex));
      });
    }

    // Chevron dropdown stays OUTSIDE pathEl so it never gets pushed off-screen
    const dropdown = this.outlineEl.createSpan({ cls: "foveafocus-outline-dropdown" });
    setIcon(dropdown, "chevron-down");
    dropdown.addEventListener("click", () => this.showOutlineMenu(dropdown));

    this.lastHeadingContext = context;
  }

  /**
   * Closes all open menus (outline menus)
   * Called before opening a new menu to ensure only one menu is visible
   */
  private closeAllMenus(): void {
    if (this.activeOutlineMenu?.isOpen()) {
      this.activeOutlineMenu.close('dismiss');
    }
    this.activeOutlineMenu = null;

    // safety: remove any stray menus
    document.querySelectorAll('.foveafocus-outline-menu').forEach(menu => menu.remove());
  }

  /**
   * Checks if heading context has changed (to avoid unnecessary updates)
   *
   * @param newContext - New heading context to check
   * @returns True if context has changed, false otherwise
   */
  hasHeadingContextChanged(newContext: HeadingContext): boolean {
    if (!this.lastHeadingContext) return true;

    if (this.lastHeadingContext.path.length !== newContext.path.length) {
      return true;
    }

    for (let i = 0; i < newContext.path.length; i++) {
      if (this.lastHeadingContext.path[i].wordIndex !== newContext.path[i].wordIndex) {
        return true;
      }
    }

    return false; // No change
  }

  /**
   * Shows outline menu with all headings in the document
   * Displays complete document structure, each heading indented by how deeply it is nested
   * Highlights current position in the list
   *
   * @param anchorEl - The element to position the menu relative to
   */
  private showOutlineMenu(anchorEl: HTMLElement): void {
    // Toggle: if already open, close and stop (do NOT re-open)
    if (this.activeOutlineMenu?.isOpen()) {
      this.activeOutlineMenu.close('dismiss');
      this.activeOutlineMenu = null;
      return;
    }

    // Otherwise ensure nothing else is hanging around
    this.closeAllMenus();

    const allHeadings = this.engine.getHeadings();

    if (allHeadings.length === 0) {
      return; // No headings to display
    }

    const wasPlayingBeforeMenu = this.engine.getIsPlaying();
    if (wasPlayingBeforeMenu) {
      this.engine.pause();
      this.onPlayStateChange?.(false);
    }

    let didSelect = false;

    // Get current position to highlight active heading
    const currentIndex = this.engine.getCurrentIndex();
    const relevantHeadings = allHeadings.filter(h => h.wordIndex <= currentIndex);
    const currentHeading = relevantHeadings.length > 0
      ? relevantHeadings[relevantHeadings.length - 1]
      : null;

    // Create menu using MenuBuilder
    const menu = MenuBuilder.createMenu({
      anchorEl: anchorEl,
      cssClass: 'foveafocus-outline-menu',
      title: 'Outline',
      items: allHeadings.map(h => ({
        text: h.text,
        wordIndex: h.wordIndex,
        level: h.level,
        depth: h.depth,
        calloutType: h.calloutType,
        isCurrent: currentHeading ? h.wordIndex === currentHeading.wordIndex : false
      })),
      onItemClick: (wordIndex) => {
        didSelect = true;
        this.navigateToHeading(wordIndex);
      },
      showLevel: true,
      indentByDepth: true,
      timeoutManager: this.timeoutManager,
      onClose: (reason) => {
        this.activeOutlineMenu = null; // <-- FIRST LINE

        const canResume = this.canAutoResume ? this.canAutoResume() : true;
        if (!canResume) return;

        if (reason === 'dismiss') {
          if (wasPlayingBeforeMenu) {
            this.engine.play();
            this.onPlayStateChange?.(true);
          }
          return;
        }

        // only resume if we were playing before opening the menu
        if (reason === 'select' && didSelect) {
          if (wasPlayingBeforeMenu) {
            this.engine.play();
            this.onPlayStateChange?.(true);
          } else {
            this.onPlayStateChange?.(false);
          }
        }
      }
    });
    this.activeOutlineMenu = menu;
    MenuBuilder.scrollToCurrentItem(menu.el, this.timeoutManager);
  }

  /**
   * Navigates to a specific heading by word index
   * Pauses playback, jumps to the heading position, and resumes if it was playing
   *
   * @param wordIndex - Word index to navigate to
   */
  private navigateToHeading(wordIndex: number): void {
    // Direct seek: exact heading index (no linebreak drift)
    this.engine.jumpToIndex(wordIndex);
    this.onPlayStateChange?.(this.engine.getIsPlaying());
  }

  /**
   * Resets the outline's state (for new text loading)
   */
  reset(): void {
    this.lastHeadingContext = null;
  }
}
