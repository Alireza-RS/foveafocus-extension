/**
 * What the extension shows in a page before a reading: a small bar at the side with a
 * button that starts one, and the means to pick the place a reading starts from. A PDF is
 * read in the extension's own viewer, where the place is picked as well; while the
 * browser's viewer shows the PDF, the bar has a button that lays the extension's over it.
 * All of it is drawn inside a root of its own, where the styles of the page do not reach
 * and its own reach nothing of the page.
 *
 * Where the settings have it so, the bar rests folded into one button and shows the others
 * when that is pressed, and it can be moved to another place at either side of the window.
 * The first time it is shown, it says beside each button what the button does.
 */

import { Ellipsis, FileText, MousePointerClick, Play, SquareDashedText, X, createElement } from 'lucide';
import type { IconNode } from 'lucide';
import type { Rest } from '../shared/prefs';

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
  /** The page that shows how the extension works is asked for */
  guide(): void;
  /** A PDF on the device is to be chosen and shown */
  choosePdf(): void;
  /** The bar was moved, and rests in another place */
  moved(at: Rest): void;
  /** What the buttons do has been said, and need not be said again */
  tipsSeen(): void;
}

/** How the bar is to behave, by the settings and the device */
export interface BarWays {
  /** Whether it rests folded into one button */
  fold: boolean;
  /** Whether it can be moved */
  drag: boolean;
  at: Rest;
  /** Whether the browser runs on a phone or a tablet. Its own button, which shows a hidden bar again, is out of the way there: the bar offers no hiding, and offers a PDF from the device, which the browser shows as no page. */
  handheld: boolean;
  /** Whether it says what its buttons do */
  tips: boolean;
}

/** How far a press has to travel before it moves the bar and presses no button */
const MOVES_FROM = 6;
/** How long the bar stays in plain sight after a finger has left it */
const AWAKE_FOR = 2500;

/** The sign of the extension, on the button that the bar folds into: the drawing of its icon, without the ground, which the button is */
export const SIGN: IconNode = [
  ['path', { d: 'M1 4.5h22M1 19.5h22M9.25 4.5v3M9.25 16.5v3', stroke: '#ba945f', 'stroke-width': '1.25' }],
  ['rect', { x: '1', y: '9.5', width: '5.5', height: '5', rx: '1.5', fill: 'currentColor', stroke: 'none' }],
  ['rect', { x: '7.5', y: '9.5', width: '3.5', height: '5', rx: '1.5', fill: '#ba945f', stroke: 'none' }],
  ['rect', { x: '12', y: '9.5', width: '6.5', height: '5', rx: '1.5', fill: 'currentColor', stroke: 'none' }],
  ['rect', { x: '19.5', y: '9.5', width: '3.5', height: '5', rx: '1.5', fill: 'currentColor', stroke: 'none' }],
];

const STYLES = `
:host { all: initial !important; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.screen {
  position: fixed;
  z-index: 2147483647;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  transform-origin: 0 0;
  pointer-events: none;
  touch-action: manipulation;
}
.bar, .menu, .hint, .toast, .tips, .tips-foot {
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #ccc2b7;
}
.bar {
  --y: 0.5;
  --n: 4;
  --edge: 0px;
  position: absolute;
  z-index: 3;
  top: clamp(8px, calc(var(--y) * 100% - var(--n) * 16px - 4px), calc(100% - var(--n) * 32px - 16px));
  right: calc(10px + var(--edge));
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid rgba(204, 194, 183, 0.2);
  border-radius: 20px;
  background: rgba(55, 45, 41, 0.96);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  opacity: 0.5;
  transition: opacity 0.15s ease;
  pointer-events: auto;
  user-select: none;
}
.bar.at-left { right: auto; left: 10px; }
.bar.folds { top: clamp(8px, calc(var(--y) * 100% - 20px), calc(100% - 48px)); }
.bar.folds.up {
  top: auto;
  bottom: clamp(8px, calc((1 - var(--y)) * 100% - 20px), calc(100% - 48px));
  flex-direction: column-reverse;
}
.bar.is-folded > :not(.handle) { display: none; }
.bar.moves { touch-action: none; }
.bar.is-moved { right: auto !important; bottom: auto !important; }
.bar.is-open, .bar.is-awake, .bar.is-moved, .bar.is-told, .bar.by-viewer:not(.is-folded), .bar.folds:not(.is-folded) { opacity: 1; }
@media (hover: hover) { .bar:hover, .bar:focus-within { opacity: 1; } }
@media (hover: none) { .bar:has(:focus-visible) { opacity: 1; } }
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
button.read, button.open, button.got { background: #ba945f; color: #372d29; }
button.read:hover, button.open:hover, button.got:hover { background: #c7a676; }
svg { width: 16px; height: 16px; }
.handle svg { width: 22px; height: 22px; }
.menu {
  position: absolute;
  z-index: 4;
  display: flex;
  flex-direction: column;
  min-width: 180px;
  padding: 4px;
  border: 1px solid rgba(204, 194, 183, 0.2);
  border-radius: 10px;
  background: rgba(55, 45, 41, 0.98);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
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
.tips, .tips-foot {
  position: absolute;
  z-index: 3;
  border: 1px solid rgba(204, 194, 183, 0.2);
  border-radius: 14px;
  background: rgba(55, 45, 41, 0.98);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  pointer-events: auto;
}
.tips {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  padding: 4px 12px;
}
.tips.up { flex-direction: column-reverse; }
.tips.at-left { align-items: flex-start; }
.tips > div {
  display: flex;
  align-items: center;
  height: 30px;
  white-space: nowrap;
}
.tips-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
}
.tips-foot > div {
  display: flex;
  gap: 6px;
}
.tips-foot button {
  width: auto;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  font: inherit;
  white-space: nowrap;
}
.tips-foot button:not(.got) { background: rgba(204, 194, 183, 0.12); }
.tips-foot button:not(.got):hover { background: rgba(204, 194, 183, 0.2); }
.picking {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  cursor: crosshair;
}
.picked {
  position: fixed;
  z-index: 2147483646;
  border: 2px solid #ba945f;
  border-radius: 4px;
  background: rgba(186, 148, 95, 0.18);
  pointer-events: none;
}
.hint, .toast {
  position: absolute;
  z-index: 4;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100% - 24px);
  padding: 7px 14px;
  border-radius: 16px;
  background: rgba(55, 45, 41, 0.97);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  text-align: center;
  pointer-events: none;
}
.hint:has(button) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 14px;
}
.hint button { flex: none; pointer-events: auto; }
[hidden] { display: none !important; }
@media print { .bar, .menu, .hint, .toast, .tips, .tips-foot, .viewer { display: none; } }
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

const within = (value: number, least: number, most: number): number => Math.max(least, Math.min(most, value));

export class Launcher {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  /** What stands in the part of the page that is in sight: the bar and what belongs to it, a word to the reader, and the frames */
  private readonly screen: HTMLElement;
  private bar: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  private tips: { labels: HTMLElement; foot: HTMLElement } | null = null;
  private picking: { layer: HTMLElement; box: HTMLElement; hint: HTMLElement } | null = null;
  private toastTimer = 0;
  private awakeTimer = 0;
  private away = false;
  /** On a PDF: whether the extension's own viewer shows it, in which it is read. Null on a web page. */
  private ownViewer: boolean | null = null;
  /** The width of a scrollbar that lies inside the window, at its right, which the bar keeps clear of */
  private edge = 0;
  /** The height of a strip that lies inside the window, at its top, which a word to the reader keeps clear of */
  private top = 0;
  private ways: BarWays = { fold: false, drag: false, at: { side: 'right', y: 0.5 }, handheld: false, tips: false };
  /** Whether what points at the page is a finger: it is nowhere until it presses, and has no key to leave with */
  private readonly touch = window.matchMedia('(hover: none)').matches;

  /**
   * `alone` says that the extension's own viewer is all that shows the PDF of this page:
   * there is no viewer of the browser to go back to. `tour` says that this page is the one
   * that shows how the extension works, which the bar then does not offer.
   */
  constructor(private readonly does: LauncherDoes, private readonly page: { alone?: boolean; tour?: boolean } = {}) {
    // A page that was open while the extension was loaded anew still holds what the old one drew
    for (const left of Array.from(document.querySelectorAll('[data-foveafocus]'))) left.remove();
    this.host = document.createElement('div');
    this.host.setAttribute('data-foveafocus', '');
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.screen = document.createElement('div');
    this.screen.className = 'screen';
    this.root.append(style, this.screen);
    document.documentElement.appendChild(this.host);
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    // A press in a frame of the page is not heard here; the window hears that the frame has taken the keys
    window.addEventListener('blur', () => this.fold());
    window.visualViewport?.addEventListener('resize', this.fit);
    window.visualViewport?.addEventListener('scroll', this.fit);
    this.fit();
  }

  /** Where the frames of the reader and the viewer are put: with the bar, out of reach of the page's styles, and in the part of the page that is in sight */
  get frameRoot(): HTMLElement {
    return this.screen;
  }

  /** Whether an element is the extension's own in the page */
  owns(el: Element | null): boolean {
    return el === this.host;
  }

  /**
   * Keeps what stands in sight in the part of the page that the window shows, and at its
   * own size. A phone draws a page larger or smaller than it is, and shows a part of it:
   * what is fixed in a page is then drawn at the size of the page, and can lie out of sight.
   */
  private readonly fit = (): void => {
    const view = window.visualViewport;
    const style = this.screen.style;
    if (!view || (view.scale === 1 && !view.offsetLeft && !view.offsetTop)) {
      style.cssText = '';
    } else {
      style.right = style.bottom = 'auto';
      style.width = `${view.width * view.scale}px`;
      style.height = `${view.height * view.scale}px`;
      style.transform = `translate(${view.offsetLeft}px, ${view.offsetTop}px) scale(${1 / view.scale})`;
    }
    this.placeTips();
  };

  /** A point of the window as it lies in what stands in sight */
  private inScreen(x: number, y: number): { x: number; y: number } {
    const view = window.visualViewport;
    return view ? { x: (x - view.offsetLeft) * view.scale, y: (y - view.offsetTop) * view.scale } : { x, y };
  }

  /** Takes up how the bar is to behave. The bar is drawn anew where that has changed, and only put in its place where no more than its place has. */
  behave(ways: BarWays): void {
    const was = this.ways;
    this.ways = ways;
    if (!this.bar) return;
    if (was.fold !== ways.fold || was.drag !== ways.drag || was.handheld !== ways.handheld) {
      this.showBar(false);
      this.showBar(true);
    } else if (was.tips !== ways.tips) {
      if (ways.tips) this.showTips();
      else this.dropTips();
    } else {
      this.rest();
    }
  }

  showBar(show: boolean): void {
    if (!show) {
      this.closeMenu();
      this.tips?.labels.remove();
      this.tips?.foot.remove();
      this.tips = null;
      this.bar?.remove();
      this.bar = null;
      return;
    }
    if (this.bar) return;
    const bar = document.createElement('div');
    // Beside the pages of the extension's own viewer the bar is in plain sight: it is faint where it lies over a page that is another's
    bar.className = this.ownViewer ? 'bar by-viewer' : 'bar';
    bar.classList.toggle('folds', this.ways.fold);
    bar.classList.toggle('moves', this.ways.drag);
    bar.classList.toggle('is-folded', this.ways.fold);
    bar.hidden = this.away;
    if (this.ways.fold) {
      button(bar, 'handle', 'Show the buttons of FoveaFocus, or tuck them away', SIGN, () => {
        if (bar.classList.contains('is-folded')) this.unfold();
        else this.fold();
      });
    }
    /** A button of the bar that has something done: what the buttons do need not be said after it, and the bar folds */
    const doing = (cls: string, label: string, icon: IconNode, does: () => void): void => {
      button(bar, cls, label, icon, () => {
        this.dropTips();
        this.fold();
        does();
      });
    };
    const own = this.ownViewer;
    if (own === false) {
      // The browser's viewer says nothing of where a selection or a click lies in a PDF: the PDF is read in the extension's own
      doing('open', "Show this PDF in FoveaFocus's viewer", FileText, () => this.does.otherViewer());
    } else {
      if (own) {
        doing('read', 'Read this PDF, from what is selected', Play, () => this.does.read());
        doing('pick', 'Read from a word in the PDF', MousePointerClick, () => this.does.pickInViewer());
      } else {
        doing('read', 'Read this page, or what is selected', Play, () => this.does.read());
        doing('pick', 'Read from a place in the page', MousePointerClick, () => this.pick());
      }
      doing('selection', 'Read only what is selected', SquareDashedText, () => this.does.readSelection());
    }
    button(bar, 'more', 'More', Ellipsis, () => {
      this.dropTips();
      this.toggleMenu();
    });
    bar.style.setProperty('--n', String(bar.childElementCount));
    bar.addEventListener('pointerdown', this.onBarDown);
    this.screen.appendChild(bar);
    this.bar = bar;
    this.rest();
    if (this.ways.tips) this.showTips();
  }

  /** Puts the bar in its place: at its side of the window, and as far down that side as it rests */
  private rest(): void {
    const bar = this.bar;
    if (!bar) return;
    const { side, y } = this.ways.at;
    bar.classList.toggle('at-left', side === 'left');
    // Folded, the bar is its one button, which stays where it is when the others are shown: they stand under it, or over it in the lower half of the window
    bar.classList.toggle('up', this.ways.fold && y > 0.5);
    bar.style.setProperty('--y', String(y));
    bar.style.setProperty('--edge', `${side === 'right' ? this.edge : 0}px`);
    this.placeTips();
  }

  private unfold(): void {
    this.bar?.classList.remove('is-folded');
    this.placeTips();
  }

  /** Folds the bar where it folds, and puts its menu away. While it says what its buttons do, it stays as it is. */
  private fold(): void {
    this.closeMenu();
    if (this.ways.fold && !this.tips) this.bar?.classList.add('is-folded');
  }

  /** Has the bar in plain sight for a while after a finger has touched it */
  private wake(): void {
    this.bar?.classList.add('is-awake');
    window.clearTimeout(this.awakeTimer);
    this.awakeTimer = window.setTimeout(() => this.bar?.classList.remove('is-awake'), AWAKE_FOR);
  }

  /** A press on the bar. Where the bar can be moved, a press that travels moves it, and presses none of its buttons. */
  private readonly onBarDown = (event: PointerEvent): void => {
    const bar = this.bar;
    if (!bar) return;
    if (event.pointerType !== 'mouse') this.wake();
    if (!this.ways.drag || event.button !== 0) return;
    const from = this.inScreen(event.clientX, event.clientY);
    const start = { left: bar.offsetLeft, top: bar.offsetTop };
    let moved = false;
    // What was pressed hears of the pointer wherever it goes from here, also over a frame, and however fast
    const pressed = event.target instanceof Element ? event.target.closest('button') ?? bar : bar;
    pressed.setPointerCapture(event.pointerId);
    const onMove = (now: PointerEvent): void => {
      if (now.pointerId !== event.pointerId) return;
      const at = this.inScreen(now.clientX, now.clientY);
      if (!moved && Math.hypot(at.x - from.x, at.y - from.y) < MOVES_FROM) return;
      if (!moved) {
        moved = true;
        this.closeMenu();
        bar.classList.add('is-moved');
        if (this.tips) this.tips.labels.hidden = this.tips.foot.hidden = true;
      }
      bar.style.left = `${within(start.left + at.x - from.x, 0, this.screen.clientWidth - bar.offsetWidth)}px`;
      bar.style.top = `${within(start.top + at.y - from.y, 0, this.screen.clientHeight - bar.offsetHeight)}px`;
    };
    const onEnd = (now: PointerEvent): void => {
      if (now.pointerId !== event.pointerId) return;
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onEnd);
      bar.removeEventListener('pointercancel', onEnd);
      if (!moved) return;
      // The press that moved the bar presses none of its buttons
      const swallow = (click: Event): void => {
        click.stopPropagation();
        click.preventDefault();
      };
      bar.addEventListener('click', swallow, true);
      window.setTimeout(() => bar.removeEventListener('click', swallow, true));
      // It rests at the nearer side of the window, as far down as the button it folds into was let go, or its middle where it does not fold
      const handle = bar.querySelector<HTMLElement>('.handle');
      const middle = handle ? bar.offsetTop + handle.offsetTop + handle.offsetHeight / 2 : bar.offsetTop + bar.offsetHeight / 2;
      const at: Rest = {
        side: bar.offsetLeft + bar.offsetWidth / 2 < this.screen.clientWidth / 2 ? 'left' : 'right',
        y: within(middle / (this.screen.clientHeight || 1), 0, 1),
      };
      bar.classList.remove('is-moved');
      bar.style.left = bar.style.top = '';
      this.ways = { ...this.ways, at };
      if (this.tips) this.tips.labels.hidden = this.tips.foot.hidden = this.away;
      this.rest();
      this.does.moved(at);
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onEnd);
    bar.addEventListener('pointercancel', onEnd);
  };

  /** Says beside each button of the bar what it does, until that is acknowledged or a button is used. The bar is open for it. */
  private showTips(): void {
    const bar = this.bar;
    if (!bar || this.tips) return;
    bar.classList.remove('is-folded');
    bar.classList.add('is-told');
    const labels = document.createElement('div');
    labels.className = 'tips';
    for (const part of Array.from(bar.children)) {
      const said = part.classList.contains('handle') ? 'Shows these buttons, and tucks them away' : part.classList.contains('more') ? 'Settings and more' : part.getAttribute('aria-label');
      labels.appendChild(document.createElement('div')).textContent = said;
    }
    const foot = document.createElement('div');
    foot.className = 'tips-foot';
    if (this.ways.drag) foot.appendChild(document.createElement('span')).textContent = this.touch ? 'Hold the bar and drag it to move it.' : 'Drag the bar to move it.';
    const answers = foot.appendChild(document.createElement('div'));
    button(answers, 'got', 'Got it', null, () => {
      this.dropTips();
      this.fold();
    });
    if (!this.page.tour) {
      button(answers, '', 'How it works', null, () => {
        this.dropTips();
        this.fold();
        this.does.guide();
      });
    }
    labels.hidden = foot.hidden = this.away;
    this.screen.append(labels, foot);
    this.tips = { labels, foot };
    this.placeTips();
  }

  /** Puts what is said of the buttons beside them, line by button, and what is to be answered under it, or over it where there is no room under */
  private placeTips(): void {
    const bar = this.bar;
    if (!bar || !this.tips) return;
    const { labels, foot } = this.tips;
    const left = this.ways.at.side === 'left';
    const beside = left ? { left: `${bar.offsetLeft + bar.offsetWidth + 8}px`, right: 'auto' } : { left: 'auto', right: `${this.screen.clientWidth - bar.offsetLeft + 8}px` };
    Object.assign(labels.style, beside, { top: `${bar.offsetTop}px` });
    labels.classList.toggle('up', bar.classList.contains('up'));
    labels.classList.toggle('at-left', left);
    const under = bar.offsetTop + bar.offsetHeight + 6;
    const fits = under + foot.offsetHeight + 8 <= this.screen.clientHeight;
    Object.assign(foot.style, beside, { top: `${fits ? under : Math.max(8, bar.offsetTop - foot.offsetHeight - 6)}px` });
  }

  /** Ends the saying of what the buttons do, and has it known that it was said */
  private dropTips(): void {
    if (!this.tips) return;
    this.tips.labels.remove();
    this.tips.foot.remove();
    this.tips = null;
    this.bar?.classList.remove('is-told');
    this.ways = { ...this.ways, tips: false };
    this.does.tipsSeen();
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
    if (this.tips) this.tips.labels.hidden = this.tips.foot.hidden = away;
    if (!away) {
      this.placeTips();
      return;
    }
    this.fold();
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
    /** A line of the menu that leads elsewhere: the menu is put away, and the bar folds */
    const leads = (label: string, does: () => void): void => {
      button(menu, '', label, null, () => {
        this.fold();
        does();
      });
    };
    if (this.ownViewer && !this.page.alone) leads("Show the browser's viewer", () => this.does.otherViewer());
    if (this.ways.handheld) {
      leads('Open a PDF from this device', () => this.does.choosePdf());
    } else {
      button(menu, '', 'Hide on this site', null, () => this.does.hideHere());
      button(menu, '', 'Hide on every site', null, () => this.does.hideEverywhere());
    }
    if (!this.page.tour) leads('How it works', () => this.does.guide());
    leads('Settings', () => this.does.settings());
    this.screen.appendChild(menu);
    const beside = this.ways.at.side === 'left' ? bar.offsetLeft + bar.offsetWidth + 8 : bar.offsetLeft - menu.offsetWidth - 8;
    menu.style.left = `${beside}px`;
    // The button that opens the menu is the last of the bar, or the first where the others stand over the one it folds into
    const level = bar.classList.contains('up') ? bar.offsetTop : bar.offsetTop + bar.offsetHeight - menu.offsetHeight;
    menu.style.top = `${within(level, 8, Math.max(8, this.screen.clientHeight - menu.offsetHeight - 8))}px`;
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
    hint.textContent = this.touch ? 'Tap where the reading is to start' : 'Click where the reading is to start. Esc leaves it.';
    if (this.touch) button(hint, '', 'Leave it', X, () => this.stopPicking());
    this.root.append(layer, box);
    this.screen.appendChild(hint);
    this.picking = { layer, box, hint };

    const blockAt = (x: number, y: number): Element | null => blockUnder(document.elementsFromPoint(x, y).find((el) => el !== this.host) ?? null);
    layer.addEventListener('pointermove', (event) => {
      const block = blockAt(event.clientX, event.clientY);
      box.hidden = !block;
      if (!block) return;
      const at = block.getBoundingClientRect();
      box.style.left = `${at.left - 4}px`;
      box.style.top = `${at.top - 2}px`;
      box.style.width = `${at.width + 8}px`;
      box.style.height = `${at.height + 4}px`;
    });
    // A finger is nowhere before it presses: the block is the one at the click itself
    layer.addEventListener('click', (event) => {
      const block = blockAt(event.clientX, event.clientY);
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
    this.screen.querySelector('.toast')?.remove();
    window.clearTimeout(this.toastTimer);
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    if (this.top) toast.style.top = `${14 + this.top}px`;
    this.screen.appendChild(toast);
    this.toastTimer = window.setTimeout(() => toast.remove(), stays);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (!this.picking && !this.menu)) return;
    event.stopPropagation();
    this.stopPicking();
    this.closeMenu();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.target !== this.host) this.fold();
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
