/**
 * What the reader takes from the app it was written for, made for a browser page.
 *
 * The reader and its settings are the source of the FoveaFocus plugin for Obsidian, copied
 * unchanged into core/. They ask the app for a window to stand in, a switch, a slider,
 * icons, and a handful of helpers on every element. The build puts this module in the place
 * of the app, so the same source runs in a page of the extension. No more of the app is
 * made here than that source uses.
 */

import type { App } from 'obsidian';
import { iconElement } from './icons';

interface ElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

function make(parent: Node | null, tag: string, info?: ElementInfo | string, callback?: (el: HTMLElement) => void): HTMLElement {
  const el = document.createElement(tag);
  const o: ElementInfo = typeof info === 'string' ? { cls: info } : info ?? {};
  if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
  if (o.text instanceof DocumentFragment) el.appendChild(o.text);
  else if (o.text !== undefined) el.textContent = String(o.text);
  if (o.attr) {
    for (const key of Object.keys(o.attr)) {
      const value = o.attr[key];
      if (value !== null && value !== undefined) el.setAttribute(key, String(value));
    }
  }
  if (o.title) el.title = o.title;
  if (o.type) el.setAttribute('type', o.type);
  if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
  if (o.placeholder) el.setAttribute('placeholder', o.placeholder);
  if (o.href) el.setAttribute('href', o.href);
  const into = o.parent ?? parent;
  if (into) {
    if (o.prepend) into.insertBefore(el, into.firstChild);
    else into.appendChild(el);
  }
  callback?.(el);
  return el;
}

const classes = (names: string[]): string[] => names.join(' ').split(/\s+/).filter(Boolean);

/** The helpers the app adds to every node and element, by the names the reader calls them by */
export const ELEMENT_HELPERS: Record<'node' | 'element' | 'html', Record<string, (this: never, ...args: never[]) => unknown>> = {
  node: {
    createEl(this: Node, tag: string, info?: ElementInfo | string, callback?: (el: HTMLElement) => void) { return make(this, tag, info, callback); },
    createDiv(this: Node, info?: ElementInfo | string, callback?: (el: HTMLElement) => void) { return make(this, 'div', info, callback); },
    createSpan(this: Node, info?: ElementInfo | string, callback?: (el: HTMLElement) => void) { return make(this, 'span', info, callback); },
    createSvg(this: Node, tag: string, info?: { cls?: string | string[]; attr?: Record<string, string | number | boolean | null> }) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      if (info?.cls) el.setAttribute('class', Array.isArray(info.cls) ? info.cls.join(' ') : info.cls);
      if (info?.attr) for (const key of Object.keys(info.attr)) el.setAttribute(key, String(info.attr[key]));
      this.appendChild(el);
      return el;
    },
    empty(this: Node) { while (this.firstChild) this.removeChild(this.firstChild); },
    detach(this: Node) { this.parentNode?.removeChild(this); },
    instanceOf(this: Node, type: new () => unknown) { return this instanceof type; },
  },
  element: {
    setText(this: Element, text: string | DocumentFragment) {
      if (text instanceof DocumentFragment) this.replaceChildren(text);
      else this.textContent = String(text);
    },
    addClass(this: Element, ...names: string[]) { this.classList.add(...classes(names)); },
    removeClass(this: Element, ...names: string[]) { this.classList.remove(...classes(names)); },
    toggleClass(this: Element, names: string | string[], on: boolean) { for (const name of classes(([] as string[]).concat(names))) this.classList.toggle(name, on); },
    hasClass(this: Element, name: string) { return this.classList.contains(name); },
    setAttr(this: Element, key: string, value: string | number | boolean | null) {
      if (value === null || value === undefined) this.removeAttribute(key);
      else this.setAttribute(key, String(value));
    },
    getAttr(this: Element, key: string) { return this.getAttribute(key); },
  },
  html: {
    setCssProps(this: HTMLElement, props: Record<string, string>) { for (const key of Object.keys(props)) this.style.setProperty(key, props[key]); },
    setCssStyles(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); },
    isShown(this: HTMLElement) { return this.getClientRects().length > 0; },
  },
};

const owners = { node: Node.prototype, element: Element.prototype, html: HTMLElement.prototype } as const;
for (const kind of Object.keys(owners) as Array<keyof typeof owners>) {
  for (const name of Object.keys(ELEMENT_HELPERS[kind])) {
    Object.defineProperty(owners[kind], name, { value: ELEMENT_HELPERS[kind][name], writable: true, configurable: true });
  }
}

/** Draws the icon of that name into an element, in place of what the element held */
export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.replaceChildren();
  const icon = iconElement(iconId);
  if (icon) parent.appendChild(icon);
}

const SVG_PARTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'title']);
const SVG_ATTRIBUTES = /^(?:class|d|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|points|width|height|viewBox|fill|fill-rule|clip-rule|stroke|stroke-width|stroke-linecap|stroke-linejoin|transform|opacity|xmlns)$/;

/** Markup as nodes, with nothing kept of it but the shapes of a drawing */
export function sanitizeHTMLToDom(markup: string): DocumentFragment {
  const holder = document.createElement('template');
  holder.innerHTML = markup;
  for (const el of Array.from(holder.content.querySelectorAll('*'))) {
    if (!SVG_PARTS.has(el.localName)) {
      el.remove();
      continue;
    }
    for (const attribute of Array.from(el.attributes)) {
      if (!SVG_ATTRIBUTES.test(attribute.name)) el.removeAttribute(attribute.name);
    }
  }
  return holder.content;
}

export const Platform = {
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: /mac/i.test(navigator.platform),
};

/**
 * Has the reader and its settings know that the browser runs on a phone or a tablet, as
 * the app they were written for knows it of itself: they then keep to the settings and the
 * controls they have for one. It is said before either of them is made.
 */
export function onHandheld(): void {
  Object.assign(Platform, { isDesktop: false, isDesktopApp: false, isMobile: true, isMobileApp: true });
  document.body.classList.add('is-mobile');
}

/** The window the reader stands in: a frame in the middle of the page, over a ground that closes it */
export class Modal {
  app: App;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  contentEl: HTMLElement;
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
  };

  constructor(app: App) {
    this.app = app;
    this.containerEl = make(null, 'div', 'modal-container');
    make(this.containerEl, 'div', 'modal-bg').addEventListener('click', () => this.close());
    this.modalEl = make(this.containerEl, 'div', 'modal');
    this.contentEl = make(this.modalEl, 'div', 'modal-content');
  }

  open(): void {
    document.body.appendChild(this.containerEl);
    document.addEventListener('keydown', this.onKey);
    void this.onOpen();
  }

  close(): void {
    if (!this.containerEl.isConnected) return;
    document.removeEventListener('keydown', this.onKey);
    void this.onClose();
    this.containerEl.remove();
  }

  onOpen(): void | Promise<void> { /* for the reader */ }
  onClose(): void | Promise<void> { /* for the reader */ }
}

export class MarkdownView {}
export class TFile {}

/** A switch. It tells of its value whenever it is set, by a press or from code, as the app's does. */
export class ToggleComponent {
  toggleEl: HTMLElement;
  private readonly box: HTMLInputElement;
  private on = false;
  private tell: (value: boolean) => unknown = () => undefined;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = make(containerEl, 'div', 'checkbox-container');
    this.box = make(this.toggleEl, 'input', { type: 'checkbox', attr: { tabindex: 0 } }) as HTMLInputElement;
    this.toggleEl.addEventListener('click', () => this.setValue(!this.on));
  }

  setValue(value: boolean): this {
    this.on = value;
    this.box.checked = value;
    this.toggleEl.classList.toggle('is-enabled', value);
    this.tell(value);
    return this;
  }

  getValue(): boolean { return this.on; }

  onChange(told: (value: boolean) => unknown): this {
    this.tell = told;
    return this;
  }
}

/**
 * A slider that fills its track as far as its handle and says what it is set to beside
 * itself, unless the format it is given leaves nothing to say. It tells of a new value once
 * it is let go, or while it is dragged where that is asked for.
 */
export class SliderComponent {
  sliderEl: HTMLInputElement;
  private readonly saidEl: HTMLElement;
  private format: (value: number) => string = String;
  private instant = false;
  private tell: (value: number) => unknown = () => undefined;

  constructor(containerEl: HTMLElement) {
    this.sliderEl = make(containerEl, 'input', { cls: 'slider', type: 'range' }) as HTMLInputElement;
    this.saidEl = make(containerEl, 'span', 'slider-value');
    this.sliderEl.addEventListener('input', () => {
      this.show();
      if (this.instant) this.tell(this.getValue());
    });
    this.sliderEl.addEventListener('change', () => {
      if (!this.instant) this.tell(this.getValue());
    });
    this.show();
  }

  setLimits(min: number, max: number, step: number | 'any'): this {
    this.sliderEl.min = String(min);
    this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    this.show();
    return this;
  }

  setInstant(instant: boolean): this {
    this.instant = instant;
    return this;
  }

  setDisplayFormat(format: (value: number) => string): this {
    this.format = format;
    this.show();
    return this;
  }

  setValue(value: number): this {
    this.sliderEl.value = String(value);
    this.show();
    return this;
  }

  getValue(): number { return parseFloat(this.sliderEl.value); }

  onChange(told: (value: number) => unknown): this {
    this.tell = told;
    return this;
  }

  private show(): void {
    const min = parseFloat(this.sliderEl.min || '0');
    const max = parseFloat(this.sliderEl.max || '100');
    this.sliderEl.style.setProperty('--slider-filled', String(max > min ? (this.getValue() - min) / (max - min) : 0));
    const said = this.format(this.getValue());
    this.saidEl.textContent = said;
    this.saidEl.hidden = said === '';
  }
}

/** A page of settings: an element to draw into, emptied when the page is left */
export class PluginSettingTab {
  app: App;
  plugin: unknown;
  containerEl: HTMLElement;

  constructor(app: App, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = make(null, 'div', 'vertical-tab-content');
  }

  hide(): void {
    this.containerEl.replaceChildren();
  }
}

/** An app with no notes in it: the reader is handed its text, and finds none to load by itself */
export function makeApp(): App {
  const app = {
    workspace: {
      onLayoutReady(ready: () => void): void { ready(); },
      on(): object { return {}; },
      offref(): void { /* nothing was registered */ },
      getActiveViewOfType(): null { return null; },
      getActiveFile(): null { return null; },
    },
  };
  return app as unknown as App;
}
