/**
 * The words of the settings, where the browser asks for other words than the app the
 * settings were written for. The page of settings is the plugin's own (core/src/settings.ts):
 * what it says of notes is said here of web pages, and what has no meaning in a browser is
 * taken off the page. A text is looked for whole, as the plugin writes it, where it stands as
 * text, as the name of a control or in an empty field; the tests see to it that every text
 * listed here is still one the plugin writes.
 */

/** What the plugin says, and what is said in its place. Null takes the row of the text off the page. */
export const WORDING: Array<[string, string | null]> = [
  ['In notes', 'On web pages'],
  ['Diagram and query blocks (Mermaid, Dataview) are never read.', 'Program code that a page shows as a block.'],
  ['Maths between single dollar signs is read as symbols. Display maths is never read.', 'Maths inside a line is read as symbols where the page carries its source. Maths set apart from the text is never read.'],
  ['Lines that hold only tags, such as "Tags: #topic #subtopic".', 'Lines that hold only tags, such as "#topic #subtopic".'],
  ['Lines that hold only links, such as "Related: [[Note A]] [[Note B]]".', 'Lines that hold only links, such as a line of related articles.'],
  ['Sections of notes to skip', 'Sections of pages to skip'],
  [
    'With no more characters than this selected in a note, the note is read from the first selected word. A longer selection is read on its own.',
    'With no more characters than this selected on a page, the page is read from the first selected word. A longer selection is read on its own.',
  ],
  [
    'These work while the reader is open. The commands that open it can be given shortcuts in the settings of the app, under hotkeys.',
    'These work while the reader is open. The shortcuts that open it are set in the browser: see "In the browser" on this page.',
  ],
  ['The words of a heading, and of the title of a callout, are shown larger than the text.', 'The words of a heading are shown larger than the text.'],
  ['Restore the list the plugin starts with', 'Restore the list the extension starts with'],
  ['The font of the whole reader. Left empty, it is the font of the theme.', 'The font of the whole reader. Left empty, it is the font of the system.'],
  ['Font of the theme', 'Font of the system'],
  ['From the theme', 'As the reader comes'],
  ['Use the theme', 'As the reader comes'],
  ['Start of a callout', null],
];

const words = new Map(WORDING);

function rewordText(node: Text): void {
  const said = words.get(node.nodeValue ?? '');
  if (said === null) node.parentElement?.closest('.foveafocus-row')?.remove();
  else if (said !== undefined) node.nodeValue = said;
}

function reword(root: Node): void {
  if (root instanceof Text) {
    rewordText(root);
    return;
  }
  const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let node = texts.nextNode(); node; node = texts.nextNode()) found.push(node as Text);
  found.forEach(rewordText);
  if (!(root instanceof Element)) return;
  for (const el of [root, ...Array.from(root.querySelectorAll('[aria-label], [placeholder]'))]) {
    for (const name of ['aria-label', 'placeholder']) {
      const said = words.get(el.getAttribute(name) ?? '');
      if (said) el.setAttribute(name, said);
    }
  }
}

/** Keeps the words of an element, and of all that is drawn into it later, those of the browser */
export function keepWording(root: HTMLElement): void {
  reword(root);
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'characterData') reword(change.target);
      for (const added of Array.from(change.addedNodes)) reword(added);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true });
}
