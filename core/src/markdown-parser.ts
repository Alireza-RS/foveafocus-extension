/**
 * Markdown to reader text.
 *
 * The reader plays prose. Everything in a note that is not prose is dropped
 * here: front matter, tag lines, link-only lines such as "Related:", block
 * IDs, comments, code and Mermaid blocks, tables, display maths and the
 * sections named in the skip list (the reference list by default). Headings
 * and callout titles are kept and marked so the reader can show structure.
 *
 * The parser also records, for every word it emits, where that word sits in
 * the source. "Start from the cursor" uses that record, so the starting word
 * is found by position and never by searching for its text.
 */

import { latexToText } from './latex-to-text';
import { REFERENCE_HEADINGS, headingMatches, normaliseHeading, toPhraseSet } from './filters';
import { tokenSpans } from './rsvp-engine';

export interface MarkdownFilterOptions {
  /** Drop fenced code blocks. Mermaid and query blocks are dropped regardless. */
  skipCodeBlocks: boolean;
  /** Drop table rows. Captions above tables are ordinary text and stay. */
  skipTables: boolean;
  /** Read inline maths as symbols (true) or drop it (false). Display maths is always dropped. */
  readInlineMaths: boolean;
  /** Drop "Tags: #a #b" lines and lines made only of tags. */
  skipTagLines: boolean;
  /** Drop lines made only of links, such as "Related: [[A|a]] [[B|b]]". */
  skipLinkLines: boolean;
  /** Drop the reference list. */
  skipReferences: boolean;
  /** Headings whose sections are dropped. */
  excludedSections: string[];
}

export interface ParsedMarkdown {
  /** Text for the reader. */
  text: string;
  /** Source offset at which each reader token starts. */
  tokenStart: number[];
  /** Source offset just past the end of each reader token. */
  tokenEnd: number[];
}

/** Fenced blocks that are never prose, whatever the code setting says. */
const NEVER_PROSE = new Set([
  'mermaid', 'dataview', 'dataviewjs', 'tasks', 'query', 'math', 'latex', 'tikz', 'plantuml', 'dot', 'chart', 'button', 'tracker',
]);

class Output {
  private chunks: string[] = [];
  readonly source: number[] = [];
  private lineStart = 0;
  private length = 0;
  private visible = false;

  /** Append text whose characters all come from `at` (or from `at + i` when `spread`). */
  push(text: string, at: number, spread: boolean): void {
    if (!text) return;
    this.chunks.push(text);
    for (let i = 0; i < text.length; i++) this.source.push(spread ? at + i : at);
    this.length += text.length;
    if (!this.visible && /\S/.test(text)) this.visible = true;
  }

  beginLine(): void {
    this.lineStart = this.length;
    this.visible = false;
  }

  /** Close the current line; a line with nothing visible on it leaves no trace. */
  endLine(at: number): void {
    if (!this.visible) {
      const text = this.chunks.join('').slice(0, this.lineStart);
      this.chunks = [text];
      this.source.length = this.lineStart;
      this.length = this.lineStart;
      return;
    }
    this.push('\n', at, false);
  }

  finish(): { text: string; source: number[] } {
    let text = this.chunks.join('');
    while (text.endsWith('\n')) text = text.slice(0, -1);
    this.source.length = text.length;
    return { text, source: this.source };
  }
}

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

/** What a wikilink without display text shows: the note name, or the heading it points at. */
function wikilinkLabel(target: string): string {
  const parts = target.split('#').map((p) => p.trim()).filter((p) => p && !p.startsWith('^'));
  return parts.length ? parts[parts.length - 1] : '';
}

interface InlineState {
  options: MarkdownFilterOptions;
  /** Set when a comment opens on this line and does not close on it. */
  openComment: '%%' | '-->' | null;
}

/**
 * Inline pass over one line. `s[k]` sits at source offset `base + k`.
 * Markup is removed, link text is kept, inline maths is converted.
 */
function inline(s: string, base: number, out: Output, state: InlineState): void {
  let i = 0;
  let literalFrom = 0;
  const flush = (to: number): void => {
    if (to > literalFrom) out.push(s.slice(literalFrom, to), base + literalFrom, true);
  };
  const skipTo = (next: number): void => {
    i = next;
    literalFrom = next;
  };

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) {
      flush(i);
      out.push(s[i + 1], base + i + 1, true);
      skipTo(i + 2);
      continue;
    }

    if (ch === '`') {
      const ticks = /^`+/.exec(s.slice(i))![0];
      const close = s.indexOf(ticks, i + ticks.length);
      if (close > 0) {
        flush(i);
        out.push(s.slice(i + ticks.length, close), base + i + ticks.length, true);
        skipTo(close + ticks.length);
        continue;
      }
    }

    if (ch === '$') {
      if (s[i + 1] === '$') {
        const close = s.indexOf('$$', i + 2);
        if (close > 0) {
          flush(i);
          skipTo(close + 2);
          continue;
        }
      } else if (!isSpace(s[i + 1])) {
        let close = -1;
        for (let j = i + 1; j < s.length; j++) {
          if (s[j] === '\\') { j++; continue; }
          if (s[j] === '$') {
            if (!isSpace(s[j - 1]) && !/\d/.test(s[j + 1] ?? '')) close = j;
            break;
          }
        }
        if (close > 0) {
          flush(i);
          if (state.options.readInlineMaths) out.push(latexToText(s.slice(i + 1, close)), base + i, false);
          skipTo(close + 1);
          continue;
        }
      }
    }

    if (ch === '%' && s[i + 1] === '%') {
      flush(i);
      const close = s.indexOf('%%', i + 2);
      if (close < 0) {
        state.openComment = '%%';
        skipTo(s.length);
      } else {
        skipTo(close + 2);
      }
      continue;
    }

    if (ch === '<') {
      if (s.startsWith('<!--', i)) {
        flush(i);
        const close = s.indexOf('-->', i + 4);
        if (close < 0) {
          state.openComment = '-->';
          skipTo(s.length);
        } else {
          skipTo(close + 3);
        }
        continue;
      }
      const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/.exec(s.slice(i));
      if (tag) {
        flush(i);
        if (tag[1].toLowerCase() === 'br') out.push(' ', base + i, false);
        skipTo(i + tag[0].length);
        continue;
      }
    }

    if (ch === '!' && s[i + 1] === '[') {
      const embed = /^!\[\[[^\]]*\]\]/.exec(s.slice(i)) ?? /^!\[[^\]]*\]\([^)]*\)/.exec(s.slice(i));
      if (embed) {
        flush(i);
        skipTo(i + embed[0].length);
        continue;
      }
    }

    if (ch === '[') {
      const rest = s.slice(i);
      const wiki = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(rest);
      if (wiki) {
        flush(i);
        if (wiki[2] !== undefined && wiki[2].trim()) {
          inline(wiki[2], base + i + 2 + wiki[1].length + 1, out, state);
        } else {
          out.push(wikilinkLabel(wiki[1]), base + i + 2, false);
        }
        skipTo(i + wiki[0].length);
        continue;
      }
      const footnote = /^\[\^[^\]]+\]/.exec(rest);
      if (footnote) {
        flush(i);
        skipTo(i + footnote[0].length);
        continue;
      }
      const link = /^\[((?:[^[\]]|\[[^[\]]*\])*)\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/.exec(rest);
      if (link) {
        flush(i);
        inline(link[1], base + i + 1, out, state);
        skipTo(i + link[0].length);
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~' || ch === '=') {
      let end = i;
      while (s[end] === ch) end++;
      const run = end - i;
      const before = s[i - 1];
      const after = s[end];
      const flanking = !isSpace(before) || !isSpace(after);
      const intraword = isWordChar(before) && isWordChar(after);
      const isMarkup =
        ch === '*' ? flanking && !(run === 1 && intraword)
        : ch === '_' ? flanking && !intraword
        : run >= 2 && flanking && !intraword;
      if (isMarkup && !(isSpace(before) && isSpace(after))) {
        flush(i);
        skipTo(end);
        continue;
      }
      i = end;
      continue;
    }

    i++;
  }
  flush(s.length);
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const TAG_LINE = /^\s*(?:(?:\*\*|__)?tags?:?(?:\*\*|__)?:?\s*)?(?:#[\w/-]+[\s,]*)+$/i;
const LINK_LINE = /^\s*(?:[A-Za-z][\w ]{0,24}:\s*)?(?:(?:!?\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\))[\s,;|]*)+$/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX/>-]\]\s+)?/;
const CALLOUT = /^\[!([\w-]+)\][+-]?\s*(.*)$/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;
const BLOCK_ID_ONLY = /^\s*\^[\w-]+\s*$/;
const TRAILING_BLOCK_ID = /\s+\^[\w-]+\s*$/;

export function parseMarkdown(source: string, options: MarkdownFilterOptions): ParsedMarkdown {
  const out = new Output();
  const excluded = toPhraseSet(options.excludedSections);
  const references = toPhraseSet(REFERENCE_HEADINGS);
  const state: InlineState = { options, openComment: null };

  let pos = 0;
  // Front matter exists only at the very top of the file, and only when it is closed.
  const front = /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source);
  if (front) pos = front[0].length;

  let fence: { char: string; length: number; skip: boolean; quoted: boolean } | null = null;
  let inMaths = false;
  let comment: '%%' | '-->' | null = null;
  /** Level of the heading that opened the section being skipped; 0 when reading normally. */
  let skipLevel = 0;

  while (pos <= source.length) {
    let end = source.indexOf('\n', pos);
    if (end < 0) end = source.length;
    let base = pos;
    let line = source.slice(pos, end);
    pos = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (comment) {
      const close = line.indexOf(comment === '%%' ? '%%' : '-->');
      if (close < 0) continue;
      const cut = close + (comment === '%%' ? 2 : 3);
      comment = null;
      base += cut;
      line = line.slice(cut);
    }

    let depth = 0;
    if (!fence || fence.quoted) {
      const quote = /^(?:\s{0,3}>\s?)+/.exec(line);
      if (quote) {
        depth = (quote[0].match(/>/g) ?? []).length;
        base += quote[0].length;
        line = line.slice(quote[0].length);
      }
    }

    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      } else if (!fence.skip && !skipLevel) {
        out.beginLine();
        out.push(line, base, true);
        out.endLine(end);
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const language = open[2].toLowerCase();
      fence = {
        char: open[1][0],
        length: open[1].length,
        skip: options.skipCodeBlocks || NEVER_PROSE.has(language),
        quoted: depth > 0,
      };
      continue;
    }

    if (inMaths) {
      if (line.includes('$$')) inMaths = false;
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      if (line.indexOf('$$', line.indexOf('$$') + 2) < 0) inMaths = true;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (skipLevel && level > skipLevel) continue;
      skipLevel = 0;
      const probe = new Output();
      probe.beginLine();
      inline(heading[2], 0, probe, { options, openComment: null });
      const name = normaliseHeading(probe.finish().text);
      if ((options.skipReferences && headingMatches(name, references)) || headingMatches(name, excluded)) {
        skipLevel = level;
        continue;
      }
      out.beginLine();
      out.push(`[H${level}]`, base + heading[1].length + 1, false);
      inline(heading[2], base + line.indexOf(heading[2], heading[1].length), out, state);
      out.endLine(end);
      continue;
    }
    if (skipLevel) continue;

    if (!line.trim() || RULE.test(line) || FOOTNOTE_DEFINITION.test(line) || BLOCK_ID_ONLY.test(line)) continue;

    if (/^\s*\|/.test(line)) {
      if (options.skipTables || TABLE_SEPARATOR.test(line)) continue;
      out.beginLine();
      let cellStart = 0;
      for (let k = 0; k <= line.length; k++) {
        if (k === line.length || (line[k] === '|' && line[k - 1] !== '\\')) {
          if (k > cellStart) {
            inline(line.slice(cellStart, k), base + cellStart, out, state);
            out.push(' ', base + k, false);
          }
          cellStart = k + 1;
        }
      }
      out.endLine(end);
      continue;
    }

    const callout = depth > 0 ? CALLOUT.exec(line) : null;
    if (callout) {
      out.beginLine();
      const title = callout[2].trim();
      out.push(`[CALLOUT:${callout[1]}]`, base, false);
      if (title) inline(callout[2], base + line.length - callout[2].length, out, state);
      else out.push(callout[1], base, false);
      out.endLine(end);
      comment = state.openComment;
      state.openComment = null;
      continue;
    }

    const marker = LIST_MARKER.exec(line);
    if (marker) {
      base += marker[0].length;
      line = line.slice(marker[0].length);
    }
    if (options.skipTagLines && TAG_LINE.test(line)) continue;
    if (options.skipLinkLines && LINK_LINE.test(line)) continue;

    const blockId = TRAILING_BLOCK_ID.exec(line);
    if (blockId) line = line.slice(0, blockId.index);

    out.beginLine();
    inline(line, base, out, state);
    out.endLine(end);
    comment = state.openComment;
    state.openComment = null;
  }

  const { text, source: map } = out.finish();
  const tokenStart: number[] = [];
  const tokenEnd: number[] = [];
  for (const [a, b] of tokenSpans(text)) {
    tokenStart.push(map[a] ?? source.length);
    tokenEnd.push((map[b - 1] ?? source.length) + 1);
  }
  return { text, tokenStart, tokenEnd };
}

/**
 * Index of the reader token at a source offset: the word the offset is inside,
 * or the next word when the offset is in something that is not read.
 */
export function tokenAtOffset(parsed: ParsedMarkdown, offset: number): number {
  const ends = parsed.tokenEnd;
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] > offset) hi = mid;
    else lo = mid + 1;
  }
  return Math.min(lo, Math.max(0, ends.length - 1));
}
