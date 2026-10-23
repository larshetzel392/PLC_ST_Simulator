// ST Prüfstand – Browser-Oberfläche
(async function () {
  'use strict';
  const ST = globalThis.ST;
  const T = ST.T;
  const $ = id => document.getElementById(id);
  const FILES = { prog: 'programm.st', model: 'anlage.st', tests: 'tests.sttest' };
  const EXAMPLES = globalThis.ST_EXAMPLES || [];

  // ---------- Speicher ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('stp.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('stp.' + k, JSON.stringify(v)); } catch (e) { /* ohne Speicher weiter */ } },
  };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- Syntax-Hervorhebung ----------
  const KW = new Set(('PROGRAM END_PROGRAM FUNCTION_BLOCK END_FUNCTION_BLOCK FUNCTION END_FUNCTION VAR VAR_INPUT VAR_OUTPUT VAR_IN_OUT VAR_TEMP VAR_GLOBAL VAR_EXTERNAL VAR_STAT END_VAR CONSTANT RETAIN PERSISTENT AT TYPE END_TYPE STRUCT END_STRUCT ARRAY OF ' +
    'IF THEN ELSIF ELSE END_IF CASE END_CASE FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT EXIT CONTINUE RETURN AND OR XOR NOT MOD TRUE FALSE AND_THEN OR_ELSE').split(' '));
  const TESTKW = new Set('TEST END_TEST SETUP END_SETUP CYCLE WAIT ASSERT RUN_UNTIL TIMEOUT LOG'.split(' '));
  const TYPES = new Set(('BOOL SINT USINT BYTE INT UINT WORD DINT UDINT DWORD LINT ULINT LWORD REAL LREAL TIME LTIME STRING WSTRING ' +
    'TON TOF TP R_TRIG F_TRIG CTU CTD CTUD SR RS').split(' '));
  const TOKEN_RE = /(\(\*[\s\S]*?(?:\*\)|$))|(\/\/[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|('(?:\$.|[^'$\n])*'?|"(?:\$.|[^"$\n])*"?)|((?:T|TIME|LT|LTIME)#[-0-9a-zA-Z_.]+|\d+#[0-9A-Fa-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)/g;
  function highlight(src, isTest) {
    let out = '', last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      const t = m[0];
      let cls = null;
      if (m[1] || m[2] || m[3]) cls = 'hl-cmt';
      else if (m[4]) cls = 'hl-str';
      else if (m[5]) cls = 'hl-num';
      else if (m[6]) {
        const u = t.toUpperCase();
        if (isTest && TESTKW.has(u)) cls = 'hl-test';
        else if (KW.has(u)) cls = 'hl-kw';
        else if (TYPES.has(u) || /^(TO_)?[A-Z]+_TO_[A-Z]+$/.test(u)) cls = 'hl-type';
      }
      out += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t);
      last = m.index + t.length;
      if (t.length === 0) TOKEN_RE.lastIndex++;
    }
    return out + esc(src.slice(last)) + '\n';
  }

  // ---------- Editor ----------
  class Editor {
    constructor(host, opts) {
      this.isTest = !!opts.isTest;
      this.onChange = opts.onChange;
      host.innerHTML = '';
      const ed = document.createElement('div'); ed.className = 'editor';
      this.gutter = document.createElement('div'); this.gutter.className = 'gutter';
      const wrap = document.createElement('div'); wrap.className = 'code-wrap';
      this.marks = document.createElement('div');
      this.marks.style.cssText = 'position:absolute;left:0;right:0;top:0;pointer-events:none;';
      this.pre = document.createElement('pre');
      this.ta = document.createElement('textarea');
      this.ta.spellcheck = false; this.ta.autocapitalize = 'off'; this.ta.setAttribute('autocomplete', 'off');
      this.ta.id = 'ta-' + opts.id;
      this.ta.setAttribute('aria-label', opts.label);
      wrap.append(this.marks, this.pre, this.ta);
      ed.append(this.gutter, wrap);
      host.append(ed);
      this.diags = [];
      this.ta.addEventListener('input', () => { this.render(); this.onChange && this.onChange(); });
      this.ta.addEventListener('scroll', () => this.syncScroll());
      this.ta.addEventListener('keydown', e => this.keydown(e));
      ['click', 'keyup', 'focus'].forEach(ev => this.ta.addEventListener(ev, () => this.reportCursor()));
    }
    get value() { return this.ta.value; }
    set value(v) { this.ta.value = v; this.render(); }
    render() {
      const v = this.ta.value;
      this.pre.innerHTML = highlight(v, this.isTest);
      const n = v.split('\n').length;
      const byLine = new Map();
      for (const d of this.diags) {
        const cur = byLine.get(d.line);
        if (!cur || (cur.kind !== 'error' && d.kind === 'error')) byLine.set(d.line, d);
      }
      let g = '';
      for (let i = 1; i <= n; i++) {
        const d = byLine.get(i);
        g += d ? `<div class="${d.kind === 'error' ? 'e' : 'w'}" title="${esc(d.msg)}">${i}</div>` : `<div>${i}</div>`;
      }
      this.gutter.innerHTML = g;
      const lh = 20, pad = 10;
      let mk = '';
      for (const [line, d] of byLine) {
        const err = d.kind === 'error';
        mk += `<div style="position:absolute;left:0;right:0;top:${pad + (line - 1) * lh}px;height:${lh}px;background:${err ? 'var(--err-line)' : 'transparent'};border-left:3px solid ${err ? 'var(--bad)' : 'var(--warn)'}"></div>`;
      }
      this.marks.innerHTML = mk;
      this.marks.style.height = (pad * 2 + n * lh + 40) + 'px';
      this.syncScroll();
    }
    setDiagnostics(d) { this.diags = d; this.render(); }
    syncScroll() {
      this.pre.scrollTop = this.ta.scrollTop; this.pre.scrollLeft = this.ta.scrollLeft;
      this.gutter.scrollTop = this.ta.scrollTop;
      this.marks.style.transform = `translateY(${-this.ta.scrollTop}px)`;
    }
    keydown(e) {
      const ta = this.ta;
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
        if (s !== en && v.slice(s, en).includes('\n')) {
          const ls = v.lastIndexOf('\n', s - 1) + 1;
          const block = v.slice(ls, en);
          const nb = e.shiftKey ? block.replace(/^( {1,4}|\t)/gm, '') : block.replace(/^/gm, '    ');
          ta.setRangeText(nb, ls, en, 'select');
        } else if (!e.shiftKey) ta.setRangeText('    ', s, en, 'end');
        this.render(); this.onChange && this.onChange();
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        const s = ta.selectionStart, v = ta.value;
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const indent = /^[ \t]*/.exec(v.slice(ls, s))[0];
        const extra = /\b(THEN|ELSE|DO|OF|REPEAT|VAR(_\w+)?|STRUCT)\s*$/i.test(v.slice(ls, s)) ? '    ' : '';
        e.preventDefault();
        ta.setRangeText('\n' + indent + extra, s, ta.selectionEnd, 'end');
        this.render(); this.onChange && this.onChange();
      }
    }
    reportCursor() {
      const v = this.ta.value.slice(0, this.ta.selectionStart);
      $('cursorPos').textContent = `Zeile ${v.split('\n').length}, Spalte ${this.ta.selectionStart - v.lastIndexOf('\n')}`;
    }
    goto(line, col) {
      const lines = this.ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
      pos += Math.max(0, (col || 1) - 1);
      this.ta.focus();
      this.ta.setSelectionRange(pos, pos);
      this.ta.scrollTop = Math.max(0, (line - 1) * 20 - this.ta.clientHeight / 3);
      this.syncScroll();
      this.reportCursor();
    }
  }

  // ---------- Zustand ----------
  const state = {
    mode: store.get('mode', 'sim'), activeEd: 'prog',
    modelOn: store.get('modelOn', false),
    plc: null, running: false, dirty: false, server: false,
    expanded: new Set(store.get('expanded', [])),
    results: null, selTest: null, testDiags: [], compileDiags: [],
    charts: [], chartIdx: 0, zoom: null,
  };

  const eds = {
    prog: new Editor($('ed-prog'), { id: 'prog', label: 'SPS-Programm', onChange: () => changed('prog') }),
    model: new Editor($('ed-model'), { id: 'model', label: 'Anlagenmodell', onChange: () => changed('model') }),
    tests: new Editor($('ed-tests'), { id: 'tests', label: 'Testdatei', isTest: true, onChange: () => changed('tests') }),
  };

  function status(msg, kind) {
    const el = $('statusMsg');
    el.textContent = msg;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // ---------- Arbeitsbereiche ----------
  function setMode(m) {
    state.mode = m;
    store.set('mode', m);
    document.querySelectorAll('.mode-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    for (const k of ['code', 'sim', 'tests']) $('mode-' + k).hidden = k !== m;
    if (m === 'code') eds[state.activeEd].render();
    if (m === 'sim') { renderChart(); if (state.zoom === null) fitChart(); updateAll(true); }
    if (m === 'tests') renderTrace();
  }
  document.querySelectorAll('.mode-tab').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  function selectEditor(k) {
    state.activeEd = k;
    document.querySelectorAll('#edTabs .tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ed === k)));
    for (const key of Object.keys(eds)) $('ed-' + key).hidden = key !== k;
    eds[k].render();
    $('btnSave').title = state.server ? `${FILES[k]} speichern (Strg/Cmd+S)` : `Als ${FILES[k].split('/').pop()} speichern`;
  }
  document.querySelectorAll('#edTabs .tab').forEach(b => b.addEventListener('click', () => selectEditor(b.dataset.ed)));
  document.querySelectorAll('#sideTabs .tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#sideTabs .tab').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $('side-diags').hidden = b.dataset.side !== 'diags';
    $('side-help').hidden = b.dataset.side !== 'help';
  }));

  // ---------- Übersetzen ----------
  function sources() {
    const s = [{ file: FILES.prog, src: eds.prog.value, role: 'main' }];
    if (state.modelOn && eds.model.value.trim()) s.push({ file: FILES.model, src: eds.model.value, role: 'model' });
    return s;
  }
  function cycleMs() { return Math.max(1, Math.min(1000, parseInt($('inpCycle').value, 10) || 10)); }

  let checkTimer = null;
  function changed(which) {
    store.set('src.' + which, eds[which].value);
    if (which !== 'tests') state.dirty = true;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(liveCheck, 350);
    if (which === 'model') updateSourceUi();
    if (state.dirty && state.plc) status('Code geändert – „Übersetzen“ lädt die neue Version in die Simulation.');
  }

  function liveCheck() {
    let plc;
    try { plc = new ST.PLC(sources(), { cycleMs: cycleMs() }); }
    catch (e) { console.error(e); return null; }
    let tdiags = [];
    if (plc.ok && eds.tests.value.trim()) {
      try { tdiags = ST.runTests(plc, eds.tests.value, { file: FILES.tests, only: [] }).diags; } catch (e) { console.error(e); }
    }
    showDiagnostics(plc.diags, tdiags);
    return plc;
  }

  function showDiagnostics(cdiags, tdiags) {
    state.compileDiags = cdiags; state.testDiags = tdiags;
    const all = cdiags.concat(tdiags);
    const of = f => all.filter(d => d.file === f);
    eds.prog.setDiagnostics(of(FILES.prog));
    eds.model.setDiagnostics(of(FILES.model));
    eds.tests.setDiagnostics(of(FILES.tests));
    const badge = (el, list) => {
      const e = list.filter(x => x.kind === 'error').length;
      el.hidden = !list.length;
      el.textContent = e || list.length;
      el.className = 'count ' + (e ? 'bad' : 'warn');
    };
    badge($('cntProg'), of(FILES.prog));
    badge($('cntModel'), of(FILES.model));
    badge($('cntTests'), of(FILES.tests));
    badge($('cntDiags'), all);
    const errs = all.filter(d => d.kind === 'error');
    $('cntCode').hidden = !errs.length;
    $('cntCode').textContent = errs.length;
    $('cntCode').className = 'count bad';
    const ul = $('diagList');
    ul.innerHTML = '';
    if (!all.length) {
      ul.innerHTML = '<li style="cursor:default"><span class="k info">OK</span><span class="where"></span><span class="msg">Keine Fehler oder Warnungen.</span></li>';
      return;
    }
    const sorted = all.slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'error' ? -1 : 1));
    for (const d of sorted) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="k ${d.kind}">${d.kind === 'error' ? 'Fehler' : 'Warnung'}</span><span class="where">${esc(d.file || '')}${d.line ? ':' + d.line : ''}</span><span class="msg">${esc(d.msg)}</span>`;
      li.addEventListener('click', () => jumpTo(d.file, d.line, d.col));
      ul.append(li);
    }
  }

  function jumpTo(file, line, col) {
    const key = Object.keys(FILES).find(k => FILES[k] === file);
    if (!key || !line) return;
    setMode('code');
    selectEditor(key);
    eds[key].goto(line, col);
  }

  function compile(opts) {
    opts = opts || {};
    stop();
    const plc = liveCheck();
    if (!plc || !plc.ok) {
      state.plc = null; state.charts = [];
      const n = plc ? plc.diags.filter(d => d.kind === 'error').length : 1;
      status(`Übersetzen fehlgeschlagen: ${n} Fehler. Klick auf eine Meldung springt zur Zeile.`, 'bad');
      const first = plc && plc.diags.find(d => d.kind === 'error');
      if (first) jumpTo(first.file, first.line, first.col); else setMode('code');
      setLeds(); renderAllViews();
      return false;
    }
    const oldForces = state.plc ? [...state.plc.forces.entries()] : [];
    state.plc = plc;
    state.dirty = false;
    const setupMsg = applyStartState();
    for (const [p, f] of oldForces) { try { plc.force(p, f.value); } catch (e) { /* Variable entfällt */ } }
    state.charts = ST.extractCharts(plc);
    if (state.chartIdx >= state.charts.length) state.chartIdx = 0;
    state.hist = []; state.lastStep = undefined; state.zoom = null;
    const w = plc.diags.filter(d => d.kind === 'warning').length;
    status(`Übersetzt. Tasks: ${plc.tasks.map(t => plc.compiler.pous.get(t).display).join(' → ')}${setupMsg}${w ? ` · ${w} Warnung(en)` : ''}`, 'ok');
    renderAllViews();
    setLeds(); updateClock();
    if (state.mode === 'sim' && !opts.noRun) { fitChart(); run(); }
    return true;
  }

  // Grundstellung aus dem SETUP der Testdatei (nur bei manuell geschalteten Sensoren)
  function applyStartState() {
    if (state.modelOn || !$('chkSetup').checked || !eds.tests.value.trim()) return '';
    const r = ST.applySetup(state.plc, eds.tests.value);
    return r.ok ? ' · Grundstellung aus SETUP übernommen' : '';
  }

  // ---------- Simulation ----------
  let raf = null, lastTs = 0, acc = 0;
  function run() {
    if (!state.plc || state.dirty) { if (!compile({ noRun: true })) return; }
    if (state.plc.fault) { status('SPS im Fehlerzustand (SF) – Kaltstart oder neu übersetzen.', 'bad'); return; }
    if (state.running) return;
    state.running = true; lastTs = performance.now(); acc = 0;
    setLeds();
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    state.running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    setLeds();
  }
  function tick(ts) {
    if (!state.running) return;
    const plc = state.plc;
    const speed = parseFloat($('selSpeed').value) || 1;
    acc += Math.min(250, ts - lastTs) * speed;
    lastTs = ts;
    const t0 = performance.now();
    try {
      while (acc >= plc.cycleMs) {
        plc.cycle();
        acc -= plc.cycleMs;
        trackStep();
        if (performance.now() - t0 > 30) { acc = 0; break; }
      }
    } catch (e) { onFault(e); return; }
    updateAll();
    raf = requestAnimationFrame(tick);
  }
  function step() {
    if (!state.plc || state.dirty) { if (!compile({ noRun: true })) return; }
    try { state.plc.cycle(); trackStep(); } catch (e) { onFault(e); return; }
    updateAll(true);
  }
  function coldStart() {
    if (!state.plc) { compile(); return; }
    state.plc.reset();
    const msg = applyStartState();
    state.hist = []; state.lastStep = undefined;
    acc = 0;
    status('Kaltstart: Variablen auf Initialwerte gesetzt' + msg + '.');
    setLeds(); updateAll(true);
  }
  function onFault(e) {
    stop();
    if (e instanceof ST.PLCFault) {
      status(`Laufzeitfehler: ${e.message}${e.loc ? ` (${e.loc.file}:${e.loc.line})` : ''} – Kaltstart setzt zurück.`, 'bad');
    } else { status('Interner Fehler: ' + e.message, 'bad'); console.error(e); }
    setLeds(); updateAll(true);
  }
  function setLeds() {
    const fault = !!(state.plc && state.plc.fault);
    $('ledRun').classList.toggle('on', state.running);
    $('ledStop').classList.toggle('on', !state.running);
    $('ledSf').classList.toggle('on', fault || (!state.plc && state.compileDiags.some(d => d.kind === 'error')));
    $('btnRun').disabled = state.running;
    $('btnStop').disabled = !state.running;
    $('btnStep').disabled = state.running;
  }
  function updateClock() {
    const plc = state.plc;
    $('simTime').textContent = plc ? T.formatTime(plc.rt.now).slice(2) : '0ms';
    $('cycCount').textContent = plc ? plc.cycleCount.toLocaleString('de-DE') : '0';
  }

  // ---------- Variablenzugriff ----------
  function safeRead(path) { try { return state.plc.read(path); } catch (e) { return undefined; } }
  function refOf(path) { try { return state.plc.resolve(path); } catch (e) { return null; } }
  function writeVar(path, v) {
    const plc = state.plc;
    if (!plc) return;
    try {
      if (plc.forces.has(path)) plc.force(path, v); else plc.write(path, v);
    } catch (e) { status(e.message, 'bad'); }
    updateAll(true);
  }
  // Vom Programm berechnete Variablen lassen sich nur per Forcen festhalten
  function toggleVar(path) {
    const plc = state.plc, ref = refOf(path);
    if (!plc || !ref || !ref.set) return;
    const cur = !!safeRead(path);
    if (ref.info && ref.info.plcWrites) {
      plc.force(path, !cur);
      status(`${path} := ${!cur ? 'TRUE' : 'FALSE'} festgehalten (wird sonst vom Programm berechnet). „lösen“ gibt den Wert wieder frei.`);
      updateAll(true);
    } else writeVar(path, !cur);
    if (!state.running && state.mode === 'sim' && !plc.fault) run();
  }
  function lineComment(file, line) {
    const key = Object.keys(FILES).find(k => FILES[k] === file);
    if (!key || !line) return '';
    const text = eds[key].value.split('\n')[line - 1] || '';
    const semi = text.indexOf(';');
    const m = /\(\*\s*(.*?)\s*\*\)|\/\/\s*(.*)$/.exec(semi >= 0 ? text.slice(semi + 1) : '');
    return m ? (m[1] || m[2] || '') : '';
  }

  // ---------- Bedienfeld: Eingänge / Ausgänge ----------
  let ioRows = [];
  function ioVars() {
    const comp = state.plc.compiler;
    const ins = [], outs = [];
    for (const v of comp.globals.values()) {
      if (v.constant || !(v.type.k === 'elem' || v.type.k === 'enum')) continue;
      (v.plcWrites ? outs : ins).push({ path: v.display, info: v });
    }
    if (!ins.length && !outs.length) {
      for (const t of state.plc.tasks) {
        const p = comp.pous.get(t);
        if (p.role === 'model') continue;
        for (const v of p.vars.values()) {
          if (!(v.type.k === 'elem' || v.type.k === 'enum')) continue;
          if (v.section === 'VAR_INPUT') ins.push({ path: p.display + '.' + v.display, info: v });
          if (v.section === 'VAR_OUTPUT') outs.push({ path: p.display + '.' + v.display, info: v });
        }
      }
    }
    return { ins, outs };
  }
  // BOOL-Variablen aus den Transitionen, die keine echten Eingänge sind (z.B. xAuto, xReset)
  function chainSignals(exclude) {
    const ch = state.charts[state.chartIdx];
    const seen = new Set(), out = [];
    const visit = conds => {
      for (const c of conds) {
        if (!c.e) continue;
        ST.exprText(c.e, (node, text) => {
          const p = ch.pathOf(node);
          if (p && !seen.has(p) && !exclude.has(p)) {
            seen.add(p);
            const ref = refOf(p);
            if (ref && ref.set && T.isBool(ref.t)) out.push({ path: p, info: ref.info || {}, ref });
          }
          return text;
        });
      }
    };
    if (ch) {
      ch.transitions.slice().sort((a, b) => a.from - b.from).forEach(t => visit(t.conds));
      ch.globalTrans.forEach(t => visit(t.conds));
    }
    // dazu alle BOOL-Eingänge der Programme (z.B. PRG_Ausgaenge.xFreigabe)
    for (const p of state.plc.programs) {
      if (p.role === 'model') continue;
      for (const v of p.vars.values()) {
        const path = p.display + '.' + v.display;
        if (v.section !== 'VAR_INPUT' || !T.isBool(v.type) || seen.has(path) || exclude.has(path)) continue;
        const ref = refOf(path);
        if (ref && ref.set) { seen.add(path); out.push({ path, info: v, ref }); }
      }
    }
    return out;
  }

  function renderIO() {
    const inEl = $('ioIn'), outEl = $('ioOut'), sigEl = $('ioSig');
    inEl.innerHTML = ''; outEl.innerHTML = ''; sigEl.innerHTML = '';
    $('sigBlock').hidden = true;
    ioRows = [];
    if (!state.plc) {
      inEl.innerHTML = '<p class="hint">Nach dem Übersetzen stehen hier die Eingänge des Programms.</p>';
      return;
    }
    const { ins, outs } = ioVars();
    const mk = (item, isIn, isSig) => {
      const row = document.createElement('div');
      row.className = 'iorow';
      const comment = lineComment(item.info.file, item.info.line);
      const isBool = T.isBool(item.info.type);
      let ctl;
      if (isBool && isIn) {
        ctl = document.createElement('button');
        ctl.className = 'sw';
        ctl.title = 'Umschalten';
        ctl.setAttribute('aria-label', item.path + ' umschalten');
        ctl.addEventListener('click', () => toggleVar(item.path));
      } else if (isBool) {
        ctl = document.createElement('span');
        ctl.className = 'lampbig';
      } else {
        ctl = document.createElement('span');
        ctl.className = 'val num';
        ctl.title = isIn ? 'Klick: Wert schreiben' : '';
        if (isIn) ctl.addEventListener('click', () => editInline(ctl, item.path, item.info.type));
      }
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.innerHTML = `<b>${esc(item.path)}</b>${comment ? `<span>${esc(comment)}</span>` : ''}`;
      row.append(ctl, nm);
      if (isSig) {
        const rel = document.createElement('button');
        rel.className = 'tbtn rel'; rel.textContent = 'lösen';
        rel.title = 'Festhalten aufheben – das Programm berechnet den Wert wieder selbst';
        rel.addEventListener('click', () => { state.plc.unforce(item.path); status(`${item.path} freigegeben.`); updateAll(true); });
        row.append(rel);
        ioRows.push({ row, ctl, path: item.path, type: item.info.type || T.ELEM.BOOL, last: undefined, rel });
        return row;
      }
      if (isBool && isIn) {
        const tb = document.createElement('button');
        tb.className = 'tbtn'; tb.textContent = '⏺';
        tb.title = 'Taster: gedrückt halten (z.B. EIN, START)';
        let orig = null;
        const up = () => { if (orig !== null) { writeVar(item.path, orig); orig = null; tb.classList.remove('on'); } };
        tb.addEventListener('pointerdown', e => {
          e.preventDefault(); orig = !!safeRead(item.path); writeVar(item.path, !orig); tb.classList.add('on');
          if (!state.running && state.plc && !state.plc.fault) run();
        });
        tb.addEventListener('pointerup', up);
        tb.addEventListener('pointerleave', up);
        tb.addEventListener('pointercancel', up);
        row.append(tb);
      } else row.append(document.createElement('span'));
      ioRows.push({ row, ctl, path: item.path, type: item.info.type, last: undefined });
      return row;
    };
    for (const i of ins) inEl.append(mk(i, true));
    for (const o of outs) outEl.append(mk(o, false));
    const sigs = chainSignals(new Set(ins.concat(outs).map(x => x.path)));
    for (const sg of sigs) {
      const r = mk({ path: sg.path, info: Object.assign({ type: sg.ref.t }, sg.info) }, true, true);
      sigEl.append(r);
    }
    $('sigBlock').hidden = !sigs.length;
    if (!ins.length) inEl.innerHTML = '<p class="hint">Keine Eingänge erkannt.</p>';
    if (!outs.length) outEl.innerHTML = '<p class="hint">Keine Ausgänge erkannt.</p>';
  }
  function updateIO() {
    const plc = state.plc;
    if (!plc) return;
    for (const r of ioRows) {
      const v = safeRead(r.path);
      const forced = plc.forces.has(r.path);
      r.row.classList.toggle('forced', forced);
      if (r.rel) r.rel.hidden = !forced;
      if (v === r.last) continue;
      r.last = v;
      if (r.ctl.classList.contains('sw')) r.ctl.classList.toggle('t', !!v);
      else if (r.ctl.classList.contains('lampbig')) r.ctl.classList.toggle('on', !!v);
      else r.ctl.textContent = v === undefined ? '?' : ST.fmtValue(r.type, v);
    }
  }
  function editInline(el, path, type) {
    const inp = document.createElement('input');
    inp.value = T.isStr(type) ? safeRead(path) : ST.fmtValue(type, safeRead(path)).replace(/ \(16#.*\)$/, '');
    inp.style.width = '110px';
    el.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = commit => {
      if (done) return; done = true;
      if (commit) {
        try { writeVar(path, T.isStr(type) ? inp.value : state.plc.parseValue(inp.value, type)); }
        catch (e) { status(`Wert nicht übernommen: ${e.message}`, 'bad'); }
      }
      inp.replaceWith(el);
      updateAll(true);
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }

  // ---------- Sensorquelle ----------
  function updateSourceUi() {
    const hasModel = !!eds.model.value.trim();
    $('srcModel').disabled = !hasModel;
    if (!hasModel && state.modelOn) state.modelOn = false;
    $('srcManual').setAttribute('aria-checked', String(!state.modelOn));
    $('srcModel').setAttribute('aria-checked', String(state.modelOn));
    $('chkSetup').parentElement.hidden = state.modelOn;
    $('srcHint').textContent = state.modelOn
      ? 'Das Anlagenmodell setzt die Sensoren aus den Ausgängen. Bedienelemente wie EIN/START schaltest du weiterhin selbst; Sensoren werden im nächsten Zyklus vom Modell überschrieben.'
      : (hasModel ? 'Du schaltest alle Eingänge selbst – die Kette springt weiter, sobald eine Transition erfüllt ist.' : 'Du schaltest alle Eingänge selbst. Für automatische Sensoren im Code-Bereich ein Anlagenmodell anlegen.');
  }
  function setSource(model) {
    if (state.modelOn === model) return;
    state.modelOn = model;
    store.set('modelOn', model);
    updateSourceUi();
    compile();
  }
  $('srcManual').addEventListener('click', () => setSource(false));
  $('srcModel').addEventListener('click', () => setSource(true));
  $('chkSetup').addEventListener('change', () => { store.set('setup', $('chkSetup').checked); if (state.plc) coldStart(); });

  // ---------- Alle Variablen ----------
  let rows = [];
  function renderWatch() {
    const body = $('watchBody');
    body.innerHTML = '';
    rows = [];
    const plc = state.plc;
    if (!plc) return;
    const filter = $('watchFilter').value.trim().toUpperCase();
    const match = n => !filter || (n.path && n.path.toUpperCase().includes(filter)) || (n.children || []).some(match);
    const add = (n, depth) => {
      if (!match(n)) return;
      const tr = document.createElement('tr');
      const hasKids = n.children && n.children.length;
      const open = filter ? true : (state.expanded.has(n.path) || (depth === 0 && !state.expanded.has('-' + n.path)));
      const tw = hasKids ? `<span class="tw" data-tw="1">${open ? '▾' : '▸'}</span>` : '<span class="tw"></span>';
      const comment = lineComment(n.file, n.line);
      tr.innerHTML = `<td class="name" style="padding-left:${6 + depth * 14}px" title="${esc(n.path + (comment ? ' – ' + comment : ''))}">${tw}${esc(n.display)}</td>` +
        `<td class="val"></td><td class="type">${esc(n.typeName || '')}</td><td class="actc"></td>`;
      body.append(tr);
      if (hasKids) {
        tr.querySelector('[data-tw]').addEventListener('click', () => {
          if (depth === 0) { if (open) state.expanded.add('-' + n.path); else state.expanded.delete('-' + n.path); }
          else if (open) state.expanded.delete(n.path); else state.expanded.add(n.path);
          store.set('expanded', [...state.expanded]);
          renderWatch();
        });
      }
      if (!hasKids && (n.type.k === 'elem' || n.type.k === 'enum')) rows.push(makeRow(tr, n));
      if (hasKids && open) for (const c of n.children) add(c, depth + 1);
    };
    for (const g of plc.tree()) {
      if (!match(g)) continue;
      const tr = document.createElement('tr');
      tr.className = 'group-row';
      const badge = g.path === null ? '' : g.role === 'model' ? 'Anlagenmodell' : g.isTask ? 'Task' : 'Programm';
      tr.innerHTML = `<td colspan="4">${esc(g.display)}${badge ? `<span class="badge">${badge}</span>` : ''}</td>`;
      body.append(tr);
      for (const c of g.children) add(c, 0);
    }
    updateWatch(true);
  }
  function makeRow(tr, n) {
    const plc = state.plc;
    const valTd = tr.querySelector('.val'), act = tr.querySelector('.actc');
    const row = { tr, n, valTd, last: undefined, el: null };
    if (T.isBool(n.type)) {
      const b = document.createElement('button');
      b.className = 'bool';
      b.innerHTML = '<i></i><span></span>';
      b.title = 'Klick: umschalten';
      b.addEventListener('click', () => toggleVar(n.path));
      valTd.append(b);
      row.el = b;
    } else {
      const s = document.createElement('span');
      s.className = 'num';
      s.title = 'Klick: Wert schreiben';
      s.addEventListener('click', () => { if (!n.constant) editInline(s, n.path, n.type); });
      valTd.append(s);
      row.el = s;
    }
    if (!n.constant) {
      const fb = document.createElement('button');
      fb.className = 'fbtn'; fb.textContent = 'F';
      fb.title = 'Forcen: Wert festhalten';
      fb.addEventListener('click', () => {
        if (plc.forces.has(n.path)) plc.unforce(n.path);
        else { try { plc.force(n.path, safeRead(n.path)); } catch (e) { status(e.message, 'bad'); } }
        updateAll(true);
      });
      act.append(fb);
      row.fb = fb;
    }
    return row;
  }
  function updateWatch(force) {
    const plc = state.plc;
    if (!plc || (!$('allVars').open && !force)) return;
    for (const r of rows) {
      const v = safeRead(r.n.path);
      const forced = plc.forces.has(r.n.path);
      if (r.fb) r.fb.classList.toggle('on', forced);
      r.tr.classList.toggle('forced', forced);
      if (v === r.last && !force) continue;
      const changedNow = r.last !== undefined && v !== r.last;
      r.last = v;
      if (T.isBool(r.n.type)) { r.el.classList.toggle('t', !!v); r.el.lastChild.textContent = v ? 'TRUE' : 'FALSE'; }
      else if (r.el.isConnected) r.el.textContent = v === undefined ? '?' : ST.fmtValue(r.n.type, v);
      if (changedNow) { r.valTd.classList.remove('changed'); void r.valTd.offsetWidth; r.valTd.classList.add('changed'); }
    }
  }
  $('allVars').addEventListener('toggle', () => updateWatch(true));

  // ---------- Ablaufplan ----------
  const G = { SW: 64, SH: 44, ACTW: 250, ACTGAP: 24, COLW: 460, SLOT: 290, TOP: 24 };

  function trackStep() {
    const ch = state.charts[state.chartIdx];
    if (!ch) return;
    const v = safeRead(ch.path);
    if (v !== state.lastStep) {
      state.lastStep = v;
      state.stepSince = state.plc.rt.now;
      state.hist = (state.hist || []).concat([{ n: v, t: state.plc.rt.now }]).slice(-14);
      state.stepChanged = true;
    }
  }

  function layout(ch) {
    const steps = new Map(ch.steps.map(s => [s.n, s]));
    const out = new Map();
    for (const s of ch.steps) out.set(s.n, []);
    ch.transitions.forEach((t, i) => { if (out.has(t.from)) out.get(t.from).push(Object.assign(t, { idx: i })); });
    for (const l of out.values()) l.sort((a, b) => a.to - b.to);
    // Ebenen: kürzester Weg vom Initialschritt; Kanten zurück auf gleiche/frühere Ebene = Sprung
    const dist = new Map();
    const bfs = start => {
      if (dist.has(start)) return;
      dist.set(start, start === ch.initial ? 0 : Math.max(0, ...dist.values()) + 1);
      const q = [start];
      while (q.length) {
        const n = q.shift();
        for (const t of out.get(n) || []) if (steps.has(t.to) && !dist.has(t.to)) { dist.set(t.to, dist.get(n) + 1); q.push(t.to); }
      }
    };
    bfs(ch.initial);
    for (const s of ch.steps) bfs(s.n);
    const back = new Set();
    for (const t of ch.transitions) if (!steps.has(t.to) || dist.get(t.to) <= dist.get(t.from)) back.add(t.idx);
    // Feinschliff: längster Pfad über Vorwärtskanten (Zusammenführungen unter die tiefste Quelle)
    const layer = new Map(dist);
    for (let changed = true, guard = 0; changed && guard < 200; guard++) {
      changed = false;
      for (const t of ch.transitions) {
        if (back.has(t.idx)) continue;
        if (layer.get(t.to) < layer.get(t.from) + 1) { layer.set(t.to, layer.get(t.from) + 1); changed = true; }
      }
    }
    const layers = [];
    for (const s of ch.steps) (layers[layer.get(s.n)] = layers[layer.get(s.n)] || []).push(s);
    // Größen
    const actH = s => {
      const m = state.measured && state.measured.get(ch.path + '#' + s.n);
      if (m) return m;
      let rows = s.actions.reduce((a, x) => a + Math.ceil((x.outputs.map(o => o.display).join(' ').length + x.display.length + 6) / 30), 0);
      for (const e of s.entry) rows += 1 + e.text.reduce((a, t) => a + Math.ceil(t.length / 34), 0);
      return rows ? Math.max(G.SH, rows * 19 + 10) : 0;
    };
    const condLines = t => Math.ceil(t.condsText.join(' AND ').length / 30) || 1;
    const pos = new Map();
    let y = G.TOP + (ch.globalTrans.length ? 64 : 0);
    const layerInfo = [];
    layers.forEach((L, li) => {
      if (!L) return;
      L.sort((a, b) => a.n - b.n);
      let rowH = G.SH;
      L.forEach((s, i) => {
        const h = actH(s);
        rowH = Math.max(rowH, h);
        pos.set(s.n, { x: (i - (L.length - 1) / 2) * G.COLW, y, actH: h, layer: li });
      });
      let lines = 1;
      for (const s of L) for (const t of out.get(s.n)) lines = Math.max(lines, condLines(t));
      const gap = Math.max(100, 58 + lines * 19 + (L.some(s => out.get(s.n).some(t => back.has(t.idx))) ? 40 : 0));
      layerInfo[li] = { y, bottom: y + rowH, gap };
      y += rowH + gap;
    });
    // Abzweige
    const edges = [];
    for (const s of ch.steps) {
      const p = pos.get(s.n), li = layerInfo[p.layer];
      const list = out.get(s.n);
      const used = [];
      const fwd = list.filter(t => !back.has(t.idx) && pos.has(t.to));
      const jumps = list.filter(t => back.has(t.idx) || !pos.has(t.to));
      for (const t of fwd) {
        let bx = list.length === 1 ? p.x : pos.get(t.to).x;
        while (used.some(u => Math.abs(u - bx) < 60)) bx += G.SLOT;
        used.push(bx);
        edges.push({ t, from: s.n, bx, jump: false });
      }
      let k = 0;
      for (const t of jumps) {
        let bx;
        if (list.length === 1) bx = p.x;
        else {
          const cands = [];
          for (let d = 1; d < 6; d++) cands.push(p.x - d * G.SLOT, p.x + d * G.SLOT);
          cands.unshift(p.x);
          bx = cands.find(c => !used.some(u => Math.abs(u - c) < 60));
        }
        used.push(bx); k++;
        edges.push({ t, from: s.n, bx, jump: true });
      }
      p.yDiv = li.bottom + 12;
      p.yBar = li.bottom + 34;
    }
    // Verschieben in den positiven Bereich
    let minX = Infinity, maxX = -Infinity;
    for (const p of pos.values()) { minX = Math.min(minX, p.x - G.SW / 2 - 90); maxX = Math.max(maxX, p.x + G.SW / 2 + G.ACTGAP + G.ACTW); }
    for (const e of edges) { minX = Math.min(minX, e.bx - 250); maxX = Math.max(maxX, e.bx + 250); }
    const dx = 24 - minX;
    for (const p of pos.values()) p.x += dx;
    for (const e of edges) e.bx += dx;
    return { pos, edges, layerInfo, W: maxX - minX + 48, H: y + 20 };
  }

  function condHtml(ch, conds) {
    // Ausdruck mit anklickbaren Variablen
    const chips = [];
    const wrap = (node, text) => {
      const p = ch.pathOf(node);
      if (!p) return text;
      chips.push(`<button class="chip" data-path="${esc(p)}" title="${esc(p)}">${esc(text)}<span class="v"></span></button>`);
      return '\u0001' + (chips.length - 1) + '\u0002';
    };
    const parts = conds.map(c => {
      if (!c.e) return c.text;
      const txt = ST.exprText(c.e, wrap);
      if (!c.neg) return txt;
      const simple = c.e.e === 'id' || c.e.e === 'member';
      return 'NOT ' + (simple ? txt : '(' + txt + ')');
    });
    return esc(parts.join(' AND ') || 'TRUE').replace(/\u0001(\d+)\u0002/g, (m, i) => chips[+i]);
  }

  function renderChart() {
    const stage = $('chartStage');
    const sel = $('selChart');
    const chs = state.charts;
    sel.hidden = chs.length < 2;
    sel.innerHTML = chs.map((c, i) => `<option value="${i}">${esc(c.path)}</option>`).join('');
    sel.value = String(state.chartIdx);
    const ch = chs[state.chartIdx];
    state.chartEls = null;
    if (!state.plc) {
      $('chartTitle').textContent = 'Ablaufplan';
      stage.innerHTML = '<div class="chart-empty">Noch kein Programm geladen. Im Bereich <b>Code</b> ein Programm eingeben und <b>Übersetzen</b> drücken.</div>';
      stage.style.width = stage.style.height = '';
      return;
    }
    if (!ch) {
      $('chartTitle').textContent = 'Ablaufplan';
      stage.innerHTML = `<div class="chart-empty"><p>In diesem Programm wurde keine Schrittkette erkannt.</p><p>Erkannt wird das übliche Muster einer Schrittkette in ST: eine Ganzzahl-Variable als Schrittmerker, ein <code>CASE iStep OF</code> mit den Schritten als Marken und darin Weiterschaltungen wie <code>IF E1 THEN iStep := 2; END_IF</code>. Aktionen werden über Zuweisungen wie <code>Motor := (iStep = 3);</code> zugeordnet.</p><p>Die Ein- und Ausgänge rechts lassen sich trotzdem schalten.</p></div>`;
      stage.style.width = stage.style.height = '';
      return;
    }
    $('chartTitle').textContent = `Ablaufplan ${ch.pou}.${ch.varName}`;
    const L = layout(ch);
    state.layout = L;
    let svg = `<svg width="${L.W}" height="${L.H}" viewBox="0 0 ${L.W} ${L.H}">`;
    let html = '';
    const bars = [];
    // Kanten
    for (const e of L.edges) {
      const p = L.pos.get(e.from);
      const sx = p.x, sy = p.y + G.SH;
      let d = `M${sx},${sy} V${p.yDiv}`;
      if (e.bx !== sx) d += ` H${e.bx}`;
      if (e.jump) {
        d += ` V${p.yBar + 34}`;
        svg += `<path class="ln" d="${d}"/><path class="arrow" d="M${e.bx - 6},${p.yBar + 30} L${e.bx + 6},${p.yBar + 30} L${e.bx},${p.yBar + 40} Z"/>`;
        html += `<div class="jump" style="left:${e.bx - 60}px;top:${p.yBar + 44}px;width:120px;text-align:center">Sprung zu ${esc(e.t.to)}</div>`;
      } else {
        const q = L.pos.get(e.t.to);
        d += ` V${q.y - 16} H${q.x} V${q.y}`;
        svg += `<path class="ln" d="${d}"/>`;
      }
      bars.push({ e, x: e.bx, y: p.yBar });
      svg += `<line class="bar" data-t="${e.t.idx}" x1="${e.bx - 14}" x2="${e.bx + 14}" y1="${p.yBar}" y2="${p.yBar}"/>`;
      const left = e.bx < sx - 10;
      const style = left ? `right:${L.W - (e.bx - 18)}px;top:${p.yBar - 11}px` : `left:${e.bx + 18}px;top:${p.yBar - 11}px`;
      html += `<div class="cond${left ? ' left' : ''}" data-t="${e.t.idx}" style="${style}" title="Zeile ${e.t.line}">${condHtml(ch, e.t.conds)}</div>`;
    }
    svg += '</svg>';
    // Rücksprung-Hinweise am Ziel
    const into = new Map();
    for (const e of L.edges) if (e.jump) into.set(e.t.to, (into.get(e.t.to) || []).concat([e.from]));
    // Schritte und Aktionen
    for (const s of ch.steps) {
      const p = L.pos.get(s.n);
      html += `<div class="step${s.n === ch.initial ? ' init' : ''}" data-step="${s.n}" title="Schritt ${s.n} – Klick: Schritt direkt setzen" style="left:${p.x - G.SW / 2}px;top:${p.y}px;width:${G.SW}px;height:${G.SH}px">${s.n}<span class="since"></span></div>`;
      if (into.has(s.n)) html += `<div class="from-hint" style="right:${L.W - (p.x - G.SW / 2 - 10)}px;top:${p.y + 13}px">von ${into.get(s.n).join(', ')} →</div>`;
      if (p.actH) {
        let rows = '';
        for (const a of s.actions) {
          const outs = a.outputs.length
            ? a.outputs.map(o => `<span class="lamp" data-lamp="${esc(o.path)}"></span>${esc(o.display)}`).join(' ') + ` <span class="out">(${esc(a.display)})</span>`
            : `<span class="lamp" data-lamp="${esc(a.path)}"></span>${esc(a.display)}`;
          rows += `<div class="arow"><span class="q">N</span><span class="an">${outs}</span></div>`;
        }
        for (const en of s.entry) rows += `<div class="arow"><span class="q" title="${esc(en.label)}">${en.label === 'Eingang' ? 'E' : '?'}</span><span class="entry">${en.label === 'Eingang' ? 'beim Eintritt: ' : esc(en.label) + ': '}${esc(en.text.join('; '))}</span></div>`;
        html += `<div class="act" data-act="${s.n}" style="left:${p.x + G.SW / 2 + G.ACTGAP}px;top:${p.y}px;width:${G.ACTW}px;min-height:${G.SH}px">${rows}</div>`;
        svg = svg.replace('</svg>', `<line class="ln" x1="${p.x + G.SW / 2}" x2="${p.x + G.SW / 2 + G.ACTGAP}" y1="${p.y + G.SH / 2}" y2="${p.y + G.SH / 2}"/></svg>`);
      }
    }
    // Transitionen aus jedem Schritt (z.B. Reset)
    if (ch.globalTrans.length) {
      html += `<div class="gtrans" id="gtrans">` + ch.globalTrans.map((t, i) =>
        `<div data-g="${i}"><b>Aus jedem Schritt → ${esc(t.to)}</b> wenn ${condHtml(ch, t.conds)}</div>`).join('') + '</div>';
    }
    stage.innerHTML = `<div class="chart-canvas" id="chartCanvas" style="width:${L.W}px;height:${L.H}px">${svg}${html}</div>`;
    stage.querySelectorAll('.chip').forEach(c => {
      const path = c.dataset.path;
      const ref = refOf(path);
      if (!ref) { c.classList.add('ro'); return; }
      if (!T.isBool(ref.t)) { c.classList.add('num'); return; }
      if (!ref.set) { c.classList.add('ro'); return; }
      if (ref.info && ref.info.plcWrites) c.title = `${path} wird vom Programm berechnet – Klick setzt und hält den Wert (lösen im Bedienfeld)`;
      else c.title = `${path} – Klick: umschalten`;
      c.addEventListener('click', ev => { ev.stopPropagation(); toggleVar(path); });
    });
    stage.querySelectorAll('.step').forEach(el => el.addEventListener('click', () => {
      const n = +el.dataset.step;
      writeVar(ch.path, n);
      trackStep();
      status(`${ch.path} := ${n} gesetzt.`);
    }));
    state.chartEls = {
      steps: new Map([...stage.querySelectorAll('.step')].map(e => [+e.dataset.step, e])),
      acts: new Map([...stage.querySelectorAll('.act')].map(e => [+e.dataset.act, e])),
      bars: [...stage.querySelectorAll('line.bar')],
      conds: [...stage.querySelectorAll('.cond')],
      chips: [...stage.querySelectorAll('.chip')],
      lamps: [...stage.querySelectorAll('[data-lamp]')],
      gtrans: [...stage.querySelectorAll('[data-g]')],
    };
    applyZoom();
    // tatsächliche Höhen der Aktionsboxen messen und bei Abweichung einmal neu auslegen
    if (!state.remeasuring) {
      state.measured = state.measured || new Map();
      let redo = false;
      for (const s of ch.steps) {
        const el = state.chartEls.acts.get(s.n), p = L.pos.get(s.n);
        if (!el || !el.offsetHeight) continue;
        if (Math.abs(el.offsetHeight - p.actH) > 2) { state.measured.set(ch.path + '#' + s.n, el.offsetHeight); redo = true; }
      }
      if (redo) { state.remeasuring = true; renderChart(); state.remeasuring = false; updateAll(true); }
    }
  }

  function updateChart() {
    const ch = state.charts[state.chartIdx], els = state.chartEls;
    if (!ch || !els || !state.plc) return;
    const cur = safeRead(ch.path);
    const ctx = ch.ctx();
    for (const [n, el] of els.steps) {
      const on = n === cur;
      el.classList.toggle('active', on);
      if (on) {
        const dt = state.plc.rt.now - (state.stepSince || 0);
        el.lastChild.textContent = (dt / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';
      }
    }
    for (const [n, el] of els.acts) el.classList.toggle('active', n === cur);
    const truth = new Map();
    for (const t of ch.transitions) {
      if (t.from !== cur || !t.eval) continue;
      let v = false;
      try { v = t.eval(ctx); } catch (e) { /* ignorieren */ }
      truth.set(t.idx, v);
    }
    for (const b of els.bars) {
      const v = truth.get(+b.dataset.t);
      b.classList.toggle('go', v === true);
      b.classList.toggle('wait', v === false);
    }
    for (const c of els.conds) {
      const v = truth.get(+c.dataset.t);
      c.classList.toggle('go', v === true);
      c.classList.toggle('wait', v === false);
    }
    ch.globalTrans.forEach((t, i) => {
      let v = false;
      try { v = t.eval ? t.eval(ctx) : false; } catch (e) { /* */ }
      if (els.gtrans[i]) els.gtrans[i].parentElement.classList.toggle('go', v);
    });
    for (const c of els.chips) {
      const v = safeRead(c.dataset.path);
      if (c.classList.contains('num')) c.lastChild.textContent = v === undefined ? '' : ST.fmtValue(refOf(c.dataset.path).t, v);
      else c.classList.toggle('t', !!v);
      c.style.borderColor = state.plc.forces.has(c.dataset.path) ? 'var(--force)' : '';
    }
    for (const l of els.lamps) l.classList.toggle('on', !!safeRead(l.dataset.lamp));
    // Verlauf
    const hist = state.hist || [];
    $('stepHist').innerHTML = hist.length
      ? hist.map((h, i) => `<span class="hs${i === hist.length - 1 ? ' cur' : ''}" title="t = ${T.formatTime(h.t).slice(2)}">${esc(h.n)}</span>`).join('→')
      : '';
    if (state.stepChanged && $('chkFollow').checked) {
      const el = els.steps.get(cur);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    state.stepChanged = false;
  }

  function applyZoom() {
    const L = state.layout, cv = $('chartCanvas');
    if (!L || !cv) return;
    const z = state.zoom || 1;
    cv.style.transform = `scale(${z})`;
    cv.style.transformOrigin = '0 0';
    $('chartStage').style.width = L.W * z + 'px';
    $('chartStage').style.height = L.H * z + 'px';
    $('btnZoomFit').textContent = Math.round(z * 100) + ' %';
  }
  function fitChart() {
    const L = state.layout, sc = $('chartScroll');
    if (!L || !sc.clientWidth) return;
    state.zoom = Math.max(0.4, Math.min(1, (sc.clientWidth - 8) / L.W));
    applyZoom();
  }
  $('btnZoomIn').addEventListener('click', () => { state.zoom = Math.min(2, (state.zoom || 1) * 1.15); applyZoom(); });
  $('btnZoomOut').addEventListener('click', () => { state.zoom = Math.max(0.3, (state.zoom || 1) / 1.15); applyZoom(); });
  $('btnZoomFit').addEventListener('click', fitChart);
  $('selChart').addEventListener('change', e => { state.chartIdx = +e.target.value; state.hist = []; state.lastStep = undefined; renderChart(); fitChart(); trackStep(); updateAll(true); });

  // ---------- Gesamtaktualisierung ----------
  function renderAllViews() { renderChart(); renderIO(); renderWatch(); updateSourceUi(); updateAll(true); }
  let lastUpd = 0;
  function updateAll(force) {
    const now = performance.now();
    if (!force && now - lastUpd < 60) return;
    lastUpd = now;
    updateClock();
    if (state.mode !== 'sim' && !force) return;
    if (state.plc && state.lastStep === undefined) trackStep();
    updateChart(); updateIO(); updateWatch(force);
  }

  // ---------- Tests ----------
  function runAllTests(only) {
    const plc = new ST.PLC(sources(), { cycleMs: cycleMs() });
    if (!plc.ok) { showDiagnostics(plc.diags, []); status('Tests nicht möglich: Programm enthält Fehler.', 'bad'); setMode('code'); return; }
    if (!eds.tests.value.trim()) { status('Die Testdatei ist leer – im Bereich Code unter „Tests“ Testfälle schreiben (siehe Hilfe).', 'bad'); setMode('code'); selectEditor('tests'); return; }
    status('Tests laufen …');
    const t0 = performance.now();
    let r;
    try { r = ST.runTests(plc, eds.tests.value, { file: FILES.tests, trace: $('chkTrace').checked ? true : null, only }); }
    catch (e) { status('Interner Fehler: ' + e.message, 'bad'); console.error(e); return; }
    showDiagnostics(plc.diags, r.diags);
    if (only && state.results) {
      const map = new Map(r.results.map(x => [x.name, x]));
      state.results.results = state.results.results.map(x => map.get(x.name) || x);
    } else state.results = r;
    const res = state.results.results;
    const fail = res.filter(x => x.status !== 'pass').length;
    const errs = r.diags.filter(d => d.kind === 'error').length;
    if (errs) status(`Testdatei enthält ${errs} Fehler – siehe Code › Meldungen.`, 'bad');
    else status(`${res.length - fail}/${res.length} Tests bestanden (${Math.round(performance.now() - t0)} ms Rechenzeit)${state.modelOn ? ' · mit Anlagenmodell' : ''}`, fail ? 'bad' : 'ok');
    if (!state.selTest || !res.some(x => x.name === state.selTest)) {
      const firstFail = res.find(x => x.status !== 'pass');
      state.selTest = firstFail ? firstFail.name : null;
    }
    setMode('tests');
    renderResults();
  }

  function renderResults() {
    const list = $('testList');
    list.innerHTML = '';
    const r = state.results;
    const cnt = $('cntResults');
    if (!r || !r.results.length) {
      cnt.hidden = true;
      $('testSummary').textContent = '';
      list.innerHTML = `<li class="empty">Noch keine Ergebnisse. Testfälle stehen in der Testdatei (Code › Tests). <b>Alle Tests ausführen</b> startet jeden Test mit einem Kaltstart in simulierter Zeit – unabhängig von der laufenden Simulation.${state.modelOn ? ' Das Anlagenmodell ist aktiv und läuft in den Tests mit.' : ''}</li>`;
      $('traceBox').hidden = true;
      return;
    }
    const pass = r.results.filter(x => x.status === 'pass').length, fail = r.results.length - pass;
    cnt.hidden = false; cnt.textContent = fail ? fail : pass; cnt.className = 'count ' + (fail ? 'bad' : 'ok');
    $('testSummary').innerHTML = `<span class="p">${pass} bestanden</span>${fail ? `<span class="f">${fail} fehlgeschlagen</span>` : ''}`;
    for (const t of r.results) {
      const li = document.createElement('li');
      const sym = { pass: '✓', fail: '✗', error: '!' }[t.status];
      const sel = state.selTest === t.name;
      let html = `<div class="trow${sel ? ' sel' : ''}"><span class="st ${t.status}">${sym}</span><span class="tname">${esc(t.name)}</span>` +
        `<span class="tmeta">${t.cycles.toLocaleString('de-DE')} Zyklen · ${T.formatTime(t.simTime).slice(2)} · ${t.asserts} Prüfungen <button class="btn small" data-run="1" title="Nur diesen Test ausführen">▶</button></span>`;
      if (t.msg) html += `<div class="tmsg">${esc(t.msg)}${t.loc ? ` <a href="#" data-loc="1">[${esc(t.loc.file)}:${t.loc.line}]</a>` : ''}</div>`;
      if (t.warning) html += `<div class="tlog">⚠ ${esc(t.warning)}</div>`;
      if (sel && t.log.length) html += `<div class="tlog">${t.log.map(l => `@${T.formatTime(l.time).slice(2)}  ${esc(l.text)}`).join('\n')}</div>`;
      html += '</div>';
      li.innerHTML = html;
      li.querySelector('.trow').addEventListener('click', e => {
        if (e.target.closest('[data-run]')) { e.stopPropagation(); state.selTest = t.name; runAllTests([t.name]); return; }
        if (e.target.closest('[data-loc]')) { e.preventDefault(); jumpTo(t.loc.file, t.loc.line, t.loc.col); return; }
        state.selTest = sel ? null : t.name;
        renderResults();
      });
      list.append(li);
    }
    renderTrace();
  }

  function renderTrace() {
    const box = $('traceBox');
    const t = state.results && state.results.results.find(x => x.name === state.selTest);
    if (!t || !t.trace) { box.hidden = true; return; }
    const sigs = t.trace.signals.filter(s => s.pts.length > 1).slice(0, 60);
    box.hidden = false;
    if (!sigs.length) { box.innerHTML = '<h3>Zeitdiagramm</h3><div class="empty">Keine Signaländerungen aufgezeichnet.</div>'; return; }
    const end = Math.max(t.trace.end, 1);
    const labelW = 210, rowH = 22, top = 24;
    const avail = Math.max(320, (box.clientWidth || 700) - 32 - labelW);
    const plotW = Math.max(avail, Math.min(6000, end / 20));
    const W = labelW + plotW + 10, H = top + sigs.length * rowH + 6;
    const x = ms => labelW + (ms / end) * plotW;
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Zeitdiagramm">`;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000, 600000];
    const stepMs = nice.find(s => (s / end) * plotW >= 70) || 600000;
    for (let ms = 0; ms <= end; ms += stepMs) {
      svg += `<line x1="${x(ms)}" x2="${x(ms)}" y1="${top - 6}" y2="${H}" stroke="var(--line)" stroke-width="1"/>`;
      svg += `<text x="${x(ms) + 3}" y="${top - 10}" class="lbl">${T.formatTime(ms).slice(2)}</text>`;
    }
    if (t.status !== 'pass') svg += `<line x1="${x(t.simTime)}" x2="${x(t.simTime)}" y1="${top - 6}" y2="${H}" stroke="var(--bad)" stroke-width="2"/>`;
    sigs.forEach((s, i) => {
      const y0 = top + i * rowH;
      svg += `<text x="4" y="${y0 + 15}">${esc(s.path.length > 27 ? '…' + s.path.slice(-26) : s.path)}</text>`;
      svg += `<line x1="${labelW}" x2="${labelW + plotW}" y1="${y0 + rowH}" y2="${y0 + rowH}" stroke="var(--surface-2)"/>`;
      if (s.bool) {
        const hi = y0 + 4, lo = y0 + rowH - 4;
        let d = '', area = '';
        s.pts.forEach((p, j) => {
          const nx = j + 1 < s.pts.length ? s.pts[j + 1].time : end;
          const yy = p.v ? hi : lo;
          d += (j === 0 ? `M${x(p.time)},${yy}` : `V${yy}`) + `H${x(nx)}`;
          if (p.v) area += `<rect x="${x(p.time)}" y="${hi}" width="${Math.max(0.5, x(nx) - x(p.time))}" height="${lo - hi}" fill="var(--ok)" opacity="0.18"/>`;
        });
        svg += area + `<path d="${d}" fill="none" stroke="var(--ok)" stroke-width="1.5"/>`;
      } else {
        s.pts.forEach((p, j) => {
          const nx = j + 1 < s.pts.length ? s.pts[j + 1].time : end;
          const x1 = x(p.time), x2 = x(nx), w = x2 - x1;
          svg += `<path d="M${x1},${y0 + rowH / 2} L${x1 + 3},${y0 + 4} H${Math.max(x1 + 3, x2 - 3)} L${x2},${y0 + rowH / 2} L${Math.max(x1 + 3, x2 - 3)},${y0 + rowH - 4} H${x1 + 3} Z" fill="var(--sel)" stroke="var(--accent)" stroke-width="1"/>`;
          const label = p.s.replace(/^T#/, '');
          if (w > label.length * 6.8 + 8) svg += `<text x="${x1 + 5}" y="${y0 + 15}">${esc(label)}</text>`;
        });
      }
    });
    svg += '</svg>';
    box.innerHTML = `<h3>Zeitdiagramm · ${esc(t.name)}</h3><div class="trace-wrap">${svg}</div>`;
  }

  // ---------- Dateien ----------
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const target = /\.sttest$/i.test(f.name) ? 'tests' : state.activeEd;
      eds[target].value = String(r.result);
      FILES[target] = f.name;
      selectEditor(target);
      changed(target);
      status(`${f.name} geladen.`);
    };
    r.readAsText(f);
    e.target.value = '';
  });
  $('btnCopy').addEventListener('click', () => {
    const ta = eds[state.activeEd].ta;
    const fallback = () => { ta.select(); status('Text markiert – mit Strg/Cmd+C kopieren.'); };
    try { navigator.clipboard.writeText(ta.value).then(() => status('In die Zwischenablage kopiert.', 'ok'), fallback); }
    catch (e) { fallback(); }
  });
  const isLocal = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  $('btnSave').hidden = !isLocal;
  function download() {
    const blob = new Blob([eds[state.activeEd].value], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = FILES[state.activeEd].split('/').pop();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function save() {
    if (!state.server) { download(); return; }
    const k = state.activeEd, name = FILES[k];
    try {
      const r = await fetch('/api/file/' + encodeURIComponent(name), { method: 'PUT', body: eds[k].value });
      if (!r.ok) throw new Error(await r.text());
      status(`${name} gespeichert.`, 'ok');
      refreshServerFiles();
    } catch (e) { status(`Speichern fehlgeschlagen: ${e.message}`, 'bad'); }
  }
  $('btnSave').addEventListener('click', save);

  async function serverText(name) {
    const r = await fetch('/api/file/' + encodeURIComponent(name));
    if (!r.ok) throw new Error(await r.text());
    return r.text();
  }
  async function refreshServerFiles() {
    const files = await (await fetch('/api/files')).json();
    $('selServerFile').innerHTML = '<option value="">Datei öffnen…</option>' + files.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  }
  $('selServerFile').addEventListener('change', async e => {
    const name = e.target.value;
    e.target.value = '';
    if (!name) return;
    try {
      const txt = await serverText(name);
      const target = /\.sttest$/i.test(name) ? 'tests' : (state.activeEd === 'tests' ? 'prog' : state.activeEd);
      eds[target].value = txt;
      FILES[target] = name;
      store.set('files', FILES);
      selectEditor(target);
      changed(target);
      status(`${name} geöffnet${target === 'model' ? ' (als Anlagenmodell)' : ''}. Strg/Cmd+S speichert zurück.`);
    } catch (err) { status(`Öffnen fehlgeschlagen: ${err.message}`, 'bad'); }
  });

  // ---------- Beispiele ----------
  const sel = $('selExample');
  EXAMPLES.forEach((ex, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = ex.name; sel.append(o); });
  sel.addEventListener('change', () => { const ex = EXAMPLES[+sel.value]; sel.value = ''; if (ex) loadExample(ex); });
  async function loadExample(ex) {
    stop();
    if (state.server && ex.files) {
      ex = Object.assign({}, ex);
      for (const k of ['prog', 'model', 'tests']) {
        if (ex.files[k] && ex[k]) { try { ex[k] = await serverText(ex.files[k]); } catch (e) { /* eingebetteter Stand */ } }
      }
    }
    eds.prog.value = ex.prog || '';
    eds.model.value = ex.model || '';
    eds.tests.value = ex.tests || '';
    Object.assign(FILES, ex.files || {});
    state.modelOn = !!ex.modelOn;
    store.set('modelOn', state.modelOn);
    for (const k of Object.keys(eds)) store.set('src.' + k, eds[k].value);
    store.set('files', FILES);
    state.plc = null; state.results = null; state.selTest = null;
    renderResults();
    if (compile()) status(`Beispiel „${ex.name}“ geladen.`, 'ok');
  }

  // ---------- Bedienung ----------
  $('btnCompile').addEventListener('click', () => compile());
  $('btnRun').addEventListener('click', run);
  $('btnStop').addEventListener('click', stop);
  $('btnStep').addEventListener('click', step);
  $('btnReset').addEventListener('click', coldStart);
  $('btnTests').addEventListener('click', () => runAllTests());
  $('btnEditTests').addEventListener('click', () => { setMode('code'); selectEditor('tests'); });
  $('btnUnforce').addEventListener('click', () => { if (state.plc) { state.plc.unforceAll(); updateAll(true); status('Alle Forcings aufgehoben.'); } });
  $('watchFilter').addEventListener('input', () => renderWatch());
  $('inpCycle').addEventListener('change', () => { if (state.plc) state.plc.cycleMs = cycleMs(); store.set('cycle', cycleMs()); });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) runAllTests(); else compile(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (isLocal) save(); }
  });
  window.addEventListener('resize', () => { if (state.mode === 'tests') renderTrace(); });

  // ---------- Hilfe ----------
  $('helpBox').innerHTML = `
<h2>Ablauf</h2>
<p>Programm unter <b>Programm</b> eingeben (CODESYS-Syntax). Fehler werden beim Tippen geprüft und am Zeilenrand markiert. <b>Übersetzen</b> lädt das Programm und wechselt in die Simulation.</p>
<h2>Simulation</h2>
<p>Der <b>Ablaufplan</b> wird aus dem Code erkannt (<code>CASE iStep OF</code> mit <code>iStep := n</code>). Der aktive Schritt ist blau, die Transitionen des aktiven Schritts sind gelb (wartet) oder grün (erfüllt). Variablen in den Bedingungen sind anklickbar. Klick auf einen Schritt setzt die Kette direkt dorthin.</p>
<p>Rechts unter <b>Eingänge</b> schaltest du Sensoren und Taster. Vom Programm berechnete Variablen (z.B. <code>xAuto</code>) werden beim Anklicken <i>geforct</i> – erneuter Klick hebt das auf.</p>
<p><b>Grundstellung aus SETUP</b>: Beim Übersetzen und Kaltstart wird der SETUP-Block der Testdatei ausgeführt, z.B. Öffner und Endlagen auf TRUE.</p>
<h2>Testdatei</h2>
<pre>SETUP                       (* vor jedem Test *)
    E9 := TRUE;             (* Öffner *)
END_SETUP

TEST 'Motor startet nach 2 s'
VAR n : INT; END_VAR
    Start := TRUE;
    CYCLE;                  (* 1 SPS-Zyklus *)
    CYCLE 5;                (* 5 Zyklen *)
    WAIT T#2s;              (* 2 s Anlagenzeit *)
    ASSERT Motor, 'Motor muss laufen';
    ASSERT PLC_PRG.iStep = 3;
    RUN_UNTIL Lampe TIMEOUT T#10s;
    LOG 'Zähler:', PLC_PRG.n;
END_TEST</pre>
<h2>Anlagenmodell</h2>
<p>Ein zweites ST-Programm, das die Maschine nachbildet: Es liest die Ausgänge und setzt die Sensoren. Es läuft in jedem Zyklus vor dem SPS-Programm; <code>TIME()</code> liefert die Simulationszeit. Umschalten unter Simulation › Sensoren.</p>
<h2>Sprachumfang</h2>
<p>PROGRAM, FUNCTION_BLOCK, FUNCTION, VAR_GLOBAL, TYPE (STRUCT, Aufzählung), ARRAY, STRING, alle Ganzzahl-Typen, REAL/LREAL, TIME, Bitzugriff <code>x.3</code>, IF/CASE/FOR/WHILE/REPEAT. Standard-FBs TON, TOF, TP, R_TRIG, F_TRIG, CTU, CTD, CTUD, SR, RS und die üblichen Funktionen.</p>
<h2>Tastatur</h2>
<table>
<tr><td><code>Strg/Cmd + Enter</code></td><td>Übersetzen</td></tr>
<tr><td><code>Strg/Cmd + Umschalt + Enter</code></td><td>Alle Tests ausführen</td></tr>
<tr><td><code>Strg/Cmd + S</code></td><td>Speichern (localhost)</td></tr>
</table>`;

  // ---------- Start ----------
  if (/^https?:$/.test(location.protocol) && isLocal) {
    try {
      const r = await fetch('/api/files');
      if (r.ok) {
        state.server = true;
        $('btnOpen').hidden = true;
        $('selServerFile').hidden = false;
        await refreshServerFiles();
      }
    } catch (e) { /* ohne Server */ }
  }
  Object.assign(FILES, store.get('files', {}));
  $('inpCycle').value = store.get('cycle', 10);
  $('chkSetup').checked = store.get('setup', true);
  setMode(state.mode);
  selectEditor('prog');
  const savedProg = store.get('src.prog', null);
  if (savedProg !== null && savedProg.trim()) {
    eds.prog.value = savedProg;
    eds.model.value = store.get('src.model', '');
    eds.tests.value = store.get('src.tests', '');
    if (compile()) status('Letzter Stand wiederhergestellt.');
  } else if (EXAMPLES.length) {
    await loadExample(EXAMPLES[0]);
  }
  updateSourceUi();
  renderResults();
  setLeds();
})();
