/**
 * The icon Obsidian shows a callout with.
 *
 * The app's styles give every type of callout an icon and a colour, and a snippet or another
 * plugin can add types of its own. Both are read off a callout that those styles lay out,
 * unseen, inside a given element: the icon from the variable the styles set for the type,
 * the colour from a blank drawing set where the callout's own icon would be, since the
 * drawing is what the styles colour.
 */

import { sanitizeHTMLToDom, setIcon } from 'obsidian';

export interface CalloutLook {
  /** The name of an icon, or an SVG element as markup */
  icon: string;
  color: string;
}

export function calloutLook(type: string, host: HTMLElement): CalloutLook {
  const probe = host.createDiv({ cls: 'callout foveafocus-callout-probe' });
  probe.dataset.callout = type.toLowerCase();
  const drawing = probe.createDiv({ cls: 'callout-title' }).createDiv({ cls: 'callout-icon' }).createSvg('svg', { cls: 'svg-icon' });
  // The variable holds the name of an icon, or an SVG element as a quoted string.
  const icon = getComputedStyle(probe).getPropertyValue('--callout-icon').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  const color = getComputedStyle(drawing).color;
  probe.remove();
  return { icon, color };
}

/** Draws the icon into an element, in the colour of the callout. */
export function drawCalloutIcon(el: HTMLElement, look: CalloutLook): void {
  if (look.color) el.setCssProps({ '--foveafocus-callout-color': look.color });
  if (/^<svg/i.test(look.icon)) el.appendChild(sanitizeHTMLToDom(look.icon));
  else if (look.icon) setIcon(el, look.icon);
}
