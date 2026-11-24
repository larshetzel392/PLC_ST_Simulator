// Compiler Teil 2: Übersetzung von Ausdrücken und Anweisungen in JS-Closures
(function (ST) {
  'use strict';
  const T = ST.T;
  const E = T.ELEM;
  const P = ST.Compiler.prototype;

  const SIG_EXIT = 1, SIG_CONTINUE = 2, SIG_RETURN = 3;

  class STRuntimeError extends Error {}
  class TestFailure extends Error {
    constructor(msg, loc) { super(msg); this.loc = loc; }
  }
  ST.STRuntimeError = STRuntimeError;
  ST.TestFailure = TestFailure;
  function rtErr(msg) { throw new STRuntimeError(msg); }

  // ---------- Formatierung ----------
  function fmtValue(t, v) {
    if (!t) return String(v);
    switch (t.k) {
      case 'elem':
        switch (t.cat) {
          case 'bool': return v ? 'TRUE' : 'FALSE';
          case 'real': return T.fmtReal(v);
          case 'time': return T.formatTime(v);
          case 'string': return "'" + v + "'";
          case 'int':
            if (t.bitstr && t.bits >= 8 && v !== 0) return `${v} (16#${(v >= 0 ? v : v + 2 ** t.bits).toString(16).toUpperCase()})`;
            return String(v);
        }
        break;
      case 'enum': return t.names.has(v) ? `${t.names.get(v)}` : `${t.display}#${v}`;
      case 'array': return '[' + v.slice(0, 20).map(x => fmtValue(t.elem, x)).join(', ') + (v.length > 20 ? ', …' : '') + ']';
      case 'struct': case 'fb': case 'prog': {
        const parts = [];
        for (const f of t.fields.values()) if (!f.hidden && f.section !== 'VAR_TEMP') parts.push(`${f.display}:=${fmtValue(f.type, v[f.name])}`);
        return '(' + parts.join(', ') + ')';
      }
    }
    return String(v);
  }
  ST.fmtValue = fmtValue;

  function coercer(t) {
    if (t.k === 'elem') {
      if (t.cat === 'bool') return v => !!v;
      if (t.cat === 'int' && !t.lit) {
        if (t.bits <= 32) {
          const lo = t.signed ? -(2 ** (t.bits - 1)) : 0, hi = t.signed ? 2 ** (t.bits - 1) - 1 : 2 ** t.bits - 1;
          return v => (Number.isInteger(v) && v >= lo && v <= hi ? v : T.wrapInt(v, t));
        }
        return v => T.wrapInt(v, t);
      }
      if (t.name === 'LREAL') return v => +v;
    }
    return v => T.coerce(t, v);
  }

  function bitop(op, x, y, t) {
    const bits = t.bits || 32;
    if (bits <= 32) {
      const r = op === 'AND' ? (x & y) : op === 'OR' ? (x | y) : (x ^ y);
      return T.wrapInt(r, t);
    }
    const bx = BigInt.asUintN(64, BigInt(x)), by = BigInt.asUintN(64, BigInt(y));
    const r = op === 'AND' ? (bx & by) : op === 'OR' ? (bx | by) : (bx ^ by);
    return Number(t.signed ? BigInt.asIntN(64, r) : r);
  }
  function bitnot(x, t) {
    if ((t.bits || 32) <= 32) return T.wrapInt(~x, t);
    const r = ~BigInt.asUintN(64, BigInt(x));
    return Number(t.signed ? BigInt.asIntN(64, r) : BigInt.asUintN(64, r));
  }
  function getBit(v, b) {
    if (b < 31 && v >= -2147483648 && v <= 4294967295) return ((v >> b) & 1) === 1;   // Zweierkomplement, auch negativ
    return ((BigInt.asUintN(64, BigInt(Math.trunc(v))) >> BigInt(b)) & 1n) === 1n;
  }
  function setBit(v, b, on, t) {
    const cur = getBit(v, b);
    if (cur === !!on) return v;
    return T.wrapInt(v + (on ? 1 : -1) * 2 ** b, t);
  }

  // ---------- Hilfen ----------
  P.markUsed = function (info) { if (info) info.used = true; };

  P.unknownName = function (e, scope, what) {
    const s = this.suggest(e.name, this.allNames(scope));
    this.error(`${what || 'Bezeichner'} '${e.display}' ist nicht deklariert${s ? ` – meinten Sie '${this.displayOf(s, scope)}'?` : ''}`, e);
  };
  P.displayOf = function (name, scope) {
    const lk = this.lookup(name, scope);
    if (lk && lk.info) return lk.info.display;
    if (lk && lk.pou) return lk.pou.display;
    return name;
  };

  // ---------- Referenzen (L-Werte) ----------
  // liefert {t, get(c), set?(c,v), readonly?, special?}
  P.compileRef = function (e, scope) {
    switch (e.e) {
      case 'id': return this.refId(e, scope);
      case 'member': return this.refMember(e, scope);
      case 'index': return this.refIndex(e, scope);
      case 'bit': return this.refBit(e, scope);
      case 'this':
        if (!scope.pou || scope.pou.kind !== 'FUNCTION_BLOCK') { this.error('THIS^ ist nur in einem FUNCTION_BLOCK möglich', e); return null; }
        return { t: scope.pou.type, get: c => c.self, isThis: true };
      case 'super': this.error('SUPER^ nur als Aufruf SUPER^() oder SUPER^.Methode() möglich', e); return null;
    }
    return null;
  };

  P.varRef = function (K, info, base) {
    const co = coercer(info.type);
    const ref = { t: info.type, info };
    // Geforcte Variablen (o.__f[K]) werden vom Programm nicht überschrieben – wie in CODESYS
    if (base === 'self') { ref.get = c => c.self[K]; ref.set = (c, v) => { const o = c.self; if (!(o.__f && o.__f[K])) o[K] = co(v); }; ref.loc = c => [c.self, K]; }
    else if (base === 'M') { ref.get = c => c.M[K]; ref.set = (c, v) => { c.M[K] = co(v); }; ref.loc = c => [c.M, K]; }
    else if (base === 'G') { ref.get = c => c.G[K]; ref.set = (c, v) => { const o = c.G; if (!(o.__f && o.__f[K])) o[K] = co(v); }; ref.loc = c => [c.G, K]; }
    else { const PN = base; ref.get = c => c.P[PN][K]; ref.set = (c, v) => { const o = c.P[PN]; if (!(o.__f && o.__f[K])) o[K] = co(v); }; ref.loc = c => [c.P[PN], K]; }
    if (info.constant) {
      ref.readonly = `'${info.display}' ist eine Konstante`;
      if (info.init !== undefined && (info.type.k === 'elem' || info.type.k === 'enum')) ref.constVal = info.init;
    }
    return ref;
  };

  P.refId = function (e, scope) {
    const lk = this.lookup(e.name, scope);
    if (!lk) { this.unknownName(e, scope); return null; }
    switch (lk.where) {
      case 'test': case 'local':
        this.markUsed(lk.info);
        return this.varRef(e.name, lk.info, 'self');
      case 'mlocal': this.markUsed(lk.info); return this.varRef(e.name, lk.info, 'M');
      case 'global': this.markUsed(lk.info); return this.varRef(e.name, lk.info, 'G');
      case 'fallback': this.markUsed(lk.info); return this.varRef(e.name, lk.info, lk.pou.name);
      case 'prog': {
        const K = e.name;
        if (scope.pou) scope.pou.usesProg = true;
        return { t: lk.pou.type, get: c => c.P[K], special: 'prog', pou: lk.pou };
      }
      case 'enumval': {
        const ev = lk.list[0];
        if (lk.list.length > 1) this.warn(`'${e.display}' ist in mehreren Aufzählungstypen definiert – bitte qualifizieren (Typ.Wert)`, e);
        const v = ev.value;
        return { t: ev.type, get: () => v, readonly: 'Aufzählungswert kann nicht beschrieben werden', constVal: v };
      }
      case 'type': return { t: lk.type, special: 'type' };
      case 'func': return { t: T.VOID, special: 'func', pou: lk.pou };
      case 'fbtype': return { t: lk.pou.type, special: 'fbtype', pou: lk.pou };
    }
    return null;
  };

  P.refMember = function (e, scope) {
    const base = this.compileRef(e.obj, scope);
    if (!base) {
      if (e.obj.e !== 'id' && e.obj.e !== 'member' && e.obj.e !== 'index') this.error(`'.${e.display}' auf einem Ausdruck ist nicht möglich`, e);
      return null;
    }
    const bt = base.t;
    if (base.special === 'type') {
      if (bt.k === 'enum') {
        if (!bt.values.has(e.name)) { this.error(`'${e.display}' ist kein Wert von ${bt.display}`, e); return null; }
        const v = bt.values.get(e.name);
        return { t: bt, get: () => v, readonly: 'Aufzählungswert kann nicht beschrieben werden', constVal: v };
      }
      this.error(`'${bt.display}' ist ein Typ, keine Variable`, e.obj);
      return null;
    }
    if (base.special === 'fbtype') { this.error(`'${base.pou.display}' ist ein FB-Typ – auf eine Instanz zugreifen`, e.obj); return null; }
    if (bt.k !== 'struct' && bt.k !== 'fb' && bt.k !== 'prog') {
      this.error(`'${T.typeName(bt)}' hat keine Elemente – '.${e.display}' nicht möglich`, e);
      return null;
    }
    const f = bt.fields.get(e.name);
    if (!f || f.hidden || (f.section === 'VAR_TEMP')) {
      const s = this.suggest(e.name, [...bt.fields.values()].filter(x => !x.hidden).map(x => x.name));
      const sd = s ? bt.fields.get(s).display : null;
      this.error(`'${T.typeName(bt)}' hat kein Element '${e.display}'${sd ? ` – meinten Sie '${sd}'?` : ''}`, e);
      return null;
    }
    this.markUsed(f);
    const K = e.name, bget = base.get, co = coercer(f.type);
    const ref = { t: f.type, info: f, get: c => bget(c)[K], set: (c, v) => { const o = bget(c); if (!(o.__f && o.__f[K])) o[K] = co(v); }, loc: c => [bget(c), K] };
    if (bt.k === 'fb' && scope.kind === 'pou' && !base.isThis) {
      if (f.section === 'VAR_OUTPUT') ref.readonly = `Ausgang '${e.display}' von '${bt.display}' kann nicht von außen beschrieben werden`;
      if (f.section === 'VAR' || f.section === 'VAR_STAT') { this.error(`'${e.display}' ist eine interne Variable von '${bt.display}' und von außen nicht zugreifbar`, e); }
    }
    if (f.constant) ref.readonly = `'${f.display}' ist eine Konstante`;
    if (base.readonly && bt.k === 'struct') ref.readonly = base.readonly;
    return ref;
  };

  P.refIndex = function (e, scope) {
    const base = this.compileRef(e.obj, scope);
    if (!base) return null;
    const bt = base.t;
    if (bt.k !== 'array') {
      if (T.isStr(bt)) { this.error('String-Indizierung wird nicht unterstützt – MID() verwenden', e); return null; }
      this.error(`'${T.typeName(bt)}' ist kein Array`, e);
      return null;
    }
    if (e.idx.length !== bt.dims.length) { this.error(`Array hat ${bt.dims.length} Dimension(en), ${e.idx.length} Index(e) angegeben`, e); return null; }
    const idx = e.idx.map(x => this.compileExpr(x, scope));
    if (idx.some(x => !x)) return null;
    idx.forEach((x, i) => {
      if (!T.isInt(x.t)) this.error(`Array-Index muss Ganzzahl sein, nicht ${T.typeName(x.t)}`, e.idx[i]);
      if (x.constVal !== undefined && (x.constVal < bt.dims[i].lo || x.constVal > bt.dims[i].hi))
        this.error(`Index ${x.constVal} außerhalb der Grenzen [${bt.dims[i].lo}..${bt.dims[i].hi}]`, e.idx[i]);
    });
    const dims = bt.dims;
    let flat;
    if (dims.length === 1) {
      const lo = dims[0].lo, hi = dims[0].hi, f0 = idx[0].f;
      flat = c => { const i = f0(c); if (i < lo || i > hi) rtErr(`Array-Index ${i} außerhalb der Grenzen [${lo}..${hi}]`); return i - lo; };
    } else {
      flat = c => {
        let off = 0;
        for (let d = 0; d < dims.length; d++) {
          const i = idx[d].f(c);
          if (i < dims[d].lo || i > dims[d].hi) rtErr(`Array-Index ${i} (Dimension ${d + 1}) außerhalb der Grenzen [${dims[d].lo}..${dims[d].hi}]`);
          off = off * (dims[d].hi - dims[d].lo + 1) + (i - dims[d].lo);
        }
        return off;
      };
    }
    const bget = base.get, co = coercer(bt.elem);
    return { t: bt.elem, get: c => bget(c)[flat(c)], set: (c, v) => { const o = bget(c), i = flat(c); if (!(o.__f && o.__f[i])) o[i] = co(v); }, loc: c => [bget(c), flat(c)], readonly: base.readonly };
  };

  P.refBit = function (e, scope) {
    const base = this.compileRef(e.obj, scope);
    if (!base) return null;
    if (!(base.t.k === 'elem' && base.t.cat === 'int')) { this.error(`Bitzugriff '.${e.bit}' nur auf Ganzzahl-/Bitfolge-Typen möglich`, e); return null; }
    if (e.bit >= base.t.bits) { this.error(`Bit ${e.bit} existiert nicht in ${base.t.name} (0..${base.t.bits - 1})`, e); return null; }
    const b = e.bit, bt = base.t;
    return {
      t: E.BOOL, get: c => getBit(base.get(c), b),
      set: base.set ? (c, v) => base.set(c, setBit(base.get(c), b, v, bt)) : undefined, readonly: base.readonly,
    };
  };

  // ---------- Ausdrücke ----------
  // liefert {t, f(c), constVal?} oder null bei Fehler
  P.compileExpr = function (e, scope) {
    switch (e.e) {
      case 'lit': {
        let t = this.litType(e);
        let v = e.v;
        if (t.k === 'elem' && t.cat === 'string' && typeof v === 'string' && v.length > t.len) t = Object.assign({}, t, { len: v.length });
        if (t.k === 'elem' && t.cat === 'bool' && typeof v === 'number') v = v !== 0;
        if (t.k === 'elem' && !t.lit) {
          if (t.cat === 'int' && (typeof v !== 'number' || !Number.isInteger(v))) { this.error(`Ungültiges ${t.name}-Literal`, e); return null; }
          if (t.cat === 'int' && T.wrapInt(v, t) !== v) this.error(`Wert ${v} liegt außerhalb des Bereichs von ${t.name}`, e);
          v = T.coerce(t, v);
        }
        return { t, f: () => v, constVal: v };
      }
      case 'enumval': {
        try { const c = this.evalConst(e); const v = c.v; return { t: c.t, f: () => v, constVal: v }; }
        catch (err) { if (typeof err === 'string') { this.error(err, e); return null; } throw err; }
      }
      case 'id': case 'member': case 'index': case 'bit': {
        const r = this.compileRef(e, scope);
        if (!r) return null;
        if (r.special) {
          const what = { prog: 'ein Programm', type: 'ein Datentyp', func: 'eine Funktion – Klammern () für den Aufruf fehlen', fbtype: 'ein Funktionsbaustein-Typ' }[r.special];
          this.error(`'${e.display || '?'}' ist ${what} und kann nicht als Wert verwendet werden`, e);
          return null;
        }
        return { t: r.t, f: r.get, constVal: r.constVal };
      }
      case 'call': {
        const c = this.compileCall(e, scope);
        if (!c) return null;
        if (c.t === T.VOID) { this.error(`Aufruf von '${this.calleeName(e)}' liefert keinen Wert`, e); return null; }
        return c;
      }
      case 'un': return this.compileUnary(e, scope);
      case 'bin': return this.compileBinary(e, scope);
      case 'arrinit': case 'structinit':
        this.error('Initialisierungslisten sind nur in Deklarationen erlaubt', e);
        return null;
    }
    this.error('Unbekannter Ausdruck', e);
    return null;
  };

  P.calleeName = function (e) {
    const f = e.fn;
    return f.display || (f.e === 'member' ? f.display : '?');
  };

  P.compileUnary = function (e, scope) {
    const x = this.compileExpr(e.x, scope);
    if (!x) return null;
    const fx = x.f, t = x.t;
    if (e.op === '-') {
      if (!T.isNum(t) && !T.isTime(t)) { this.error(`Negation nicht möglich für ${T.typeName(t)}`, e); return null; }
      return { t, f: c => -fx(c) };
    }
    // NOT
    if (T.isBool(t)) return { t, f: c => !fx(c) };
    if (T.isInt(t) && t.k === 'elem') {
      const rt = t.lit ? E.DWORD : t;
      return { t: rt, f: c => bitnot(fx(c), rt) };
    }
    this.error(`NOT nicht möglich für ${T.typeName(t)}`, e);
    return null;
  };

  P.compileBinary = function (e, scope) {
    const a = this.compileExpr(e.a, scope), b = this.compileExpr(e.b, scope);
    if (!a || !b) return null;
    const fa = a.f, fb = b.f, ta = a.t, tb = b.t, op = e.op;
    const tn = T.typeName;
    const bad = (why) => { this.error(why || `Operator '${op}' nicht anwendbar auf ${tn(ta)} und ${tn(tb)}`, e); return null; };
    let r;
    switch (op) {
      case 'AND': case 'OR': case 'XOR': case 'AND_THEN': case 'OR_ELSE': {
        if (T.isBool(ta) && T.isBool(tb)) {
          if (op === 'AND') r = { t: E.BOOL, f: c => { const x = fa(c), y = fb(c); return x && y; } };
          else if (op === 'OR') r = { t: E.BOOL, f: c => { const x = fa(c), y = fb(c); return x || y; } };
          else if (op === 'XOR') r = { t: E.BOOL, f: c => fa(c) !== fb(c) };
          else if (op === 'AND_THEN') r = { t: E.BOOL, f: c => fa(c) && fb(c) };
          else r = { t: E.BOOL, f: c => fa(c) || fb(c) };
          break;
        }
        if (ta.k === 'elem' && tb.k === 'elem' && ta.cat === 'int' && tb.cat === 'int' && op !== 'AND_THEN' && op !== 'OR_ELSE') {
          let rt = T.arithType(ta, tb);
          if (rt.lit) rt = E.DWORD;
          r = { t: rt, f: c => bitop(op, fa(c), fb(c), rt) };
          break;
        }
        if ((T.isBool(ta) && T.isNum(tb)) || (T.isNum(ta) && T.isBool(tb)))
          return bad(`'${op}' verknüpft BOOL mit ${tn(T.isBool(ta) ? tb : ta)} – Vergleich (z.B. '= 0') vergessen?`);
        return bad();
      }
      case '=': case '<>': case '<': case '>': case '<=': case '>=': {
        const ok = (T.isNum(ta) && T.isNum(tb)) || (T.isTime(ta) && T.isTime(tb)) || (T.isStr(ta) && T.isStr(tb)) ||
          (T.isBool(ta) && T.isBool(tb)) ||
          (ta.k === 'enum' && tb.k === 'enum' && ta.name === tb.name) ||
          (ta.k === 'enum' && T.isInt(tb)) || (tb.k === 'enum' && T.isInt(ta));
        if (!ok) {
          if (ta.k === 'enum' && tb.k === 'enum') return bad(`Vergleich verschiedener Aufzählungstypen ${tn(ta)} und ${tn(tb)}`);
          return bad(`Vergleich von ${tn(ta)} mit ${tn(tb)} nicht möglich`);
        }
        if (T.isBool(ta) && (op !== '=' && op !== '<>')) return bad();
        const cmp = {
          '=': c => fa(c) === fb(c), '<>': c => fa(c) !== fb(c), '<': c => fa(c) < fb(c),
          '>': c => fa(c) > fb(c), '<=': c => fa(c) <= fb(c), '>=': c => fa(c) >= fb(c),
        }[op];
        if (T.isReal(ta) || T.isReal(tb)) {
          if ((op === '=' || op === '<>') && scope.kind !== 'test' && !(a.constVal !== undefined && b.constVal !== undefined))
            this.warn(`Gleichheitsvergleich von Gleitkommazahlen ist unzuverlässig`, e);
          // REAL-Werte sind als float32 gespeichert; Literal ebenfalls runden
          if ((ta.name === 'REAL' && tb.lit) || (tb.name === 'REAL' && ta.lit)) {
            const ga = ta.lit ? (c => Math.fround(fa(c))) : fa, gb = tb.lit ? (c => Math.fround(fb(c))) : fb;
            r = { t: E.BOOL, f: { '=': c => ga(c) === gb(c), '<>': c => ga(c) !== gb(c), '<': c => ga(c) < gb(c), '>': c => ga(c) > gb(c), '<=': c => ga(c) <= gb(c), '>=': c => ga(c) >= gb(c) }[op] };
            break;
          }
        }
        r = { t: E.BOOL, f: cmp };
        break;
      }
      case '+': case '-': case '*': case '/': case 'MOD': case '**': {
        if (T.isStr(ta) || T.isStr(tb)) return bad(op === '+' ? "Strings mit CONCAT() verketten, nicht mit '+'" : undefined);
        if (T.isBool(ta) || T.isBool(tb)) return bad(`Arithmetik '${op}' mit BOOL nicht möglich`);
        // Zeitarithmetik
        if (T.isTime(ta) || T.isTime(tb)) {
          const tt = T.isTime(ta) ? ta : tb;
          if ((op === '+' || op === '-') && T.isTime(ta) && T.isTime(tb)) r = { t: tt, f: op === '+' ? c => fa(c) + fb(c) : c => fa(c) - fb(c) };
          else if (op === '*' && T.isTime(ta) && T.isNum(tb)) r = { t: tt, f: c => Math.round(fa(c) * fb(c)) };
          else if (op === '*' && T.isNum(ta) && T.isTime(tb)) r = { t: tt, f: c => Math.round(fa(c) * fb(c)) };
          else if (op === '/' && T.isTime(ta) && T.isNum(tb)) r = { t: tt, f: c => { const y = fb(c); if (y === 0) rtErr('Division durch 0'); return Math.trunc(fa(c) / y); } };
          else if (op === '/' && T.isTime(ta) && T.isTime(tb)) r = { t: E.DINT, f: c => { const y = fb(c); if (y === 0) rtErr('Division durch 0'); return Math.trunc(fa(c) / y); } };
          else return bad();
          break;
        }
        if (!T.isNum(ta) && ta.k !== 'enum') return bad();
        if (!T.isNum(tb) && tb.k !== 'enum') return bad();
        if (ta.k === 'enum' || tb.k === 'enum') this.warn('Arithmetik mit Aufzählungswerten', e);
        const ta2 = ta.k === 'enum' ? E.INT : ta, tb2 = tb.k === 'enum' ? E.INT : tb;
        const rt = op === '**' ? (T.isReal(ta2) && ta2.name === 'LREAL' ? E.LREAL : E.REAL) : T.arithType(ta2, tb2);
        const intRes = rt.cat === 'int';
        switch (op) {
          case '+': r = { t: rt, f: c => fa(c) + fb(c) }; break;
          case '-': r = { t: rt, f: c => fa(c) - fb(c) }; break;
          case '*': r = { t: rt, f: c => fa(c) * fb(c) }; break;
          case '/':
            if (b.constVal === 0) this.error('Division durch 0', e);
            r = intRes
              ? { t: rt, f: c => { const y = fb(c); if (y === 0) rtErr('Division durch 0'); return Math.trunc(fa(c) / y); } }
              : { t: rt, f: c => fa(c) / fb(c) };
            break;
          case 'MOD':
            if (!intRes) return bad('MOD ist nur für Ganzzahlen definiert');
            if (b.constVal === 0) this.error('MOD 0 (Division durch 0)', e);
            r = { t: rt, f: c => { const y = fb(c); if (y === 0) rtErr('MOD durch 0'); return fa(c) % y; } };
            break;
          case '**': r = { t: rt, f: c => Math.pow(fa(c), fb(c)) }; break;
        }
        break;
      }
      default: return bad();
    }
    // Konstantenfaltung
    if (a.constVal !== undefined && b.constVal !== undefined && r) {
      try { const v = r.f(null); r = { t: r.t, f: () => v, constVal: v }; } catch (err) { /* Laufzeitfehler bleibt */ }
    }
    return r;
  };

  // ---------- Aufrufe ----------
  // Aktion oder Methode eines Bausteins suchen
  function memberProc(pou, name) {
    if (!pou || !pou.actions) return null;
    if (pou.methods.has(name)) return { m: pou.methods.get(name) };
    if (pou.actions.has(name)) return { a: pou.actions.get(name) };
    return null;
  }

  P.compileCall = function (e, scope) {
    const fnE = e.fn;
    if (fnE.e === 'super') {
      const b = scope.pou && scope.pou.base;
      if (!b) { this.error('SUPER^() ohne Basis-Baustein (EXTENDS)', e); return null; }
      return { t: T.VOID, f: c => { b.body({ self: c.self, G: c.G, P: c.P, rt: c.rt }); } };
    }
    if (fnE.e === 'member' && (fnE.obj.e === 'super' || fnE.obj.e === 'this')) {
      const owner = fnE.obj.e === 'super' ? scope.pou && scope.pou.base : scope.pou;
      const mp = memberProc(owner, fnE.name);
      if (mp) return mp.m ? this.callMethod(e, mp.m, c => c.self, scope) : this.callAction(e, mp.a, c => c.self);
      if (fnE.obj.e === 'super') { this.error(`'${fnE.display}' gibt es im Basis-Baustein nicht`, fnE); return null; }
    }
    if (fnE.e === 'member' && fnE.obj.e !== 'super') {
      // inst.Methode(...) / inst.Aktion() / Programm.Aktion()
      const saved = this.diags.length;
      const base = this.compileRef(fnE.obj, scope);
      if (base && (base.t.k === 'fb' || base.t.k === 'prog')) {
        const mp = memberProc(base.t.pou, fnE.name);
        if (mp) {
          if (scope.pou && base.special === 'prog') scope.pou.calls.add(base.t.pou.name);
          const get = base.special === 'prog' ? (K => c => c.P[K])(base.t.pou.name) : base.get;
          return mp.m ? this.callMethod(e, mp.m, get, scope) : this.callAction(e, mp.a, get);
        }
      }
      this.diags.length = saved;
    }
    if (fnE.e === 'id') {
      const lk = this.lookup(fnE.name, scope);
      const own = !lk || lk.where === 'fbtype' || lk.where === 'prog' ? memberProc(scope.pou, fnE.name) : null;
      if (own) return own.m ? this.callMethod(e, own.m, c => c.self, scope) : this.callAction(e, own.a, c => c.self);
      if (!lk) {
        if (fnE.name === 'TIME' && e.args.length === 0) return { t: E.TIME, f: c => c.rt.now };
        const bf = T.getFunc(fnE.name);
        if (bf) return this.callBuiltin(e, bf, scope);
        const cands = [...this.pous.values()].filter(p => p.kind !== 'FUNCTION_BLOCK' || true).map(p => p.name).concat(Object.keys(T.FUNCS));
        const s = this.suggest(fnE.name, cands);
        this.error(`Unbekannte Funktion/Baustein '${fnE.display}'${s ? ` – meinten Sie '${s}'?` : ''}`, fnE);
        return null;
      }
      if (lk.where === 'func') return this.callFunction(e, lk.pou, scope);
      if (lk.where === 'prog') {
        if (scope.pou) {
          if (lk.pou === scope.pou) { this.error(`Programm '${lk.pou.display}' ruft sich selbst auf`, e); return null; }
          scope.pou.calls.add(lk.pou.name);
        }
        const K = lk.pou.name;
        return this.callInstance(e, lk.pou, c => c.P[K], scope, true);
      }
      if (lk.where === 'fbtype') { this.error(`'${lk.pou.display}' ist ein FB-Typ – bitte eine Instanz deklarieren (z.B. fb${lk.pou.display} : ${lk.pou.display};) und diese aufrufen`, e); return null; }
    }
    const ref = this.compileRef(fnE, scope);
    if (!ref) return null;
    if (ref.t.k === 'fb') {
      if (scope.pou && ref.t.pou === scope.pou) { this.error('Rekursiver FB-Aufruf', e); return null; }
      return this.callInstance(e, ref.t.pou, ref.get, scope, false);
    }
    this.error(`'${fnE.display || '?'}' ist vom Typ ${T.typeName(ref.t)} und kann nicht aufgerufen werden`, e);
    return null;
  };

  // FB- oder Programmaufruf
  P.callInstance = function (e, pou, getInst, scope, isProg) {
    const ins = [], outs = [], inouts = [];
    const seen = new Set();
    for (const a of e.args) {
      if (!a.name) {
        this.error(`Beim Aufruf von '${pou.display}' müssen Parameter benannt werden (Name := Wert)`, a.value);
        continue;
      }
      if (seen.has(a.name)) { this.error(`Parameter '${a.display}' mehrfach angegeben`, a); continue; }
      seen.add(a.name);
      const f = pou.vars.get(a.name);
      if (!f || f.hidden) {
        const s = this.suggest(a.name, [...pou.vars.values()].filter(v => !v.hidden && ['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT'].includes(v.section)).map(v => v.name));
        this.error(`'${pou.display}' hat keinen Parameter '${a.display}'${s ? ` – meinten Sie '${pou.vars.get(s).display}'?` : ''}`, a);
        continue;
      }
      this.markUsed(f);
      if (a.out) {
        if (f.section !== 'VAR_OUTPUT') { this.error(`'${a.display}' ist kein Ausgang von '${pou.display}' ('=>' nur für VAR_OUTPUT)`, a); continue; }
        const tgt = this.compileRef(a.value, scope);
        if (!tgt) { if (!['id', 'member', 'index', 'bit'].includes(a.value.e)) this.error("Ziel von '=>' muss eine Variable sein", a.value); continue; }
        this.checkAssignTarget(tgt, a.value);
        this.checkAssign(tgt.t, f.type, a.value, `Ausgang '${a.display}'`);
        this.markWrite(tgt, scope);
        outs.push({ K: a.name, set: tgt.set });
      } else {
        if (f.section === 'VAR_OUTPUT') { this.error(`'${a.display}' ist ein Ausgang – mit '=>' abholen statt ':='`, a); continue; }
        if (f.section === 'VAR_IN_OUT') {
          const tgt = this.compileRef(a.value, scope);
          if (!tgt || !tgt.set) { this.error(`VAR_IN_OUT '${a.display}' braucht eine Variable`, a.value); continue; }
          this.checkAssign(f.type, tgt.t, a.value, `Parameter '${a.display}'`);
          inouts.push({ K: a.name, get: tgt.get, set: tgt.set, co: coercer(f.type) });
          continue;
        }
        if (f.section !== 'VAR_INPUT') {
          if (!isProg || scope.kind === 'pou') { this.error(`'${a.display}' ist kein Eingang von '${pou.display}'`, a); continue; }
        }
        const v = this.compileExpr(a.value, scope);
        if (!v) continue;
        this.checkAssign(f.type, v.t, a.value, `Eingang '${a.display}'`);
        if (scope.kind === 'pou' && scope.pou && scope.pou.role !== 'model') f.plcWrites = true;
        ins.push({ K: a.name, f: v.f, co: coercer(f.type) });
      }
    }
    for (const f of pou.vars.values())
      if (f.section === 'VAR_IN_OUT' && !seen.has(f.name)) this.error(`VAR_IN_OUT '${f.display}' von '${pou.display}' muss beim Aufruf angegeben werden`, e);
    const temps = pou.builtin ? [] : [...pou.vars.values()].filter(v => v.section === 'VAR_TEMP');
    const run = this.instanceRunner(pou, temps);
    const nIn = ins.length, nOut = outs.length, nIo = inouts.length;
    return {
      t: T.VOID,
      f: c => {
        const inst = getInst(c);
        const fz = inst.__f;
        for (let i = 0; i < nIn; i++) { const p = ins[i]; const v = p.co(p.f(c)); if (!(fz && fz[p.K])) inst[p.K] = v; }
        for (let i = 0; i < nIo; i++) { const p = inouts[i]; const v = p.co(p.get(c)); if (!(fz && fz[p.K])) inst[p.K] = v; }
        run(inst, c);
        for (let i = 0; i < nIo; i++) { const p = inouts[i]; p.set(c, inst[p.K]); }
        for (let i = 0; i < nOut; i++) { const p = outs[i]; p.set(c, inst[p.K]); }
      },
    };
  };

  P.callAction = function (e, act, getInst) {
    if (e.args.length) this.error(`Aktion '${act.display}' hat keine Parameter`, e);
    return {
      t: T.VOID,
      f: c => {
        const rt = c.rt;
        if (++rt.depth > 64) rtErr(`Aufruftiefe überschritten (Rekursion?) in Aktion '${act.display}'`);
        const saved = rt.loc;
        act.body({ self: getInst(c), G: c.G, P: c.P, rt });
        rt.loc = saved;
        rt.depth--;
      },
    };
  };

  P.callMethod = function (e, m, getInst, scope) {
    const params = m.inputs.map(n => m.vars.get(n));
    const ins = [], outs = [];
    let pos = 0;
    for (const a of e.args) {
      const f = a.name ? m.vars.get(a.name) : params[pos++];
      if (!f || !['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT'].includes(f.section)) { this.error(a.name ? `Methode '${m.display}' hat keinen Parameter '${a.display}'` : `Zu viele Argumente für '${m.display}'`, a.value || a); continue; }
      if (a.out || f.section === 'VAR_IN_OUT') {
        const tgt = this.compileRef(a.value, scope);
        if (!tgt || !tgt.set) { this.error(`Parameter '${f.display}' braucht eine Variable`, a.value); continue; }
        if (f.section === 'VAR_IN_OUT') ins.push({ K: f.name, f: tgt.get, co: coercer(f.type) });
        outs.push({ K: f.name, set: tgt.set });
        continue;
      }
      const v = this.compileExpr(a.value, scope);
      if (!v) continue;
      this.checkAssign(f.type, v.t, a.value, `Parameter '${f.display}'`);
      ins.push({ K: f.name, f: v.f, co: coercer(f.type) });
    }
    const make = m.type.makeInstance, RK = m.name, hasRet = m.retType !== T.VOID;
    return {
      t: m.retType,
      f: c => {
        const fr = make();
        for (let i = 0; i < ins.length; i++) { const p = ins[i]; fr[p.K] = p.co(p.f(c)); }
        const rt = c.rt;
        if (++rt.depth > 64) rtErr(`Aufruftiefe überschritten (Rekursion?) in Methode '${m.display}'`);
        const saved = rt.loc;
        m.body({ self: getInst(c), M: fr, G: c.G, P: c.P, rt });
        rt.loc = saved;
        rt.depth--;
        for (let i = 0; i < outs.length; i++) outs[i].set(c, fr[outs[i].K]);
        return hasRet ? fr[RK] : undefined;
      },
    };
  };

  P.instanceRunner = function (pou, temps) {
    if (pou.native) { const nat = pou.native; return (inst, c) => nat(inst, c.rt); }
    return (inst, c) => {
      for (const v of temps) inst[v.name] = v.init !== undefined ? T.deepCopy(v.init) : T.defaultValue(v.type);
      const rt = c.rt;
      if (++rt.depth > 64) rtErr(`Aufruftiefe überschritten (Rekursion?) in '${pou.display}'`);
      const saved = rt.loc;
      pou.body({ self: inst, G: c.G, P: c.P, rt });
      rt.loc = saved;
      rt.depth--;
    };
  };

  P.callFunction = function (e, pou, scope) {
    if (scope.pou === pou) { this.error(`Rekursiver Aufruf von '${pou.display}' ist nicht erlaubt`, e); return null; }
    const params = pou.inputs.map(n => pou.vars.get(n));
    const ins = [], outs = [];
    const given = new Set();
    let pos = 0;
    for (const a of e.args) {
      let f;
      if (a.name) {
        f = pou.vars.get(a.name);
        if (!f || !['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT'].includes(f.section)) { this.error(`'${pou.display}' hat keinen Parameter '${a.display}'`, a); continue; }
      } else {
        f = params[pos++];
        if (!f) { this.error(`Zu viele Argumente für '${pou.display}' (erwartet ${params.length})`, a.value); continue; }
      }
      given.add(f.name);
      if (a.out) {
        if (f.section !== 'VAR_OUTPUT') { this.error(`'${a.display}' ist kein Ausgang`, a); continue; }
        const tgt = this.compileRef(a.value, scope);
        if (!tgt) continue;
        this.checkAssignTarget(tgt, a.value);
        outs.push({ K: f.name, set: tgt.set });
        continue;
      }
      if (f.section === 'VAR_IN_OUT') {
        const tgt = this.compileRef(a.value, scope);
        if (!tgt || !tgt.set) { this.error(`VAR_IN_OUT '${f.display}' braucht eine Variable`, a.value); continue; }
        ins.push({ K: f.name, f: tgt.get, co: coercer(f.type) });
        outs.push({ K: f.name, set: tgt.set });
        continue;
      }
      const v = this.compileExpr(a.value, scope);
      if (!v) continue;
      this.checkAssign(f.type, v.t, a.value, `Parameter '${f.display}'`);
      ins.push({ K: f.name, f: v.f, co: coercer(f.type) });
    }
    for (const p of params) if (!given.has(p.name) && p.init === undefined && p.section === 'VAR_INPUT' && e.args.every(a => !a.name))
      this.error(`Argument '${p.display}' fehlt beim Aufruf von '${pou.display}'`, e);
    const make = pou.type.makeInstance, RK = pou.name;
    const run = this.instanceRunner(pou, []);
    const hasRet = pou.retType !== T.VOID;
    return {
      t: pou.retType,
      f: c => {
        const fr = make();
        for (let i = 0; i < ins.length; i++) { const p = ins[i]; fr[p.K] = p.co(p.f(c)); }
        run(fr, c);
        for (let i = 0; i < outs.length; i++) outs[i].set(c, fr[outs[i].K]);
        return hasRet ? fr[RK] : undefined;
      },
    };
  };

  P.callBuiltin = function (e, bf, scope) {
    const args = [];
    for (const a of e.args) {
      if (a.out) { this.error(`'=>' bei Standardfunktion '${bf.name}' nicht möglich`, a); return null; }
      const v = this.compileExpr(a.value, scope);
      if (!v) return null;
      args.push(v);
    }
    if (args.length < bf.minArgs || args.length > bf.maxArgs) {
      this.error(`'${bf.name}' erwartet ${bf.minArgs === bf.maxArgs ? bf.minArgs : bf.minArgs + '..' + (bf.maxArgs > 50 ? 'n' : bf.maxArgs)} Argument(e), ${args.length} angegeben`, e);
      return null;
    }
    let rt;
    const at = args.map(a => a.t);
    try { rt = bf.sig(at, e); }
    catch (err) { if (typeof err === 'string') { this.error(`${bf.name}: ${err}`, e); return null; } throw err; }
    const fs = args.map(a => a.f), impl = bf.impl, n = fs.length;
    const co = rt.k === 'elem' && !rt.lit ? coercer(rt) : (v => v);
    const f = c => {
      const vals = new Array(n);
      for (let i = 0; i < n; i++) vals[i] = fs[i](c);
      let r;
      try { r = impl(vals, rt, at); }
      catch (err) { if (err instanceof Error && !(err instanceof STRuntimeError)) rtErr(err.message); throw err; }
      return co(r);
    };
    if (args.every(a => a.constVal !== undefined)) {
      try { const v = f(null); return { t: rt, f: () => v, constVal: v }; } catch (err) { /* zur Laufzeit */ }
    }
    return { t: rt, f };
  };

  // Merkt, welche Variablen das SPS-Programm selbst schreibt (Ausgänge/Merker vs. Eingänge)
  P.markWrite = function (ref, scope) {
    if (ref && ref.info && scope.kind === 'pou' && scope.pou && scope.pou.role !== 'model') ref.info.plcWrites = true;
  };

  // ---------- Typprüfungen ----------
  P.checkAssign = function (dst, src, node, what) {
    const r = T.assignCheck(dst, src);
    if (!r) return true;
    if (r.error) { this.error(what ? `${what}: ${r.error}` : r.error, node); return false; }
    if (r.warn) this.warn(what ? `${what}: ${r.warn}` : r.warn, node);
    return true;
  };
  P.checkAssignTarget = function (ref, node) {
    if (ref.special) { this.error('Ziel der Zuweisung ist keine Variable', node); return false; }
    if (!ref.set) { this.error('Ziel kann nicht beschrieben werden', node); return false; }
    if (ref.readonly) { this.error(ref.readonly, node); return false; }
    return true;
  };

  // ---------- Anweisungen ----------
  P.compileBlock = function (stmts, scope) {
    const fs = [];
    for (const s of stmts) {
      const f = this.compileStmt(s, scope);
      if (f) fs.push(f);
    }
    const n = fs.length;
    if (n === 0) return () => 0;
    if (n === 1) return fs[0];
    return c => {
      for (let i = 0; i < n; i++) { const r = fs[i](c); if (r) return r; }
      return 0;
    };
  };

  // Jede Anweisung merkt sich den Zyklus, in dem sie zuletzt lief (für den Programmablaufplan)
  P.compileStmt = function (s, scope) {
    const loc = { line: s.line, col: s.col, file: scope.file };
    const inner = this.compileStmtInner(s, scope, loc);
    if (!inner) return null;
    return c => { c.rt.loc = loc; s.hit = c.rt.cyc; return inner(c); };
  };

  P.compileStmtInner = function (s, scope, loc) {
    switch (s.s) {
      case 'assign': {
        const tgt = this.compileRef(s.target, scope);
        const val = this.compileExpr(s.value, scope);
        if (!tgt) { if (!['id', 'member', 'index', 'bit'].includes(s.target.e)) this.error('Linke Seite der Zuweisung muss eine Variable sein', s.target); return null; }
        if (!this.checkAssignTarget(tgt, s.target) || !val) return null;
        if (scope.loopVars && s.target.e === 'id' && scope.loopVars.includes(s.target.name))
          this.warn(`Laufvariable '${s.target.display}' wird in der Schleife verändert`, s);
        if (!this.checkAssign(tgt.t, val.t, s.value)) return null;
        this.markWrite(tgt, scope);
        const set = tgt.set, f = val.f;
        return c => { set(c, f(c)); return 0; };
      }
      case 'setreset': {
        const tgt = this.compileRef(s.target, scope);
        const val = this.compileExpr(s.value, scope);
        if (!tgt || !val || !this.checkAssignTarget(tgt, s.target)) return null;
        if (!T.isBool(tgt.t)) { this.error(`${s.set ? 'S=' : 'R='} braucht eine BOOL-Variable`, s.target); return null; }
        if (!T.isBool(val.t)) { this.error(`Bedingung muss BOOL sein, nicht ${T.typeName(val.t)}`, s.value); return null; }
        this.markWrite(tgt, scope);
        const set = tgt.set, f = val.f, on = s.set;
        return c => { if (f(c)) set(c, on); return 0; };
      }
      case 'call': {
        const call = this.compileCall(s.call, scope);
        if (!call) return null;
        const f = call.f;
        return c => { f(c); return 0; };
      }
      case 'if': {
        const conds = [], bodies = [];
        for (const br of s.branches) {
          const cnd = this.compileExpr(br.cond, scope);
          if (cnd && !T.isBool(cnd.t)) this.error(`Bedingung muss BOOL sein, nicht ${T.typeName(cnd.t)}`, br.cond);
          conds.push(cnd ? cnd.f : () => false);
          bodies.push(this.compileBlock(br.body, scope));
        }
        const elseB = s.elseBody ? this.compileBlock(s.elseBody, scope) : null;
        const n = conds.length;
        // s.br: Index des zuletzt genommenen Zweigs (n = ELSE bzw. keiner)
        return c => {
          for (let i = 0; i < n; i++) if (conds[i](c)) { s.br = i; return bodies[i](c); }
          s.br = n;
          return elseB ? elseB(c) : 0;
        };
      }
      case 'case': {
        const sel = this.compileExpr(s.expr, scope);
        if (sel && !T.isInt(sel.t)) this.error(`CASE-Ausdruck muss Ganzzahl oder Aufzählung sein, nicht ${T.typeName(sel.t)}`, s.expr);
        const map = new Map(), ranges = [], bodies = [];
        s.cases.forEach((cs, idx) => {
          bodies.push(this.compileBlock(cs.body, scope));
          for (const lb of cs.labels) {
            const lo = this.caseConst(lb.lo, scope, sel);
            if (lo === null) continue;
            if (lb.hi) {
              const hi = this.caseConst(lb.hi, scope, sel);
              if (hi === null) continue;
              if (hi < lo) this.error(`Leerer Bereich ${lo}..${hi}`, lb.lo);
              for (const r of ranges) if (lo <= r.hi && hi >= r.lo) this.warn(`CASE-Bereich ${lo}..${hi} überschneidet sich mit ${r.lo}..${r.hi}`, lb.lo);
              ranges.push({ lo, hi, idx });
            } else {
              if (map.has(lo) || ranges.some(r => lo >= r.lo && lo <= r.hi)) this.warn(`CASE-Marke ${lo} ist doppelt`, lb.lo);
              else map.set(lo, idx);
            }
          }
        });
        const elseB = s.elseBody ? this.compileBlock(s.elseBody, scope) : null;
        const fsel = sel ? sel.f : () => 0;
        return c => {
          const v = fsel(c);
          let i = map.get(v);
          if (i === undefined) for (const r of ranges) if (v >= r.lo && v <= r.hi) { i = r.idx; break; }
          if (i !== undefined) { s.br = i; return bodies[i](c); }
          s.br = bodies.length;
          return elseB ? elseB(c) : 0;
        };
      }
      case 'for': {
        const v = this.compileRef(s.v, scope);
        if (v && !(v.t.k === 'elem' && v.t.cat === 'int')) this.error(`Laufvariable '${s.v.display}' muss eine Ganzzahl sein`, s.v);
        const from = this.compileExpr(s.from, scope), to = this.compileExpr(s.to, scope);
        const by = s.by ? this.compileExpr(s.by, scope) : { t: E.ANY_INT, f: () => 1, constVal: 1 };
        for (const [x, n] of [[from, s.from], [to, s.to], [by, s.by]]) if (x && !T.isInt(x.t)) this.error('FOR-Grenzen müssen Ganzzahlen sein', n);
        if (by && by.constVal === 0) this.error('FOR-Schrittweite 0 ergibt eine Endlosschleife', s.by);
        const sub = Object.assign({}, scope, { loopVars: (scope.loopVars || []).concat([s.v.name]), inLoop: true });
        const body = this.compileBlock(s.body, sub);
        if (!v || !from || !to || !by) return null;
        this.markWrite(v, scope);
        const set = v.set, get = v.get, ff = from.f, ft = to.f, fb = by.f;
        return c => {
          const end = ft(c), step = fb(c);
          if (step === 0) rtErr('FOR-Schrittweite ist 0');
          set(c, ff(c));
          const rt = c.rt;
          for (;;) {
            const i = get(c);
            if (step > 0 ? i > end : i < end) break;
            const r = body(c);
            if (r === SIG_EXIT) break;
            if (r === SIG_RETURN) return r;
            if (++rt.loops > rt.maxLoops) rtErr('Schleifenlimit überschritten – Endlosschleife?');
            const nx = get(c) + step;
            set(c, nx);
            if (get(c) !== nx) break; // Überlauf der Laufvariable
          }
          return 0;
        };
      }
      case 'while': case 'repeat': {
        const cnd = this.compileExpr(s.cond, scope);
        if (cnd && !T.isBool(cnd.t)) this.error(`Bedingung muss BOOL sein, nicht ${T.typeName(cnd.t)}`, s.cond);
        const body = this.compileBlock(s.body, Object.assign({}, scope, { inLoop: true }));
        if (!cnd) return null;
        const fc = cnd.f;
        if (s.s === 'while') {
          return c => {
            const rt = c.rt;
            while (fc(c)) {
              const r = body(c);
              if (r === SIG_EXIT) break;
              if (r === SIG_RETURN) return r;
              if (++rt.loops > rt.maxLoops) rtErr('Schleifenlimit überschritten – Endlosschleife?');
            }
            return 0;
          };
        }
        return c => {
          const rt = c.rt;
          do {
            const r = body(c);
            if (r === SIG_EXIT) break;
            if (r === SIG_RETURN) return r;
            if (++rt.loops > rt.maxLoops) rtErr('Schleifenlimit überschritten – Endlosschleife?');
          } while (!fc(c));
          return 0;
        };
      }
      case 'exit':
        if (!scope.inLoop) this.error('EXIT außerhalb einer Schleife', s);
        return () => SIG_EXIT;
      case 'continue':
        if (!scope.inLoop) this.error('CONTINUE außerhalb einer Schleife', s);
        return () => SIG_CONTINUE;
      case 'return': return () => SIG_RETURN;
      case 'cycle': case 'wait': case 'assert': case 'rununtil': case 'log':
        if (scope.kind !== 'test') { this.error(`'${s.s.toUpperCase()}' ist nur in Testdateien erlaubt`, s); return null; }
        return this.compileTestStmt(s, scope, loc);
    }
    this.error('Unbekannte Anweisung', s);
    return null;
  };

  P.caseConst = function (e, scope, sel) {
    // Enum-Werte und Konstanten erlauben
    if (e.e === 'id' && sel && sel.t.k === 'enum' && sel.t.values.has(e.name)) return sel.t.values.get(e.name);
    const x = this.compileExpr(e, scope);
    if (!x) return null;
    if (x.constVal === undefined) { this.error('CASE-Marke muss konstant sein', e); return null; }
    if (!T.isInt(x.t)) { this.error(`CASE-Marke muss Ganzzahl sein, nicht ${T.typeName(x.t)}`, e); return null; }
    if (sel && sel.t.k === 'enum' && x.t.k === 'enum' && x.t.name !== sel.t.name) this.error(`CASE-Marke vom Typ ${x.t.display} passt nicht zu ${sel.t.display}`, e);
    return x.constVal;
  };

  // ---------- Test-Anweisungen ----------
  P.compileTestStmt = function (s, scope, loc) {
    switch (s.s) {
      case 'cycle': {
        const n = s.n ? this.compileExpr(s.n, scope) : { t: E.ANY_INT, f: () => 1 };
        if (!n) return null;
        if (!T.isInt(n.t)) { this.error('CYCLE erwartet eine Anzahl (Ganzzahl)', s.n); return null; }
        const fn = n.f;
        return c => { c.rt.test.cycles(fn(c)); return 0; };
      }
      case 'wait': {
        const d = this.compileExpr(s.dur, scope);
        if (!d) return null;
        if (!T.isTime(d.t)) { this.error('WAIT erwartet eine Zeit, z.B. WAIT T#500ms;', s.dur); return null; }
        const fd = d.f;
        return c => { c.rt.test.wait(fd(c)); return 0; };
      }
      case 'assert': {
        const cnd = this.compileExpr(s.cond, scope);
        if (!cnd) return null;
        if (!T.isBool(cnd.t)) { this.error(`ASSERT erwartet einen BOOL-Ausdruck, nicht ${T.typeName(cnd.t)}`, s.cond); return null; }
        let detail = null;
        const ce = s.cond;
        if (ce.e === 'bin' && ['=', '<>', '<', '>', '<=', '>='].includes(ce.op)) {
          const a = this.compileExpr(ce.a, scope), b = this.compileExpr(ce.b, scope);
          if (a && b) detail = c => {
            const av = fmtValue(a.t, a.f(c)), bv = fmtValue(b.t, b.f(c));
            // die Seite, die kein reines Literal ist, ist der „Ist“-Wert
            const lit = e => e.e === 'lit' || e.e === 'enumval' || (e.e === 'un' && e.x.e === 'lit') || (e.e === 'member' && a.constVal !== undefined && b.constVal !== undefined);
            if (lit(ce.a) && !lit(ce.b)) return `ist ${bv}`;
            if (lit(ce.b) && !lit(ce.a)) return `ist ${av}`;
            return `links ${av}, rechts ${bv}`;
          };
        }
        const msg = s.msg ? this.compileExpr(s.msg, scope) : null;
        const fc = cnd.f, src = s.src;
        return c => {
          c.rt.test.asserts++;
          if (!fc(c)) {
            let m = `ASSERT ${src} fehlgeschlagen`;
            if (detail) m += ` (${detail(c)})`;
            if (msg) m = `${msg.f(c)} – ${m}`;
            throw new TestFailure(m, loc);
          }
          return 0;
        };
      }
      case 'rununtil': {
        const cnd = this.compileExpr(s.cond, scope);
        if (!cnd) return null;
        if (!T.isBool(cnd.t)) { this.error('RUN_UNTIL erwartet einen BOOL-Ausdruck', s.cond); return null; }
        const to = s.timeout ? this.compileExpr(s.timeout, scope) : { t: E.TIME, f: () => 10000 };
        if (!to) return null;
        if (!T.isTime(to.t)) { this.error('TIMEOUT erwartet eine Zeit', s.timeout); return null; }
        const fc = cnd.f, ft = to.f;
        return c => { c.rt.test.asserts++; c.rt.test.runUntil(() => fc(c), ft(c), loc); return 0; };
      }
      case 'log': {
        const args = s.args.map(a => this.compileExpr(a, scope));
        if (args.some(a => !a)) return null;
        return c => {
          c.rt.test.log(args.map(a => (T.isStr(a.t) ? a.f(c) : fmtValue(a.t, a.f(c)))).join(' '), loc);
          return 0;
        };
      }
    }
    return null;
  };

  ST.SIG = { EXIT: SIG_EXIT, CONTINUE: SIG_CONTINUE, RETURN: SIG_RETURN };
})(globalThis.ST);
