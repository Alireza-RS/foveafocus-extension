/**
 * What an element is called is told on pointing at it. The app the reader was written for
 * does this with every label, and the reader counts on it: a button with a drawing alone
 * has its name in its label and nowhere else.
 */

const AFTER = 500;
const GAP = 6;

export function tellLabels(): void {
  let over: Element | null = null;
  let tip: HTMLElement | null = null;
  let timer = 0;

  const hide = (): void => {
    window.clearTimeout(timer);
    tip?.remove();
    tip = null;
    over = null;
  };

  const show = (labelled: Element, label: string): void => {
    if (!labelled.isConnected) return;
    tip = document.createElement('div');
    tip.className = 'host-tooltip';
    tip.textContent = label;
    document.body.appendChild(tip);
    const at = labelled.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const below = at.bottom + GAP + box.height <= window.innerHeight;
    const left = Math.max(GAP, Math.min(window.innerWidth - box.width - GAP, at.left + at.width / 2 - box.width / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? at.bottom + GAP : Math.max(GAP, at.top - GAP - box.height)}px`;
  };

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const target = event.target instanceof Element ? event.target : null;
    const labelled = target?.closest('[aria-label]') ?? null;
    if (labelled === over) return;
    hide();
    const label = labelled?.getAttribute('aria-label');
    if (!labelled || !label) return;
    over = labelled;
    timer = window.setTimeout(() => show(labelled, label), AFTER);
  });
  for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, hide, true);
  document.documentElement.addEventListener('pointerleave', hide);
  window.addEventListener('blur', hide);
}
