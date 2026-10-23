// Typsystem, Standardfunktionen und Standard-Funktionsbausteine
(function (ST) {
  'use strict';

  const INT_TYPES = {
    SINT: [8, true], USINT: [8, false], BYTE: [8, false],
    INT: [16, true], UINT: [16, false], WORD: [16, false],
    DINT: [32, true], UDINT: [32, false], DWORD: [32, false],
    LINT: [64, true], ULINT: [64, false], LWORD: [64, false],
  };
  const BIT_TYPES = new Set(['BYTE', 'WORD', 'DWORD', 'LWORD']);

  const ELEM = {};
  function mk(name, cat, extra) { ELEM[name] = Object.assign({ k: 'elem', name, cat }, extra || {}); }
  mk('BOOL', 'bool');
  for (const [n, [bits, signed]] of Object.entries(INT_TYPES)) mk(n, 'int', { bits, signed, bitstr: BIT_TYPES.has(n) });
  mk('REAL', 'real'); mk('LREAL', 'real');
  mk('TIME', 'time'); mk('LTIME', 'time');
  mk('STRING', 'string', { len: 80 }); mk('WSTRING', 'string', { len: 80 });
  mk('ANY_INT', 'int', { lit: true, bits: 64, signed: true });
  mk('ANY_REAL', 'real', { lit: true });
  const VOID = { k: 'void', name: 'VOID' };

  function isNum(t) { return t && t.k === 'elem' && (t.cat === 'int' || t.cat === 'real'); }
  function isInt(t) { return t && ((t.k === 'elem' && t.cat === 'int') || t.k === 'enum'); }
  function isBool(t) { return t && t.k === 'elem' && t.cat === 'bool'; }
  function isTime(t) { return t && t.k === 'elem' && t.cat === 'time'; }
  function isStr(t) { return t && t.k === 'elem' && t.cat === 'string'; }
  function isReal(t) { return t && t.k === 'elem' && t.cat === 'real'; }
  function isAnyBit(t) { return t && t.k === 'elem' && (t.cat === 'bool' || (t.cat === 'int')); }

  function typeName(t) {
    if (!t) return '?';
    switch (t.k) {
      case 'elem': if (t.lit) return t.cat === 'int' ? 'Ganzzahl-Literal' : 'REAL-Literal'; return t.name === 'STRING' && t.len !== 80 ? `STRING(${t.len})` : t.name;
      case 'array': return `ARRAY[${t.dims.map(d => d.lo + '..' + d.hi).join(',')}] OF ${typeName(t.elem)}`;
      case 'struct': case 'enum': case 'fb': return t.display || t.name;
      case 'prog': return 'PROGRAM ' + t.display;
      case 'void': return 'VOID';
      case 'enumtype': return t.type.display;
    }
    return t.name || t.k;
  }

  // Wert auf Typ abbilden (Überlauf, Rundung, Länge)
  function wrapInt(v, t) {
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (!Number.isFinite(v)) v = 0;
    if (!Number.isInteger(v)) v = Math.round(v);
    const bits = t.bits;
    if (bits >= 64) return v;
    const m = 2 ** bits;
    v = ((v % m) + m) % m;
    if (t.signed && v >= m / 2) v -= m;
    return v;
  }
  function coerce(t, v) {
    if (t.k === 'elem') {
      switch (t.cat) {
        case 'bool': return !!v;
        case 'int': return t.lit ? v : wrapInt(v, t);
        case 'real': { const x = typeof v === 'boolean' ? (v ? 1 : 0) : +v; return t.name === 'REAL' ? Math.fround(x) : x; }
        case 'time': {
          let x = Math.round(typeof v === 'number' ? v : 0);
          if (t.name === 'TIME') { const m = 2 ** 32; x = ((x % m) + m) % m; }
          return x;
        }
        case 'string': { const s = String(v); return s.length > t.len ? s.slice(0, t.len) : s; }
      }
    }
    if (t.k === 'enum') return typeof v === 'number' ? Math.trunc(v) : v;
    if (t.k === 'array' || t.k === 'struct' || t.k === 'fb') return deepCopy(v);
    return v;
  }
  function deepCopy(v) {
    if (Array.isArray(v)) return v.map(deepCopy);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = deepCopy(v[k]); return o; }
    return v;
  }

  function defaultValue(t) {
    switch (t.k) {
      case 'elem':
        switch (t.cat) { case 'bool': return false; case 'string': return ''; default: return 0; }
      case 'enum': return t.first;
      case 'array': {
        const n = t.dims.reduce((a, d) => a * (d.hi - d.lo + 1), 1);
        const arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = defaultValue(t.elem);
        return arr;
      }
      case 'struct': case 'fb': return t.makeInstance ? t.makeInstance() : {};
    }
    return 0;
  }

  // Ergebnistyp einer Arithmetik zweier Operanden
  function arithType(a, b) {
    if (isReal(a) || isReal(b)) {
      if ((a && a.name === 'LREAL') || (b && b.name === 'LREAL')) return ELEM.LREAL;
      if (a.lit && b.lit) return ELEM.ANY_REAL;
      if (isReal(a) && !a.lit) return a;
      if (isReal(b) && !b.lit) return b;
      return ELEM.REAL;
    }
    const ai = a.k === 'enum' ? ELEM.INT : a, bi = b.k === 'enum' ? ELEM.INT : b;
    if (ai.lit) return bi;
    if (bi.lit) return ai;
    if (ai.bits !== bi.bits) return ai.bits > bi.bits ? ai : bi;
    return ai.signed ? ai : bi;
  }

  // Zuweisungskompatibilität: liefert null (ok), {warn} oder {error}
  function assignCheck(dst, src) {
    if (!dst || !src) return null;
    const d = typeName(dst), s = typeName(src);
    if (dst.k === 'elem' && src.k === 'elem') {
      if (dst.cat === src.cat) {
        if (dst.cat === 'int' && !src.lit && !dst.lit && src.bits > dst.bits)
          return { warn: `Implizite Konvertierung von ${s} nach ${d} – möglicher Datenverlust` };
        if (dst.cat === 'real' && dst.name === 'REAL' && src.name === 'LREAL')
          return { warn: `Implizite Konvertierung von LREAL nach REAL – Genauigkeitsverlust` };
        return null;
      }
      if (dst.cat === 'real' && src.cat === 'int') return null;
      if (dst.cat === 'int' && src.cat === 'real') return { warn: `Implizite Konvertierung von ${s} nach ${d} (wird gerundet) – besser ${s === 'ANY_REAL' ? 'REAL' : s}_TO_${d} verwenden` };
      if ((dst.cat === 'time' && src.cat === 'int') || (dst.cat === 'int' && src.cat === 'time'))
        return { warn: `Implizite Konvertierung von ${s} nach ${d}` };
      return { error: `Typ '${s}' kann nicht an '${d}' zugewiesen werden` };
    }
    if (dst.k === 'enum') {
      if (src.k === 'enum' && src.name === dst.name) return null;
      if (src.k === 'elem' && src.cat === 'int') return { warn: `Ganzzahl an Aufzählungstyp ${d} zugewiesen` };
      return { error: `Typ '${s}' kann nicht an '${d}' zugewiesen werden` };
    }
    if (dst.k === 'elem' && dst.cat === 'int' && src.k === 'enum') return null;
    if (dst.k === src.k && (dst.k === 'struct' || dst.k === 'fb') && dst.name === src.name) return null;
    if (dst.k === 'array' && src.k === 'array') {
      if (typeName(dst) === typeName(src)) return null;
      return { error: `Array-Typen passen nicht: '${s}' → '${d}'` };
    }
    return { error: `Typ '${s}' kann nicht an '${d}' zugewiesen werden` };
  }

  // ---------- Standardfunktionen ----------
  // sig(argTypes, node, ctx) -> Rückgabetyp; wirft String bei Fehler
  // impl(argValues, retType, argTypes) -> Wert
  const FUNCS = {};
  function fn(name, sig, impl, minArgs, maxArgs) { FUNCS[name] = { name, sig, impl, minArgs, maxArgs }; }
  const num1 = (ret) => (a) => { if (!isNum(a[0])) throw `erwartet Zahl, nicht ${typeName(a[0])}`; return ret || (isReal(a[0]) ? a[0] : ELEM.LREAL); };
  const real1 = (a) => { if (!isNum(a[0])) throw `erwartet Zahl, nicht ${typeName(a[0])}`; return isReal(a[0]) && !a[0].lit ? a[0] : ELEM.REAL; };

  fn('ABS', a => { if (!isNum(a[0]) && !isTime(a[0])) throw `erwartet Zahl`; return a[0]; }, v => Math.abs(v[0]), 1, 1);
  fn('SQRT', real1, v => Math.sqrt(v[0]), 1, 1);
  fn('LN', real1, v => Math.log(v[0]), 1, 1);
  fn('LOG', real1, v => Math.log10(v[0]), 1, 1);
  fn('EXP', real1, v => Math.exp(v[0]), 1, 1);
  fn('SIN', real1, v => Math.sin(v[0]), 1, 1);
  fn('COS', real1, v => Math.cos(v[0]), 1, 1);
  fn('TAN', real1, v => Math.tan(v[0]), 1, 1);
  fn('ASIN', real1, v => Math.asin(v[0]), 1, 1);
  fn('ACOS', real1, v => Math.acos(v[0]), 1, 1);
  fn('ATAN', real1, v => Math.atan(v[0]), 1, 1);
  fn('EXPT', a => { if (!isNum(a[0]) || !isNum(a[1])) throw 'erwartet Zahlen'; return isReal(a[0]) && !a[0].lit ? a[0] : ELEM.REAL; }, v => Math.pow(v[0], v[1]), 2, 2);
  const cmpSig = a => {
    let t = a[0];
    for (const x of a.slice(1)) {
      if (isNum(t) && isNum(x)) t = arithType(t, x);
      else if (!(typeName(t) === typeName(x) || (isTime(t) && isTime(x)) || (isStr(t) && isStr(x)))) throw `inkompatible Argumente ${typeName(t)} / ${typeName(x)}`;
    }
    return t.lit ? (t.cat === 'int' ? ELEM.DINT : ELEM.LREAL) : t;
  };
  fn('MIN', cmpSig, v => v.reduce((a, b) => (b < a ? b : a)), 2, 99);
  fn('MAX', cmpSig, v => v.reduce((a, b) => (b > a ? b : a)), 2, 99);
  fn('LIMIT', a => cmpSig(a), v => Math.min(Math.max(v[1], v[0]), v[2]), 3, 3);
  fn('SEL', a => { if (!isBool(a[0])) throw 'erstes Argument (G) muss BOOL sein'; return cmpSig(a.slice(1)); }, v => (v[0] ? v[2] : v[1]), 3, 3);
  fn('MUX', a => { if (!isInt(a[0])) throw 'erstes Argument (K) muss Ganzzahl sein'; return cmpSig(a.slice(1)); }, (v) => {
    const k = v[0];
    if (k < 0 || k >= v.length - 1) throw new Error(`MUX: Index ${k} außerhalb 0..${v.length - 2}`);
    return v[k + 1];
  }, 3, 99);
  fn('MOVE', a => a[0], v => v[0], 1, 1);
  const shiftSig = a => { if (!isInt(a[0]) || !isInt(a[1])) throw 'erwartet Bitfolge und Anzahl'; return a[0].lit ? ELEM.DWORD : a[0]; };
  const bitsOf = t => (t.bits || 32);
  const toU = (v, b) => (b >= 64 ? v : (((v % 2 ** b) + 2 ** b) % 2 ** b));
  fn('SHL', shiftSig, (v, r) => wrapInt(toU(v[0], bitsOf(r)) * 2 ** v[1], r), 2, 2);
  fn('SHR', shiftSig, (v, r) => wrapInt(Math.floor(toU(v[0], bitsOf(r)) / 2 ** v[1]), r), 2, 2);
  fn('ROL', shiftSig, (v, r) => { const b = bitsOf(r), n = v[1] % b, x = toU(v[0], b); return wrapInt((x * 2 ** n) % 2 ** b + Math.floor(x / 2 ** (b - n)), r); }, 2, 2);
  fn('ROR', shiftSig, (v, r) => { const b = bitsOf(r), n = v[1] % b, x = toU(v[0], b); return wrapInt(Math.floor(x / 2 ** n) + (x % 2 ** n) * 2 ** (b - n), r); }, 2, 2);
  fn('TRUNC', a => { if (!isNum(a[0])) throw 'erwartet Zahl'; return ELEM.DINT; }, v => Math.trunc(v[0]), 1, 1);
  // Strings
  const strSig = (ret, pattern) => a => {
    pattern.forEach((p, i) => {
      if (p === 's' && !isStr(a[i])) throw `Argument ${i + 1} muss STRING sein, nicht ${typeName(a[i])}`;
      if (p === 'i' && !isInt(a[i])) throw `Argument ${i + 1} muss Ganzzahl sein, nicht ${typeName(a[i])}`;
    });
    return ret;
  };
  fn('LEN', strSig(ELEM.INT, ['s']), v => v[0].length, 1, 1);
  fn('LEFT', strSig(ELEM.STRING, ['s', 'i']), v => v[0].slice(0, Math.max(0, v[1])), 2, 2);
  fn('RIGHT', strSig(ELEM.STRING, ['s', 'i']), v => (v[1] <= 0 ? '' : v[0].slice(-v[1])), 2, 2);
  fn('MID', strSig(ELEM.STRING, ['s', 'i', 'i']), v => v[0].substr(v[2] - 1, v[1]), 3, 3);
  fn('CONCAT', a => { a.forEach((x, i) => { if (!isStr(x)) throw `Argument ${i + 1} muss STRING sein`; }); return ELEM.STRING; }, v => v.join(''), 2, 99);
  fn('INSERT', strSig(ELEM.STRING, ['s', 's', 'i']), v => v[0].slice(0, v[2]) + v[1] + v[0].slice(v[2]), 3, 3);
  fn('DELETE', strSig(ELEM.STRING, ['s', 'i', 'i']), v => v[0].slice(0, v[2] - 1) + v[0].slice(v[2] - 1 + v[1]), 3, 3);
  fn('REPLACE', strSig(ELEM.STRING, ['s', 's', 'i', 'i']), v => v[0].slice(0, v[3] - 1) + v[1] + v[0].slice(v[3] - 1 + v[2]), 4, 4);
  fn('FIND', strSig(ELEM.INT, ['s', 's']), v => v[0].indexOf(v[1]) + 1, 2, 2);

  // Konvertierungen X_TO_Y und TO_Y
  function conversion(name) {
    let m = /^([A-Z]+)_TO_([A-Z]+)$/.exec(name);
    let from = null, to;
    if (m) { from = m[1]; to = m[2]; } else { m = /^TO_([A-Z]+)$/.exec(name); if (!m) return null; to = m[1]; }
    const special = /^(TRUNC|ROUND)$/;
    if (!ELEM[to] || ELEM[to].lit) return null;
    if (from && !ELEM[from] && !special.test(from)) return null;
    const rt = ELEM[to];
    return {
      name,
      sig: (a) => {
        if (from && ELEM[from] && a[0].k === 'elem' && !a[0].lit && a[0].cat !== ELEM[from].cat)
          throw `erwartet ${from}, nicht ${typeName(a[0])}`;
        if (a[0].k !== 'elem' && a[0].k !== 'enum') throw `kann ${typeName(a[0])} nicht konvertieren`;
        return rt;
      },
      impl: (v, r, at) => convertValue(v[0], at[0], rt, from),
      minArgs: 1, maxArgs: 1,
    };
  }
  function fmtReal(x) {
    if (Number.isInteger(x)) return x.toFixed(1);
    return String(+x.toPrecision(7));
  }
  function convertValue(v, st, dt, from) {
    const sc = st.k === 'enum' ? 'int' : st.cat;
    switch (dt.cat) {
      case 'bool':
        if (sc === 'string') return v.trim().toUpperCase() === 'TRUE' || v.trim() === '1';
        return !!v;
      case 'int': {
        let x;
        if (sc === 'bool') x = v ? 1 : 0;
        else if (sc === 'string') { x = parseInt(v, 10); if (isNaN(x)) x = 0; }
        else if (sc === 'real') x = from === 'TRUNC' ? Math.trunc(v) : roundHalfAway(v);
        else x = v;
        return wrapInt(x, dt);
      }
      case 'real': {
        let x = sc === 'bool' ? (v ? 1 : 0) : sc === 'string' ? parseFloat(v) || 0 : v;
        return dt.name === 'REAL' ? Math.fround(x) : x;
      }
      case 'time': return coerce(dt, sc === 'bool' ? (v ? 1 : 0) : sc === 'string' ? 0 : v);
      case 'string':
        if (sc === 'bool') return v ? 'TRUE' : 'FALSE';
        if (sc === 'real') return fmtReal(v);
        if (sc === 'time') return formatTime(v);
        return String(v);
    }
    return v;
  }
  function roundHalfAway(v) { return v < 0 ? -Math.round(-v) : Math.round(v); }

  function getFunc(name) { return FUNCS[name] || conversion(name); }

  function formatTime(ms) {
    if (ms === 0) return 'T#0ms';
    let s = 'T#';
    let r = Math.abs(ms);
    if (ms < 0) s += '-';
    const parts = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
    for (const [u, f] of parts) { if (r >= f) { s += Math.floor(r / f) + u; r %= f; } }
    if (r > 0) s += (Number.isInteger(r) ? r : +r.toFixed(3)) + 'ms';
    return s;
  }

  // ---------- Standard-Funktionsbausteine ----------
  // vars: [name, sektion, typ]; run(inst, rt)
  const FBS = {
    TON: {
      vars: [['IN', 'VAR_INPUT', 'BOOL'], ['PT', 'VAR_INPUT', 'TIME'], ['Q', 'VAR_OUTPUT', 'BOOL'], ['ET', 'VAR_OUTPUT', 'TIME'], ['_START', 'VAR', 'TIME'], ['_RUN', 'VAR', 'BOOL']],
      run(s, rt) {
        if (!s.IN) { s.Q = false; s.ET = 0; s._RUN = false; return; }
        if (!s._RUN) { s._RUN = true; s._START = rt.now; }
        const et = rt.now - s._START;
        if (et >= s.PT) { s.Q = true; s.ET = s.PT; } else { s.Q = false; s.ET = et; }
      },
    },
    TOF: {
      vars: [['IN', 'VAR_INPUT', 'BOOL'], ['PT', 'VAR_INPUT', 'TIME'], ['Q', 'VAR_OUTPUT', 'BOOL'], ['ET', 'VAR_OUTPUT', 'TIME'], ['_START', 'VAR', 'TIME'], ['_RUN', 'VAR', 'BOOL']],
      run(s, rt) {
        if (s.IN) { s.Q = true; s.ET = 0; s._RUN = false; return; }
        if (!s.Q) { s.ET = 0; return; }
        if (!s._RUN) { s._RUN = true; s._START = rt.now; }
        const et = rt.now - s._START;
        if (et >= s.PT) { s.Q = false; s.ET = s.PT; s._RUN = false; } else s.ET = et;
      },
    },
    TP: {
      vars: [['IN', 'VAR_INPUT', 'BOOL'], ['PT', 'VAR_INPUT', 'TIME'], ['Q', 'VAR_OUTPUT', 'BOOL'], ['ET', 'VAR_OUTPUT', 'TIME'], ['_START', 'VAR', 'TIME'], ['_M', 'VAR', 'BOOL']],
      run(s, rt) {
        if (!s.Q && s.IN && !s._M) { s.Q = true; s._START = rt.now; s.ET = 0; }
        if (s.Q) {
          const et = rt.now - s._START;
          if (et >= s.PT) { s.Q = false; s.ET = s.PT; } else s.ET = et;
        } else if (!s.IN) s.ET = 0;
        s._M = s.IN;
      },
    },
    R_TRIG: {
      vars: [['CLK', 'VAR_INPUT', 'BOOL'], ['Q', 'VAR_OUTPUT', 'BOOL'], ['M', 'VAR', 'BOOL']],
      run(s) { s.Q = s.CLK && !s.M; s.M = s.CLK; },
    },
    F_TRIG: {
      vars: [['CLK', 'VAR_INPUT', 'BOOL'], ['Q', 'VAR_OUTPUT', 'BOOL'], ['M', 'VAR', 'BOOL']],
      run(s) { s.Q = !s.CLK && !s.M; s.M = !s.CLK; },
      init: { M: true },
    },
    SR: {
      vars: [['SET1', 'VAR_INPUT', 'BOOL'], ['RESET', 'VAR_INPUT', 'BOOL'], ['Q1', 'VAR_OUTPUT', 'BOOL']],
      run(s) { s.Q1 = s.SET1 || (!s.RESET && s.Q1); },
    },
    RS: {
      vars: [['SET', 'VAR_INPUT', 'BOOL'], ['RESET1', 'VAR_INPUT', 'BOOL'], ['Q1', 'VAR_OUTPUT', 'BOOL']],
      run(s) { s.Q1 = !s.RESET1 && (s.SET || s.Q1); },
    },
    CTU: {
      vars: [['CU', 'VAR_INPUT', 'BOOL'], ['RESET', 'VAR_INPUT', 'BOOL'], ['PV', 'VAR_INPUT', 'WORD'], ['Q', 'VAR_OUTPUT', 'BOOL'], ['CV', 'VAR_OUTPUT', 'WORD'], ['_M', 'VAR', 'BOOL']],
      run(s) {
        if (s.RESET) s.CV = 0;
        else if (s.CU && !s._M && s.CV < 65535) s.CV++;
        s._M = s.CU; s.Q = s.CV >= s.PV;
      },
    },
    CTD: {
      vars: [['CD', 'VAR_INPUT', 'BOOL'], ['LOAD', 'VAR_INPUT', 'BOOL'], ['PV', 'VAR_INPUT', 'WORD'], ['Q', 'VAR_OUTPUT', 'BOOL'], ['CV', 'VAR_OUTPUT', 'WORD'], ['_M', 'VAR', 'BOOL']],
      run(s) {
        if (s.LOAD) s.CV = s.PV;
        else if (s.CD && !s._M && s.CV > 0) s.CV--;
        s._M = s.CD; s.Q = s.CV <= 0;
      },
    },
    CTUD: {
      vars: [['CU', 'VAR_INPUT', 'BOOL'], ['CD', 'VAR_INPUT', 'BOOL'], ['RESET', 'VAR_INPUT', 'BOOL'], ['LOAD', 'VAR_INPUT', 'BOOL'], ['PV', 'VAR_INPUT', 'WORD'],
        ['QU', 'VAR_OUTPUT', 'BOOL'], ['QD', 'VAR_OUTPUT', 'BOOL'], ['CV', 'VAR_OUTPUT', 'WORD'], ['_MU', 'VAR', 'BOOL'], ['_MD', 'VAR', 'BOOL']],
      run(s) {
        if (s.RESET) s.CV = 0;
        else if (s.LOAD) s.CV = s.PV;
        else {
          const up = s.CU && !s._MU, dn = s.CD && !s._MD;
          if (up && !dn && s.CV < 65535) s.CV++;
          else if (dn && !up && s.CV > 0) s.CV--;
        }
        s._MU = s.CU; s._MD = s.CD;
        s.QU = s.CV >= s.PV; s.QD = s.CV <= 0;
      },
    },
  };

  ST.T = {
    ELEM, VOID, INT_TYPES, isNum, isInt, isBool, isTime, isStr, isReal, isAnyBit,
    typeName, coerce, wrapInt, defaultValue, deepCopy, arithType, assignCheck,
    getFunc, FUNCS, FBS, formatTime, fmtReal, convertValue,
  };
})(globalThis.ST);
