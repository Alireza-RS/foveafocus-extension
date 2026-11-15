/**
 * The text of a web page, written out as Markdown.
 *
 * The reader plays notes written in Markdown, and leaves out of them what is not prose:
 * code, tables, lines that hold only links, the reference list. A page handed over as
 * Markdown is read by the same rules. What is written here is the structure of the page
 * (headings, paragraphs, lists, quotations, code, tables, links); every character of its
 * text is escaped, so that nothing in it is taken for Markdown of its own.
 *
 * Of an article, only the article is read: the page is given to Readability, the library
 * behind the reading view of Firefox, which leaves menus, sidebars and footers out. A page
 * that is no article is read as it stands, without what is plainly not its text.
 */

import { Readability, isProbablyReaderable } from '@mozilla/readability';

export interface PageText {
  markdown: string;
  title: string;
  /** Where in the Markdown the reading starts, when it does not start at the top */
  startAt?: number;
}

/** Marks, for as long as the page is being read out, the element the reading starts in */
const START = 'data-foveafocus-start';

const NEVER_TEXT = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'picture',
  'button', 'input', 'select', 'textarea', 'datalist', 'progress', 'meter', 'map', 'del', 's', 'strike', 'rt', 'rp', 'head',
]);
/** Parts of a page that are not its text; left out where the whole page is read and not an article taken out of it */
const NOT_THE_TEXT = new Set(['nav', 'footer', 'aside', 'form', 'dialog', 'menu']);
const NOT_THE_TEXT_ROLES = /^(?:navigation|banner|contentinfo|complementary|search|menu|menubar|toolbar|dialog|alertdialog|alert|tablist)$/;
const BLOCKS = new Set<string>([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const BLOCK_SELECTOR = Array.from(BLOCKS).join(',');

/** What gives a page its structure; inside a link, a heading or a cell of a table it is no more than a gap between words */
const STRUCTURE = new Set(['br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'ul', 'ol', 'li', 'blockquote']);

/** A mark that points to a note or a source: [1], [a], [citation needed] */
const REFERENCE_MARK = /^\s*\[[^\]]{1,24}\]\s*$/;

/** Figures and signs as they are written raised and lowered, so that 10 to the power of 6 is not read as 106 */
const RAISED: Record<string, string> = { 0: '\u2070', 1: '\u00B9', 2: '\u00B2', 3: '\u00B3', 4: '\u2074', 5: '\u2075', 6: '\u2076', 7: '\u2077', 8: '\u2078', 9: '\u2079', '+': '\u207A', '-': '\u207B', '\u2212': '\u207B', n: '\u207F' };
const LOWERED: Record<string, string> = { 0: '\u2080', 1: '\u2081', 2: '\u2082', 3: '\u2083', 4: '\u2084', 5: '\u2085', 6: '\u2086', 7: '\u2087', 8: '\u2088', 9: '\u2089', '+': '\u208A', '-': '\u208B', '\u2212': '\u208B' };

/** Text of the page, with every character that Markdown gives a meaning to escaped */
function escaped(text: string): string {
  return text.replace(/[\\`*_~=$%<[\]^|]/g, '\\$&');
}

/** A line of text that would be taken for a heading, a list item, a quotation or a rule by how it starts */
function escapedStart(line: string): string {
  return line
    .replace(/^(#{1,6})(?=\s)/, '\\$1')
    .replace(/^([>+-])/, '\\$1')
    .replace(/^(\d{1,3})([.)])(?=\s)/, '$1\\$2');
}

interface ListState {
  ordered: boolean;
  count: number;
}

class Writer {
  private lines: string[] = [];
  /** The line being written: what it starts with, and its text so far */
  private text = '';
  private marker = '';
  private quotes = 0;
  private lists: ListState[] = [];
  /** Characters written in the finished lines, line ends counted */
  private written = 0;
  private startWanted = false;
  startAt: number | undefined;
  /** Where the line of the start begins and what it starts with, to look for a word in it */
  startLine: { at: number; text: string } | null = null;

  /**
   * @param live - the nodes stand in the page, so what is not shown there can be told and left out
   * @param wholePage - the page is read as it stands, and what is plainly not its text is left out
   * @param flat - the text is wanted as one run of words, whatever structure it has
   */
  constructor(private readonly live: boolean, private readonly wholePage: boolean, private readonly flat = false) {}

  private get quoted(): string {
    return '> '.repeat(this.quotes);
  }

  private push(line: string): void {
    this.lines.push(line);
    this.written += line.length + 1;
  }

  /** Ends the line being written. A line with nothing on it leaves no trace. */
  private endLine(): void {
    const text = this.text.trim();
    this.text = '';
    if (!text) return;
    const indent = '  '.repeat(Math.max(0, this.lists.length - 1));
    const starts = `${this.quoted}${this.marker ? indent + this.marker : ''}`;
    this.marker = '';
    const line = `${starts}${escapedStart(text)}`;
    if (this.startWanted) {
      this.startWanted = false;
      this.startAt = this.written;
      this.startLine = { at: this.written + starts.length, text: line.slice(starts.length) };
    }
    this.push(line);
  }

  /** Ends a block: its last line, and an empty line after it */
  private endBlock(): void {
    this.endLine();
    if (this.lines.length && this.lines[this.lines.length - 1] !== this.quoted.trimEnd()) this.push(this.quoted.trimEnd());
  }

  private add(text: string): void {
    this.text += !this.text || this.text.endsWith(' ') ? text.replace(/^ +/, '') : text;
  }

  /** The words of a node as one run, for a place that holds a single line: a heading, a link, a cell */
  private inlineText(node: Node): string {
    const inner = new Writer(this.live, false, true);
    inner.children(node);
    return inner.text.trim();
  }

  children(node: Node): void {
    for (const child of Array.from(node.childNodes)) this.node(child);
  }

  private node(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      this.add(escaped((node.nodeValue ?? '').replace(/\s+/g, ' ')));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.localName;
    if (NEVER_TEXT.has(tag) || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return;
    const style = this.live ? getComputedStyle(el) : null;
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden') return;
      // What a closed fold of the page holds is not shown either; an element that is no box of its own is asked through its children
      if (style.display !== 'contents' && !el.checkVisibility()) return;
    }
    if (this.wholePage) {
      if (NOT_THE_TEXT.has(tag) || NOT_THE_TEXT_ROLES.test(el.getAttribute('role') ?? '')) return;
      if (tag === 'header' && el.parentElement?.localName === 'body') return;
      if (style && /^(?:fixed|sticky)$/.test(style.position)) return;
    }
    const block = BLOCKS.has(tag) || (!!style && !/^(?:inline|contents|ruby)/.test(style.display));

    if (this.flat && (block || STRUCTURE.has(tag))) {
      this.add(' ');
      this.children(el);
      this.add(' ');
      return;
    }
    if (el.hasAttribute(START)) {
      this.endLine();
      this.startWanted = true;
    }

    switch (tag) {
      case 'br':
        this.endLine();
        return;
      case 'hr':
        this.endBlock();
        return;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        this.endBlock();
        const text = this.inlineText(el);
        if (text) {
          this.text = `${'#'.repeat(Number(tag[1]))} ${text}`;
          this.endHeading();
        }
        return;
      }
      case 'pre':
        this.code(el);
        return;
      case 'table':
        if (laysOut(el as HTMLTableElement)) {
          this.endBlock();
          this.children(el);
          this.endBlock();
        } else {
          this.table(el as HTMLTableElement);
        }
        return;
      case 'ul': case 'ol':
        this.endBlock();
        this.lists.push({ ordered: tag === 'ol', count: 0 });
        this.children(el);
        this.endLine();
        this.lists.pop();
        this.endBlock();
        return;
      case 'li': {
        this.endLine();
        const list = this.lists[this.lists.length - 1];
        if (list) {
          list.count += 1;
          this.marker = list.ordered ? `${list.count}. ` : '- ';
        }
        this.children(el);
        this.endLine();
        this.marker = '';
        return;
      }
      case 'blockquote':
        this.endBlock();
        this.quotes += 1;
        this.children(el);
        this.endLine();
        this.quotes -= 1;
        this.endBlock();
        return;
      case 'a':
        this.link(el);
        return;
      case 'code': case 'kbd': case 'samp': case 'tt': {
        const code = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!code) return;
        const ticks = '`'.repeat(Math.max(0, ...Array.from(code.matchAll(/`+/g), (run) => run[0].length)) + 1);
        this.add(`${ticks}${code}${ticks}`);
        return;
      }
      case 'sup': case 'sub': {
        if (REFERENCE_MARK.test(el.textContent ?? '') || el.querySelector('a[href^="#"]') || el.closest('a[href^="#"]')) return;
        const signs = Array.from((el.textContent ?? '').trim(), (sign) => (tag === 'sup' ? RAISED : LOWERED)[sign]);
        if (signs.length > 0 && signs.length <= 4 && signs.every(Boolean) && /\S$/.test(this.text)) this.add(signs.join(''));
        else this.children(el);
        return;
      }
      case 'math':
        this.maths(el, el.querySelector('annotation[encoding*="tex" i]')?.textContent ?? el.getAttribute('alttext') ?? '');
        return;
      case 'img':
        // A picture that stands for maths names the maths it shows
        if (/math/i.test(el.className) && !/display/i.test(el.className)) this.maths(el, el.getAttribute('alt') ?? '');
        return;
      case 'q':
        this.add('“');
        this.children(el);
        this.add('”');
        return;
      default:
        if (block) {
          this.endBlock();
          this.children(el);
          this.endBlock();
        } else {
          this.children(el);
        }
    }
  }

  /** A heading is one line that starts with its marks, which are Markdown and stay unescaped */
  private endHeading(): void {
    const line = `${this.quoted}${this.text}`;
    this.text = '';
    this.marker = '';
    if (this.startWanted) {
      this.startWanted = false;
      this.startAt = this.written;
      this.startLine = { at: this.written, text: line };
    }
    this.push(line);
    this.push(this.quoted.trimEnd());
  }

  private link(el: Element): void {
    // A link round whole blocks, as round a card with a heading and a line of text, is no link in a line
    if (!this.flat && el.querySelector(BLOCK_SELECTOR)) {
      this.children(el);
      return;
    }
    const text = this.inlineText(el);
    const href = el.getAttribute('href') ?? '';
    if (!text || (href.startsWith('#') && REFERENCE_MARK.test(el.textContent ?? ''))) return;
    // Text with a bracket of its own would not be told from the brackets of the link
    if (this.flat || !href || /^\s*javascript:/i.test(href) || /[[\]]/.test(el.textContent ?? '')) {
      this.add(text);
      return;
    }
    this.add(`[${text}](${href.trim().replace(/[\s()<>]/g, (sign) => `%${sign.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`);
  }

  private code(el: Element): void {
    this.endBlock();
    const code = (el.textContent ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
    if (!code) return;
    const fence = '`'.repeat(Math.max(3, ...Array.from(code.matchAll(/`+/g), (run) => run[0].length + 1)));
    if (this.startWanted) {
      this.startWanted = false;
      this.startAt = this.written;
    }
    this.push(`${this.quoted}${fence}`);
    for (const line of code.split('\n')) this.push(`${this.quoted}${line}`);
    this.push(`${this.quoted}${fence}`);
    this.push(this.quoted.trimEnd());
  }

  private table(el: HTMLTableElement): void {
    this.endBlock();
    // A start inside the table is a start at the table: its cells are not places of their own
    if (el.querySelector(`[${START}]`)) this.startWanted = true;
    const caption = el.caption ? this.inlineText(el.caption) : '';
    if (caption) {
      this.text = caption;
      this.endBlock();
    }
    let first = true;
    for (const row of Array.from(el.rows)) {
      const cells = Array.from(row.cells, (cell) => this.inlineText(cell));
      if (!cells.some(Boolean)) continue;
      if (this.startWanted) {
        this.startWanted = false;
        this.startAt = this.written;
      }
      this.push(`${this.quoted}| ${cells.join(' | ')} |`);
      if (first) this.push(`${this.quoted}|${' --- |'.repeat(cells.length)}`);
      first = false;
    }
    this.push(this.quoted.trimEnd());
  }

  /**
   * Maths inside a line is written as in a note, between dollar signs, from its source in
   * TeX where the page carries that; maths set apart from the text is left out, as it is in
   * a note. Without a source, what the maths holds is read as text.
   */
  private maths(el: Element, source: string): void {
    if (el.getAttribute('display') === 'block') return;
    const tex = source.replace(/\s+/g, ' ').trim();
    if (tex) this.add(`$${tex.replace(/\$/g, '\\$')}$`);
    else this.add(escaped((el.textContent ?? '').replace(/\s+/g, ' ')));
  }

  finish(): string {
    this.endLine();
    while (this.lines.length && !this.lines[this.lines.length - 1].trim()) this.lines.pop();
    return this.lines.join('\n');
  }
}

/**
 * Whether a table is there to lay the page out, not to set figures side by side: one that is
 * marked as such, that holds another table or whole blocks of text in its cells, or that
 * has a single column. Its cells are read as the text of the page.
 */
function laysOut(table: HTMLTableElement): boolean {
  if (/^(?:presentation|none)$/.test(table.getAttribute('role') ?? '')) return true;
  if (table.querySelector('table, p, div, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6')) return true;
  return !table.caption && !Array.from(table.rows).some((row) => row.cells.length > 1);
}

interface Written {
  markdown: string;
  startAt?: number;
  startLine: { at: number; text: string } | null;
}

function write(root: Node, live: boolean, wholePage: boolean): Written {
  const writer = new Writer(live, wholePage);
  writer.children(root);
  const markdown = writer.finish();
  return { markdown, startAt: writer.startAt, startLine: writer.startLine };
}

/** The element a node stands in that is a paragraph, a heading, a list item or the like */
function blockOf(node: Node | null): Element | null {
  let el = node instanceof Element ? node : node?.parentElement ?? null;
  while (el && el !== document.body && !BLOCKS.has(el.localName)) el = el.parentElement;
  return el && el !== document.documentElement ? el : null;
}

/** The article of the page as Readability takes it out of a copy of the page, or null where it finds none worth the name */
function article(): { content: Element; title: string } | null {
  if (!isProbablyReaderable(document)) return null;
  try {
    const copy = document.cloneNode(true) as Document;
    const found = new Readability(copy, { serializer: (el) => el }).parse();
    const content = found?.content as unknown as Element | undefined;
    if (!found || !content || (found.textContent ?? '').trim().length < 200) return null;
    // The title as the page gives it often carries the name of the site as well; the heading of the article does not
    const title = (found.title ?? '').replace(/\s+/g, ' ').trim();
    const heading = (document.querySelector('article h1, main h1, h1')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return { content, title: heading && title.includes(heading) ? heading : title };
  } catch {
    return null;
  }
}

/** No more of the words of a selection than this are looked for in the line it starts in */
const WORDS_ENOUGH = 12;

/**
 * The offset of a word in the line the reading starts in: the place of the selected words
 * there, counted off among their like where the line holds them more than once. Words that
 * the line does not hold as they stand, as where they run over a link in it, are looked for
 * by fewer and fewer of them: without a sign they end in, such as a comma, then without
 * their last word.
 *
 * @param before - the text of the block before the selection
 */
function offsetOfWords(line: string, words: string, before: string): number {
  const fewer = (some: string): string => (/[\p{L}\p{N}]$/u.test(some) ? some.slice(0, Math.max(0, some.lastIndexOf(' '))) : some.replace(/[^\p{L}\p{N}]+$/u, ''));
  for (let some = words; some; some = fewer(some)) {
    const sought = escaped(some);
    let at = -1;
    for (let earlier = occurrences(before, some); earlier >= 0; earlier--) {
      const next = line.indexOf(sought, at + 1);
      if (next < 0) break;
      at = next;
    }
    if (at >= 0) return at;
  }
  return 0;
}

/** How often some words stand in a text */
function occurrences(text: string, words: string): number {
  if (!words) return 0;
  let count = 0;
  for (let at = text.indexOf(words); at >= 0; at = text.indexOf(words, at + words.length)) count += 1;
  return count;
}

/** The name of the file that a page shows, as the address of the page ends in it */
export function fileName(): string {
  const name = location.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * A file of text that the browser shows as it stands, in one block: that block, and whether
 * the text is Markdown. A Markdown file is read as the note it is; in any other text no sign
 * is taken for Markdown.
 */
function shownFile(): { block: Element; markdown: boolean } | null {
  if (!/^text\/(?:plain|markdown|x-markdown)$/.test(document.contentType)) return null;
  const block = document.querySelector('body > pre');
  return block && { block, markdown: document.contentType !== 'text/plain' || /\.(?:md|markdown)$/i.test(location.pathname) };
}

/**
 * The place in the page that was pointed at: what stands there or, in a file of text, which
 * is one block from end to end, the spot in its text.
 */
export function placeAt(what: Node | null, x: number, y: number): Node | Range | null {
  return (shownFile() && document.caretRangeFromPoint(x, y)) || what;
}

/** A file of text as Markdown. A selection starts the reading at its first word; a place that was pointed at, at the start of its line. */
function fileText(file: { block: Element; markdown: boolean }, from?: Node | Range): PageText {
  const as = (text: string): string => (file.markdown ? text : unsigned(text));
  const markdown = as(file.block.textContent ?? '');
  let startAt: number | undefined;
  if (from instanceof Range && file.block.contains(from.startContainer)) {
    const lead = document.createRange();
    lead.selectNodeContents(file.block);
    lead.setEnd(from.startContainer, from.startOffset);
    startAt = as(from.collapsed ? lead.toString().replace(/[^\n]*$/, '') : lead.toString()).length;
    while (/\s/.test(markdown.charAt(startAt))) startAt += 1;
  }
  return { markdown, title: fileName() || location.hostname, startAt };
}

/**
 * The page as Markdown: its article where it has one, else all of its text. With a place to
 * start from, the reading starts in the block that place lies in, at the first of the words
 * selected there if any were.
 */
export function pageText(from?: Node | Range): PageText {
  const file = shownFile();
  if (file) return fileText(file, from);
  const block = from ? blockOf(from instanceof Range ? from.startContainer : from) : null;
  // Of a selection, its first words as far as they stand in the block it starts in, and the text of that block before it
  let words = '';
  let before = '';
  if (from instanceof Range && block) {
    const held = document.createRange();
    held.selectNodeContents(block);
    held.setStart(from.startContainer, from.startOffset);
    if (block.contains(from.endContainer)) held.setEnd(from.endContainer, from.endOffset);
    words = held.toString().replace(/\s+/g, ' ').trim().split(' ').slice(0, WORDS_ENOUGH).join(' ');
    const lead = document.createRange();
    lead.selectNodeContents(block);
    lead.setEnd(from.startContainer, from.startOffset);
    before = lead.toString().replace(/\s+/g, ' ');
  }
  block?.setAttribute(START, '');
  try {
    const found = article();
    const inArticle = found && write(found.content, false, false);
    let written: Written;
    let title = '';
    if (inArticle && !(block && inArticle.startAt === undefined)) {
      written = inArticle;
      title = found?.title ?? '';
    } else {
      // A page with no article is read as it stands. So is one whose article does not hold
      // the place to start from; where that place is no text of the page at all, the article
      // is read from its top.
      const whole = write(document.body, true, true);
      written = inArticle && whole.startAt === undefined ? inArticle : whole;
      title = written === inArticle ? found?.title ?? '' : '';
    }
    if (title) {
      const head = `# ${escaped(title)}\n\n`;
      written = {
        markdown: head + written.markdown,
        startAt: written.startAt === undefined ? undefined : written.startAt + head.length,
        startLine: written.startLine && { at: written.startLine.at + head.length, text: written.startLine.text },
      };
    }

    let startAt = written.startAt;
    if (startAt !== undefined && written.startLine && words) {
      startAt = written.startLine.at + offsetOfWords(written.startLine.text, words, before);
    }
    return { markdown: written.markdown, title: title || document.title.trim() || location.hostname, startAt };
  } finally {
    block?.removeAttribute(START);
  }
}

/** A selection as Markdown, with the structure it has in the page */
export function selectionText(selection: Selection): PageText {
  const file = shownFile();
  if (file) return { markdown: file.markdown ? selection.toString() : unsigned(selection.toString()), title: fileName() || location.hostname };
  const holder = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i++) holder.appendChild(selection.getRangeAt(i).cloneContents());
  return { markdown: write(holder, false, false).markdown, title: document.title.trim() || location.hostname };
}

/** Text with no sign in it that Markdown would take for its own: its paragraphs, each as one line */
function unsigned(text: string): string {
  return text.split(/\n\s*\n/).map((block) => escapedStart(escaped(block.replace(/\s+/g, ' ').trim()))).filter(Boolean).join('\n\n');
}

/** Text that is known only as a string, such as a selection in a frame of the page */
export function plainText(text: string): PageText {
  return { markdown: unsigned(text), title: document.title.trim() || location.hostname };
}
