/**
 * Step 1b: characters the PDF does not name.
 *
 * Some fonts keep glyphs at private-use code points, which mean nothing outside the font:
 * the ligatures of a face embedded without their names (a page printed to PDF from a
 * browser), and the Greek of the old Symbol face as word processors write it. Left alone,
 * each reaches the reader as an empty box inside a word.
 *
 * Symbol's layout is fixed, so its letters are looked up. A ligature has to be worked out:
 * for each font and code point, the words it occurs in are filled in with each ligature in
 * turn, and the one that makes known words wins ("speci?c", "?rst" and "de?ned" can only be
 * fi). Nothing is replaced on a guess: a code point that makes no known word stays as it is.
 *
 * Only the characters of a run change, never its words, so every word keeps its place in
 * the viewer's text layer.
 */

import { KEPT_NAMELESS } from './extract';
import type { RawItem, RawPage } from './types';

const PRIVATE = /[\uE000-\uF8FF]/;
const PRIVATE_ALL = /[\uE000-\uF8FF]/g;

const LIGATURES = ['fi', 'fl', 'ff', 'ffi', 'ffl', 'Th'];

/** Short words that count only whole. */
const WORDS = new Set(
  'fit fits fix fig figs fine find finds five file files fill film fire firm fish flag flat flaw flex flip flow flows flux fly flu off diff staff stiff stuff cliff the this that these those then than they thus them their there three'.split(' ')
);

/** Openings of longer words; each holds its ligature, and no other ligature in its place makes one of them. */
const STEMS =
  // fi
  ('fiber fibre fibr fidel field fifteen fifth fifty fight figur filing filter filtr final financ finding finger finish finite firing first fiscal fitn fitt fixed fixing fixat ' +
    'amplif artific benefic benefit certific clarif classif confid config confin confirm defici defin diversif identif infinit justif magnific modif notif overfit prefix profici ' +
    'profil profit purif qualif quantif rectif redefin refin satisf scientif signific insignific simplif specif nonspecif unspecif stratif superfic undefin unifi unifo verif ' +
    'misclassif reclassif unidentif unmodif fibro fibrin filament acidif calcif intensif solidif typif exemplif ' +
    // fl
    'flagell flame flank flash flask flatten flavo flexib flight float flood floor flora flour flowe flowi fluct fluen fluid fluor flush ' +
    'conflat conflict deflat deflect inflam inflat inflect inflex inflict influen influx reflect reflex reflux overflow workflow outflow inflow airflow underflow backflow ' +
    'butterfly briefly superflu leaflet trifluor difluor perfluor ' +
    // ff
    'affair affect afford buffer coffee cutoff differ diffus diffract effect effort offend offens offer offload offset offshore offspring payoff scaffold stiffn staffed ' +
    'suffer tradeoff unaffect ineffect sheriff tariff plaintiff ' +
    // ffi
    'affili affin affirm coeffic coffin diffic effic ineffic insuffic offic paraffin suffic suffix traffic staffing stuffing ' +
    // ffl
    'affluen afflict baffl effluen efflux muffl raffl ruffl shuffl reshuffl scuffl ' +
    // Th
    'theor therefore thereby therap thermal thermo thick thing think third thirty thousand though thought thread threat threshold through').split(' ');

const known = (word: string): boolean => WORDS.has(word) || (word.length >= 4 && STEMS.some((stem) => word.startsWith(stem)));

/** The Symbol face as Windows software writes it: U+F000 plus the code of the key. Greek, and the signs that turn up in text. */
const SYMBOL: Record<string, string> = {};
{
  const latin = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const greek = '\u0391\u0392\u03A7\u0394\u0395\u03A6\u0393\u0397\u0399\u03D1\u039A\u039B\u039C\u039D\u039F\u03A0\u0398\u03A1\u03A3\u03A4\u03A5\u03C2\u03A9\u039E\u03A8\u0396' +
    '\u03B1\u03B2\u03C7\u03B4\u03B5\u03C6\u03B3\u03B7\u03B9\u03D5\u03BA\u03BB\u03BC\u03BD\u03BF\u03C0\u03B8\u03C1\u03C3\u03C4\u03C5\u03D6\u03C9\u03BE\u03C8\u03B6';
  for (let i = 0; i < latin.length; i++) SYMBOL[String.fromCharCode(0xf000 + latin.charCodeAt(i))] = greek[i];
  const signs: Array<[number, string]> = [
    [0x2d, '\u2212'], [0xa3, '\u2264'], [0xa5, '\u221E'], [0xae, '\u2192'], [0xb0, '\u00B0'], [0xb1, '\u00B1'], [0xb3, '\u2265'],
    [0xb4, '\u00D7'], [0xb6, '\u2202'], [0xb9, '\u2260'], [0xbb, '\u2248'], [0xe5, '\u2211'],
  ];
  for (const [code, sign] of signs) SYMBOL[String.fromCharCode(0xf000 + code)] = sign;
}

/** One place where a glyph without a name stands: the text before and after it on its line. */
interface Place {
  left: string;
  right: string;
  /** Set above the line, in smaller type than what precedes it. */
  raised: boolean;
  /** Followed by "10" with an exponent raised behind it. */
  power: boolean;
  /** Alone at the start of a line, with a blank and a word after it: where the bullet of a list stands. */
  opens: boolean;
}

/**
 * Signs that a glyph can only be, given where it stands: the degree between a figure and C,
 * the micro sign between a figure and a unit, the multiplication sign before a power of ten,
 * the minus of an exponent, of a freezer's temperature or after an equals sign, the plus-minus
 * before "SD". Signs
 * of comparison are not among them: nothing around "n ? 30" tells = from > or from about.
 */
const SIGNS: Array<[string, (p: Place) => boolean]> = [
  ['\u00B0', (p) => /(?:^|[\s(\u2212\u2013\uE000-\uF8FF-])\d{1,3}(?:\.\d)? ?$/.test(p.left) && /^ ?C(?![A-Za-z])/.test(p.right)],
  ['\u03BC', (p) => /\d ?$/.test(p.left) && /^(?:g\/|(?:mol|[lLMm])(?![A-Za-z]))/.test(p.right)],
  ['\u00D7', (p) => /\d ?$/.test(p.left) && p.power],
  [
    '\u2212',
    (p) =>
      (p.raised && /^ ?\d/.test(p.right)) ||
      (/= ?$/.test(p.left) && /^ ?\.?\d/.test(p.right)) ||
      (!/[\d)\]] ?$/.test(p.left) && /^ ?(?:20|70|80|196) ?.? ?C(?![A-Za-z])/.test(p.right)),
  ],
  ['\u00B1', (p) => /^ ?(?:SD|SEM|SE|s\.d\.|s\.e\.m\.)(?![A-Za-z])/.test(p.right)],
];

/** Is `a` set above the line of `ref`, in smaller type? */
function raised(a: RawItem | undefined, ref: RawItem | undefined): boolean {
  return !!a && !!ref && a.base < ref.base - 0.15 * ref.size && a.base > ref.base - ref.size && a.size <= 0.9 * ref.size;
}

/** True when `b` follows `a` on its line with no word space between them. */
function touches(a: RawItem | undefined, b: RawItem | undefined, reach: number): boolean {
  if (!a || !b) return false;
  const size = Math.min(a.size, b.size);
  const gap = b.x0 - a.x1;
  return Math.abs(a.base - b.base) <= 0.3 * Math.max(a.size, b.size) && gap >= -0.5 * size && gap <= reach * size;
}

/**
 * A font of mathematical signs laid out on the keys of a text font reaches the reader as the
 * letters of those keys: "n \u00BC 10" for "n = 10", "\u00F0x\u00DE" for "(x)". In a text font the same
 * letters are letters. A font used for these more than for the letters and figures of the
 * alphabet is such a font: one that holds the thorn or the eth, or the quarter beside signs that are no
 * fractions. Its signs are known.
 *
 * The same family keeps "greater than" on the key 4, "less than" on 5 or on o, and the micro
 * sign on m. A document that has a formula font may use others for these alone: a font that
 * is never used for anything but one of them at a time ("P50.05", "Po0.05", "10 mg" for
 * 10 \u03BCg), and whose o always stands in front of a figure.
 */
const FORMULA_SIGNS: Record<string, string> = {
  '\u00BC': '=', '\u00FE': '+', '\u00F0': '(', '\u00DE': ')', '\u00BD': '[', '\u00C0': '\u2212', '\u00C2': '\u00D7', '\u00C6': '\u00B1',
};
const FORMULA_SIGN = /[\u00BC\u00FE\u00F0\u00DE\u00BD\u00C0\u00C2\u00C6]/g;
const KEYED_SIGNS: Record<string, string> = { '4': '>', '5': '<', o: '<', m: '\u03BC' };

function nameFormulaSigns(pages: RawPage[]): void {
  const fonts = new Map<string, { total: number; alnum: number; letters: number; fractions: number; signs: number; keyed: number; compared: number }>();
  for (const page of pages) {
    page.items.forEach((it, k) => {
      let f = fonts.get(it.font);
      if (!f) fonts.set(it.font, (f = { total: 0, alnum: 0, letters: 0, fractions: 0, signs: 0, keyed: 0, compared: 0 }));
      const alone = it.s.trim();
      const next = page.items[k + 1];
      const beforeFigure = !!next && Math.abs(next.base - it.base) <= 0.3 * it.size && /^ ?\.?\d/.test(next.s);
      if (alone in KEYED_SIGNS && (alone !== 'o' || beforeFigure)) f.keyed++;
      if (alone === '4' || alone === '5' || (alone === 'o' && beforeFigure)) f.compared++;
      for (const ch of it.s) {
        if (ch === ' ') continue;
        f.total++;
        if (/[A-Za-z0-9]/.test(ch)) f.alnum++;
        else if (/[\u00FE\u00F0\u00DE]/.test(ch)) f.letters++;
        else if (/[\u00BC\u00BD\u00BE]/.test(ch)) f.fractions++;
        if (ch in FORMULA_SIGNS) f.signs++;
      }
    });
  }
  const formula = new Set<string>();
  for (const [font, f] of fonts) {
    if (f.signs > 0 && f.alnum <= 0.5 * f.total && (f.letters > 0 || f.total > f.fractions)) formula.add(font);
  }
  if (!formula.size) return;
  const keyed = new Set<string>();
  for (const [font, f] of fonts) {
    if (!formula.has(font) && f.compared > 0 && f.keyed === f.total) keyed.add(font);
  }
  for (const page of pages) {
    for (const it of page.items) {
      if (formula.has(it.font)) it.s = it.s.replace(FORMULA_SIGN, (ch) => FORMULA_SIGNS[ch]);
      else if (keyed.has(it.font)) it.s = it.s.replace(/[45mo]/, (ch) => KEYED_SIGNS[ch]);
    }
  }
}

export function nameUnnamedGlyphs(pages: RawPage[]): void {
  nameFormulaSigns(pages);
  // Every use of a private character: the letters of its word on either side of it.
  const uses = new Map<string, Array<{ before: string; after: string }>>();
  const places = new Map<string, Place[]>();
  let any = false;
  for (const page of pages) {
    page.items.forEach((it, k) => {
      if (!PRIVATE.test(it.s)) return;
      any = true;
      const prev = page.items[k - 1];
      const next = page.items[k + 1];
      const onLine = (o: RawItem | undefined): o is RawItem => !!o && Math.abs(o.base - it.base) <= 0.6 * Math.max(o.size, it.size);
      for (let i = 0; i < it.s.length; i++) {
        if (!PRIVATE.test(it.s[i])) continue;
        if (KEPT_NAMELESS.test(it.s[i])) {
          const rest = it.s.slice(i + 1);
          const at = rest.trim() ? k : k + 1;
          const ten = rest.trim() ? rest : page.items[at]?.s ?? '';
          const place: Place = {
            left: [3, 2, 1].map((n) => page.items[k - n]).filter(onLine).map((o) => o.s).join('') + it.s.slice(0, i),
            right: rest + [1, 2, 3].map((n) => page.items[k + n]).filter(onLine).map((o) => o.s).join(''),
            raised: raised(it, prev),
            power: /^ ?10 ?$/.test(ten) && raised(page.items[at + 1], page.items[at]),
            opens: it.s.trim().length === 1 && (!onLine(prev) || prev.x0 > it.x0) && onLine(next) && !touches(it, next, 0.16) && /^ ?[A-Za-z]/.test(next.s),
          };
          const list = places.get(`${it.font}|${it.s[i]}`);
          if (list) list.push(place);
          else places.set(`${it.font}|${it.s[i]}`, [place]);
        }
        let before = /[A-Za-z]*$/.exec(it.s.slice(0, i))?.[0] ?? '';
        let after = /^[A-Za-z]*/.exec(it.s.slice(i + 1))?.[0] ?? '';
        if (before.length === i && touches(prev, it, 0.25) && !prev.s.endsWith(' ')) before = (/[A-Za-z]+$/.exec(prev.s)?.[0] ?? '') + before;
        if (after.length === it.s.length - i - 1 && touches(it, next, 0.25) && !next.s.startsWith(' ')) after += /^[A-Za-z]+/.exec(next.s)?.[0] ?? '';
        const key = `${it.font}|${it.s[i]}`;
        let list = uses.get(key);
        if (!list) uses.set(key, (list = []));
        list.push({ before, after });
      }
    });
  }
  if (!any) return;

  // A ligature is settled by the words it makes: two different ones, or one long one, in at
  // least half the places the character stands, and more than any other ligature makes.
  const names = new Map<string, string>();
  for (const [key, list] of uses) {
    let best = '', bestHits = 0, runnerUp = 0;
    for (const ligature of LIGATURES) {
      const made = new Set<string>();
      let hits = 0;
      for (const { before, after } of list) {
        const word = (before + ligature + after).toLowerCase();
        if (!known(word)) continue;
        hits++;
        made.add(word);
      }
      const settled = made.size >= 2 || [...made].some((word) => word.length >= 6);
      if (settled && hits > bestHits) { runnerUp = bestHits; bestHits = hits; best = ligature; }
      else if (hits > runnerUp) runnerUp = hits;
    }
    if (best && bestHits > runnerUp && bestHits >= 0.5 * list.length) names.set(key, best);
  }
  // A sign is settled by the places that can only hold it: two of them (one will do where the
  // glyph stands nowhere else), and no more than a third as many that point to another sign.
  for (const [key, list] of places) {
    if (names.has(key)) continue;
    const votes = SIGNS.map(([sign, fits]) => ({ sign, n: list.filter(fits).length })).sort((a, b) => b.n - a.n);
    const [best, next] = votes;
    const enough = best.n >= 2 || (best.n === list.length && best.sign !== '\u03BC');
    const bullets = list.filter((p) => p.opens).length;
    if (enough && 3 * next.n <= best.n) names.set(key, best.sign);
    else if (bullets >= 2 && bullets >= 0.8 * list.length) names.set(key, '\u2022');
  }

  for (const page of pages) {
    page.items.forEach((it, k) => {
      if (!PRIVATE.test(it.s)) return;
      // A Symbol letter belongs to the text around it. A character that stands alone, clear of
      // the words on its line, is a bullet from some pictorial face, which uses the same code points.
      const inText = it.s.trim().length > 1 || touches(page.items[k - 1], it, 0.6) || touches(it, page.items[k + 1], 0.6);
      // A glyph that came without so much as a code point of its own, and that nothing here could name, is shown as unknown.
      it.s = it.s.replace(PRIVATE_ALL, (ch) => names.get(`${it.font}|${ch}`) ?? (KEPT_NAMELESS.test(ch) ? '\uFFFD' : inText ? SYMBOL[ch] ?? ch : '\u2022'));
    });
  }
}
