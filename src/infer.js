// Vorlauf beim Übersetzen: ergänzt, was in einem einzeln geladenen Programm fehlt.
//  - nicht deklarierte Variablen (z.B. aus einer fehlenden GVL) → globale Variable, Typ aus der Verwendung
//  - unbekannte Bausteine (Bibliotheks-FBs wie MC_Power) → leerer Platzhalter-FB mit den benutzten Parametern
//  - unbekannte Datentypen, die nur als Wert benutzt werden (z.B. fehlende Aufzählung) → INT
//  - direkte Adressen im Code (%IX0.0) → Variable mit dieser AT-Adresse bzw. neue globale Variable
// Alles Ergänzte wird als Warnung gemeldet.
(function (ST) {
  'use strict';
  const T = ST.T;
  const P = ST.Compiler.prototype;
  const AUTO = '(automatisch)';

  const isElem = n => !!(T.ELEM[n] && !T.ELEM[n].lit);
  const named = n => ({ k: 'named', name: n, display: n });
  const WEAK = new Set(['INT']);
  const ADDR_TYPE = { X: 'BOOL', B: 'BYTE', W: 'WORD', D: 'DWORD', L: 'LWORD' };

  P.inferMissing = function () {
    const files = this.files.filter(f => f.ast);
    const pouAst = new Map(), typeNames = new Set(), enumVals = new Set(), globals = new Map(), addrMap = new Map(), globalDisplay = new Map();
    for (const f of files) {
      for (const p of f.ast.pous) pouAst.set(p.name, p);
      for (const td of f.ast.types) {
        typeNames.add(td.name);
        if (td.spec.k === 'enum') td.spec.values.forEach(v => enumVals.add(v.name));
      }
      for (const sec of f.ast.globals) for (const v of sec.vars) {
        globals.set(v.name, v.type);
        globalDisplay.set(v.name, v.display);
        if (v.address) addrMap.set(v.address.toUpperCase(), v.name);
        if (v.type.k === 'enum') v.type.values.forEach(x => enumVals.add(x.name));
      }
    }
    const isType = n => isElem(n) || typeNames.has(n) || pouAst.has(n) || !!T.FBS[n] || n === 'STRING' || n === 'WSTRING';

    // Variablen eines Bausteins inkl. Basis (EXTENDS)
    const varsOf = (p, seen) => {
      const m = new Map();
      seen = seen || new Set();
      if (!p || seen.has(p.name)) return m;
      seen.add(p.name);
      if (p.extends && pouAst.has(p.extends.name)) for (const [k, v] of varsOf(pouAst.get(p.extends.name), seen)) m.set(k, v);
      for (const sec of p.sections || []) for (const v of sec.vars) {
        m.set(v.name, v);
        if (v.type.k === 'enum') v.type.values.forEach(x => enumVals.add(x.name));
      }
      return m;
    };

    // ---------- Sammeln ----------
    const missing = new Map();   // Name -> {display, type, weak, node, file, asLabel}
    const stubs = new Map();     // Typname -> {display, fields: Map(name -> {display, dir, type}), node, file, called}
    const unknownTypes = new Map(); // Typname -> {display, node, file, usedAsFb}
    const consts = new Map();    // Name -> {display, node, file}

    // unbekannte Datentypen in Deklarationen
    const checkSpec = (spec, file) => {
      if (!spec) return;
      if (spec.k === 'array') return checkSpec(spec.elem, file);
      if (spec.k === 'named' && !isType(spec.name) && !unknownTypes.has(spec.name))
        unknownTypes.set(spec.name, { display: spec.display, node: spec, file, usedAsFb: false });
    };
    for (const f of files) {
      for (const sec of f.ast.globals) for (const v of sec.vars) checkSpec(v.type, f.file);
      for (const td of f.ast.types) if (td.spec.k === 'struct') td.spec.fields.forEach(x => checkSpec(x.type, f.file));
      for (const p of f.ast.pous) {
        for (const sec of p.sections) for (const v of sec.vars) checkSpec(v.type, f.file);
        for (const m of p.methods || []) for (const sec of m.sections) for (const v of sec.vars) checkSpec(v.type, f.file);
      }
    }
    const specOf = (spec) => (spec && spec.k === 'named' ? spec.name : spec && spec.k === 'string' ? 'STRING' : null);

    // Bodies mit ihrem Sichtbarkeitsbereich
    const bodies = [];
    for (const f of files) for (const p of f.ast.pous) {
      const vars = varsOf(p);
      if (p.kind === 'FUNCTION' && p.retType) vars.set(p.name, { name: p.name, type: p.retType });
      bodies.push({ file: f.file, pou: p, vars, body: p.body });
      for (const a of p.actions || []) bodies.push({ file: f.file, pou: p, vars, body: a.body });
      for (const m of p.methods || []) {
        const mv = new Map(vars);
        for (const sec of m.sections) for (const v of sec.vars) mv.set(v.name, v);
        if (m.retType) mv.set(m.name, { name: m.name, type: m.retType });
        bodies.push({ file: f.file, pou: p, vars: mv, body: m.body, method: m });
      }
    }
    const hasAction = (p, n) => {
      for (let q = p, i = 0; q && i < 10; q = q.extends && pouAst.get(q.extends.name), i++)
        if ((q.actions || []).some(a => a.name === n) || (q.methods || []).some(m => m.name === n)) return true;
      return false;
    };

    // Typ eines Ausdrucks (Typname oder null)
    let ctx = null;
    const declType = name => {
      if (ctx.vars.has(name)) return specOf(ctx.vars.get(name).type);
      if (globals.has(name)) return specOf(globals.get(name));
      if (missing.has(name)) return missing.get(name).type;
      if (consts.has(name)) return 'INT';
      return null;
    };
    const fieldType = (tname, field) => {
      if (stubs.has(tname)) { const f = stubs.get(tname).fields.get(field); return f ? f.type : null; }
      if (T.FBS[tname]) { const d = T.FBS[tname].vars.find(x => x[0] === field); return d ? d[2] : null; }
      const p = pouAst.get(tname);
      if (p) { const v = varsOf(p).get(field); return v ? specOf(v.type) : null; }
      for (const f of files) for (const td of f.ast.types) if (td.name === tname && td.spec.k === 'struct') {
        const x = td.spec.fields.find(y => y.name === field);
        return x ? specOf(x.type) : null;
      }
      return null;
    };
    const guess = e => {
      if (!e) return null;
      switch (e.e) {
        case 'lit':
          if (e.t === 'ANY_INT') return 'INT';
          if (e.t === 'ANY_REAL') return 'REAL';
          return e.t === 'WSTRING' ? 'WSTRING' : e.t;
        case 'id': return declType(e.name);
        case 'member': { const bt = guess(e.obj); return bt ? fieldType(bt, e.name) : null; }
        case 'index': { const b = e.obj.e === 'id' && (ctx.vars.get(e.obj.name) || {}).type; return b && b.k === 'array' ? specOf(b.elem) : null; }
        case 'bit': return 'BOOL';
        case 'this': return ctx.pou.name;
        case 'un': return guess(e.x);
        case 'bin':
          if (['=', '<>', '<', '>', '<=', '>='].includes(e.op)) return 'BOOL';
          return pick(guess(e.a), guess(e.b));
        case 'call': {
          if (e.fn.e !== 'id') return null;
          const n = e.fn.name;
          const p = pouAst.get(n);
          if (p && p.kind === 'FUNCTION') return specOf(p.retType);
          const m = /_TO_(\w+)$/.exec(n);
          if (m && isElem(m[1])) return m[1];
          if (['ABS', 'MIN', 'MAX', 'LIMIT', 'SEL', 'MUX', 'MOVE'].includes(n)) return pick(...e.args.map(a => guess(a.value)));
          if (/^(SQRT|SIN|COS|TAN|ASIN|ACOS|ATAN|LN|LOG|EXP|EXPT|TRUNC)$/.test(n)) return n === 'TRUNC' ? 'DINT' : 'REAL';
          if (/^(LEN|FIND)$/.test(n)) return 'INT';
          if (/^(CONCAT|LEFT|RIGHT|MID|INSERT|DELETE|REPLACE)$/.test(n)) return 'STRING';
          return null;
        }
      }
      return null;
    };
    const pick = (...ts) => {
      let best = null;
      for (const t of ts) if (t && (!best || (WEAK.has(best) && !WEAK.has(t)))) best = t;
      return best;
    };

    // Ziel „x“ bekommt (vermutlich) Typ t
    const want = (e, t) => {
      if (!e || !t) return;
      if (e.e === 'id' && missing.has(e.name)) {
        const m = missing.get(e.name);
        if (!m.type || (WEAK.has(m.type) && !WEAK.has(t))) m.type = t;
      } else if (e.e === 'member') {
        const bt = guess(e.obj);
        if (bt && stubs.has(bt)) {
          const f = stubs.get(bt).fields.get(e.name);
          if (f && (!f.type || (WEAK.has(f.type) && !WEAK.has(t)))) f.type = t;
        }
      } else if (e.e === 'bin' && ['AND', 'OR', 'XOR', 'AND_THEN', 'OR_ELSE'].includes(e.op) && t === 'BOOL') {
        want(e.a, 'BOOL'); want(e.b, 'BOOL');
      } else if (e.e === 'un' && e.op === 'NOT' && t === 'BOOL') want(e.x, 'BOOL');
    };
    const resolvable = name =>
      ctx.vars.has(name) || globals.has(name) || pouAst.has(name) || typeNames.has(name) || enumVals.has(name) ||
      !!T.getFunc(name) || !!T.FBS[name] || consts.has(name) || name === 'TIME' || hasAction(ctx.pou, name) ||
      (ctx.method && name === ctx.method.name) || (ctx.pou.kind === 'FUNCTION' && name === ctx.pou.name);

    const note = (e, asLabel) => {
      if (e.addr) {
        // %IX0.0 → Variable mit dieser Adresse
        for (const [n, v] of ctx.vars) if (v.address && v.address.toUpperCase() === e.name) { e.name = n; e.display = v.display; e.addr = false; return; }
        if (addrMap.has(e.name)) { const n = addrMap.get(e.name); e.name = n; e.display = globalDisplay.get(n) || n; e.addr = false; return; }
        if (!missing.has(e.name)) {
          const m = /^%[IQM]([XBWDL]?)/.exec(e.name);
          missing.set(e.name, { display: e.display, type: ADDR_TYPE[m[1] || 'X'], fixed: true, node: e, file: ctx.file, addr: true });
        }
        return;
      }
      if (resolvable(e.name)) return;
      if (asLabel) { if (!consts.has(e.name)) consts.set(e.name, { display: e.display, node: e, file: ctx.file }); return; }
      // sehr ähnlich zu einer vorhandenen Variablen → wohl ein Tippfehler: nicht ergänzen, der Compiler meldet ihn
      if (!missing.has(e.name) && e.name.length >= 5 && this.suggest(e.name, [...ctx.vars.keys(), ...globals.keys()].filter(n => n.length >= 5))) return;
      if (!missing.has(e.name)) missing.set(e.name, { display: e.display, type: null, node: e, file: ctx.file });
    };

    // Instanz eines unbekannten Typs (→ Platzhalter-FB)
    const stubOf = e => {
      if (e.e !== 'id') return null;
      const v = ctx.vars.get(e.name) || (globals.has(e.name) ? { type: globals.get(e.name) } : null);
      const tn = v && specOf(v.type);
      if (!tn || !unknownTypes.has(tn)) return null;
      const u = unknownTypes.get(tn);
      u.usedAsFb = true;
      if (!stubs.has(tn)) stubs.set(tn, { display: u.display, fields: new Map(), node: u.node, file: u.file, called: false });
      return stubs.get(tn);
    };
    const stubField = (st, a, dir) => {
      if (!st.fields.has(a.name)) st.fields.set(a.name, { display: a.display, dir, type: null });
      const f = st.fields.get(a.name);
      if (dir === 'in') f.dir = 'in';
      return f;
    };

    const expr = e => {
      if (!e) return;
      switch (e.e) {
        case 'id': note(e); break;
        case 'member': {
          // GVL.x bzw. Namensraum.x: Basis unbekannt, Element ist eine globale Variable
          if (e.obj.e === 'id' && !e.obj.addr && !resolvable(e.obj.name) && !stubOf(e.obj)) {
            const ns = e.obj;
            Object.assign(e, { e: 'id', obj: undefined, ns: ns.display });
            note(e);
            break;
          }
          const st = stubOf(e.obj);
          if (st) stubField(st, e, 'out');
          expr(e.obj);
          break;
        }
        case 'index': expr(e.obj); e.idx.forEach(expr); break;
        case 'bit': expr(e.obj); break;
        case 'un': expr(e.x); break;
        case 'bin':
          expr(e.a); expr(e.b);
          if (!['AND', 'OR', 'XOR', 'AND_THEN', 'OR_ELSE'].includes(e.op)) { want(e.a, guess(e.b)); want(e.b, guess(e.a)); }
          else { const t = pick(guess(e.a), guess(e.b)); if (t) { want(e.a, t); want(e.b, t); } }
          break;
        case 'call': call(e); break;
      }
    };
    const call = e => {
      const fn = e.fn;
      if (fn.e === 'member') {
        expr(fn.obj);
        e.args.forEach(a => expr(a.value));
        return;
      }
      if (fn.e !== 'id') { e.args.forEach(a => expr(a.value)); return; }
      const st = stubOf(fn);
      if (st) {
        st.called = true;
        for (const a of e.args) {
          expr(a.value);
          if (!a.name) continue;
          const f = stubField(st, a, a.out ? 'out' : 'in');
          const t = guess(a.value);
          if (t && (!f.type || (WEAK.has(f.type) && !WEAK.has(t)))) f.type = t;
          if (a.out && f.type) want(a.value, f.type);
        }
        return;
      }
      // bekannte Parameter → Typen an die Argumente weitergeben
      let params = null;
      const v = ctx.vars.get(fn.name) || (globals.has(fn.name) ? { type: globals.get(fn.name) } : null);
      const tn = v ? specOf(v.type) : fn.name;
      if (T.FBS[tn]) params = new Map(T.FBS[tn].vars.map(x => [x[0], x[2]]));
      else if (pouAst.has(tn)) params = new Map([...varsOf(pouAst.get(tn)).values()].map(x => [x.name, specOf(x.type)]));
      for (const a of e.args) {
        expr(a.value);
        if (a.name && params && params.has(a.name)) want(a.value, params.get(a.name));
      }
    };
    const block = list => {
      for (const s of list) {
        switch (s.s) {
          case 'assign':
            if (s.target.e === 'member') { const st = stubOf(s.target.obj); if (st) stubField(st, s.target, 'in'); }
            expr(s.target); expr(s.value); want(s.target, guess(s.value)); want(s.value, guess(s.target)); break;
          case 'setreset': expr(s.target); expr(s.value); want(s.target, 'BOOL'); want(s.value, 'BOOL'); break;
          case 'call': call(s.call); break;
          case 'if': s.branches.forEach(b => { expr(b.cond); want(b.cond, 'BOOL'); block(b.body); }); if (s.elseBody) block(s.elseBody); break;
          case 'case':
            expr(s.expr); want(s.expr, 'INT');
            for (const c of s.cases) {
              for (const l of c.labels) for (const x of [l.lo, l.hi]) if (x && x.e === 'id' && !x.addr) note(x, true);
              block(c.body);
            }
            if (s.elseBody) block(s.elseBody);
            break;
          case 'for': expr(s.v); want(s.v, 'INT'); expr(s.from); expr(s.to); if (s.by) expr(s.by); block(s.body); break;
          case 'while': case 'repeat': expr(s.cond); want(s.cond, 'BOOL'); block(s.body); break;
        }
      }
    };
    // mehrere Durchläufe, damit Typen sich über Zuweisungen fortpflanzen
    for (let pass = 0; pass < 3; pass++) for (const b of bodies) { ctx = b; block(b.body); }

    // Werte unbekannter Aufzählungen, die zugewiesen/verglichen werden (eState := IDLE)
    for (const [n, m] of [...missing]) {
      if (m.addr) continue;
      if (consts.has(n)) { missing.delete(n); continue; }
      if (m.type && unknownTypes.has(m.type) && !stubs.has(m.type)) { consts.set(n, { display: m.display, node: m.node, file: m.file }); missing.delete(n); }
    }

    if (!missing.size && !stubs.size && !unknownTypes.size && !consts.size) return;

    // ---------- Ergänzen ----------
    const ast = { globals: [], types: [], pous: [] };
    const gsec = { kind: 'VAR_GLOBAL', constant: false, vars: [], line: 0 };
    for (const [n, m] of missing) {
      const t = m.type || 'BOOL';
      gsec.vars.push({ name: n, display: m.display, type: named(t), init: null, address: m.addr ? n : null, line: 0, col: 0 });
      this.warn(m.addr
        ? `Adresse ${m.display} hat keine deklarierte Variable – als globale ${t}-Variable angelegt`
        : `'${m.display}' ist nicht deklariert – als globale Variable '${m.display} : ${t}' angenommen (fehlt eine GVL?)`, m.node, m.file);
    }
    if (gsec.vars.length) ast.globals.push(gsec);
    if (consts.size) {
      const csec = { kind: 'VAR_GLOBAL', constant: true, vars: [], line: 0 };
      let k = 0;
      for (const [n, c] of consts) {
        csec.vars.push({ name: n, display: c.display, type: named('INT'), init: { e: 'lit', v: k, t: 'ANY_INT' }, line: 0, col: 0 });
        this.warn(`'${c.display}' ist nicht deklariert – als Konstante ${c.display} = ${k} angenommen (fehlende Aufzählung?)`, c.node, c.file);
        k++;
      }
      ast.globals.push(csec);
    }
    for (const [n, u] of unknownTypes) {
      if (stubs.has(n)) continue;
      ast.types.push({ name: n, display: u.display, spec: named('INT'), init: null, line: 0 });
      this.warn(`Datentyp '${u.display}' ist unbekannt – als INT angenommen`, u.node, u.file);
    }
    for (const [n, st] of stubs) {
      const ins = { kind: 'VAR_INPUT', vars: [], line: 0 }, outs = { kind: 'VAR_OUTPUT', vars: [], line: 0 };
      for (const [fn, f] of st.fields) {
        // ohne Aufruf: alles als Eingang, damit es von außen lesbar und beschreibbar ist
        (f.dir === 'in' || !st.called ? ins : outs).vars.push({ name: fn, display: f.display, type: named(f.type || 'BOOL'), init: null, line: 0, col: 0 });
      }
      ast.pous.push({ kind: 'FUNCTION_BLOCK', name: n, display: st.display, line: 0, sections: [ins, outs], body: [], methods: [], actions: [], extends: null, stub: true });
      const list = [...st.fields.values()].map(f => f.display).join(', ');
      this.warn(`Baustein '${st.display}' ist unbekannt (Bibliothek?) – als leerer Platzhalter angelegt${list ? ` mit ${list}` : ''}. Seine Ausgänge lassen sich in der Simulation von Hand setzen.`, st.node, st.file);
    }
    this.files.unshift({ file: AUTO, ast, role: 'main', auto: true });
  };
})(globalThis.ST);
