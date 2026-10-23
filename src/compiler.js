// Compiler Teil 1: Deklarationen, Typen, POU-Struktur, Namensauflösung
(function (ST) {
  'use strict';
  const T = ST.T;
  const { STError } = ST;

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }

  class Compiler {
    constructor() {
      this.diags = [];
      this.types = new Map();      // NAME -> {decl, file, resolved}
      this.pous = new Map();       // NAME -> pou info
      this.globals = new Map();    // NAME -> var info
      this.enumValues = new Map(); // WERT -> [{type, value}]
      this.files = [];
      this.curFile = null;
      this.registerBuiltinFBs();
    }

    // ---------- Diagnose ----------
    error(msg, node, file) { this.diags.push({ kind: 'error', msg, line: node ? node.line : 0, col: node ? node.col || 0 : 0, file: file || this.curFile }); }
    warn(msg, node, file) { this.diags.push({ kind: 'warning', msg, line: node ? node.line : 0, col: node ? node.col || 0 : 0, file: file || this.curFile }); }
    get hasErrors() { return this.diags.some(d => d.kind === 'error'); }

    suggest(name, candidates) {
      let best = null, bd = 3;
      for (const c of candidates) {
        const d = levenshtein(name, c);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    // ---------- Eingabe ----------
    addSource(file, src, role) {
      this.curFile = file;
      let ast;
      try { ast = ST.parse(src); }
      catch (e) {
        if (e instanceof STError) { for (const x of (e.all || [e])) this.error(x.message, x, file); return false; }
        throw e;
      }
      this.files.push({ file, ast, role: role || 'main' });
      return true;
    }

    registerBuiltinFBs() {
      for (const [name, def] of Object.entries(T.FBS)) {
        const vars = new Map();
        for (const [vn, sec, tn] of def.vars)
          vars.set(vn, { name: vn, display: vn, section: sec, type: T.ELEM[tn], init: def.init && def.init[vn] !== undefined ? def.init[vn] : undefined, hidden: vn.startsWith('_') });
        const pou = { kind: 'FUNCTION_BLOCK', name, display: name, builtin: true, native: def.run, vars, file: null };
        pou.type = this.makePouType(pou);
        this.pous.set(name, pou);
      }
    }

    makePouType(pou) {
      const type = { k: pou.kind === 'PROGRAM' ? 'prog' : 'fb', name: pou.name, display: pou.display, pou };
      type.fields = pou.vars;
      type.makeInstance = () => {
        const o = {};
        for (const v of pou.vars.values()) {
          if (v.section === 'VAR_TEMP' && pou.kind === 'FUNCTION') continue;
          o[v.name] = v.init !== undefined ? T.deepCopy(v.init) : T.defaultValue(v.type);
        }
        return o;
      };
      return type;
    }

    // ---------- Aufbau ----------
    build() {
      // 1) Typen registrieren
      for (const f of this.files) {
        this.curFile = f.file;
        for (const td of f.ast.types) {
          if (this.types.has(td.name) || T.ELEM[td.name] || this.pous.has(td.name)) { this.error(`Typ '${td.display}' ist mehrfach definiert`, td); continue; }
          this.types.set(td.name, { decl: td, file: f.file, resolved: null, resolving: false });
        }
      }
      // 2) POUs registrieren
      for (const f of this.files) {
        this.curFile = f.file;
        for (const p of f.ast.pous) {
          if (this.pous.has(p.name) || this.types.has(p.name)) {
            const old = this.pous.get(p.name);
            this.error(old && old.builtin ? `'${p.display}' ist ein Standard-Baustein und kann nicht neu definiert werden` : `'${p.display}' ist mehrfach definiert`, p);
            continue;
          }
          const pou = { kind: p.kind, name: p.name, display: p.display, ast: p, file: f.file, role: f.role, vars: new Map(), inputs: [], calls: new Set(), line: p.line };
          pou.type = this.makePouType(pou);
          this.pous.set(p.name, pou);
        }
      }
      // 3) Typen auflösen
      for (const [name, t] of this.types) { this.curFile = t.file; this.resolveNamedType(name, t.decl); }
      // 4) Globale Variablen
      for (const f of this.files) {
        this.curFile = f.file;
        for (const sec of f.ast.globals) {
          for (const v of sec.vars) {
            if (this.globals.has(v.name)) { this.error(`Globale Variable '${v.display}' ist mehrfach deklariert`, v); continue; }
            if (this.pous.has(v.name)) { this.error(`'${v.display}' kollidiert mit einem Bausteinnamen`, v); continue; }
            this.globals.set(v.name, this.declVar(v, sec, f.file, null));
          }
        }
      }
      // 5) Variablen der POUs
      for (const pou of this.pous.values()) {
        if (pou.builtin) continue;
        this.curFile = pou.file;
        if (pou.kind === 'FUNCTION') {
          pou.retType = pou.ast.retType ? this.resolveTypeSpec(pou.ast.retType) : T.VOID;
          if (pou.retType && pou.retType.k === 'fb') this.error('Funktionen können keinen FB zurückgeben', pou.ast);
        }
        this.constScope = pou.vars;
        for (const sec of pou.ast.sections) {
          if (sec.kind === 'VAR_GLOBAL') { this.error('VAR_GLOBAL ist innerhalb eines Bausteins nicht erlaubt', sec); continue; }
          if (pou.kind === 'FUNCTION' && sec.kind === 'VAR_OUTPUT') { /* erlaubt (CODESYS) */ }
          for (const v of sec.vars) {
            if (pou.vars.has(v.name)) { this.error(`Variable '${v.display}' ist in '${pou.display}' mehrfach deklariert`, v); continue; }
            if (sec.kind === 'VAR_EXTERNAL') {
              if (!this.globals.has(v.name)) this.error(`VAR_EXTERNAL '${v.display}' hat keine globale Variable`, v);
              continue;
            }
            const info = this.declVar(v, sec, pou.file, pou);
            if (info.type && info.type.k === 'prog') this.error(`Programm '${info.type.display}' kann nicht instanziert werden`, v);
            if (info.type && info.type.k === 'fb' && info.type.pou === pou) { this.error(`FB '${pou.display}' kann sich nicht selbst enthalten`, v); info.type = T.ELEM.BOOL; }
            pou.vars.set(v.name, info);
            if (sec.kind === 'VAR_INPUT' || sec.kind === 'VAR_IN_OUT') pou.inputs.push(v.name);
          }
        }
        this.constScope = null;
        if (pou.kind === 'FUNCTION' && pou.retType !== T.VOID)
          pou.vars.set(pou.name, { name: pou.name, display: pou.display, section: 'RETURN', type: pou.retType, line: pou.line });
      }
      // Instanz-Rekursion (FB A enthält B enthält A) erkennen
      for (const pou of this.pous.values()) if (!pou.builtin) this.checkRecursion(pou, []);
      if (this.hasErrors) return false;
      // 6) Rümpfe übersetzen
      for (const pou of this.pous.values()) {
        if (pou.builtin) continue;
        this.curFile = pou.file;
        const scope = { pou, file: pou.file, kind: 'pou' };
        pou.body = this.compileBlock(pou.ast.body, scope);
        this.checkUnused(pou);
      }
      return !this.hasErrors;
    }

    checkRecursion(pou, stack) {
      if (stack.includes(pou)) return true;
      for (const v of pou.vars.values()) {
        let t = v.type;
        while (t && t.k === 'array') t = t.elem;
        if (t && t.k === 'fb' && !t.pou.builtin) {
          if (this.checkRecursion(t.pou, stack.concat([pou]))) {
            if (stack.length === 0) this.error(`Rekursive Instanzierung: '${pou.display}' enthält sich selbst über '${t.display}'`, v);
            return stack.length > 0;
          }
        }
      }
      return false;
    }

    checkUnused(pou) {
      for (const v of pou.vars.values()) {
        if (v.section === 'VAR' && !v.used && !pou.builtin && pou.kind !== 'PROGRAM')
          this.warn(`Variable '${v.display}' wird nicht verwendet`, v, pou.file);
      }
    }

    declVar(v, sec, file, pou) {
      const type = this.resolveTypeSpec(v.type);
      const info = { name: v.name, display: v.display, section: sec.kind, constant: sec.constant, type, line: v.line, col: v.col, file, address: v.address };
      if (v.init) {
        try { info.init = this.constInit(v.init, type); }
        catch (e) {
          if (typeof e === 'string') this.error(e, v.init); else throw e;
        }
      } else if (sec.constant) this.error(`Konstante '${v.display}' braucht einen Initialwert`, v);
      if (type && type.k === 'fb' && sec.kind === 'VAR_IN_OUT') { /* ok */ }
      return info;
    }

    // ---------- Typen ----------
    resolveNamedType(name, decl) {
      const ent = this.types.get(name);
      if (ent.resolved) return ent.resolved;
      if (ent.resolving) { this.error(`Zyklische Typdefinition '${decl.display}'`, decl); return T.ELEM.INT; }
      ent.resolving = true;
      const spec = decl.spec;
      let t;
      if (spec.k === 'struct') {
        t = { k: 'struct', name, display: decl.display, fields: new Map() };
        ent.resolved = t; // für Selbstverweis-Fehler
        for (const f of spec.fields) {
          if (t.fields.has(f.name)) { this.error(`Feld '${f.display}' mehrfach`, f); continue; }
          const ft = this.resolveTypeSpec(f.type);
          const fi = { name: f.name, display: f.display, type: ft, section: 'FIELD', line: f.line };
          if (f.init) { try { fi.init = this.constInit(f.init, ft); } catch (e) { if (typeof e === 'string') this.error(e, f.init); else throw e; } }
          t.fields.set(f.name, fi);
        }
        t.makeInstance = () => {
          const o = {};
          for (const f of t.fields.values()) o[f.name] = f.init !== undefined ? T.deepCopy(f.init) : T.defaultValue(f.type);
          return o;
        };
      } else if (spec.k === 'enum') {
        t = { k: 'enum', name, display: decl.display, values: new Map(), names: new Map() };
        let next = 0;
        for (const v of spec.values) {
          if (v.value) { try { next = this.evalConst(v.value).v; } catch (e) { if (typeof e === 'string') this.error(e, v); else throw e; } }
          t.values.set(v.name, next);
          if (!t.names.has(next)) t.names.set(next, v.display);
          const arr = this.enumValues.get(v.name) || [];
          arr.push({ type: t, value: next });
          this.enumValues.set(v.name, arr);
          next++;
        }
        t.first = t.values.values().next().value;
        if (decl.init) { try { t.first = this.constInit(decl.init, t); } catch (e) { if (typeof e === 'string') this.error(e, decl.init); else throw e; } }
      } else {
        // Alias / Array / String
        t = this.resolveTypeSpec(spec);
      }
      ent.resolved = t;
      ent.resolving = false;
      return t;
    }

    resolveTypeSpec(spec) {
      switch (spec.k) {
        case 'named': {
          if (T.ELEM[spec.name] && !T.ELEM[spec.name].lit) return T.ELEM[spec.name];
          if (this.types.has(spec.name)) return this.resolveNamedType(spec.name, this.types.get(spec.name).decl);
          if (this.pous.has(spec.name)) {
            const p = this.pous.get(spec.name);
            if (p.kind === 'FUNCTION') { this.error(`'${spec.display}' ist eine Funktion, kein Datentyp`, spec); return T.ELEM.INT; }
            return p.type;
          }
          const all = [...Object.keys(T.ELEM).filter(k => !T.ELEM[k].lit), ...this.types.keys(), ...[...this.pous.values()].filter(p => p.kind === 'FUNCTION_BLOCK').map(p => p.name)];
          const s = this.suggest(spec.name, all);
          this.error(`Unbekannter Datentyp '${spec.display}'${s ? ` – meinten Sie '${s}'?` : ''}`, spec);
          return T.ELEM.INT;
        }
        case 'string': {
          let len = 80;
          try { len = this.evalConst(spec.len).v; } catch (e) { if (typeof e === 'string') this.error(e, spec); else throw e; }
          return Object.assign({}, T.ELEM[spec.name], { len });
        }
        case 'array': {
          const dims = [];
          for (const d of spec.dims) {
            try {
              const lo = this.evalConst(d.lo).v, hi = this.evalConst(d.hi).v;
              if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw 'Array-Grenzen müssen Ganzzahlen sein';
              if (hi < lo) throw `Array-Obergrenze ${hi} kleiner als Untergrenze ${lo}`;
              if ((hi - lo + 1) > 1e6) throw 'Array zu groß (max. 1.000.000 Elemente)';
              dims.push({ lo, hi });
            } catch (e) { if (typeof e === 'string') { this.error(e, spec); dims.push({ lo: 0, hi: 0 }); } else throw e; }
          }
          return { k: 'array', dims, elem: this.resolveTypeSpec(spec.elem) };
        }
        case 'struct': case 'enum': {
          // anonymer Typ in Variablendeklaration
          const name = '__ANON' + (this.anon = (this.anon || 0) + 1);
          this.types.set(name, { decl: { name, display: spec.k === 'enum' ? '(Aufzählung)' : 'STRUCT', spec, line: spec.line }, file: this.curFile, resolved: null });
          return this.resolveNamedType(name, this.types.get(name).decl);
        }
      }
      this.error('Unbekannte Typangabe', spec);
      return T.ELEM.INT;
    }

    // ---------- Konstanten ----------
    // Liefert {v, t}; wirft String bei Fehler
    evalConst(e) {
      switch (e.e) {
        case 'lit': return { v: e.v, t: this.litType(e) };
        case 'id': {
          const g = this.globals.get(e.name);
          if (g && g.constant && g.init !== undefined) return { v: g.init, t: g.type };
          const ev = this.enumValues.get(e.name);
          if (ev && ev.length === 1) return { v: ev[0].value, t: ev[0].type };
          if (this.constScope && this.constScope.has(e.name)) {
            const c = this.constScope.get(e.name);
            if (c.constant && c.init !== undefined) return { v: c.init, t: c.type };
          }
          throw `'${e.display}' ist keine Konstante`;
        }
        case 'enumval': {
          const ent = this.types.get(e.type);
          const t = ent && this.resolveNamedType(e.type, ent.decl);
          if (!t || t.k !== 'enum') throw `Unbekannter Aufzählungstyp '${e.type}'`;
          if (!t.values.has(e.name)) throw `'${e.display}' ist kein Wert von ${t.display}`;
          return { v: t.values.get(e.name), t };
        }
        case 'member': {
          if (e.obj.e === 'id' && this.types.has(e.obj.name)) {
            return this.evalConst({ e: 'enumval', type: e.obj.name, name: e.name, display: e.display });
          }
          throw 'Ausdruck ist nicht konstant';
        }
        case 'un': {
          const x = this.evalConst(e.x);
          if (e.op === '-') return { v: -x.v, t: x.t };
          if (e.op === 'NOT') return { v: T.isBool(x.t) ? !x.v : ~x.v, t: x.t };
          break;
        }
        case 'bin': {
          const a = this.evalConst(e.a), b = this.evalConst(e.b);
          const isI = T.isInt(a.t) && T.isInt(b.t);
          switch (e.op) {
            case '+': return { v: a.v + b.v, t: T.arithType(a.t, b.t) };
            case '-': return { v: a.v - b.v, t: T.arithType(a.t, b.t) };
            case '*': return { v: a.v * b.v, t: T.arithType(a.t, b.t) };
            case '/': if (b.v === 0) throw 'Division durch 0 im konstanten Ausdruck'; return { v: isI ? Math.trunc(a.v / b.v) : a.v / b.v, t: T.arithType(a.t, b.t) };
            case 'MOD': if (b.v === 0) throw 'Division durch 0 im konstanten Ausdruck'; return { v: a.v % b.v, t: T.arithType(a.t, b.t) };
            case '**': return { v: Math.pow(a.v, b.v), t: T.ELEM.LREAL };
            case 'AND': return { v: T.isBool(a.t) ? a.v && b.v : a.v & b.v, t: a.t };
            case 'OR': return { v: T.isBool(a.t) ? a.v || b.v : a.v | b.v, t: a.t };
          }
          break;
        }
        case 'call': {
          if (e.fn.e === 'id') {
            const f = T.getFunc(e.fn.name);
            if (f && e.args.every(a => !a.name)) {
              const args = e.args.map(a => this.evalConst(a.value));
              const rt = f.sig(args.map(a => a.t), e);
              return { v: f.impl(args.map(a => a.v), rt, args.map(a => a.t)), t: rt };
            }
          }
          break;
        }
      }
      throw 'Ausdruck muss konstant sein';
    }

    litType(e) {
      if (e.t === 'BOOL') return T.ELEM.BOOL;
      const t = T.ELEM[e.t];
      if (!t) {
        if (this.types.has(e.t)) return this.resolveNamedType(e.t, this.types.get(e.t).decl);
        this.error(`Unbekannter Typ-Präfix '${e.t}#'`, e);
        return T.ELEM.ANY_INT;
      }
      return t;
    }

    constInit(init, type) {
      if (init.e === 'arrinit') {
        if (type.k !== 'array') throw `Array-Initialisierung für Nicht-Array '${T.typeName(type)}'`;
        const n = type.dims.reduce((a, d) => a * (d.hi - d.lo + 1), 1);
        const out = T.defaultValue(type);
        let i = 0;
        for (const it of init.items) {
          for (let r = 0; r < it.repeat; r++) {
            if (i >= n) throw `Zu viele Initialwerte (Array hat ${n} Elemente)`;
            if (it.value) out[i] = this.constInit(it.value, type.elem);
            i++;
          }
        }
        return out;
      }
      if (init.e === 'structinit') {
        if (type.k !== 'struct' && type.k !== 'fb') throw `Struktur-Initialisierung für '${T.typeName(type)}'`;
        const out = type.makeInstance();
        for (const f of init.fields) {
          const fi = type.fields.get(f.name);
          if (!fi) throw `'${T.typeName(type)}' hat kein Element '${f.display}'`;
          out[f.name] = this.constInit(f.value, fi.type);
        }
        return out;
      }
      const c = this.evalConst(init);
      const chk = T.assignCheck(type, c.t);
      if (chk && chk.error) throw chk.error;
      if (type.k === 'enum' && c.t.k === 'enum') return c.v;
      return T.coerce(type, c.v);
    }

    // ---------- Namensauflösung ----------
    lookup(name, scope) {
      if (scope.locals && scope.locals.has(name)) return { where: 'test', info: scope.locals.get(name) };
      if (scope.pou && scope.pou.vars.has(name)) return { where: 'local', info: scope.pou.vars.get(name) };
      if (scope.pou && scope.pou.kind === 'FUNCTION' && name === scope.pou.name) return { where: 'local', info: scope.pou.vars.get(name) };
      if (this.globals.has(name)) return { where: 'global', info: this.globals.get(name) };
      if (this.pous.has(name)) {
        const p = this.pous.get(name);
        if (p.kind === 'PROGRAM') return { where: 'prog', pou: p };
        if (p.kind === 'FUNCTION') return { where: 'func', pou: p };
        return { where: 'fbtype', pou: p };
      }
      if (this.enumValues.has(name)) return { where: 'enumval', list: this.enumValues.get(name) };
      if (this.types.has(name)) return { where: 'type', type: this.resolveNamedType(name, this.types.get(name).decl) };
      if (scope.fallback) {
        for (const p of scope.fallback) if (p.vars.has(name)) return { where: 'fallback', pou: p, info: p.vars.get(name) };
      }
      return null;
    }

    allNames(scope) {
      const out = [...this.globals.keys(), ...this.pous.keys(), ...this.enumValues.keys()];
      if (scope.pou) out.push(...scope.pou.vars.keys());
      if (scope.locals) out.push(...scope.locals.keys());
      return out;
    }
  }

  ST.Compiler = Compiler;
})(globalThis.ST);
