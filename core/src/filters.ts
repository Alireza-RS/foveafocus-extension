/**
 * Section names shared by the Markdown and PDF readers.
 *
 * These lists are only ever compared with text the layout has already
 * identified as a heading (or as a bold label opening a paragraph), and the
 * whole heading has to match. A word such as "funding" inside a sentence, or a
 * longer heading such as "Funding mechanisms in cancer research", never matches.
 */

import type { FoveaFocusSettings } from './types';
import type { MarkdownFilterOptions } from './markdown-parser';
import type { PdfFilterOptions } from './pdf/types';

/** PDF sections dropped by default. Shown in settings, one per line, and editable there. */
export const DEFAULT_EXCLUDED_SECTIONS: string[] = [
  'acknowledgements',
  'acknowledgement',
  'acknowledgments',
  'acknowledgment',
  'funding',
  'financial support',
  'financial disclosure',
  'grant support',
  'author contributions',
  "authors' contributions",
  'author contribution',
  'contributions',
  'contributors',
  'credit authorship contribution statement',
  'competing interests',
  'competing interest',
  'competing financial interests',
  'conflicting interests',
  'declaration of conflicting interests',
  'conflict of interest',
  'conflicts of interest',
  'declaration of interests',
  'declaration of interest',
  'declaration of competing interest',
  'declaration of competing interests',
  'declarations',
  'disclosure',
  'disclosures',
  'ethics',
  'ethics approval',
  'ethics statement',
  'ethics declarations',
  'ethical approval',
  'ethical considerations',
  'ethical statement',
  'informed consent',
  'ethics approval and consent to participate',
  'consent for publication',
  'consent to participate',
  'data availability',
  'data and code availability',
  'data and materials availability',
  'availability of data and materials',
  'availability of data and material',
  'code availability',
  'data sharing',
  'data deposition',
  'accession numbers',
  'accession codes',
  'role of the funding source',
  'role of the sponsor',
  'role of the funder',
  'role of the funder/sponsor',
  'funding/support',
  'funding/support and role of the sponsor',
  'orcid',
  'resource availability',
  'materials availability',
  'lead contact',
  'supplementary material',
  'supplementary materials',
  'supplementary information',
  'supplementary data',
  'supplemental information',
  'supplemental material',
  'supplemental data',
  'supporting information',
  'additional information',
  'additional files',
  'abbreviations',
  'author information',
  'author details',
  "authors' information",
  "publisher's note",
  'rights and permissions',
  'reprints and permissions',
  'reprints and permission',
  'open access',
  'correspondence',
  'correspondence and requests for materials',
  'keywords',
  'key words',
  'index terms',
  'ccs concepts',
  'categories and subject descriptors',
  'general terms',
  'author orcids',
  'peer review material',
  'supplementary files',
  'about this article',
  'cite this article',
  'how to cite this article',
  'peer review information',
  'reporting summary',
  'life sciences reporting summary',
  'online content',
];

/**
 * Ordinary section names. They are never skipped; they are listed so that a section title
 * typed in the plain body font on a line of its own (common in preprints written in a word
 * processor) can still be recognised as a title.
 */
export const COMMON_SECTION_HEADINGS: string[] = [
  'abstract',
  'summary',
  'introduction',
  'background',
  'methods',
  'materials and methods',
  'methods and materials',
  'online methods',
  'experimental procedures',
  'results',
  'results and discussion',
  'discussion',
  'conclusion',
  'concluding remarks',
  'limitations',
  'related work',
  'figure legends',
  'appendix',
];

/** Headings that open a reference list. */
export const REFERENCE_HEADINGS: string[] = [
  'references',
  'reference',
  'references and notes',
  'notes and references',
  'bibliography',
  'literature cited',
  'works cited',
  'reference list',
  'cited literature',
];

/** Reduce a heading to the form the lists above are written in. */
export function normaliseHeading(raw: string): string {
  let t = raw.trim();
  // Letter-spaced capitals, e.g. "A B S T R A C T".
  if (/^(?:\S\s+){2,}\S$/.test(t)) t = t.replace(/\s+/g, '');
  t = t.toLowerCase();
  t = t.replace(/^(?:\d{1,2}(?:\.\d{1,2}){0,3}[.)]?|[ivx]{1,5}[.)]|[a-z][.)])\s+/, '');
  // "Appendix A. Supplementary data" names its section after the label.
  t = t.replace(/^appendix\s+[a-z0-9]{1,2}[.:]\s+(?=\S)/, '');
  t = t.replace(/[\u2018\u2019]/g, "'");
  t = t.replace(/[\s:.\u2014\u2013|*-]+$/, '');
  return t.replace(/\s+/g, ' ');
}

const TRAILING_NOUN = /\s+(?:statement|information|section|detail|source)$/;

/**
 * Fold away the differences that do not change which section a heading names:
 * plural and possessive endings, and the two spellings of "acknowledgement".
 */
function fold(phrase: string): string {
  return phrase
    .split(' ')
    .map((w) => {
      let s = w.replace(/'s?$/, '').replace('dgement', 'dgment');
      if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
      return s;
    })
    .join(' ');
}

/** True when the whole heading is one of the listed phrases, or several of them joined by "and". */
export function headingMatches(normalised: string, phrases: ReadonlySet<string>): boolean {
  if (!normalised) return false;
  const one = (p: string): boolean => {
    const f = fold(p);
    return phrases.has(f) || phrases.has(f.replace(TRAILING_NOUN, ''));
  };
  if (one(normalised)) return true;
  const parts = normalised.split(/\s*(?:,|&|\/|\band\b)\s*/).filter(Boolean);
  return parts.length >= 2 && parts.every(one);
}

/**
 * Build the lookup set for `headingMatches` from phrases as a person would type them. A phrase
 * of several words is also listed run together: a PDF can deliver letter-spaced capitals as one
 * long word, the spaces between its words lost ("CONFLICTOFINTEREST").
 */
export function toPhraseSet(phrases: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const p of phrases) {
    const typed = normaliseHeading(p);
    const n = fold(typed);
    if (!n) continue;
    set.add(n);
    if (n.includes(' ')) set.add(fold(n.replace(/ /g, ''))).add(fold(typed.replace(/ /g, '')));
  }
  return set;
}

/** The note filters as the settings have them. */
export function markdownFilters(settings: FoveaFocusSettings): MarkdownFilterOptions {
  return {
    skipCodeBlocks: settings.skipCodeBlocks,
    skipTables: settings.skipTables,
    readInlineMaths: settings.readInlineMaths,
    skipTagLines: settings.skipTagLines,
    skipLinkLines: settings.skipLinkLines,
    skipReferences: settings.skipReferences,
    excludedSections: settings.noteExcludedSections,
  };
}

/** The PDF filters as the settings have them. */
export function pdfFilters(settings: FoveaFocusSettings): PdfFilterOptions {
  return {
    includeTitle: settings.pdfIncludeTitle,
    includeCaptions: settings.pdfIncludeCaptions,
    skipFrontMatter: settings.pdfSkipFrontMatter,
    stopAtReferences: settings.pdfStopAtReferences,
    skipFootnotes: settings.pdfSkipFootnotes,
    excludedSections: settings.pdfExcludedSections,
  };
}
