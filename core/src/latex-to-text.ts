/**
 * Turn a short piece of inline LaTeX into text that reads cleanly one word at a
 * time: "\theta" becomes the Greek letter, "x^2" a real superscript, and
 * "\frac{a}{b}" becomes "a/b". It is a tidy-up for inline maths in notes, not a
 * LaTeX engine: anything it does not know is passed through without the backslash.
 */

// unicode-table: command names to symbols
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', pm: '±', mp: '∓', div: '÷', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', propto: '∝', to: '→', rightarrow: '→', leftarrow: '←',
  Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', mapsto: '↦', infty: '∞', sum: 'Σ', prod: 'Π',
  int: '∫', partial: '∂', nabla: '∇', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
  forall: '∀', exists: '∃', ldots: '…', dots: '…', cdots: '…', mid: '|', vert: '|', neg: '¬', land: '∧',
  lor: '∨', ll: '≪', gg: '≫', circ: '∘', bullet: '•', star: '⋆', dagger: '†', ell: 'ℓ', hbar: 'ℏ',
  emptyset: '∅', varnothing: '∅', angle: '∠', perp: '⊥', parallel: '∥', top: '⊤', prime: '′', degree: '°',
};
// unicode-table: blackboard letters
const BLACKBOARD: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ',
};
// unicode-table: superscript forms
const SUPER: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', 'T': 'ᵀ', 'k': 'ᵏ', 'm': 'ᵐ', 't': 'ᵗ',
};
// unicode-table: subscript forms
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', 'a': 'ₐ', 'e': 'ₑ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ', 'm': 'ₘ',
  'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'x': 'ₓ',
};
/** Combining accents, which follow the letter they sit on. */
const ACCENTS: Record<string, string> = {
  hat: '\u0302', widehat: '\u0302', bar: '\u0304', overline: '\u0304', tilde: '\u0303', widetilde: '\u0303',
  vec: '\u20D7', dot: '\u0307', ddot: '\u0308',
};

const WORD_OPERATORS = new Set([
  'log', 'ln', 'exp', 'min', 'max', 'lim', 'sup', 'inf', 'sin', 'cos', 'tan', 'det', 'dim', 'arg', 'Pr', 'gcd', 'mod',
]);
const UNWRAP = new Set([
  'text', 'textrm', 'textit', 'textbf', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathcal', 'boldsymbol', 'bm',
  'operatorname', 'mathscr', 'mathtt', 'mbox', 'underline',
]);
const SPACING = new Set(['quad', 'qquad', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'displaystyle', 'limits', 'nolimits']);

/** Read one argument starting at `i`: a braced group, or a single token. Returns its source and the index after it. */
function readArgument(s: string, i: number): [string, number] {
  while (s[i] === ' ') i++;
  if (s[i] !== '{') {
    if (s[i] === '\\') {
      const m = /^\\[A-Za-z]+/.exec(s.slice(i));
      if (m) return [m[0], i + m[0].length];
    }
    return [s[i] ?? '', i + 1];
  }
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
}

function script(body: string, table: Record<string, string>, marker: string): string {
  const text = convert(body);
  let out = '';
  for (const ch of text) {
    const m = table[ch];
    if (m === undefined) {
      const compact = text.replace(/\s+/g, '');
      return compact.length > 1 ? `${marker}(${compact})` : `${marker}${compact}`;
    }
    out += m;
  }
  return out;
}

const group = (s: string): string => (/^[\w.]+$/.test(s) || s.length <= 1 ? s : `(${s})`);

function convert(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+)\*?/.exec(s.slice(i));
      if (!m) {
        // Escaped symbol such as \% or \_, or a spacing command such as \, and \;
        const next = s[i + 1] ?? '';
        out += /[,;:!> ]/.test(next) ? ' ' : next === '\\' ? ' ' : next;
        i += 2;
        continue;
      }
      const name = m[1];
      i += m[0].length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [a, j] = readArgument(s, i);
        const [b, k] = readArgument(s, j);
        out += `${group(convert(a))}/${group(convert(b))}`;
        i = k;
      } else if (name === 'binom') {
        const [a, j] = readArgument(s, i);
        const [b, k] = readArgument(s, j);
        out += `C(${convert(a)},${convert(b)})`;
        i = k;
      } else if (name === 'sqrt') {
        const [a, j] = readArgument(s, i);
        out += `\u221A${group(convert(a))}`;
        i = j;
      } else if (name === 'mathbb') {
        const [a, j] = readArgument(s, i);
        out += BLACKBOARD[a] ?? a;
        i = j;
      } else if (ACCENTS[name]) {
        const [a, j] = readArgument(s, i);
        out += convert(a) + ACCENTS[name];
        i = j;
      } else if (UNWRAP.has(name)) {
        const [a, j] = readArgument(s, i);
        out += name.startsWith('text') || name === 'mbox' ? a : convert(a);
        i = j;
      } else if (name === 'tag') {
        const [, j] = readArgument(s, i);
        i = j;
      } else if (SPACING.has(name)) {
        out += ' ';
      } else if (SYMBOLS[name]) {
        out += SYMBOLS[name];
      } else {
        out += WORD_OPERATORS.has(name) && /[A-Za-z0-9\\]/.test(s[i] ?? '') ? `${name} ` : name;
      }
    } else if (ch === '^' || ch === '_') {
      const [a, j] = readArgument(s, i + 1);
      out += script(a, ch === '^' ? SUPER : SUB, ch);
      i = j;
    } else if (ch === '{' || ch === '}') {
      i++;
    } else if (ch === '~') {
      out += ' ';
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function latexToText(latex: string): string {
  return convert(latex).replace(/\s+/g, ' ').trim();
}
