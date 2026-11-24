// Erzeugt aus beliebigem ST-Code Ablaufpläne:
//  1. Schrittketten über eine Ganzzahl-/Aufzählungsvariable – egal ob als CASE iStep OF …,
//     als IF/ELSIF-Kette (IF iStep = 10 THEN …) oder als lose IFs (IF iStep = 10 AND x THEN iStep := 20 …),
//     mit festen Zielen (iStep := 20) oder relativen (iStep := iStep + 10)
//  2. Schrittketten aus BOOL-Schrittmerkern (IF S1 AND x THEN S1 := FALSE; S2 := TRUE; END_IF)
//  3. für jeden Baustein ein Programmablaufplan (PAP) des Codes, der live zeigt, welche Zweige laufen
// Bausteine (FUNCTION_BLOCK) werden pro Instanz dargestellt.
(function (ST) {
  'use strict';
  const T = ST.T;

  // ---------- Ausdrücke als Text ----------
  const PREC = { OR: 1, OR_ELSE: 1, XOR: 2, AND: 3, AND_THEN: 3, '=': 4, '<>': 4, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, MOD: 7, '**': 8 };
  function exprText(e, wrap) {
    wrap = wrap || ((n, s) => s);
    const p = (x, min) => {
      const s = exprText(x, wrap);
      const xp = x.e === 'bin' ? PREC[x.op] : x.e === 'un' ? 9 : 10;
      // AND innerhalb von OR zur Lesbarkeit klammern
      const clarify = min <= 2 && x.e === 'bin' && (x.op === 'AND' || x.op === 'AND_THEN');
      return xp < min || clarify ? '(' + s + ')' : s;
    };
    switch (e.e) {
      case 'lit':
        if (typeof e.v === 'boolean') return e.v ? 'TRUE' : 'FALSE';
        if (e.t === 'TIME') return T.formatTime(e.v);
        if (typeof e.v === 'string') return "'" + e.v + "'";
        if (e.t && !['ANY_INT', 'ANY_REAL'].includes(e.t)) return e.t + '#' + e.v;
        return String(e.v);
      case 'enumval': return (e.typeDisplay || e.type) + '#' + e.display;
      case 'id': return wrap(e, e.display);
      case 'this': return 'THIS^';
      case 'super': return 'SUPER^';
      case 'member': return wrap(e, exprText(e.obj, () => exprText(e.obj)) + '.' + e.display);
      case 'index': return wrap(e, exprText(e.obj) + '[' + e.idx.map(i => exprText(i)).join(', ') + ']');
      case 'bit': return wrap(e, exprText(e.obj) + '.' + e.bit);
      case 'call': return exprText(e.fn) + '(' + e.args.map(a => (a.name ? a.display + (a.out ? ' => ' : ' := ') : '') + exprText(a.value, wrap)).join(', ') + ')';
      case 'un': return e.op === 'NOT' ? 'NOT ' + p(e.x, 9) : '-' + p(e.x, 9);
      case 'bin': {
        const pr = PREC[e.op];
        return p(e.a, pr) + ' ' + e.op + ' ' + p(e.b, pr + 1);
      }
    }
    return '?';
  }

  function stmtText(s) {
    switch (s.s) {
      case 'assign': return exprText(s.target) + ' := ' + exprText(s.value);
      case 'setreset': return exprText(s.target) + (s.set ? ' S= ' : ' R= ') + exprText(s.value);
      case 'call': return exprText(s.call);
      case 'if': return 'IF ' + exprText(s.branches[0].cond) + ' THEN ' + s.branches[0].body.map(stmtText).join('; ') + (s.elseBody ? ' ELSE ' + s.elseBody.map(stmtText).join('; ') : '');
      case 'case': return 'CASE ' + exprText(s.expr) + ' OF …';
      case 'for': return 'FOR ' + exprText(s.v) + ' := ' + exprText(s.from) + ' TO ' + exprText(s.to) + (s.by ? ' BY ' + exprText(s.by) : '');
      case 'while': return 'WHILE ' + exprText(s.cond);
      case 'repeat': return 'REPEAT … UNTIL ' + exprText(s.cond);
      case 'exit': return 'EXIT';
      case 'continue': return 'CONTINUE';
      case 'return': return 'RETURN';
    }
    return s.s.toUpperCase() + ' …';
  }

  // ---------- AST-Hilfen ----------
  function walkStmts(list, fn) {
    for (const s of list) {
      fn(s);
      switch (s.s) {
        case 'if': s.branches.forEach(b => walkStmts(b.body, fn)); if (s.elseBody) walkStmts(s.elseBody, fn); break;
        case 'case': s.cases.forEach(c => walkStmts(c.body, fn)); if (s.elseBody) walkStmts(s.elseBody, fn); break;
        case 'for': case 'while': case 'repeat': walkStmts(s.body, fn); break;
      }
    }
  }
  function walkExpr(e, fn) {
    if (!e) return;
    fn(e);
    switch (e.e) {
      case 'member': case 'bit': walkExpr(e.obj, fn); break;
      case 'index': walkExpr(e.obj, fn); e.idx.forEach(i => walkExpr(i, fn)); break;
      case 'call': e.args.forEach(a => walkExpr(a.value, fn)); break;
      case 'un': walkExpr(e.x, fn); break;
      case 'bin': walkExpr(e.a, fn); walkExpr(e.b, fn); break;
    }
  }
  // wie walkExpr, aber ohne negierte Teilausdrücke (Verriegelungen wie AND NOT x)
  function walkPositive(e, fn) {
    if (!e) return;
    fn(e);
    if (e.e === 'un' && e.op === 'NOT') return;
    if (e.e === 'bin') { walkPositive(e.a, fn); walkPositive(e.b, fn); }
    if (e.e === 'member') walkPositive(e.obj, fn);
  }
  const isVar = (e, name) => e && e.e === 'id' && e.name === name;
  // Schlüssel einer Variablen-Referenz: iStep, stDaten.iStep, THIS^.iStep
  const refKey = e => {
    if (!e) return null;
    if (e.e === 'id') return e.name;
    if (e.e === 'member') { if (e.obj.e === 'this') return e.name; const b = refKey(e.obj); return b ? b + '.' + e.name : null; }
    return null;
  };
  const conj = e => (e.e === 'bin' && (e.op === 'AND' || e.op === 'AND_THEN') ? conj(e.a).concat(conj(e.b)) : [e]);
  const andOf = list => list.reduce((a, b) => (a ? { e: 'bin', op: 'AND', a, b, line: b.line, col: b.col } : b), null);
  const simpleStmt = s => s.s === 'assign' || s.s === 'call' || s.s === 'setreset';

  // ---------- Umgebung: Instanzen, Pfade, Auswertung ----------
  function quiet(comp, fn, report) {
    const saved = comp.diags; comp.diags = [];
    try { return fn(); } catch (e) { if (globalThis.ST_DEBUG) globalThis.ST_DEBUG(e); return null; } finally { comp.diags = saved; }
  }

  // alle Instanzpfade je Baustein: Programme direkt, FBs über Programme/globale Variablen
  function instances(plc) {
    const comp = plc.compiler;
    const out = new Map();
    const add = (pou, path) => { if (!out.has(pou.name)) out.set(pou.name, []); out.get(pou.name).push(path); };
    const visit = (type, path, depth) => {
      if (depth > 6) return;
      if (type.k === 'array') {
        const d = type.dims[0];
        if (type.dims.length === 1 && d.hi - d.lo < 16) for (let i = d.lo; i <= d.hi; i++) visit(type.elem, `${path}[${i}]`, depth + 1);
        return;
      }
      if (type.k !== 'fb' || type.pou.builtin) return;
      add(type.pou, path);
      for (const v of type.pou.vars.values()) if (v.section !== 'VAR_TEMP') visit(v.type, path + '.' + v.display, depth + 1);
    };
    for (const p of comp.pous.values()) {
      if (p.kind !== 'PROGRAM' || p.role === 'model') continue;
      add(p, p.display);
      for (const v of p.vars.values()) if (v.section !== 'VAR_TEMP') visit(v.type, p.display + '.' + v.display, 1);
    }
    for (const g of comp.globals.values()) visit(g.type, g.display, 1);
    return out;
  }

  function env(plc, pou, inst) {
    const comp = plc.compiler;
    const scope = { pou, file: pou.file, kind: 'pou' };
    const isProg = pou.kind === 'PROGRAM';
    let instRef = null;
    const self = () => {
      if (isProg) return plc.P[pou.name];
      if (!instRef) instRef = plc.resolve(inst);
      return instRef.get(plc.ctx());
    };
    // Pfad einer Variablen im Ausdruck (für anklickbare Variablen)
    const pathOf = e => {
      if (e.e === 'id') {
        const lk = comp.lookup(e.name, scope);
        if (!lk) return null;
        if (lk.where === 'local') return inst + '.' + (lk.info.display || e.display);
        if (lk.where === 'global') return lk.info.display;
        return null;
      }
      if (e.e === 'member') {
        if (e.obj.e === 'this') return inst + '.' + e.display;
        const b = e.obj.e === 'id' && comp.pous.has(e.obj.name) && comp.pous.get(e.obj.name).kind === 'PROGRAM' ? comp.pous.get(e.obj.name).display : pathOf(e.obj);
        return b ? b + '.' + e.display : null;
      }
      if (e.e === 'index' && e.idx.length === 1 && e.idx[0].e === 'lit') { const b = pathOf(e.obj); return b ? `${b}[${e.idx[0].v}]` : null; }
      return null;
    };
    const ctx = () => ({ self: self(), G: plc.G, P: plc.P, rt: plc.rt });
    const compile = e => quiet(comp, () => comp.compileExpr(e, scope));
    const constOf = e => {
      if (!e) return null;
      const x = compile(e);
      return x && x.constVal !== undefined && T.isInt(x.t) ? x.constVal : null;
    };
    return { comp, scope, pathOf, ctx, compile, constOf, inst };
  }

  // Bedingungen live auswertbar machen und als Text ablegen
  function finishConds(E, t) {
    const fns = [];
    for (const c of t.conds) {
      if (c.fn) { fns.push(c.fn); continue; }
      if (!c.e) { fns.push(null); continue; }
      const x = E.compile(c.e);
      fns.push(x && T.isBool(x.t) ? (neg => ctx => (neg ? !x.f(ctx) : !!x.f(ctx)))(c.neg) : null);
    }
    t.eval = fns.every(f => f) ? ctx => fns.every(f => f(ctx)) : null;
    t.condsText = t.conds.map(c => condText(c));
  }
  // eine Teilbedingung als Text; ODER-Ausdrücke geklammert, weil die Teile mit AND verbunden werden
  function condText(c, wrap) {
    if (c.text) return c.text;
    const s = exprText(c.e, wrap);
    const simple = c.e.e === 'id' || c.e.e === 'member' || c.e.e === 'lit' || c.e.e === 'call' || c.e.e === 'index';
    if (c.neg) return simple ? 'NOT ' + s : 'NOT (' + s + ')';
    return c.e.e === 'bin' && ['OR', 'OR_ELSE', 'XOR'].includes(c.e.op) ? '(' + s + ')' : s;
  }

  // Aktionsvariablen → globale Ausgänge (z.B. SAEGE_ANTRIEB := … SFC_Saege.xK1 …)
  function outputsMap(comp, pou, actionVars) {
    const outputsOf = new Map();
    if (!actionVars.size) return outputsOf;
    for (const p of comp.pous.values()) {
      if (p.builtin || !p.ast) continue;
      walkStmts(p.ast.body, s => {
        if (s.s !== 'assign' || s.target.e !== 'id' || !comp.globals.has(s.target.name)) return;
        walkPositive(s.value, e => {
          let hit = null;
          if (p === pou && e.e === 'id' && actionVars.has(e.name)) hit = e.name;
          if (e.e === 'member' && e.obj.e === 'id' && e.obj.name === pou.name && actionVars.has(e.name)) hit = e.name;
          if (hit) {
            const list = outputsOf.get(hit) || [];
            const g = comp.globals.get(s.target.name);
            if (!list.some(x => x.name === g.name)) list.push({ name: g.name, display: g.display, path: g.display });
            outputsOf.set(hit, list);
          }
        });
      });
    }
    return outputsOf;
  }

  // Flankenmerker wie xNeu := (iStep <> iStepOld) erkennen → „beim Eintritt“
  function isEntryFlag(pou, cond, V) {
    if (!cond || cond.e !== 'id') return false;
    let hit = false;
    walkStmts(pou.ast.body, a => {
      if (a.s === 'assign' && isVar(a.target, cond.name)) walkExpr(a.value, x => { if (x.e === 'bin' && x.op === '<>' && (refKey(x.a) === V || refKey(x.b) === V)) hit = true; });
    });
    return hit;
  }

  // ======================================================================
  // 1. Schrittketten über eine Ganzzahl-/Aufzählungsvariable
  // ======================================================================
  // Code des Bausteins samt seiner Aktionen und Methoden. Werden sie im Rumpf ohne Bedingung aufgerufen
  // (z.B. Ablauf();), zählen sie wie eigener Code, sonst nur „bei Aufruf“.
  function sources(pou) {
    const out = [{ body: pou.ast.body, conds: [] }];
    const plain = new Set();
    for (const st of pou.ast.body) {
      if (st.s !== 'call' || st.call.args.length) continue;
      const fn = st.call.fn;
      if (fn.e === 'id') plain.add(fn.name);
      else if (fn.e === 'member' && fn.obj.e === 'this') plain.add(fn.name);
    }
    const procs = [...pou.actions.values(), ...pou.methods.values()].filter(a => a.owner === pou);
    for (const a of procs) out.push({ body: a.ast.body, conds: plain.has(a.name) ? [] : [{ text: `bei Aufruf von ${a.display}` }] });
    return out;
  }
  const allStmts = pou => [].concat(...sources(pou).map(x => x.body));

  function intChain(plc, pou, V, vnode, info, E) {
    const body = allStmts(pou);
    const isVarV = e => refKey(e) === V;
    const type = info.type;
    const isEnum = type.k === 'enum';
    // Schrittnamen: Aufzählungswert bzw. Name der Konstanten in der CASE-Marke (S_FUELLEN := 10)
    const constName = new Map();
    const label = n => (isEnum && type.names.has(n) ? type.names.get(n) : constName.has(n) ? constName.get(n) : String(n));

    const stepEq = e => {
      if (e.e !== 'bin' || e.op !== '=') return null;
      if (isVarV(e.a)) return E.constOf(e.b);
      if (isVarV(e.b)) return E.constOf(e.a);
      return null;
    };
    // „iStep = 3“ bzw. „iStep = 3 OR iStep = 4“ → [3, 4]
    const stepSet = e => {
      const k = stepEq(e);
      if (k !== null) return [k];
      if (e.e === 'bin' && (e.op === 'OR' || e.op === 'OR_ELSE')) {
        const a = stepSet(e.a), b = stepSet(e.b);
        return a && b ? [...new Set(a.concat(b))] : null;
      }
      return null;
    };
    const inter = (a, b) => (a === null ? b : a.filter(x => b.includes(x)));
    const labelsOf = c => {
      const out = [];
      for (const l of c.labels) {
        const lo = E.constOf(l.lo);
        if (lo === null) continue;
        if (!l.hi) { if (l.lo.e === 'id' && !constName.has(lo)) constName.set(lo, l.lo.display); out.push(lo); continue; }
        const hi = E.constOf(l.hi);
        if (hi !== null && hi - lo <= 64) for (let k = lo; k <= hi; k++) out.push(k);
      }
      return out;
    };
    const targetOf = (val, from, known) => {
      const k = E.constOf(val);
      if (k !== null) return () => k;
      // iNext := 100; iStep := iNext;  → 100
      const rk = refKey(val);
      if (rk && known && known.has(rk)) { const v = known.get(rk); return () => v; }
      if (val.e === 'bin' && (val.op === '+' || val.op === '-') && isVarV(val.a)) {
        const d = E.constOf(val.b);
        if (d !== null && from !== null) return f => (val.op === '+' ? f + d : f - d);
      }
      return null;
    };

    const steps = new Map();
    const step = n => { if (!steps.has(n)) steps.set(n, { n, label: label(n), ops: [], line: null }); return steps.get(n); };
    const transitions = [], globalTrans = [];
    let fromCount = 0, caseLines = [];

    const addOp = (from, op) => { for (const k of from) step(k).ops.push(op); };

    function walk(list, ctx) {
      const direct = list.filter(s => s.s === 'assign' && isVarV(s.target));
      const does = direct.length ? list.filter(s => simpleStmt(s) && !(s.s === 'assign' && isVarV(s.target))).map(stmtText) : [];
      const known = new Map();
      for (const s of list) {
        if (s.s === 'assign' && !isVarV(s.target) && refKey(s.target)) {
          const k = E.constOf(s.value);
          if (k !== null) known.set(refKey(s.target), k); else known.delete(refKey(s.target));
        }
        if (s.s === 'assign' && isVarV(s.target)) {
          // Ziel nicht bestimmbar (berechnet) → Sprung ins Ungewisse, als Text angezeigt
          const tf = targetOf(s.value, ctx.from, known) || (() => null);
          const toText = exprText(s.value);
          if (ctx.from === null) {
            const to = tf(null);
            globalTrans.push({ from: '*', to, toText, conds: ctx.conds.slice(), line: s.line, does });
            if (to !== null) step(to);
          } else {
            for (const f of ctx.from) {
              transitions.push({ from: f, to: tf(f), toText, conds: ctx.conds.slice(), line: s.line, does });
              fromCount++;
            }
          }
        } else if (simpleStmt(s)) {
          if (ctx.from === null || direct.length) continue;
          // Anweisung innerhalb eines Schritts → Aktion
          const extra = ctx.conds;
          const lamp = s.s !== 'call' ? E.pathOf(s.target) : null;
          let q = 'N', lbl = 'im Schritt';
          if (extra.length) {
            const entry = !extra[0].neg && extra[0].e && isEntryFlag(pou, extra[0].e, V);
            const rest = entry ? extra.slice(1) : extra;
            q = entry ? 'E' : 'C';
            lbl = (entry ? 'beim Eintritt' + (rest.length ? ', ' : '') : '') + (rest.length ? 'wenn ' + rest.map(c => condText(c)).join(' AND ') : '');
          }
          addOp(ctx.from, { q, label: lbl, text: stmtText(s), lamp, line: s.line });
        } else if (s.s === 'if') {
          const prevs = [];
          const branch = (bodyList, b) => {
            let from = ctx.from, rest = [], kset = null;
            if (b) {
              for (const x of conj(b.cond)) {
                const ks = stepSet(x);
                if (ks) { kset = inter(kset, ks); } else rest.push(x);
              }
              if (kset) from = inter(from, kset);
            }
            const negs = [];
            for (const p of prevs) {
              if (p.kset && from !== null) {
                const overlap = from.filter(k => p.kset.includes(k));
                if (!overlap.length) continue;           // anderer Schritt → ohnehin falsch
                if (!p.rest.length) { from = from.filter(k => !p.kset.includes(k)); continue; } // voriger Zweig fängt alles ab
                negs.push({ e: andOf(p.rest), neg: true });
              } else negs.push({ e: p.cond, neg: true });
            }
            const conds = ctx.conds.concat(negs, rest.map(e => ({ e, neg: false })));
            if (from === null || from.length) walk(bodyList, { from, conds });
            if (b) prevs.push({ kset, rest, cond: b.cond });
          };
          s.branches.forEach(b => branch(b.body, b));
          if (s.elseBody) branch(s.elseBody, null);
        } else if (s.s === 'case') {
          if (isVarV(s.expr)) {
            caseLines.push(s.line);
            const all = [];
            for (const c of s.cases) {
              const ks = labelsOf(c);
              all.push(...ks);
              ks.forEach(k => { if (step(k).line === null) step(k).line = c.line; });
              const from = inter(ctx.from, ks);
              if (from.length) walk(c.body, { from, conds: ctx.conds });
            }
            if (s.elseBody && ctx.from === null) {
              const known = new Set(all);
              const ref = E.compile(s.expr);
              walk(s.elseBody, { from: null, conds: ctx.conds.concat([{ text: `${info.display} kein definierter Schritt`, fn: ref ? c => !known.has(ref.f(c)) : null }]) });
            }
          } else {
            for (const c of s.cases) {
              const eqs = c.labels.filter(l => !l.hi).map(l => ({ e: 'bin', op: '=', a: s.expr, b: l.lo, line: l.lo.line, col: l.lo.col }));
              const cond = eqs.length === c.labels.length && eqs.length ? { e: eqs.reduce((a, b) => (a ? { e: 'bin', op: 'OR', a, b } : b), null), neg: false } : { text: 'CASE ' + exprText(s.expr) + ' = ' + c.labels.map(l => exprText(l.lo) + (l.hi ? '..' + exprText(l.hi) : '')).join(', ') };
              walk(c.body, Object.assign({}, ctx, { conds: ctx.conds.concat([cond]) }));
            }
            if (s.elseBody) walk(s.elseBody, Object.assign({}, ctx, { conds: ctx.conds.concat([{ text: 'CASE ' + exprText(s.expr) + ' sonst' }]) }));
          }
        } else if (s.s === 'for' || s.s === 'while' || s.s === 'repeat') {
          walk(s.body, ctx);
        }
      }
    }
    for (const src of sources(pou)) walk(src.body, { from: null, conds: src.conds });
    // eine echte Schrittkette braucht mindestens zwei Weiterschaltungen aus bestimmten Schritten
    // (oder ein CASE über die Variable mit Übergängen, z.B. Betriebsarten-Umschaltung)
    if (fromCount < 2 && !(caseLines.length && fromCount + globalTrans.length >= 2)) return null;

    const initial = typeof info.init === 'number' ? info.init : isEnum ? (type.first !== undefined ? type.first : 0) : 0;
    step(initial);
    for (const t of transitions) { step(t.from); if (t.to !== null) step(t.to); }

    // Aktionen: X := … (V = k) …  → X ist im Schritt k aktiv
    const actionVars = new Set();
    walkStmts(body, s => {
      if (s.s !== 'assign' || isVarV(s.target) || s.target.e !== 'id') return;
      const ks = new Set();
      walkExpr(s.value, e => { const k = stepEq(e); if (k !== null) ks.add(k); });
      if (!ks.size) return;
      actionVars.add(s.target.name);
      for (const k of ks) step(k).ops.unshift({ q: 'N', name: s.target.name, display: s.target.display, lamp: E.pathOf(s.target), action: true, line: s.line });
    });
    const outs = outputsMap(E.comp, pou, actionVars);
    for (const st of steps.values()) for (const a of st.ops) if (a.action) a.outputs = outs.get(a.name) || [];

    for (const st of steps.values()) st.label = label(st.n);
    transitions.forEach(t => finishConds(E, t));
    globalTrans.forEach(t => finishConds(E, t));
    const path = E.pathOf(vnode);
    let ref = null;
    const readV = () => { if (!ref) ref = plc.resolve(path); return ref.get(plc.ctx()); };
    return {
      kind: 'chain', varName: exprText(vnode).replace(/^THIS\^\./, ''), path, initial, line: caseLines[0] || info.line,
      steps: [...steps.values()].sort((a, b) => a.n - b.n),
      transitions, globalTrans,
      active: () => { const v = readV(); return [v]; },
      setStep: n => plc.write(path, n),
    };
  }

  // ======================================================================
  // 2. Schrittketten aus BOOL-Schrittmerkern
  // ======================================================================
  function flagChains(plc, pou, E) {
    const comp = E.comp;
    const body = allStmts(pou);
    const isBoolVar = e => {
      if (!e || e.e !== 'id') return false;
      const lk = comp.lookup(e.name, E.scope);
      return lk && (lk.where === 'local' || lk.where === 'global') && T.isBool(lk.info.type) && !lk.info.constant;
    };
    const trans = [];
    // IF … A … THEN A := FALSE; B := TRUE; END_IF   (A als positiver Teil der Bedingung)
    function walk(list, conds) {
      const resets = list.filter(s => (s.s === 'assign' && s.value.e === 'lit' && s.value.v === false && isBoolVar(s.target)) || (s.s === 'setreset' && !s.set && s.value.e === 'lit' && s.value.v === true && isBoolVar(s.target)));
      const sets = list.filter(s => (s.s === 'assign' && s.value.e === 'lit' && s.value.v === true && isBoolVar(s.target)) || (s.s === 'setreset' && s.set && s.value.e === 'lit' && s.value.v === true && isBoolVar(s.target)));
      if (resets.length && sets.length) {
        const pos = conds.filter(c => !c.neg).flatMap(c => conj(c.e)).filter(x => x.e === 'id');
        const srcs = resets.map(s => s.target.name).filter(n => pos.some(p => p.name === n));
        if (srcs.length) {
          const tgts = sets.map(s => s.target.name).filter(n => !srcs.includes(n));
          if (tgts.length) {
            const others = list.filter(s => simpleStmt(s) && !resets.includes(s) && !sets.includes(s)).map(stmtText);
            const c2 = [];
            for (const c of conds) {
              if (c.neg) { c2.push(c); continue; }
              const rest = conj(c.e).filter(x => !(x.e === 'id' && srcs.includes(x.name)));
              if (rest.length) c2.push({ e: andOf(rest), neg: false });
            }
            trans.push({ srcs, tgts, conds: c2, line: list[0].line, does: others });
          }
        }
      }
      for (const s of list) {
        if (s.s === 'if') {
          const prev = [];
          for (const b of s.branches) { walk(b.body, conds.concat(prev, [{ e: b.cond, neg: false }])); prev.push({ e: b.cond, neg: true }); }
          if (s.elseBody) walk(s.elseBody, conds.concat(prev));
        } else if (s.s === 'case') {
          s.cases.forEach(c => walk(c.body, conds.concat([{ text: 'CASE ' + exprText(s.expr) + ' = ' + c.labels.map(l => exprText(l.lo)).join(', ') }])));
        }
      }
    }
    for (const src of sources(pou)) walk(src.body, src.conds.slice());
    if (trans.length < 2) return [];
    // zusammenhängende Gruppen bilden
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    const unite = (a, b) => { parent.set(find(a), find(b)); };
    for (const t of trans) for (const n of t.srcs.concat(t.tgts)) if (!parent.has(n)) parent.set(n, n);
    for (const t of trans) { const all = t.srcs.concat(t.tgts); for (const n of all) unite(all[0], n); }
    const groups = new Map();
    for (const t of trans) { const r = find(t.srcs[0]); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
    const charts = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const names = [];
      for (const t of list) for (const n of t.srcs.concat(t.tgts)) if (!names.includes(n)) names.push(n);
      const info = n => comp.lookup(n, E.scope).info;
      // Reihenfolge: Deklarationsreihenfolge, Initialschritt zuerst
      const declOrder = n => { const i = [...pou.vars.keys()].indexOf(n); return i < 0 ? 1000 + [...comp.globals.keys()].indexOf(n) : i; };
      names.sort((a, b) => declOrder(a) - declOrder(b));
      let initName = names.find(n => info(n).init === true);
      if (!initName) initName = names.find(n => !list.some(t => t.tgts.includes(n))) || names[0];
      const idx = new Map(names.map((n, i) => [n, i]));
      const steps = names.map((n, i) => ({ n: i, label: info(n).display, name: n, ops: [], line: info(n).line, path: E.pathOf({ e: 'id', name: n, display: info(n).display }) }));
      const transitions = [];
      for (const t of list) for (const a of t.srcs) for (const b of t.tgts) transitions.push({ from: idx.get(a), to: idx.get(b), conds: t.conds, line: t.line, does: t.does });
      // globale Übergänge: X := TRUE außerhalb der Weiterschaltungen (z.B. Initialisierung)
      const globalTrans = [];
      const inTrans = new Set(list.map(t => t.line));
      (function g(lst, conds) {
        for (const s of lst) {
          if (s.s === 'assign' && isBoolVar(s.target) && idx.has(s.target.name) && s.value.e === 'lit' && s.value.v === true && conds.length && !inTrans.has(lst[0].line)) {
            globalTrans.push({ from: '*', to: idx.get(s.target.name), conds: conds.slice(), line: s.line, does: [] });
          } else if (s.s === 'if') {
            const prev = [];
            for (const b of s.branches) { g(b.body, conds.concat(prev, [{ e: b.cond, neg: false }])); prev.push({ e: b.cond, neg: true }); }
            if (s.elseBody) g(s.elseBody, conds.concat(prev));
          }
        }
      })(pou.ast.body, []);
      // Aktionen: Y := … S3 …  bzw.  IF S3 THEN … END_IF
      const actionVars = new Set();
      walkStmts(body, s => {
        if (s.s === 'assign' && s.target.e === 'id' && !idx.has(s.target.name)) {
          const hit = new Set();
          walkPositive(s.value, e => { if (e.e === 'id' && idx.has(e.name)) hit.add(e.name); });
          if (!hit.size) return;
          actionVars.add(s.target.name);
          for (const n of hit) steps[idx.get(n)].ops.push({ q: 'N', name: s.target.name, display: s.target.display, lamp: E.pathOf(s.target), action: true, line: s.line });
        } else if (s.s === 'if' && s.branches.length === 1 && !s.elseBody && s.branches[0].cond.e === 'id' && idx.has(s.branches[0].cond.name)) {
          const st = steps[idx.get(s.branches[0].cond.name)];
          for (const x of s.branches[0].body) if (simpleStmt(x) && !(x.s === 'assign' && x.target.e === 'id' && idx.has(x.target.name)))
            st.ops.push({ q: 'N', label: 'im Schritt', text: stmtText(x), lamp: x.s !== 'call' ? E.pathOf(x.target) : null, line: x.line });
        }
      });
      const outs = outputsMap(comp, pou, actionVars);
      for (const st of steps) for (const a of st.ops) if (a.action) a.outputs = outs.get(a.name) || [];
      transitions.forEach(t => finishConds(E, t));
      globalTrans.forEach(t => finishConds(E, t));
      const refs = steps.map(s => s.path);
      charts.push({
        kind: 'chain', flags: true, varName: names.map(n => info(n).display).join(', '), path: null,
        initial: idx.get(initName), line: list[0].line, steps, transitions, globalTrans,
        active: () => steps.filter((s, i) => { try { return !!plc.read(refs[i]); } catch (e) { return false; } }).map(s => s.n),
        setStep: n => { steps.forEach((s, i) => plc.write(refs[i], i === n)); },
      });
    }
    return charts;
  }

  // ======================================================================
  // 3. Programmablaufplan des Codes
  // ======================================================================
  function flowOf(list) {
    const items = [];
    let run = null;
    const flush = () => { if (run) { items.push(run); run = null; } };
    for (const s of list) {
      if (s.s === 'assign' || s.s === 'setreset') {
        if (!run || run.stmts.length >= 6) { flush(); run = { t: 'op', stmts: [] }; }
        run.stmts.push(s);
        continue;
      }
      flush();
      switch (s.s) {
        case 'call': items.push({ t: 'call', stmt: s }); break;
        case 'if': {
          // ELSIF als verschachteltes IF im NEIN-Zweig
          const build = i => {
            if (i >= s.branches.length) return s.elseBody ? flowOf(s.elseBody) : { t: 'seq', items: [] };
            return { t: 'seq', items: [{ t: 'if', stmt: s, bi: i, cond: s.branches[i].cond, yes: flowOf(s.branches[i].body), no: build(i + 1) }] };
          };
          items.push(...build(0).items);
          break;
        }
        case 'case':
          items.push({ t: 'case', stmt: s, branches: s.cases.map(c => ({ label: c.labels.map(l => exprText(l.lo) + (l.hi ? '..' + exprText(l.hi) : '')).join(', '), body: flowOf(c.body) })), other: s.elseBody ? flowOf(s.elseBody) : null });
          break;
        case 'for': case 'while': case 'repeat':
          items.push({ t: 'loop', stmt: s, body: flowOf(s.body) });
          break;
        case 'exit': case 'continue': case 'return':
          items.push({ t: 'jump', stmt: s });
          break;
      }
    }
    flush();
    return { t: 'seq', items };
  }

  // ======================================================================
  function extractCharts(plc) {
    const charts = [];
    if (!plc || !plc.ok) return charts;
    const comp = plc.compiler;
    const inst = instances(plc);
    const used = p => inst.has(p.name);
    const pous = [...comp.pous.values()].filter(p => !p.builtin && !p.stub && p.role !== 'model' && p.kind !== 'FUNCTION' && used(p));
    const chains = [], flows = [];
    for (const pou of pous) {
      const paths = inst.get(pou.name);
      // Kandidaten für die Schrittvariable: Ganzzahl-/Aufzählungsvariablen, die im Baustein beschrieben werden
      const cands = new Map();
      const scope = { pou, file: pou.file, kind: 'pou' };
      const loopVars = new Set();
      walkStmts(allStmts(pou), s => {
        if (s.s === 'for' && s.v.e === 'id') loopVars.add(s.v.name);
        if (s.s !== 'assign') return;
        const key = refKey(s.target);
        if (!key || cands.has(key)) return;
        if (s.target.e === 'id') {
          const lk = comp.lookup(s.target.name, scope);
          if (!lk || (lk.where !== 'local' && lk.where !== 'global')) return;
        }
        // auch Strukturelemente wie stDaten.iStep (Methodenvariablen fallen hier heraus)
        const ref = quiet(comp, () => comp.compileRef(s.target, scope));
        if (!ref || !ref.info || ref.special) return;
        const t = ref.t;
        if ((t.k === 'elem' && t.cat === 'int' && !t.lit) || t.k === 'enum') cands.set(key, { vnode: s.target, info: Object.assign({}, ref.info, { type: t }) });
      });
      for (const p of paths) {
        const E = env(plc, pou, p);
        for (const [V, c] of cands) {
          if (loopVars.has(V)) continue;
          const ch = quiet(comp, () => intChain(plc, pou, V, c.vnode, c.info, E), true);
          if (ch) chains.push(Object.assign(ch, { pou: pou.display, pouName: pou.name, file: pou.file, inst: p, pathOf: E.pathOf, ctx: E.ctx, title: `${p}.${ch.varName}` }));
        }
        for (const ch of quiet(comp, () => flagChains(plc, pou, E)) || []) chains.push(Object.assign(ch, { pou: pou.display, pouName: pou.name, file: pou.file, inst: p, pathOf: E.pathOf, ctx: E.ctx, title: `${p} (Schrittmerker)` }));
      }
      // PAP einmal je Baustein (Markierung gilt für alle Instanzen gemeinsam)
      const E = env(plc, pou, paths[0]);
      flows.push({ kind: 'flow', pou: pou.display, pouName: pou.name, file: pou.file, inst: paths[0], line: pou.line, title: `${pou.display}${pou.kind === 'FUNCTION_BLOCK' ? ' (FB)' : ''}`, flow: flowOf(pou.ast.body), pathOf: E.pathOf, ctx: E.ctx, compile: E.compile, isTask: plc.tasks.includes(pou.name) });
      for (const a of pou.actions.values()) if (a.owner === pou)
        flows.push({ kind: 'flow', pou: pou.display, pouName: pou.name, file: pou.file, inst: paths[0], line: a.line, title: `${pou.display}.${a.display} (Aktion)`, flow: flowOf(a.ast.body), pathOf: E.pathOf, ctx: E.ctx, compile: E.compile });
      for (const m of pou.methods.values()) if (m.owner === pou)
        flows.push({ kind: 'flow', pou: pou.display, pouName: pou.name, file: pou.file, inst: paths[0], line: m.line, title: `${pou.display}.${m.display} (Methode)`, flow: flowOf(m.ast.body), pathOf: E.pathOf, ctx: E.ctx, compile: E.compile });
    }
    // Tasks zuerst
    flows.sort((a, b) => (b.isTask ? 1 : 0) - (a.isTask ? 1 : 0));
    charts.push(...chains, ...flows);
    charts.forEach((c, i) => { c.id = i; });
    return charts;
  }

  ST.extractCharts = extractCharts;
  ST.exprText = exprText;
  ST.stmtText = stmtText;
  ST.condText = condText;
})(globalThis.ST);
