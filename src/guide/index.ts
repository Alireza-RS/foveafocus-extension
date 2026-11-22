/**
 * The page that shows how the extension works: a few steps beside the buttons they are
 * about, and a text to try them on. The script that stands in every page stands in this one
 * too, so the bar and the reader here are the ones of every page. The steps are those of
 * the device the browser runs on.
 */

import { Ellipsis, MousePointerClick, Play, SquareDashedText, createElement } from 'lucide';
import type { IconNode } from 'lucide';
import { SIGN } from '../content/launcher';
import { start } from '../content/index';
import type { ToWorker } from '../shared/messages';

/** A step: the button it is about, what is done, and what comes of it */
type Step = [IconNode, string, string];

const ON_A_COMPUTER = {
  lead: 'Four steps, to be tried on the text below. The bar is at the side of this page.',
  steps: [
    [Play, 'Press the first button of the bar.', 'The reader opens on the text below. Space plays and pauses, the arrow keys move through the text, and Esc closes the reader.'],
    [MousePointerClick, 'To start further down, press the second button and click a paragraph.', 'Or select a word and press the first button: the reading starts at that word.'],
    [SquareDashedText, 'To read one part alone, select it and press the third button.', 'Nothing else of the page is read.'],
    [Ellipsis, 'The last button hides the bar, and opens this page and the settings.', 'The FoveaFocus button in the toolbar of the browser shows a hidden bar again.'],
  ] as Step[],
  pdfs: "A PDF is shown in FoveaFocus's own viewer. A reading starts at any word there: select the word and press the first button of the bar, or press the second button and click the word. The links of a PDF are followed as on a web page; which kinds are followed is in the settings.",
  more: 'A right-click on a page offers the same readings. So do two shortcuts: Alt+Shift+F reads the page or what is selected, and Alt+Shift+G picks the place to start from. The bar can be made to fold into one button, and to be moved by dragging, in the settings.',
};

const ON_A_PHONE = {
  lead: 'Five steps, to be tried on the text below. The round button is at the side of this page.',
  steps: [
    [SIGN, 'Tap the round button.', 'It shows the bar, and a touch on the page tucks the bar away again. Held and dragged, the button moves to another place.'],
    [Play, 'Tap the first button of the bar.', 'The reader opens on the text below. A tap on the word plays and pauses.'],
    [MousePointerClick, 'To start further down, tap the second button and then a paragraph.', 'Or select a word and tap the first button: the reading starts at that word.'],
    [SquareDashedText, 'To read one part alone, select it and tap the third button.', 'Nothing else of the page is read.'],
    [Ellipsis, 'The last button opens this page and the settings.', 'It also opens a PDF that is on this device.'],
  ] as Step[],
  pdfs: "A link to a PDF opens the PDF in FoveaFocus's own viewer. A reading starts at any word there: select the word and tap the first button of the bar, or tap the second button and then the word. The links of a PDF are followed as on a web page; which kinds are followed is in the settings.",
  more: 'Whether the bar folds into the round button, and whether it can be moved, is in the settings.',
};

const ask = <T>(message: ToWorker): Promise<T | undefined> => chrome.runtime.sendMessage<ToWorker, T>(message).catch(() => undefined);

async function show(): Promise<void> {
  const told = (await ask<boolean>({ type: 'device' })) ? ON_A_PHONE : ON_A_COMPUTER;
  (document.getElementById('lead') as HTMLElement).textContent = told.lead;
  (document.getElementById('pdfs') as HTMLElement).textContent = told.pdfs;
  (document.getElementById('more') as HTMLElement).textContent = told.more;
  const steps = document.getElementById('steps') as HTMLElement;
  for (const [icon, done, comes] of told.steps) {
    const step = steps.appendChild(document.createElement('li'));
    const drawn = step.appendChild(document.createElement('div'));
    drawn.className = icon === Play ? 'guide-button is-first' : 'guide-button';
    drawn.appendChild(createElement(icon));
    const said = step.appendChild(document.createElement('div'));
    said.className = 'guide-step';
    said.appendChild(document.createElement('strong')).textContent = done;
    said.appendChild(document.createElement('span')).textContent = comes;
  }
  document.getElementById('settings')?.addEventListener('click', () => void ask({ type: 'options' }));
}

void show();
start({ tour: true });
