/**
 * The icons the reader and the settings ask for by name, as the app they were written for
 * hands them out: drawings from the Lucide set. Only those that are asked for are listed,
 * so only they are built in.
 */

import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronsLeft, ChevronsRight, FileText, Minus, Monitor, Pause, Play,
  Plus, Settings, Smartphone, Square, X, createElement,
} from 'lucide';
import type { IconNode } from 'lucide';

const ICONS: Record<string, IconNode> = {
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'chevron-down': ChevronDown,
  'chevrons-left': ChevronsLeft,
  'chevrons-right': ChevronsRight,
  'file-text': FileText,
  minus: Minus,
  monitor: Monitor,
  pause: Pause,
  play: Play,
  plus: Plus,
  settings: Settings,
  smartphone: Smartphone,
  square: Square,
  x: X,
};

/** The drawing of an icon, or null for a name that is not among those built in */
export function iconElement(name: string): SVGElement | null {
  const node = ICONS[name.replace(/^lucide-/, '')];
  if (!node) return null;
  const svg = createElement(node);
  svg.setAttribute('class', `svg-icon lucide-${name.replace(/^lucide-/, '')}`);
  return svg;
}
