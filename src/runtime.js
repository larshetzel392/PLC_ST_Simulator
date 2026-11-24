// Laufzeit: SPS-Zyklus, Variablenzugriff, Forcen, Testausführung
(function (ST) {
  'use strict';
  const T = ST.T;

  class PLCFault extends Error {
    constructor(msg, loc) { super(msg); this.loc = loc; }
  }
  ST.PLCFault = PLCFault;

  class PLC {
    // sources: [{file, src, role: 'main'|'model'}]
    constructor(sources, opts) {
      opts = opts || {};
      this.cycleMs = opts.cycleMs || 10;
      this.compiler = new ST.Compiler();
      for (const s of sources) this.compiler.addSource(s.file, s.src, s.role);
      this.ok = !this.compiler.hasErrors && this.compiler.build();
      this.diags = this.compiler.diags;
      this.forces = new Map();
      this.refCache = new Map();
      if (this.ok) {
        this.tasks = opts.tasks ? opts.tasks.map(n => n.toUpperCase()) : this.defaultTasks();
        for (const t of this.tasks) {
          const p = this.compiler.pous.get(t);
          if (!p || p.kind !== 'PROGRAM') { this.diags.push({ kind: 'error', msg: `Task-Programm '${t}' existiert nicht`, line: 0, col: 0 }); this.ok = false; }
        }
        if (this.ok && this.tasks.length === 0) { this.diags.push({ kind: 'error', msg: 'Kein PROGRAM gefunden, das zyklisch ausgeführt werden kann', line: 0, col: 0 }); this.ok = false; }
      }
      if (this.ok) this.reset();
    }

    defaultTasks() {
      const pous = [...this.compiler.pous.values()].filter(p => p.kind === 'PROGRAM');
      const called = new Set();
      for (const p of pous) for (const c of p.calls) called.add(c);
      const main = pous.filter(p => p.role !== 'model');
      const model = pous.filter(p => p.role === 'model' && !called.has(p.name));
      let tasks;
      if (main.some(p => p.name === 'PLC_PRG')) tasks = ['PLC_PRG'];
      else tasks = main.filter(p => !called.has(p.name)).map(p => p.name);
      // Anlagenmodell zuerst: es liefert die Eingänge aus den Ausgängen des letzten Zyklus
      return model.map(p => p.name).concat(tasks);
    }

    get programs() { return [...this.compiler.pous.values()].filter(p => p.kind === 'PROGRAM'); }

    // Kaltstart
    reset() {
      const G = {};
      for (const v of this.compiler.globals.values()) G[v.name] = v.init !== undefined ? T.deepCopy(v.init) : T.defaultValue(v.type);
      const P = {};
      for (const p of this.programs) P[p.name] = p.type.makeInstance();
      this.G = G; this.P = P;
      this.rt = { now: 0, loc: null, depth: 0, loops: 0, maxLoops: 1e6, test: null };
      this.cycleCount = 0;
      this.fault = null;
      this.applyForces();
    }

    cycle() {
      this.notReady();
      if (this.fault) throw this.fault;
      const rt = this.rt;
      rt.loops = 0; rt.depth = 0; rt.cyc = this.cycleCount + 1;
      this.applyForces();
      try {
        for (const t of this.tasks) {
          const pou = this.compiler.pous.get(t);
          pou.body({ self: this.P[t], G: this.G, P: this.P, rt });
        }
      } catch (e) {
        if (e instanceof ST.STRuntimeError || e instanceof RangeError) {
          this.fault = new PLCFault(e instanceof RangeError ? 'Stapelüberlauf' : e.message, rt.loc);
          throw this.fault;
        }
        throw e;
      }
      this.applyForces();
      rt.now += this.cycleMs;
      this.cycleCount++;
    }

    // ---------- Variablenzugriff über Pfade (z.B. "SFC_Saege.iStep", "arr[2]") ----------
    scope() {
      const fallback = this.tasks.map(t => this.compiler.pous.get(t));
      return { kind: 'test', file: '(Pfad)', locals: new Map(), fallback };
    }
    ctx() { return { self: {}, G: this.G, P: this.P, rt: this.rt }; }

    notReady() { if (!this.ok) throw new ST.STError('Das Programm ist nicht übersetzt (Fehler beim Übersetzen)'); }

    resolve(path) {
      this.notReady();
      if (this.refCache.has(path)) return this.refCache.get(path);
      const c = this.compiler;
      const saved = c.diags; c.diags = [];
      let ref = null;
      try {
        const p = new ST.Parser(path);
        const e = p.parsePostfix();
        if (p.t.type !== 'eof') throw new ST.STError(`Ungültiger Pfad '${path}'`);
        ref = c.compileRef(e, this.scope());
        if (c.diags.some(d => d.kind === 'error')) throw new ST.STError(c.diags.find(d => d.kind === 'error').msg);
        if (!ref || ref.special) throw new ST.STError(`'${path}' ist keine Variable`);
      } finally { c.diags = saved; }
      this.refCache.set(path, ref);
      return ref;
    }
    read(path) { const r = this.resolve(path); return r.get(this.ctx()); }
    typeOf(path) { return this.resolve(path).t; }
    format(path) { const r = this.resolve(path); return ST.fmtValue(r.t, r.get(this.ctx())); }

    // Wert aus Text (ST-Literal/Ausdruck) parsen und typgerecht liefern
    parseValue(text, type) {
      const c = this.compiler;
      // Eingabe-Komfort: 2,5 → 2.5 · 3s → T#3s · 1/0 → TRUE/FALSE
      const raw = String(text).trim();
      if (T.isBool(type) && /^[01]$/.test(raw)) text = raw === '1' ? 'TRUE' : 'FALSE';
      else if (type.k === 'elem' && type.cat === 'real' && /^[-+]?\d+,\d+(e[-+]?\d+)?$/i.test(raw)) text = raw.replace(',', '.');
      else if (T.isTime(type) && /^-?\d+([.,]\d+)?\s*(d|h|m|s|ms|us)\b/i.test(raw)) text = 'T#' + raw.replace(/\s+/g, '').replace(',', '.');
      const saved = c.diags; c.diags = [];
      try {
        const p = new ST.Parser(text);
        const e = p.parseExpr();
        if (p.t.type !== 'eof') throw new ST.STError(`Ungültiger Wert '${text}'`);
        const x = c.compileExpr(e, this.scope());
        const errs = c.diags.filter(d => d.kind === 'error');
        if (errs.length || !x) throw new ST.STError(errs.length ? errs[0].msg : `Ungültiger Wert '${text}'`);
        const chk = T.assignCheck(type, x.t);
        if (chk && chk.error) throw new ST.STError(chk.error);
        const v = x.f(this.ctx());
        // Ganzzahl außerhalb des Bereichs nicht stillschweigend überlaufen lassen
        if (type.k === 'elem' && type.cat === 'int' && !type.lit && typeof v === 'number' && Number.isInteger(v) && T.wrapInt(v, type) !== v)
          throw new ST.STError(`${v} liegt außerhalb des Bereichs von ${type.name} (${T.wrapInt(type.signed ? 2 ** (type.bits - 1) : 0, type)} … ${T.wrapInt(type.signed ? 2 ** (type.bits - 1) - 1 : -1, type)})`);
        return T.coerce(type, v);
      } finally { c.diags = saved; }
    }
    write(path, value) {
      const r = this.resolve(path);
      if (!r.set) throw new ST.STError(`'${path}' kann nicht beschrieben werden`);
      if (typeof value === 'string' && !T.isStr(r.t)) value = this.parseValue(value, r.t);
      else if (typeof value === 'string') value = this.parseValue(value.startsWith("'") ? value : `'${value.replace(/'/g, "$'")}'`, r.t);
      r.set(this.ctx(), value);
      if (this.forces.has(path)) this.forces.get(path).value = r.get(this.ctx());
    }
    // Forcen: Wert festhalten; Schreibzugriffe des Programms auf die Variable werden ignoriert
    force(path, value) {
      const r = this.resolve(path);
      if (!r.set) throw new ST.STError(`'${path}' kann nicht geforct werden`);
      if (typeof value === 'string') value = this.parseValue(value, r.t);
      this.forces.set(path, { ref: r, value: T.coerce(r.t, value) });
      this.applyForces();
    }
    unforce(path) {
      const f = this.forces.get(path);
      if (!f) return;
      this.forces.delete(path);
      if (f.ref.loc) {
        try { const [o, k] = f.ref.loc(this.ctx()); if (o.__f) delete o.__f[k]; } catch (e) { /* Container existiert nicht mehr */ }
      }
    }
    unforceAll() { for (const p of [...this.forces.keys()]) this.unforce(p); }
    applyForces() {
      if (!this.forces.size) return;
      const c = this.ctx();
      for (const f of this.forces.values()) {
        if (f.ref.loc) {
          const [o, k] = f.ref.loc(c);
          if (!o.__f) Object.defineProperty(o, '__f', { value: {}, enumerable: false, writable: true });
          o.__f[k] = true;
          o[k] = f.value;
        } else f.ref.set(c, f.value);
      }
    }

    // Variablenbaum für die Anzeige
    tree() {
      const out = [];
      const node = (path, display, type, info) => {
        const n = { path, display, type, typeName: T.typeName(type), section: info && info.section, address: info && info.address, constant: info && info.constant, line: info && info.line, file: info && info.file };
        if (type.k === 'struct' || type.k === 'fb' || type.k === 'prog') {
          n.children = [];
          for (const f of type.fields.values()) {
            if (f.hidden || f.section === 'VAR_TEMP') continue;
            n.children.push(node(path + '.' + f.display, f.display, f.type, f));
          }
        } else if (type.k === 'array') {
          const total = type.dims.reduce((a, d) => a * (d.hi - d.lo + 1), 1);
          if (type.dims.length === 1 && total <= 256) {
            n.children = [];
            for (let i = type.dims[0].lo; i <= type.dims[0].hi; i++) n.children.push(node(`${path}[${i}]`, `[${i}]`, type.elem, null));
          }
        }
        return n;
      };
      if (this.compiler.globals.size) {
        const g = { path: null, display: 'Globale Variablen', children: [] };
        for (const v of this.compiler.globals.values()) g.children.push(node(v.display, v.display, v.type, v));
        out.push(g);
      }
      for (const p of this.programs) {
        const n = node(p.display, p.display, p.type, null);
        n.isProgram = true;
        n.line = p.line; n.file = p.file;
        n.isTask = this.tasks.includes(p.name);
        n.role = p.role;
        out.push(n);
      }
      return out;
    }
  }
  ST.PLC = PLC;

  // ---------- Tests ----------
  // Liefert {diags, results:[{name, status, msg, loc, asserts, cycles, simTime, log, ms}]}
  function runTests(plc, testSrc, opts) {
    opts = opts || {};
    const file = opts.file || 'tests';
    const diags = [];
    const results = [];
    let tf;
    try { tf = ST.parseTests(testSrc); }
    catch (e) {
      if (e instanceof ST.STError) { for (const x of (e.all || [e])) diags.push({ kind: 'error', msg: x.message, line: x.line, col: x.col, file }); return { diags, results }; }
      throw e;
    }
    if (!plc.ok) return { diags, results };
    const c = plc.compiler;
    const saved = c.diags; c.diags = diags;
    const fileLocals = new Map();
    const compiled = [];
    try {
      c.curFile = file;
      for (const sec of tf.globals) for (const v of sec.vars) fileLocals.set(v.name, c.declVar(v, sec, file, null));
      const fallback = plc.tasks.map(t => c.pous.get(t));
      for (const t of tf.tests) {
        const locals = new Map(fileLocals);
        for (const sec of t.sections) for (const v of sec.vars) locals.set(v.name, c.declVar(v, sec, file, null));
        const scope = { kind: 'test', file, locals, fallback };
        const errBefore = diags.filter(d => d.kind === 'error').length;
        const setup = c.compileBlock(tf.setup, scope);
        const body = c.compileBlock(t.body, scope);
        const ok = diags.filter(d => d.kind === 'error').length === errBefore;
        compiled.push({ t, locals, setup, body, ok });
      }
    } finally { c.diags = saved; }

    const only = opts.only ? new Set(opts.only) : null;
    for (const ct of compiled) {
      if (only && !only.has(ct.t.name)) continue;
      const res = { name: ct.t.name, line: ct.t.line, status: 'pass', msg: '', loc: null, asserts: 0, cycles: 0, simTime: 0, log: [], trace: null };
      if (!ct.ok) { res.status = 'error'; res.msg = 'Test enthält Übersetzungsfehler'; results.push(res); continue; }
      const t0 = Date.now();
      const savedForces = plc.forces; plc.forces = new Map();
      plc.reset();
      const self = {};
      for (const v of ct.locals.values()) self[v.name] = v.init !== undefined ? T.deepCopy(v.init) : T.defaultValue(v.type);
      const tracer = opts.trace ? makeTracer(plc, opts.trace) : null;
      const maxCycles = opts.maxCycles || 2000000;
      const test = {
        asserts: 0,
        cycles(n) {
          if (n < 0) throw new ST.STRuntimeError('CYCLE mit negativer Anzahl');
          for (let i = 0; i < n; i++) step();
        },
        wait(ms) {
          const end = plc.rt.now + ms;
          while (plc.rt.now < end) step();
        },
        runUntil(cond, timeout, loc) {
          const end = plc.rt.now + timeout;
          for (;;) {
            if (cond()) return;
            if (plc.rt.now >= end) throw new ST.TestFailure(`RUN_UNTIL: Bedingung nach ${T.formatTime(timeout)} nicht erfüllt`, loc);
            step();
          }
        },
        log(text, loc) { res.log.push({ text, line: loc.line, time: plc.rt.now, cycle: plc.cycleCount }); },
      };
      function step() {
        if (plc.cycleCount >= maxCycles) throw new ST.STRuntimeError(`Zykluslimit (${maxCycles}) im Test erreicht`);
        const savedLoc = plc.rt.loc, savedTest = plc.rt.test;
        plc.rt.test = null;
        plc.cycle();
        plc.rt.loc = savedLoc; plc.rt.test = savedTest;
        if (tracer) tracer.sample();
      }
      plc.rt.test = test;
      if (tracer) tracer.sample();
      const ctx = { self, G: plc.G, P: plc.P, rt: plc.rt };
      try {
        ct.setup(ctx);
        ct.body(ctx);
      } catch (e) {
        if (e instanceof ST.TestFailure) { res.status = 'fail'; res.msg = e.message; res.loc = e.loc; }
        else if (e instanceof ST.PLCFault) { res.status = 'error'; res.msg = 'Laufzeitfehler im SPS-Programm: ' + e.message; res.loc = e.loc; }
        else if (e instanceof ST.STRuntimeError) { res.status = 'error'; res.msg = 'Laufzeitfehler im Test: ' + e.message; res.loc = plc.rt.loc; }
        else throw e;
      }
      res.asserts = test.asserts;
      res.cycles = plc.cycleCount;
      res.simTime = plc.rt.now;
      res.ms = Date.now() - t0;
      if (tracer) res.trace = tracer.result();
      if (res.status === 'pass' && res.asserts === 0) res.warning = 'Test enthält kein ASSERT';
      plc.forces = savedForces;
      plc.rt.test = null;
      results.push(res);
    }
    plc.reset();
    return { diags, results };
  }

  // Zeichnet Signalverläufe für Zeitdiagramme auf (nur Änderungen)
  function makeTracer(plc, paths) {
    if (paths === true) {
      paths = [];
      for (const v of plc.compiler.globals.values()) paths.push(v.display);
      for (const t of plc.tasks) {
        const p = plc.compiler.pous.get(t);
        for (const v of p.vars.values()) if (v.type.k === 'elem' || v.type.k === 'enum') paths.push(p.display + '.' + v.display);
      }
    }
    const sigs = [];
    for (const p of paths) {
      try { const r = plc.resolve(p); if (r.t.k === 'elem' || r.t.k === 'enum') sigs.push({ path: p, ref: r, t: r.t, pts: [] }); } catch (e) { /* ignorieren */ }
    }
    const c = { self: {}, G: plc.G, P: plc.P, rt: plc.rt };
    let n = 0;
    return {
      sample() {
        c.G = plc.G; c.P = plc.P;
        const time = plc.rt.now;
        for (const s of sigs) {
          const v = s.ref.get(c);
          const last = s.pts.length ? s.pts[s.pts.length - 1] : null;
          if (!last || last.v !== v) { if (s.pts.length < 5000) s.pts.push({ time, cycle: plc.cycleCount, v }); }
        }
        n++;
      },
      result() {
        return {
          end: plc.rt.now, cycles: plc.cycleCount,
          signals: sigs.map(s => ({ path: s.path, type: T.typeName(s.t), bool: T.isBool(s.t), pts: s.pts.map(p => ({ time: p.time, cycle: p.cycle, v: p.v, s: ST.fmtValue(s.t, p.v) })) })),
        };
      },
    };
  }

  ST.runTests = runTests;

  // Führt nur den SETUP-Block einer Testdatei aus (z.B. Grundstellung für die manuelle Simulation)
  function applySetup(plc, testSrc) {
    let tf;
    try { tf = ST.parseTests(testSrc); } catch (e) { return { ok: false, msg: e.message }; }
    if (!tf.setup.length) return { ok: false, msg: 'kein SETUP' };
    const c = plc.compiler;
    const saved = c.diags; c.diags = [];
    let fn, locals = new Map();
    try {
      for (const sec of tf.globals) for (const v of sec.vars) locals.set(v.name, c.declVar(v, sec, '(SETUP)', null));
      fn = c.compileBlock(tf.setup, { kind: 'setup', file: '(SETUP)', locals, fallback: plc.tasks.map(t => c.pous.get(t)) });
      if (c.diags.some(d => d.kind === 'error')) return { ok: false, msg: c.diags.find(d => d.kind === 'error').msg };
    } finally { c.diags = saved; }
    const self = {};
    for (const v of locals.values()) self[v.name] = v.init !== undefined ? T.deepCopy(v.init) : T.defaultValue(v.type);
    try { fn({ self, G: plc.G, P: plc.P, rt: plc.rt }); } catch (e) { return { ok: false, msg: e.message }; }
    plc.applyForces();
    return { ok: true, count: tf.setup.length };
  }
  ST.applySetup = applySetup;
})(globalThis.ST);
