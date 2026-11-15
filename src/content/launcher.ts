/**
 * What the extension shows in a page before a reading: a small bar at the side with a
 * button that starts one, and the means to pick the place a reading starts from. A PDF is
 * read in the extension's own viewer, where the place is picked as well; while the
 * browser's viewer shows the PDF, the bar has a button that lays the extension's over it.
 * All of it is drawn inside a root of its own, where the styles of the page do not reach
 * and its own reach nothing of the page.
 */

import { Ellipsis, FileText, MousePointerClick, Play, SquareDashedText, createElement } from 'lucide';
import type { IconNode } from 'lucide';

export interface LauncherDoes {
  read(): void;
  /** What is selected is to be read, and no more */
  readSelection(): void;
  /** A block of the page was picked, by a click at this point of the window */
  readFrom(block: Element, x: number, y: number): void;
  /** A place is to be picked in the extension's own viewer of a PDF */
  pickInViewer(): void;
  /** The other viewer of a PDF is asked for: the browser's, or the extension's own */
  otherViewer(): void;
  hideHere(): void;
  hideEverywhere(): void;
  settings(): void;
}

const STYLES = `
:host { all: initial !important; }
* { box-sizing: border-box; }
.bar, .menu, .hint, .toast {
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #ccc2b7;
}
.bar {
  position: fixed;
  z-index: 2147483646;
  top: 50%;
  right: 10px;
  display: flex;
  flex-direction: column;
  transform: translateY(-50%);
  gap: 2px;
  padding: 4px;
  border: 1px solid rgba(204, 194, 183, 0.2);
  border-radius: 20px;
  background: rgba(55, 45, 41, 0.96);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  opacity: 0.5;
  transition: opacity 0.15s ease;
}
.bar:hover, .bar:focus-within, .bar.is-open, .bar.by-viewer { opacity: 1; }
button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button:hover { background: rgba(204, 194, 183, 0.16); }
button:focus-visible { outline: 2px solid #ba945f; outline-offset: 1px; }
button.read, button.open { background: #ba945f; color: #372d29; }
button.read:hover, button.open:hover { background: #c7a676; }
svg { width: 16px; height: 16px; }
.menu {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  min-width: 180px;
  padding: 4px;
  border: 1px solid rgba(204, 194, 183, 0.2);
  border-radius: 10px;
  background: rgba(55, 45, 41, 0.98);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.menu button {
  justify-content: flex-start;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  font: inherit;
  white-space: nowrap;
}
.picking {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  cursor: crosshair;
}
.picked {
  position: fixed;
  z-index: 2147483645;
  border: 2px solid #ba945f;
  border-radius: 4px;
  background: rgba(186, 148, 95, 0.18);
  pointer-events: none;
}
.hint, .toast {
  position: fixed;
  z-index: 2147483647;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 14px;
  border-radius: 16px;
  background: rgba(55, 45, 41, 0.97);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
  pointer-events: none;
}
[hidden] { display: none !important; }
@media print { .bar, .menu, .hint, .toast, .viewer { display: none; } }
`;

function button(parent: Node, cls: string, label: string, icon: IconNode | null, does: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = cls;
  el.type = 'button';
  if (icon) {
    el.appendChild(createElement(icon));
    el.title = label;
    el.setAttribute('aria-label', label);
  } else {
    el.textContent = label;
  }
  el.addEventListener('click', does);
  parent.appendChild(el);
  return el;
}

export class Launcher {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private bar: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  private picking: { layer: HTMLElement; box: HTMLElement; hint: HTMLElement; block: Element | null } | null = null;
  private toastTimer = 0;
  private away = false;
  /** On a PDF: whether the extension's own viewer shows it, in which it is read. Null on a web page. */
  private ownViewer: boolean | null = null;
  /** The width of a scrollbar that lies inside the window, at its right, which the bar keeps clear of */
  private edge = 0;
  /** The height of a strip that lies inside the window, at its top, which a word to the reader keeps clear of */
  private top = 0;

  constructor(private readonly does: LauncherDoes) {
    // A page that was open while the extension was loaded anew still holds what the old one drew
    for (const left of Array.from(document.querySelectorAll('[data-foveafocus]'))) left.remove();
    this.host = document.createElement('div');
    this.host.setAttribute('data-foveafocus', '');
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.root.appendChild(style);
    document.documentElement.appendChild(this.host);
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    // A press in a frame of the page is not heard here; the window hears that the frame has taken the keys
    window.addEventListener('blur', () => this.closeMenu());
  }

  /** Where the reader's frame is put: the same root, so that it too is out of reach of the page's styles */
  get frameRoot(): ShadowRoot {
    return this.root;
  }

  /** Whether an element is the extension's own in the page */
  owns(el: Element | null): boolean {
    return el === this.host;
  }

  showBar(show: boolean): void {
    if (!show) {
      this.closeMenu();
      this.bar?.remove();
      this.bar = null;
      return;
    }
    if (this.bar) return;
    const bar = document.createElement('div');
    // Beside the pages of the extension's own viewer the bar is in plain sight: it is faint where it lies over a page that is another's
    bar.className = this.ownViewer ? 'bar by-viewer' : 'bar';
    bar.hidden = this.away;
    if (this.edge) bar.style.right = `${10 + this.edge}px`;
    const own = this.ownViewer;
    if (own === false) {
      // The browser's viewer says nothing of where a selection or a click lies in a PDF: the PDF is read in the extension's own
      button(bar, 'open', "Show this PDF in FoveaFocus's viewer", FileText, () => this.does.otherViewer());
    } else {
      if (own) {
        button(bar, 'read', 'Read this PDF, from what is selected', Play, () => this.does.read());
        button(bar, 'pick', 'Read from a word in the PDF', MousePointerClick, () => this.does.pickInViewer());
      } else {
        button(bar, 'read', 'Read this page, or what is selected', Play, () => this.does.read());
        button(bar, 'pick', 'Read from a place in the page', MousePointerClick, () => this.pick());
      }
      button(bar, 'selection', 'Read only what is selected', SquareDashedText, () => this.does.readSelection());
    }
    button(bar, 'more', 'More', Ellipsis, () => this.toggleMenu());
    this.root.appendChild(bar);
    this.bar = bar;
  }

  /** Says what shows the PDF of this page, how wide the scrollbar of that is and how tall the strip over its pages. The bar is drawn anew for it. */
  showsPdf(ownViewer: boolean, edge: number, top: number): void {
    this.top = top;
    if (this.ownViewer === ownViewer && this.edge === edge) return;
    this.ownViewer = ownViewer;
    this.edge = edge;
    if (!this.bar) return;
    this.showBar(false);
    this.showBar(true);
  }

  /** Hides the bar for the time the reader is open, and shows it again where it was on show */
  dim(away: boolean): void {
    this.away = away;
    if (this.bar) this.bar.hidden = away;
    if (!away) return;
    this.closeMenu();
    this.stopPicking();
  }

  private toggleMenu(): void {
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const bar = this.bar;
    if (!bar) return;
    const menu = document.createElement('div');
    menu.className = 'menu';
    if (this.ownViewer) {
      button(menu, '', "Show the browser's viewer", null, () => {
        this.closeMenu();
        this.does.otherViewer();
      });
    }
    button(menu, '', 'Hide on this site', null, () => this.does.hideHere());
    button(menu, '', 'Hide on every site', null, () => this.does.hideEverywhere());
    button(menu, '', 'Settings', null, () => {
      this.closeMenu();
      this.does.settings();
    });
    this.root.appendChild(menu);
    const at = bar.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    menu.style.left = `${at.left - box.width - 8}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - box.height - 8, at.bottom - box.height))}px`;
    bar.classList.add('is-open');
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.bar?.classList.remove('is-open');
  }

  /**
   * Has a place in the page picked for the reading to start from. A layer over the page
   * takes the pointer, so the page itself is not clicked; the block under the pointer is
   * framed, and a click starts the reading there. Escape leaves the page as it was.
   */
  pick(): void {
    if (this.picking) return;
    this.closeMenu();
    const layer = document.createElement('div');
    layer.className = 'picking';
    const box = document.createElement('div');
    box.className = 'picked';
    box.hidden = true;
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Click where the reading is to start. Esc leaves it.';
    this.root.append(layer, box, hint);
    this.picking = { layer, box, hint, block: null };

    layer.addEventListener('pointermove', (event) => {
      const picking = this.picking;
      if (!picking) return;
      const under = document.elementsFromPoint(event.clientX, event.clientY).find((el) => el !== this.host) ?? null;
      const block = blockUnder(under);
      picking.block = block;
      box.hidden = !block;
      if (!block) return;
      const at = block.getBoundingClientRect();
      box.style.left = `${at.left - 4}px`;
      box.style.top = `${at.top - 2}px`;
      box.style.width = `${at.width + 8}px`;
      box.style.height = `${at.height + 4}px`;
    });
    layer.addEventListener('click', (event) => {
      const block = this.picking?.block;
      this.stopPicking();
      if (block) this.does.readFrom(block, event.clientX, event.clientY);
    });
  }

  private stopPicking(): void {
    if (!this.picking) return;
    this.picking.layer.remove();
    this.picking.box.remove();
    this.picking.hint.remove();
    this.picking = null;
  }

  /** Says a word at the top of the page for a moment, or a longer one for more than a few words */
  toast(text: string, stays = 2600): void {
    this.root.querySelector('.toast')?.remove();
    window.clearTimeout(this.toastTimer);
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    if (this.top) toast.style.top = `${14 + this.top}px`;
    this.root.appendChild(toast);
    this.toastTimer = window.setTimeout(() => toast.remove(), stays);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (!this.picking && !this.menu)) return;
    event.stopPropagation();
    this.stopPicking();
    this.closeMenu();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.menu && event.target !== this.host) this.closeMenu();
  };
}

/** The paragraph, heading, list item or the like that an element is, or stands in */
function blockUnder(el: Element | null): Element | null {
  for (let at = el; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    if (/^(?:p|li|h[1-6]|blockquote|pre|dd|dt|td|th|figcaption|summary)$/.test(at.localName)) return at;
    if (at.localName === 'div' && Array.from(at.childNodes).some((child) => child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim())) return at;
  }
  return null;
}
