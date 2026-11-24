// ST Lexer – IEC 61131-3 Structured Text (CODESYS-Dialekt)
(function (ST) {
  'use strict';

  class STError extends Error {
    constructor(msg, line, col, kind) {
      super(msg);
      this.line = line || 0;
      this.col = col || 0;
      this.kind = kind || 'error';
    }
  }

  const KEYWORDS = new Set([
    'PROGRAM', 'END_PROGRAM', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'FUNCTION', 'END_FUNCTION',
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_GLOBAL', 'VAR_EXTERNAL', 'VAR_STAT', 'END_VAR',
    'CONSTANT', 'RETAIN', 'PERSISTENT', 'AT',
    'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT', 'ARRAY', 'OF',
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
    'EXIT', 'CONTINUE', 'RETURN',
    'METHOD', 'END_METHOD', 'ACTION', 'END_ACTION',
    'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE', 'AND_THEN', 'OR_ELSE',
    // Test-DSL
    'TEST', 'END_TEST', 'SETUP', 'END_SETUP', 'CYCLE', 'WAIT', 'ASSERT', 'RUN_UNTIL', 'TIMEOUT', 'LOG',
  ]);

  // Test-DSL-Schlüsselwörter sind im Programmcode normale Bezeichner
  const TEST_KEYWORDS = new Set(['TEST', 'END_TEST', 'SETUP', 'END_SETUP', 'CYCLE', 'WAIT', 'ASSERT', 'RUN_UNTIL', 'TIMEOUT', 'LOG']);

  const TIME_PREFIX = /^(T|TIME|LT|LTIME)$/i;
  const DATE_PREFIX = /^(D|DATE|TOD|TIME_OF_DAY|DT|DATE_AND_TIME)$/i;

  // Zeitliteral wie 1h2m3s4ms, 1.5s, 100ms -> Millisekunden
  function parseDuration(text, line, col) {
    let s = text.replace(/_/g, '').toLowerCase();
    let neg = false;
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    const re = /(\d+(?:\.\d+)?)(d|h|ms|m|s|us|ns)/g;
    let m, total = 0, pos = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index !== pos) throw new STError(`Ungültiges Zeitliteral '${text}'`, line, col);
      const v = parseFloat(m[1]);
      const f = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 }[m[2]];
      total += v * f;
      pos = re.lastIndex;
    }
    if (pos !== s.length || s.length === 0) throw new STError(`Ungültiges Zeitliteral '${text}'`, line, col);
    return neg ? -total : total;
  }

  function lex(src, opts) {
    const testMode = !!(opts && opts.testMode);
    const toks = [];
    let i = 0, line = 1, col = 1;
    const n = src.length;

    function adv(k) {
      for (let j = 0; j < k; j++) {
        if (src[i] === '\n') { line++; col = 1; } else col++;
        i++;
      }
    }
    function push(type, value, text, l, c, extra) {
      const t = { type, value, text, line: l, col: c };
      if (extra) Object.assign(t, extra);
      toks.push(t);
    }

    while (i < n) {
      const ch = src[i];
      // Whitespace
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') { adv(1); continue; }
      const l = line, c = col;
      // Kommentare (* *) (verschachtelt), /* */, //
      if (ch === '(' && src[i + 1] === '*') {
        let depth = 1; adv(2);
        while (i < n && depth > 0) {
          if (src[i] === '(' && src[i + 1] === '*') { depth++; adv(2); }
          else if (src[i] === '*' && src[i + 1] === ')') { depth--; adv(2); }
          else adv(1);
        }
        if (depth > 0) throw new STError('Kommentar (* ... *) nicht geschlossen', l, c);
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        adv(2);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) adv(1);
        if (i >= n) throw new STError('Kommentar /* ... */ nicht geschlossen', l, c);
        adv(2); continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') adv(1);
        continue;
      }
      // Pragmas {attribute ...} ignorieren
      if (ch === '{') {
        while (i < n && src[i] !== '}') adv(1);
        adv(1); continue;
      }
      // Strings
      if (ch === "'" || ch === '"') {
        const q = ch; adv(1);
        let s = '';
        while (i < n && src[i] !== q) {
          if (src[i] === '$' && i + 1 < n) {
            const e = src[i + 1];
            const map = { n: '\n', N: '\n', l: '\n', L: '\n', r: '\r', R: '\r', t: '\t', T: '\t', p: '\f', P: '\f', $: '$', "'": "'", '"': '"' };
            if (map[e] !== undefined) { s += map[e]; adv(2); continue; }
            if (/[0-9a-fA-F]{2}/.test(src.substr(i + 1, 2))) { s += String.fromCharCode(parseInt(src.substr(i + 1, 2), 16)); adv(3); continue; }
          }
          if (src[i] === '\n') throw new STError('String nicht geschlossen', l, c);
          s += src[i]; adv(1);
        }
        if (i >= n) throw new STError('String nicht geschlossen', l, c);
        adv(1);
        push('string', s, src.slice(0, 0) + q + s + q, l, c, { wide: q === '"' });
        continue;
      }
      // Direkte Adressen %IX0.0 etc.
      if (ch === '%') {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_.*]/.test(src[j])) j++;
        push('address', src.slice(i, j), src.slice(i, j), l, c);
        adv(j - i); continue;
      }
      // Zahlen
      if (/[0-9]/.test(ch)) {
        let j = i;
        // Basis-Literal 16#FF, 2#1010, 8#17
        let m = /^(\d+)#([0-9A-Fa-f_]+)/.exec(src.slice(i, i + 80));
        if (m && ['2', '8', '16'].includes(m[1])) {
          const v = parseInt(m[2].replace(/_/g, ''), parseInt(m[1]));
          push('int', v, m[0], l, c);
          adv(m[0].length); continue;
        }
        m = /^\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 80));
        // Achtung: "1..5" ist Bereich, kein Real
        let txt = m[0];
        if (m[1] && src[i + txt.indexOf('.') + 1] === '.') txt = txt.slice(0, txt.indexOf('.'));
        const clean = txt.replace(/_/g, '');
        const isReal = /[.eE]/.test(clean);
        push(isReal ? 'real' : 'int', isReal ? parseFloat(clean) : parseInt(clean, 10), txt, l, c);
        adv(txt.length); continue;
      }
      // Bezeichner / Schlüsselwörter / typisierte Literale
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        const word = src.slice(i, j);
        const up = word.toUpperCase();
        // Typisierte Literale: T#1s, INT#5, BOOL#TRUE, MyEnum#Wert
        if (src[j] === '#') {
          if (TIME_PREFIX.test(word)) {
            let k = j + 1;
            while (k < n && /[0-9A-Za-z_.\-]/.test(src[k])) k++;
            const body = src.slice(j + 1, k);
            push('time', parseDuration(body, l, c), src.slice(i, k), l, c);
            adv(k - i); continue;
          }
          if (DATE_PREFIX.test(word)) {
            let k = j + 1;
            while (k < n && /[0-9A-Za-z_.\-:]/.test(src[k])) k++;
            const body = src.slice(j + 1, k);
            push('date', body, src.slice(i, k), l, c, { dateKind: up });
            adv(k - i); continue;
          }
          // Typpräfix: <TYPE>#<literal>  bzw. Enum#Wert
          push('typeprefix', up, word + '#', l, c);
          adv(j - i + 1); continue;
        }
        if (KEYWORDS.has(up) && (testMode || !TEST_KEYWORDS.has(up))) push('kw', up, word, l, c);
        else push('ident', up, word, l, c);
        adv(j - i); continue;
      }
      // Operatoren
      const two = src.substr(i, 2);
      if ([':=', '=>', '<>', '<=', '>=', '**', '..'].includes(two)) {
        push('op', two, two, l, c); adv(2); continue;
      }
      if ('+-*/()[],;:.=<>&^#'.includes(ch)) { push('op', ch, ch, l, c); adv(1); continue; }
      throw new STError(`Unerwartetes Zeichen '${ch}'`, l, c);
    }
    push('eof', null, '<Dateiende>', line, col);
    return toks;
  }

  ST.STError = STError;
  ST.lex = lex;
  ST.parseDuration = parseDuration;
})(typeof globalThis.ST !== 'undefined' ? globalThis.ST : (globalThis.ST = {}));
