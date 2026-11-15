/**
 * Step 6: turn the surviving blocks into the text the reader plays.
 *
 * Three repairs happen here, all of them about restoring sentences that the
 * page layout cut up: paragraphs split by a column or page break are rejoined,
 * captions that interrupt a sentence are moved to the end of that paragraph,
 * and words hyphenated at a line end are put back together.
 *
 * Every word keeps a record of which reader token it became, which is what
 * lets a selection on the page be mapped to one exact position in the text.
 */

import type { Block, BlockKind, Line, NarrativeUnit, UnitLine } from './types';
import { sentenceEnds } from './layout';

const LETTERS = 'A-Za-z\\u00C0-\\u024F';
const HYPHEN_TAIL = new RegExp(`^(.*?)([${LETTERS}]+)[-\\u2010]$`);
const WORD_HEAD = new RegExp(`^([${LETTERS}]+)(.*)$`);
const PLAIN_WORD = new RegExp(`^[${LETTERS}]+(?:-[${LETTERS}]+)*$`);

interface Draft {
  kind: BlockKind;
  level: number;
  blocks: Block[];
  lines: Line[];
}

/** Every word the document prints whole, used to tell "methyl-ation" from "long-read". */
function buildVocabulary(blocks: Block[]): Set<string> {
  const vocab = new Set<string>();
  for (const b of blocks) {
    for (const line of b.lines) {
      const words = line.text.split(' ');
      for (let i = 0; i < words.length; i++) {
        const w = words[i].replace(/^[^A-Za-z\u00C0-\u024F]+|[^A-Za-z\u00C0-\u024F]+$/g, '');
        if (!w || (i === words.length - 1 && /[-\u2010]$/.test(words[i]))) continue;
        if (PLAIN_WORD.test(w)) vocab.add(w.toLowerCase());
      }
    }
  }
  return vocab;
}

/** The single word that the last word of one line and the first of the next form, or null if they are two words. */
function mergeAcrossBreak(last: string, first: string, vocab: Set<string>): string | null {
  const tail = HYPHEN_TAIL.exec(last);
  if (!tail) return null;
  const head = WORD_HEAD.exec(first);
  if (!head) return /^\d/.test(first) ? last + first : null;
  const [, lead, left] = tail;
  const [, right, rest] = head;
  if (/^[A-Z]/.test(right)) return last + first;
  const joined = (left + right).toLowerCase();
  if (vocab.has(joined)) return lead + left + right + rest;
  if (vocab.has(`${left}-${right}`.toLowerCase()) || lead.includes('-')) return last + first;
  return lead + left + right + rest;
}

function continues(open: Draft, b: Block): boolean {
  if (b.kind !== 'paragraph' || b.runIn) return false;
  const lastBlock = open.blocks[open.blocks.length - 1];
  const lastLine = open.lines[open.lines.length - 1];
  if (Math.abs(b.size - lastBlock.size) > 0.6) return false;
  const first = b.lines[0].text;
  const full = (lastLine.x1 - lastBlock.regionX0) / Math.max(1, lastBlock.regionX1 - lastBlock.regionX0) > 0.9;
  const moved = lastBlock.page !== b.page || lastBlock.region !== b.region;
  // A name with dots in it ("bench.lamp.reading") can be cut after one of them at the foot of
  // a column. The stop that closes that full line closes no sentence: the next column opens in
  // lower case with the rest of the name, a dot inside it.
  if (open.kind === 'paragraph' && lastBlock.kind === 'paragraph' && moved && full && /[A-Za-z]\.$/.test(lastLine.text) && /^[a-z]\w*\.\w/.test(first)) return true;
  if (sentenceEnds(lastLine.text, ':')) return false;
  const broken = /[A-Za-z][-\u2010]$/.test(lastLine.text);
  // A title or legend runs on only where that is plain to see: many end without a full stop.
  if (open.kind === 'caption') return broken || /^[a-z\u00DF-\u00FF(]/.test(first);
  // The item of a list often ends without a full stop: it runs on only where that is plain to
  // see, from a word cut at the line end, or from lower case after an item of several lines
  // or a full last line.
  if (lastBlock.kind === 'list') return broken || ((full || lastBlock.lines.length >= 2) && /^[a-z\u00DF-\u00FF]/.test(first));
  if (broken || /^[a-z\u00DF-\u00FF(\u2013\u2014,;]/.test(first)) return true;
  return moved && full;
}

export function buildNarrative(blocks: Block[]): { text: string; units: NarrativeUnit[] } {
  const kept = blocks.filter((b) => !b.drop);
  const vocab = buildVocabulary(kept);

  const drafts: Draft[] = [];
  /** The body paragraph most recently started; its sentence may still be running. */
  let open: Draft | null = null;
  /** The caption most recently met; a caption set in columns runs on into further blocks. */
  let float: Draft | null = null;
  /** Captions and other float text met while a sentence was hanging, held until it finishes. */
  let held: Draft[] = [];
  /** The legend most recently met: a part of it that was cut off is joined to it again. */
  let legend: Draft | null = null;
  const release = (): void => {
    open = null;
    drafts.push(...held);
    held = [];
  };
  const draft = (b: Block): Draft => ({ kind: b.kind, level: b.level, blocks: [b], lines: b.lines.slice() });
  const extend = (d: Draft, b: Block): void => {
    d.blocks.push(b);
    d.lines.push(...b.lines);
  };

  for (let i = 0; i < kept.length; i++) {
    const b = kept[i];
    const hanging = open !== null && open.blocks[open.blocks.length - 1].kind !== 'list' && !sentenceEnds(open.lines[open.lines.length - 1].text, ':');
    if (b.kind === 'heading' || b.kind === 'title') {
      // A panel set into the text under a heading of its own ("Significance") can cut a sentence
      // in two: a few paragraphs in another size, each perhaps under a heading, and then the
      // sentence goes on in lower case. The panel is held until the sentence is finished, as a
      // legend is.
      if (hanging && open && b.kind === 'heading') {
        const size = open.blocks[open.blocks.length - 1].size;
        const inset = (o: Block): boolean => (o.kind === 'paragraph' || o.kind === 'list') && Math.abs(o.size - size) > 0.6;
        let j = i + 1;
        while (j < kept.length && j <= i + 8 && (inset(kept[j]) || (kept[j].kind === 'heading' && j + 1 < kept.length && inset(kept[j + 1])))) j++;
        const rest = kept[j];
        if (j > i + 1 && rest && rest.kind === 'paragraph' && Math.abs(rest.size - size) <= 0.6 && /^[a-z\u00DF-\u00FF]/.test(rest.lines[0].text) && continues(open, rest)) {
          for (let k = i; k < j; k++) held.push(draft(kept[k]));
          i = j - 1;
          continue;
        }
      }
      release();
      float = null;
      drafts.push(draft(b));
      continue;
    }
    if (b.kind === 'caption') {
      // The part of a legend that was cut off: it opens in lower case, where the legend before it stopped in mid-sentence.
      if (legend && /^[a-z\u00DF-\u00FF]/.test(b.lines[0].text) && !sentenceEnds(legend.lines[legend.lines.length - 1].text)) {
        extend(legend, b);
        continue;
      }
      // A box of text set into a column in the print of the text ("Box 1 | ...") can cut a
      // sentence in two. Its text stands under its title at the title's left edge, and a box
      // that fills the rest of its page goes on through the columns of that page; then the
      // sentence goes on in lower case. The box is held until the sentence is finished.
      if (hanging && open && /^box\s*\d/i.test(b.lines[0].text)) {
        const sentence = open;
        const carries = (o: Block): boolean => /^[a-z\u00DF-\u00FF]/.test(o.lines[0].text) && continues(sentence, o);
        const inBox = (o: Block | undefined): o is Block => !!o && o.page === b.page && o.kind !== 'caption' && !carries(o);
        let j = i + 1;
        while (inBox(kept[j]) && kept[j].region === b.region && Math.abs(kept[j].x0 - b.x0) <= 2) j++;
        if (inBox(kept[j]) && kept[j].region !== b.region) while (inBox(kept[j])) j++;
        if (j > i + 1 && kept[j] && carries(kept[j])) {
          // Inside the box a paragraph cut in two is still joined.
          let part: Draft | null = null;
          for (let k = i; k < j; k++) {
            if (part && part.kind !== 'heading' && continues(part, kept[k])) extend(part, kept[k]);
            else held.push((part = draft(kept[k])));
          }
          i = j - 1;
          continue;
        }
      }
      float = draft(b);
      legend = float;
      (hanging ? held : drafts).push(float);
    } else if (open && continues(open, b)) {
      extend(open, b);
    } else if (float && continues(float, b)) {
      extend(float, b);
    } else if (hanging && open && Math.abs(b.size - open.blocks[0].size) > 0.6) {
      // Text in another size in the middle of a sentence belongs to a float.
      const d = draft(b);
      held.push(d);
      float = b.kind === 'paragraph' ? d : null;
    } else {
      release();
      const d = draft(b);
      drafts.push(d);
      open = b.kind === 'paragraph' || b.kind === 'list' ? d : null;
      float = null;
    }
  }
  release();

  const units: NarrativeUnit[] = [];
  let cursor = 0;
  for (const d of drafts) {
    const words: string[] = [];
    const lines: UnitLine[] = [];
    for (let li = 0; li < d.lines.length; li++) {
      const line = d.lines[li];
      const lineWords = line.text.split(' ').filter(Boolean);
      const map: number[] = [];
      let k = 0;
      if (li > 0 && words.length && lineWords.length) {
        const merged = mergeAcrossBreak(words[words.length - 1], lineWords[0], vocab);
        if (merged !== null) {
          words[words.length - 1] = merged;
          map.push(cursor + words.length - 1);
          k = 1;
        }
      }
      for (; k < lineWords.length; k++) {
        map.push(cursor + words.length);
        words.push(lineWords[k]);
      }
      lines.push({
        page: line.page, x0: line.x0, x1: line.x1, top: line.top, bottom: line.bottom,
        wordX0: line.wordX0, wordX1: line.wordX1, wordToken: map, runs: line.runs,
      });
    }
    if (!words.length) continue;
    let firstLine = 0;
    for (const b of d.blocks) {
      b.token = lines[firstLine].wordToken[0] ?? cursor;
      firstLine += b.lines.length;
    }

    if (d.kind === 'heading' || d.kind === 'title') {
      // Letter-spaced capitals ("A B S T R A C T") are one word.
      if (words.length >= 3 && words.every((w) => w.length === 1)) {
        const joined = words.join('');
        words.length = 0;
        words.push(joined);
        for (const l of lines) l.wordToken = l.wordToken.map(() => cursor);
      }
      words[0] = `[H${Math.min(6, Math.max(1, d.level || 2))}]${words[0]}`;
    }
    units.push({ text: words.join(' '), tokenStart: cursor, tokenCount: words.length, kind: d.kind, lines });
    cursor += words.length + 1;
  }

  return { text: units.map((u) => u.text).join('\n'), units };
}
