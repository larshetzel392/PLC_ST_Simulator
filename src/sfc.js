// Erkennt Schrittketten im ST-Code (CASE <Schrittvariable> OF … <Schrittvariable> := n)
// und liefert daraus einen Ablaufplan: Schritte, Transitionen, Aktionen.
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
      case 'enumval': return e.type + '#' + e.display;
      case 'id': return wrap(e, e.display);
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
      case 'call': return exprText(s.call);
      case 'if': return 'IF ' + exprText(s.branches[0].cond) + ' THEN ' + s.branches[0].body.map(stmtText).join('; ') + (s.elseBody ? ' ELSE ' + s.elseBody.map(stmtText).join('; ') : '');
    }
    return s.s.toUpperCase() + ' …';
  }

  // ---------- AST-Hilfen ----------
  function walkStmts(list, fn, ctx) {
    for (const s of list) {
      fn(s, ctx);
      switch (s.s) {
        case 'if': s.branches.forEach(b => walkStmts(b.body, fn, ctx)); if (s.elseBody) walkStmts(s.elseBody, fn, ctx); break;
        case 'case': s.cases.forEach(c => walkStmts(c.body, fn, ctx)); if (s.elseBody) walkStmts(s.elseBody, fn, ctx); break;
        case 'for': case 'while': case 'repeat': walkStmts(s.body, fn, ctx); break;
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
  const intLit = e => (e && e.e === 'lit' && typeof e.v === 'number' && Number.isInteger(e.v) ? e.v : null);
  function assignsTo(list, name) {
    let found = false;
    walkStmts(list, s => { if (s.s === 'assign' && isVar(s.target, name)) found = true; });
    return found;
  }

  // ---------- Erkennung ----------
  function extractCharts(plc) {
    const charts = [];
    if (!plc || !plc.ok) return charts;
    const comp = plc.compiler;
    for (const pou of comp.pous.values()) {
      if (pou.builtin || pou.kind !== 'PROGRAM' || pou.role === 'model') continue;
      // Kandidaten: CASE über eine lokale Ganzzahlvariable, deren Zweige diese Variable neu setzen
      const cand = new Map();
      walkStmts(pou.ast.body, s => {
        if (s.s !== 'case' || s.expr.e !== 'id') return;
        const v = pou.vars.get(s.expr.name);
        if (!v || !T.isInt(v.type)) return;
        if (s.cases.some(c => assignsTo(c.body, s.expr.name))) {
          if (!cand.has(s.expr.name)) cand.set(s.expr.name, s);
        }
      });
      for (const [vname, chainCase] of cand) charts.push(buildChart(plc, pou, vname, chainCase));
    }
    return charts;
  }

  function buildChart(plc, pou, V, chainCase) {
    const comp = plc.compiler;
    const vinfo = pou.vars.get(V);
    const scope = { pou, file: pou.file, kind: 'pou' };
    const initial = typeof vinfo.init === 'number' ? vinfo.init : 0;
    const steps = new Map();
    const step = n => { if (!steps.has(n)) steps.set(n, { n, actions: [], entry: [], line: null }); return steps.get(n); };
    step(initial);
    const transitions = [];
    const globalTrans = [];

    // Transitionen aus den Zweigen der Kette
    function collect(list, conds, from, out, line) {
      for (const s of list) {
        if (s.s === 'assign' && isVar(s.target, V)) {
          const to = intLit(s.value);
          if (to !== null) out.push({ from, to, conds: conds.slice(), line: s.line });
        } else if (s.s === 'if') {
          const prev = [];
          for (const b of s.branches) {
            collect(b.body, conds.concat(prev, [{ e: b.cond, neg: false }]), from, out);
            prev.push({ e: b.cond, neg: true });
          }
          if (s.elseBody) collect(s.elseBody, conds.concat(prev), from, out);
        } else if (s.s === 'case' && s !== chainCase) {
          s.cases.forEach(c => collect(c.body, conds.concat([{ text: 'CASE ' + exprText(s.expr) + ' = ' + c.labels.map(l => exprText(l.lo)).join(',') }]), from, out));
        }
      }
    }
    for (const c of chainCase.cases) {
      for (const l of c.labels) {
        const n = intLit(l.lo);
        if (n === null || l.hi) continue;
        step(n).line = c.line;
        collect(c.body, [], n, transitions);
      }
    }
    if (chainCase.elseBody) collect(chainCase.elseBody, [], '*', globalTrans);
    for (const t of transitions) step(t.to);

    // Zuweisungen an die Schrittvariable außerhalb der Kette (z.B. Reset)
    (function outside(list, conds) {
      for (const s of list) {
        if (s === chainCase) continue;
        if (s.s === 'assign' && isVar(s.target, V)) {
          const to = intLit(s.value);
          if (to !== null) { globalTrans.push({ from: '*', to, conds: conds.slice(), line: s.line }); step(to); }
        } else if (s.s === 'if') {
          const prev = [];
          for (const b of s.branches) { outside(b.body, conds.concat(prev, [{ e: b.cond, neg: false }])); prev.push({ e: b.cond, neg: true }); }
          if (s.elseBody) outside(s.elseBody, conds.concat(prev));
        }
      }
    })(pou.ast.body, []);

    // Aktionen: X := … (V = k) …  → X ist im Schritt k aktiv
    const actionVars = new Set();
    walkStmts(pou.ast.body, s => {
      if (s.s !== 'assign' || isVar(s.target, V)) return;
      const ks = new Set();
      walkExpr(s.value, e => {
        if (e.e === 'bin' && e.op === '=') {
          if (isVar(e.a, V) && intLit(e.b) !== null) ks.add(intLit(e.b));
          if (isVar(e.b, V) && intLit(e.a) !== null) ks.add(intLit(e.a));
        }
      });
      if (!ks.size || s.target.e !== 'id') return;
      actionVars.add(s.target.name);
      for (const k of ks) step(k).actions.push({ name: s.target.name, display: s.target.display, path: pou.display + '.' + s.target.display, qual: 'N' });
    });

    // Eingangsaktionen: weitere CASE über V (ohne Transitionen), z.B. unter IF xNeu
    (function entries(list, cond) {
      for (const s of list) {
        if (s.s === 'case' && s !== chainCase && isVar(s.expr, V) && !s.cases.some(c => assignsTo(c.body, V))) {
          let label = 'N';
          if (cond) {
            // Flankenmerker wie xNeu := (iStep <> iStepOld) erkennen
            let isEntry = false;
            if (cond.e === 'id') walkStmts(pou.ast.body, a => {
              if (a.s === 'assign' && isVar(a.target, cond.name)) walkExpr(a.value, x => { if (x.e === 'bin' && x.op === '<>' && (isVar(x.a, V) || isVar(x.b, V))) isEntry = true; });
            });
            label = isEntry ? 'Eingang' : 'wenn ' + exprText(cond);
          }
          for (const c of s.cases) for (const l of c.labels) {
            const n = intLit(l.lo);
            if (n === null) continue;
            step(n).entry.push({ label, text: c.body.map(stmtText) });
          }
        } else if (s.s === 'if') {
          s.branches.forEach(b => entries(b.body, b.cond));
        }
      }
    })(pou.ast.body, null);

    // Aktionsvariablen → globale Ausgänge (z.B. SAEGE_ANTRIEB := … SFC_Saege.xK1 …)
    const outputsOf = new Map();
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
    for (const st of steps.values()) for (const a of st.actions) a.outputs = outputsOf.get(a.name) || [];

    // Bedingungen live auswertbar machen
    const saved = comp.diags; comp.diags = [];
    const compileCond = t => {
      const fns = [];
      for (const c of t.conds) {
        if (!c.e) { fns.push(null); continue; }
        const x = comp.compileExpr(c.e, scope);
        fns.push(x && T.isBool(x.t) ? (neg => ctx => (neg ? !x.f(ctx) : !!x.f(ctx)))(c.neg) : null);
      }
      t.eval = fns.every(f => f) ? ctx => fns.every(f => f(ctx)) : null;
      t.condsText = t.conds.map(c => (c.text ? c.text : (c.neg ? (c.e.e === 'id' || c.e.e === 'member' ? 'NOT ' : 'NOT (') + exprText(c.e) + (c.e.e === 'id' || c.e.e === 'member' ? '' : ')') : exprText(c.e))));
    };
    transitions.forEach(compileCond);
    globalTrans.forEach(compileCond);
    comp.diags = saved;

    // Pfad einer Variablen im Ausdruck (für anklickbare Variablen)
    const pathOf = e => {
      if (e.e === 'id') {
        const lk = comp.lookup(e.name, scope);
        if (!lk) return null;
        if (lk.where === 'local') return pou.display + '.' + e.display;
        if (lk.where === 'global') return e.display;
        return null;
      }
      if (e.e === 'member') { const b = e.obj.e === 'id' && comp.pous.has(e.obj.name) ? comp.pous.get(e.obj.name).display : pathOf(e.obj); return b ? b + '.' + e.display : null; }
      return null;
    };

    return {
      pou: pou.display, pouName: pou.name, file: pou.file, line: chainCase.line,
      varName: vinfo.display, path: pou.display + '.' + vinfo.display, initial,
      steps: [...steps.values()].sort((a, b) => a.n - b.n),
      transitions, globalTrans, pathOf,
      ctx: () => ({ self: plc.P[pou.name], G: plc.G, P: plc.P, rt: plc.rt }),
    };
  }

  ST.extractCharts = extractCharts;
  ST.exprText = exprText;
})(globalThis.ST);
