/**
 * The font setting as a value for CSS: nothing set means the font of the theme, a name with a
 * space in it is put in quotation marks, and a list of fallbacks stays a list.
 */
export function cssFontFamily(input?: string): string {
  const raw = (input ?? "").trim();
  if (!raw || raw.toLowerCase() === "default") return "inherit";

  // Back-compat + typo guard
  const lower = raw.toLowerCase();
  if (lower === "literata" || lower === "litterata") return '"Literata"';

  // Generic families / keywords
  const generics = new Set([
    "inherit", "serif", "sans-serif", "monospace", "cursive", "fantasy",
    "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
    "emoji", "math", "fangsong"
  ]);
  if (generics.has(lower)) return lower;

  // Support comma-separated fallback lists; quote names with spaces
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  const normalized = parts.map(p => {
    if (/^["'].*["']$/.test(p)) return p;            // already quoted
    if (/\s/.test(p)) return `"${p.replace(/"/g, '\\"')}"`;
    return p;
  });

  return normalized.join(", ");
}
