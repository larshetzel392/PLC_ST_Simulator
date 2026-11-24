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
    dismissedErr.clear();
    let plc;
    try { plc = new ST.PLC(sources(), { cycleMs: cycleMs() }); }
    catch (e) { console.error(e); return null; }
    let tdiags = [];
    if (plc.ok && eds.tests.value.trim()) {
      try { tdiags = ST.runTests(plc, eds.tests.value, { file: FILES.tests, only: [] }).diags; } catch (e) { console.error(e); }
    }
    tdiags = mismatch(tdiags, FILES.tests, 'Die Testdatei', 'clearTests');
    const cd = plc.diags.filter(d => d.file !== FILES.model);
    const md = mismatch(plc.diags.filter(d => d.file === FILES.model), FILES.model, 'Das Anlagenmodell', 'modelOff');
    showDiagnostics(cd.concat(md), tdiags);
    return plc;
  }

  // Gehört Testdatei/Anlagenmodell offensichtlich zu einem anderen Programm (viele unbekannte Namen),
  // statt hunderter Einzelfehler einen Hinweis mit Abhilfe zeigen
  function mismatch(diags, file, what, action) {
    const unknown = diags.filter(d => d.kind === 'error' && /nicht deklariert|hat kein Element|Unbekannte/.test(d.msg));
    if (unknown.length < 5 || unknown.length < diags.filter(d => d.kind === 'error').length / 2) return diags;
    const names = [...new Set(unknown.map(d => (/'([^']+)'/.exec(d.msg) || [])[1]).filter(Boolean))];
    return [{
      kind: 'error', file, line: 0, col: 0, action,
      msg: `${what} passt nicht zu diesem Programm – ${names.length} unbekannte Namen (z.B. ${names.slice(0, 4).join(', ')}). Vermutlich stammt sie vom vorherigen Programm.`,
    }];
  }

  // Gelöschte Meldungen: Warnungen bleiben weg (Schlüssel ohne Zeile, damit sie beim Tippen nicht zurückkommen),
  // Fehler nur bis zur nächsten Prüfung
  const dismissed = new Set(store.get('dismissed', []));
  const dismissedErr = new Set();
  const diagKey = d => `${d.file}|${d.kind}|${d.msg}`;
  function isDismissed(d) { const k = diagKey(d); return d.kind === 'error' ? dismissedErr.has(k) : dismissed.has(k); }
  function dismiss(list) {
    for (const d of list) (d.kind === 'error' ? dismissedErr : dismissed).add(diagKey(d));
    store.set('dismissed', [...dismissed]);
    showDiagnostics(state.compileDiags, state.testDiags);
  }

  function showDiagnostics(cdiags, tdiags) {
    state.compileDiags = cdiags; state.testDiags = tdiags;
    const raw = cdiags.concat(tdiags);
    const all = raw.filter(d => !isDismissed(d));
    const hiddenWarn = raw.filter(d => d.kind !== 'error' && isDismissed(d)).length;
    const hiddenErr = raw.length - all.length - hiddenWarn;
    $('diagTools').hidden = !raw.length;
    $('diagHidden').textContent = (hiddenWarn || hiddenErr) ? `${hiddenWarn + hiddenErr} gelöscht` : '';
    $('btnDiagRestore').hidden = !dismissed.size && !dismissedErr.size;
    $('btnDiagClear').hidden = !all.length;
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
      ul.innerHTML = raw.length
        ? '<li style="cursor:default"><span class="k info">Leer</span><span class="where"></span><span class="msg">Alle Meldungen gelöscht.</span></li>'
        : '<li style="cursor:default"><span class="k info">OK</span><span class="where"></span><span class="msg">Keine Fehler oder Warnungen.</span></li>';
      return;
    }
    const sorted = all.slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'error' ? -1 : 1));
    for (const d of sorted) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="k ${d.kind}">${d.kind === 'error' ? 'Fehler' : 'Warnung'}</span><span class="where">${esc(d.file || '')}${d.line ? ':' + d.line : ''}</span><span class="msg">${esc(d.msg)}</span>`;
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '×';
      del.title = d.kind === 'error' ? 'Löschen (kommt wieder, solange der Fehler im Code besteht)' : 'Warnung löschen';
      del.setAttribute('aria-label', 'Meldung löschen');
      del.addEventListener('click', e => { e.stopPropagation(); dismiss([d]); });
      li.append(del);
      if (d.action) {
        const fix = document.createElement('button');
        fix.className = 'btn small fix';
        fix.textContent = d.action === 'clearTests' ? 'Testdatei leeren' : 'Anlagenmodell ausschalten';
        fix.addEventListener('click', e => {
          e.stopPropagation();
          if (d.action === 'clearTests') { eds.tests.value = ''; store.set('src.tests', ''); changed('tests'); status('Testdatei geleert.', 'ok'); }
          else { setSource(false); }
          liveCheck(); updateSourceUi();
        });
        li.querySelector('.msg').append(document.createElement('br'), fix);
      }
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
    const prevTitle = curChart() && curChart().title;
    state.charts = ST.extractCharts(plc);
    const keep = state.charts.findIndex(c => c.title === prevTitle);
    state.chartIdx = keep >= 0 ? keep : 0;
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
      // keine globalen Variablen: Variablen der Task-Programme nehmen
      // (gelesen, aber nie beschrieben = Eingang; vom Programm beschrieben = Ausgang/Merker)
      for (const t of state.plc.tasks) {
        const p = comp.pous.get(t);
        if (p.role === 'model') continue;
        for (const v of p.vars.values()) {
          if (v.constant || !(v.type.k === 'elem' || v.type.k === 'enum') || v.section === 'VAR_TEMP') continue;
          const item = { path: p.display + '.' + v.display, info: v };
          const addr = (v.address || '').toUpperCase();
          if (addr.startsWith('%I') || v.section === 'VAR_INPUT') ins.push(item);
          else if (addr.startsWith('%Q') || v.section === 'VAR_OUTPUT') outs.push(item);
          else if (v.section === 'VAR' && v.used) (v.plcWrites ? outs : ins).push(item);
        }
      }
    }
    return { ins, outs };
  }
  // BOOL-Variablen aus den Transitionen, die keine echten Eingänge sind (z.B. xAuto, xReset)
  function chainSignals(exclude) {
    const ch = curChart();
    const seen = new Set(), out = [];
    const visit = e => {
      if (!e) return;
      ST.exprText(e, (node, text) => {
        const p = ch.pathOf(node);
        if (p && !seen.has(p) && !exclude.has(p)) {
          seen.add(p);
          const ref = refOf(p);
          if (ref && ref.set && T.isBool(ref.t)) out.push({ path: p, info: ref.info || {}, ref });
        }
        return text;
      });
    };
    if (ch && ch.kind === 'chain') {
      ch.transitions.slice().sort((a, b) => a.from - b.from).forEach(t => t.conds.forEach(c => visit(c.e)));
      ch.globalTrans.forEach(t => t.conds.forEach(c => visit(c.e)));
    } else if (ch) {
      // Bedingungen im Programmablaufplan
      const walk = n => {
        if (!n) return;
        if (n.t === 'seq') n.items.forEach(walk);
        else if (n.t === 'if') { visit(n.cond); walk(n.yes); walk(n.no); }
        else if (n.t === 'case') { visit(n.stmt.expr); n.branches.forEach(b => walk(b.body)); walk(n.other); }
        else if (n.t === 'loop') { if (n.stmt.cond) visit(n.stmt.cond); walk(n.body); }
      };
      walk(ch.flow);
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
    return out.slice(0, 40);
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
      const comment = item.info.stub ? 'Platzhalter-Baustein (Bibliothek fehlt) – von Hand setzen'
        : item.info.plcWrites && isSig ? 'vom Programm berechnet' : lineComment(item.info.file, item.info.line);
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
    // SETUP gibt es nur mit Testdatei
    const hasSetup = /^\s*SETUP\b/im.test(eds.tests.value);
    $('chkSetup').parentElement.hidden = state.modelOn || !hasSetup;
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
  const G = { SW: 64, SH: 44, ACTW: 260, ACTGAP: 24, COLW: 470, SLOT: 290, TOP: 24 };
  const curChart = () => state.charts[state.chartIdx];
  const stepW = s => Math.max(G.SW, Math.round(String(s.label).length * 10.5 + 26));
  const stepLabel = (ch, n) => { const s = ch.steps.find(x => x.n === n); return s ? s.label : String(n); };
  // Ziel einer Transition; berechnete Ziele (iStep := iNext) als Ausdruck
  const toLabel = (ch, t) => (t.to === null ? `${t.toText} (berechnet)` : stepLabel(ch, t.to));

  function trackStep() {
    const ch = curChart();
    if (!ch || ch.kind !== 'chain' || !state.plc) return;
    let act;
    try { act = ch.active(); } catch (e) { act = []; }
    const key = act.join(',');
    if (key !== state.lastStep) {
      state.lastStep = key;
      state.stepSince = state.plc.rt.now;
      const lbl = act.length ? act.map(n => stepLabel(ch, n)).join('+') : '–';
      state.hist = (state.hist || []).concat([{ n: lbl, t: state.plc.rt.now }]).slice(-14);
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
      const m = state.measured && state.measured.get(ch.title + '#' + s.n);
      if (m) return m;
      let rows = 0;
      for (const a of s.ops) rows += a.action ? Math.ceil(((a.outputs || []).map(o => o.display).join(' ').length + a.display.length + 6) / 30) : 1 + Math.ceil(a.text.length / 34);
      return rows ? Math.max(G.SH, rows * 19 + 10) : 0;
    };
    const condLines = t => (Math.ceil(t.condsText.join(' AND ').length / 30) || 1) + (t.does && t.does.length ? Math.ceil(t.does.join('; ').length / 32) : 0);
    const pos = new Map();
    let y = G.TOP + (ch.globalTrans.length ? 30 + ch.globalTrans.length * 34 : 0);
    const layerInfo = [];
    layers.forEach((L, li) => {
      if (!L) return;
      L.sort((a, b) => a.n - b.n);
      let rowH = G.SH;
      L.forEach((s, i) => {
        const h = actH(s);
        rowH = Math.max(rowH, h);
        pos.set(s.n, { x: (i - (L.length - 1) / 2) * G.COLW, y, actH: h, layer: li, w: stepW(s) });
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
      for (const t of jumps) {
        let bx;
        if (list.length === 1) bx = p.x;
        else {
          const cands = [p.x];
          for (let d = 1; d < 8; d++) cands.push(p.x - d * G.SLOT, p.x + d * G.SLOT);
          bx = cands.find(c => !used.some(u => Math.abs(u - c) < 60));
        }
        used.push(bx);
        edges.push({ t, from: s.n, bx, jump: true });
      }
      p.yDiv = li.bottom + 12;
      p.yBar = li.bottom + 34;
    }
    // Verschieben in den positiven Bereich
    let minX = Infinity, maxX = -Infinity;
    for (const p of pos.values()) { minX = Math.min(minX, p.x - p.w / 2 - 90); maxX = Math.max(maxX, p.x + p.w / 2 + G.ACTGAP + G.ACTW); }
    for (const e of edges) { minX = Math.min(minX, e.bx - 250); maxX = Math.max(maxX, e.bx + 250); }
    if (ch.globalTrans.length) maxX = Math.max(maxX, minX + 420);
    const dx = 24 - minX;
    for (const p of pos.values()) p.x += dx;
    for (const e of edges) e.bx += dx;
    return { pos, edges, layerInfo, W: maxX - minX + 48, H: y + 20 };
  }

  // Ausdruck mit anklickbaren Variablen
  function chipWrap(ch, chips) {
    return (node, text) => {
      const p = ch.pathOf(node);
      if (!p) return text;
      chips.push(`<button class="chip" data-path="${esc(p)}" title="${esc(p)}">${esc(text)}<span class="v"></span></button>`);
      return '\u0001' + (chips.length - 1) + '\u0002';
    };
  }
  const unchip = (s, chips) => esc(s).replace(/\u0001(\d+)\u0002/g, (m, i) => chips[+i]);
  function condHtml(ch, conds) {
    const chips = [];
    const wrap = chipWrap(ch, chips);
    const parts = conds.map(c => ST.condText(c, wrap));
    return unchip(parts.join(' AND ') || 'TRUE', chips);
  }
  function exprHtml(ch, e) {
    const chips = [];
    return unchip(ST.exprText(e, chipWrap(ch, chips)), chips);
  }

  function chartOptions() {
    const sel = $('selChart'), chs = state.charts;
    const chains = chs.filter(c => c.kind === 'chain'), flows = chs.filter(c => c.kind === 'flow');
    const opt = c => `<option value="${c.id}">${esc(c.title)}</option>`;
    sel.innerHTML = (chains.length ? `<optgroup label="Schrittketten">${chains.map(opt).join('')}</optgroup>` : '')
      + (flows.length ? `<optgroup label="Programmablaufpläne">${flows.map(opt).join('')}</optgroup>` : '');
    sel.hidden = chs.length < 2;
    sel.value = String(state.chartIdx);
  }

  function renderChart() {
    const stage = $('chartStage');
    chartOptions();
    const ch = curChart();
    state.chartEls = null; state.flowEls = null;
    $('stepHist').innerHTML = '';
    if (!state.plc) {
      $('chartTitle').textContent = 'Ablaufplan';
      stage.innerHTML = '<div class="chart-empty">Noch kein Programm geladen. Im Bereich <b>Code</b> ein Programm eingeben oder eine <code>.st</code>-Datei öffnen und <b>Übersetzen</b> drücken. Der Ablaufplan wird daraus automatisch erzeugt.</div>';
      stage.style.width = stage.style.height = '';
      state.layout = null;
      return;
    }
    if (!ch) {
      $('chartTitle').textContent = 'Ablaufplan';
      stage.innerHTML = '<div class="chart-empty">Kein zyklisch laufendes Programm gefunden.</div>';
      stage.style.width = stage.style.height = '';
      state.layout = null;
      return;
    }
    if (ch.kind === 'flow') return renderFlow(ch);
    $('chartTitle').textContent = ch.flags ? `Schrittkette ${ch.inst}` : `Schrittkette ${ch.title}`;
    const L = layout(ch);
    state.layout = L;
    let svg = `<svg width="${L.W}" height="${L.H}" viewBox="0 0 ${L.W} ${L.H}">`;
    let html = '';
    // Kanten
    for (const e of L.edges) {
      const p = L.pos.get(e.from);
      const sx = p.x, sy = p.y + G.SH;
      let d = `M${sx},${sy} V${p.yDiv}`;
      if (e.bx !== sx) d += ` H${e.bx}`;
      if (e.jump) {
        d += ` V${p.yBar + 34}`;
        svg += `<path class="ln" d="${d}"/><path class="arrow" d="M${e.bx - 6},${p.yBar + 30} L${e.bx + 6},${p.yBar + 30} L${e.bx},${p.yBar + 40} Z"/>`;
        html += `<div class="jump" style="left:${e.bx - 70}px;top:${p.yBar + 44}px;width:140px;text-align:center">Sprung zu ${esc(toLabel(ch, e.t))}</div>`;
      } else {
        const q = L.pos.get(e.t.to);
        d += ` V${q.y - 16} H${q.x} V${q.y}`;
        svg += `<path class="ln" d="${d}"/>`;
      }
      svg += `<line class="bar" data-t="${e.t.idx}" x1="${e.bx - 14}" x2="${e.bx + 14}" y1="${p.yBar}" y2="${p.yBar}"/>`;
      const left = e.bx < sx - 10;
      const style = left ? `right:${L.W - (e.bx - 18)}px;top:${p.yBar - 11}px` : `left:${e.bx + 18}px;top:${p.yBar - 11}px`;
      const does = e.t.does && e.t.does.length ? `<span class="does">/ ${esc(e.t.does.join('; '))}</span>` : '';
      html += `<div class="cond${left ? ' left' : ''}" data-t="${e.t.idx}" style="${style}" title="Zeile ${e.t.line}">${condHtml(ch, e.t.conds)}${does}</div>`;
    }
    // Rücksprung-Hinweise am Ziel
    const into = new Map();
    for (const e of L.edges) if (e.jump) into.set(e.t.to, (into.get(e.t.to) || []).concat([stepLabel(ch, e.from)]));
    // Schritte und Aktionen
    for (const s of ch.steps) {
      const p = L.pos.get(s.n);
      const tip = ch.flags ? `Schrittmerker ${s.label} – Klick: diesen Schritt aktiv setzen` : `Schritt ${s.label} – Klick: Schritt direkt setzen`;
      html += `<div class="step${s.n === ch.initial ? ' init' : ''}${String(s.label).length > 3 ? ' long' : ''}" data-step="${s.n}" title="${esc(tip)}" style="left:${p.x - p.w / 2}px;top:${p.y}px;width:${p.w}px;height:${G.SH}px">${esc(s.label)}<span class="since"></span></div>`;
      if (into.has(s.n)) html += `<div class="from-hint" style="right:${L.W - (p.x - p.w / 2 - 10)}px;top:${p.y + 13}px">von ${esc(into.get(s.n).join(', '))} →</div>`;
      if (p.actH) {
        let rows = '';
        for (const a of s.ops) {
          if (a.action) {
            const outs = a.outputs.length
              ? a.outputs.map(o => `<span class="lamp" data-lamp="${esc(o.path)}"></span>${esc(o.display)}`).join(' ') + ` <span class="out">(${esc(a.display)})</span>`
              : `${a.lamp && refOf(a.lamp) && T.isBool(refOf(a.lamp).t) ? `<span class="lamp" data-lamp="${esc(a.lamp)}"></span>` : ''}${esc(a.display)}${a.lamp && refOf(a.lamp) && !T.isBool(refOf(a.lamp).t) ? ` <span class="pv" data-pv="${esc(a.lamp)}"></span>` : ''}`;
            rows += `<div class="arow"><span class="q" title="nicht speichernd: aktiv, solange der Schritt aktiv ist">N</span><span class="an">${outs}</span></div>`;
          } else {
            const qt = { E: 'beim Eintritt in den Schritt', C: a.label, N: 'wird ausgeführt, solange der Schritt aktiv ist' }[a.q];
            // BOOL-Ziel: Lampe; Zahl/Text: aktueller Wert
            const lr = a.lamp ? refOf(a.lamp) : null;
            const ind = !lr ? '' : T.isBool(lr.t) ? `<span class="lamp" data-lamp="${esc(a.lamp)}"></span>` : '';
            const val = lr && !T.isBool(lr.t) ? ` <span class="pv" data-pv="${esc(a.lamp)}"></span>` : '';
            rows += `<div class="arow"><span class="q" title="${esc(qt)}">${a.q === 'C' ? '?' : a.q}</span><span class="entry">${a.q === 'N' ? '' : `<i>${esc(a.label)}:</i> `}${ind}${esc(a.text)}${val}</span></div>`;
          }
        }
        html += `<div class="act" data-act="${s.n}" style="left:${p.x + p.w / 2 + G.ACTGAP}px;top:${p.y}px;width:${G.ACTW}px;min-height:${G.SH}px">${rows}</div>`;
        svg += `<line class="ln" x1="${p.x + p.w / 2}" x2="${p.x + p.w / 2 + G.ACTGAP}" y1="${p.y + G.SH / 2}" y2="${p.y + G.SH / 2}"/>`;
      }
    }
    svg += '</svg>';
    // Transitionen aus jedem Schritt (z.B. Reset)
    if (ch.globalTrans.length) {
      html += `<div class="gtrans" id="gtrans">` + ch.globalTrans.map((t, i) =>
        `<div data-g="${i}"><b>Aus jedem Schritt → ${esc(toLabel(ch, t))}</b> wenn ${condHtml(ch, t.conds)}${t.does && t.does.length ? `<span class="does">/ ${esc(t.does.join('; '))}</span>` : ''}</div>`).join('') + '</div>';
    }
    stage.innerHTML = `<div class="chart-canvas" id="chartCanvas" style="width:${L.W}px;height:${L.H}px">${svg}${html}</div>`;
    wireChips(stage);
    stage.querySelectorAll('.step').forEach(el => el.addEventListener('click', () => {
      const n = +el.dataset.step;
      try { ch.setStep(n); } catch (e) { status(e.message, 'bad'); return; }
      trackStep();
      status(ch.flags ? `Schrittmerker ${stepLabel(ch, n)} gesetzt, die anderen zurückgesetzt.` : `${ch.path} := ${stepLabel(ch, n)} gesetzt.`);
      updateAll(true);
    }));
    state.chartEls = {
      steps: new Map([...stage.querySelectorAll('.step')].map(e => [+e.dataset.step, e])),
      acts: new Map([...stage.querySelectorAll('.act')].map(e => [+e.dataset.act, e])),
      bars: [...stage.querySelectorAll('line.bar')],
      conds: [...stage.querySelectorAll('.cond')],
      chips: [...stage.querySelectorAll('.chip')],
      lamps: [...stage.querySelectorAll('[data-lamp]')],
      gtrans: [...stage.querySelectorAll('[data-g]')],
      pvs: [...stage.querySelectorAll('[data-pv]')],
    };
    applyZoom();
    // tatsächliche Höhen der Aktionsboxen messen und bei Abweichung einmal neu auslegen
    if (!state.remeasuring) {
      state.measured = state.measured || new Map();
      let redo = false;
      for (const s of ch.steps) {
        const el = state.chartEls.acts.get(s.n), p = L.pos.get(s.n);
        if (!el || !el.offsetHeight) continue;
        if (Math.abs(el.offsetHeight - p.actH) > 2) { state.measured.set(ch.title + '#' + s.n, el.offsetHeight); redo = true; }
      }
      if (redo) { state.remeasuring = true; renderChart(); state.remeasuring = false; updateAll(true); }
    }
  }

  function wireChips(stage) {
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
  }
  function updateChips(els) {
    for (const c of els.chips) {
      const v = safeRead(c.dataset.path);
      if (c.classList.contains('num')) { const r = refOf(c.dataset.path); c.lastChild.textContent = v === undefined || !r ? '' : ST.fmtValue(r.t, v); }
      else c.classList.toggle('t', !!v);
      c.style.borderColor = state.plc.forces.has(c.dataset.path) ? 'var(--force)' : '';
    }
    for (const l of els.lamps) l.classList.toggle('on', !!safeRead(l.dataset.lamp));
    for (const p of els.pvs || []) {
      const r = refOf(p.dataset.pv);
      const v = safeRead(p.dataset.pv);
      if (!r || v === undefined) { p.textContent = ''; continue; }
      if (T.isBool(r.t)) { p.className = 'pv b' + (v ? ' t' : ''); p.textContent = ''; }
      else { p.className = 'pv'; p.textContent = ST.fmtValue(r.t, v); }
    }
  }

  function updateChart() {
    const ch = curChart();
    if (!ch || !state.plc) return;
    if (ch.kind === 'flow') return updateFlow(ch);
    const els = state.chartEls;
    if (!els) return;
    let cur;
    try { cur = ch.active(); } catch (e) { cur = []; }
    const ctx = ch.ctx();
    for (const [n, el] of els.steps) {
      const on = cur.includes(n);
      el.classList.toggle('active', on);
      if (on) {
        const dt = state.plc.rt.now - (state.stepSince || 0);
        el.lastChild.textContent = (dt / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';
      }
    }
    for (const [n, el] of els.acts) el.classList.toggle('active', cur.includes(n));
    const truth = new Map();
    for (const t of ch.transitions) {
      if (!cur.includes(t.from) || !t.eval) continue;
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
      if (els.gtrans[i]) els.gtrans[i].classList.toggle('go', v);
    });
    updateChips(els);
    // Verlauf
    const hist = state.hist || [];
    $('stepHist').innerHTML = hist.length
      ? hist.map((h, i) => `<span class="hs${i === hist.length - 1 ? ' cur' : ''}" title="t = ${T.formatTime(h.t).slice(2)}">${esc(h.n)}</span>`).join('→')
      : '';
    if (state.stepChanged && $('chkFollow').checked) {
      const el = els.steps.get(cur[0]);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    state.stepChanged = false;
  }

  // ---------- Programmablaufplan (PAP nach DIN 66001) ----------
  const F = { GAP: 26, GAPX: 36, CH: 7.3, LH: 17, MINW: 150, MAXW: 430, BR: 60 };
  function textW(s) { return Math.min(F.MAXW, Math.max(F.MINW, Math.round(s.length * F.CH + 28))); }

  // Größe und Zeichnung rekursiv; jeder Knoten hat Ein- und Ausgang mittig oben/unten
  function flowMeasure(n) {
    switch (n.t) {
      case 'seq': {
        n.items.forEach(flowMeasure);
        n.w = n.items.reduce((a, x) => Math.max(a, x.w), 0);
        n.h = n.items.reduce((a, x) => a + x.h, 0) + Math.max(0, n.items.length - 1) * F.GAP;
        break;
      }
      case 'op': {
        n.lines = n.stmts.map(s => ST.stmtText(s));
        n.w = Math.max(...n.lines.map(textW)) + 34;
        n.h = n.lines.length * F.LH + 14;
        break;
      }
      case 'call': n.text = ST.stmtText(n.stmt); n.w = textW(n.text) + 24; n.h = 34; break;
      case 'jump': n.text = ST.stmtText(n.stmt); n.w = 110; n.h = 30; break;
      case 'if': {
        n.text = ST.exprText(n.cond);
        let chips = 0;
        ST.exprText(n.cond, (x, t) => { chips++; return t; });
        const tw = n.text.length * F.CH + chips * 24;
        n.hw = Math.min(F.MAXW + 60, Math.max(170, tw + 104));
        n.hh = 22 + Math.ceil(tw / (n.hw - 100)) * 22;
        flowMeasure(n.yes); flowMeasure(n.no);
        n.cols = [n.yes, n.no];
        layoutCols(n);
        break;
      }
      case 'case': {
        n.text = 'CASE ' + ST.exprText(n.stmt.expr) + ' OF';
        n.hw = Math.max(170, n.text.length * F.CH + 70); n.hh = 26 + F.LH;
        n.branches.forEach(b => flowMeasure(b.body));
        if (n.other) flowMeasure(n.other);
        n.cols = n.branches.map(b => b.body).concat(n.other ? [n.other] : [{ t: 'seq', items: [], w: 0, h: 0 }]);
        n.labs = n.branches.map(b => b.label).concat(['sonst']);
        if (n.cols.length > 4) {
          // viele Zweige: als Leiter untereinander statt nebeneinander
          n.vert = true;
          const bw = n.cols.reduce((a, c) => Math.max(a, c.w), 80);
          n.bodyX = 96; n.railX = n.bodyX + bw + 40;
          n.w = Math.max(n.hw, n.railX + 20);
          n.rows = n.cols.map(c => (c.items.length ? 22 + c.h + 14 : 30));
          n.h = n.hh + 24 + n.rows.reduce((a, b) => a + b, 0) + 26;
          break;
        }
        layoutCols(n);
        break;
      }
      case 'loop': {
        const s = n.stmt;
        n.text = s.s === 'repeat' ? 'REPEAT' : ST.stmtText(s);
        n.foot = s.s === 'for' ? 'END_FOR' : s.s === 'while' ? 'END_WHILE' : 'UNTIL ' + ST.exprText(s.cond);
        flowMeasure(n.body);
        n.lw = Math.max(textW(n.text), textW(n.foot)) + 20;
        n.w = Math.max(n.lw, n.body.w);
        n.h = 34 + F.GAP + n.body.h + (n.body.items.length ? F.GAP : 0) + 34;
        break;
      }
    }
  }
  function layoutCols(n) {
    const ws = n.cols.map(c => Math.max(c.w, F.BR));
    const inner = ws.reduce((a, b) => a + b, 0) + (ws.length - 1) * F.GAPX;
    n.w = Math.max(n.hw, inner);
    let x = (n.w - inner) / 2;
    n.cx = ws.map(w => { const c = x + w / 2; x += w + F.GAPX; return c; });
    n.bh = Math.max(...n.cols.map(c => c.h));
    n.h = n.hh + 34 + n.bh + 30;
  }

  function flowDraw(ch, n, x0, y0, out) {
    // x0: linke Kante des Knotens, y0: Oberkante; Mittellinie bei x0 + n.w / 2
    const cx = x0 + n.w / 2;
    const id = out.nodes.length;
    switch (n.t) {
      case 'seq': {
        let y = y0;
        n.items.forEach((it, i) => {
          if (i > 0) { out.edge(`M${cx},${y - F.GAP} V${y}`, () => isHot(it), true); }
          flowDraw(ch, it, cx - it.w / 2, y, out);
          y += it.h + F.GAP;
        });
        if (!n.items.length) out.svg += '';
        return;
      }
      case 'op': {
        out.nodes.push({ n, hot: () => n.stmts.some(s => s.hit === cyc()) });
        const rows = n.stmts.map((s, i) => {
          const p = s.target ? ch.pathOf(s.target) : null;
          return `<div class="pl" title="${esc(n.lines[i])} – Zeile ${s.line}">${esc(n.lines[i])}${p ? `<span class="pv" data-pv="${esc(p)}"></span>` : ''}</div>`;
        }).join('');
        out.html += `<div class="pap op" data-node="${id}" data-line="${n.stmts[0].line}" style="left:${x0}px;top:${y0}px;width:${n.w}px;height:${n.h}px">${rows}</div>`;
        return;
      }
      case 'call': case 'jump': {
        out.nodes.push({ n, hot: () => n.stmt.hit === cyc() });
        out.html += `<div class="pap ${n.t}" data-node="${id}" data-line="${n.stmt.line}" title="${esc(n.text)} – Zeile ${n.stmt.line}" style="left:${x0}px;top:${y0}px;width:${n.w}px;height:${n.h}px"><span>${esc(n.text)}</span></div>`;
        return;
      }
      case 'if': case 'case': {
        const s = n.stmt;
        const isIf = n.t === 'if';
        const evaluated = isIf ? () => s.hit === cyc() && s.br >= n.bi : () => s.hit === cyc();
        out.nodes.push({ n, hot: evaluated });
        const hx = cx - n.hw / 2;
        const label = isIf ? exprHtml(ch, n.cond) : esc(n.text);
        out.html += `<div class="pap dec${isIf ? '' : ' case'}" data-node="${id}" data-line="${isIf ? n.cond.line || s.line : s.line}" style="left:${hx}px;top:${y0}px;width:${n.hw}px;height:${n.hh}px"><span><span class="ct">${label}</span></span></div>`;
        const yb = y0 + n.hh, yc = yb + 34;
        if (n.vert) {
          const sx = x0 + 22, rx = x0 + n.railX, bx0 = x0 + n.bodyX;
          let y = yb + 24;
          out.edge(`M${cx},${yb} V${yb + 12} H${sx} V${y}`, evaluated, true);
          n.cols.forEach((c, i) => {
            const taken = () => s.hit === cyc() && s.br === i;
            const ry = y + 8;
            out.html += `<div class="pap-lab case" style="left:${sx + 8}px;top:${ry - 16}px">${esc(n.labs[i])}</div>`;
            if (i < n.cols.length - 1) out.edge(`M${sx},${y} V${y + n.rows[i]}`, () => evaluated() && s.br > i, true);
            if (!c.items.length) out.edge(`M${sx},${y} V${ry} H${rx}`, taken, true);
            else {
              const bcx = bx0 + c.w / 2;
              out.edge(`M${sx},${y} V${ry} H${bcx} V${y + 22}`, taken);
              flowDraw(ch, c, bx0, y + 22, out);
              out.edge(`M${bcx},${y + 22 + c.h} V${y + 22 + c.h + 8} H${rx}`, taken, true);
            }
            y += n.rows[i];
          });
          out.edge(`M${rx},${yb + 30} V${y + 8} H${cx} V${y0 + n.h}`, evaluated, true);
          return;
        }
        const ym = yc + n.bh + 16;
        n.cols.forEach((c, i) => {
          const bx = x0 + n.cx[i];
          const taken = isIf ? (i === 0 ? () => evaluated() && s.br === n.bi : () => evaluated() && s.br > n.bi) : () => s.hit === cyc() && s.br === i;
          const lab = isIf ? (i === 0 ? 'ja' : 'nein') : (i < n.branches.length ? n.branches[i].label : (n.other ? 'sonst' : 'sonst'));
          out.html += `<div class="pap-lab${isIf && i === 1 ? ' no' : ''}" style="left:${bx + 5}px;top:${yb + 13}px">${esc(lab)}</div>`;
          if (!c.items.length) { out.edge(`M${cx},${yb} V${yb + 12} H${bx} V${ym} H${cx}`, taken, true); return; }
          out.edge(`M${cx},${yb} V${yb + 12} H${bx} V${yc}`, taken);
          flowDraw(ch, c, bx - c.w / 2, yc, out);
          out.edge(`M${bx},${yc + c.h} V${ym} H${cx}`, taken, true);
        });
        out.edge(`M${cx},${ym} V${y0 + n.h}`, () => evaluated(), true);
        return;
      }
      case 'loop': {
        const s = n.stmt;
        out.nodes.push({ n, hot: () => s.hit === cyc() });
        out.html += `<div class="pap loop" data-node="${id}" data-line="${s.line}" style="left:${cx - n.lw / 2}px;top:${y0}px;width:${n.lw}px;height:34px"><span>${esc(n.text)}</span></div>`;
        let y = y0 + 34 + F.GAP;
        out.edge(`M${cx},${y0 + 34} V${y}`, () => s.hit === cyc(), true);
        if (n.body.items.length) {
          flowDraw(ch, n.body, cx - n.body.w / 2, y, out);
          y += n.body.h + F.GAP;
          out.edge(`M${cx},${y - F.GAP} V${y}`, () => s.hit === cyc(), true);
        }
        out.html += `<div class="pap loop end" style="left:${cx - n.lw / 2}px;top:${y - (n.body.items.length ? 0 : F.GAP)}px;width:${n.lw}px;height:34px"><span>${esc(n.foot)}</span></div>`;
        return;
      }
    }
  }
  const cyc = () => (state.plc ? state.plc.cycleCount : -1);
  function isHot(n) {
    if (!n) return false;
    switch (n.t) {
      case 'op': return n.stmts.some(s => s.hit === cyc());
      case 'if': return n.stmt.hit === cyc() && n.stmt.br >= n.bi;
      case 'seq': return n.items.length ? isHot(n.items[0]) : false;
      default: return n.stmt.hit === cyc();
    }
  }

  function renderFlow(ch) {
    const stage = $('chartStage');
    $('chartTitle').textContent = `Programmablaufplan ${ch.title}`;
    flowMeasure(ch.flow);
    const PAD = 40;
    const W = Math.max(ch.flow.w, 200) + PAD * 2;
    const out = { svg: '', html: '', nodes: [], edges: [] };
    out.edge = (d, hot, plain) => { out.edges.push({ hot, arrow: !plain }); out.svg += `<path class="ln pe" data-e="${out.edges.length - 1}" d="${d}"${plain ? '' : ' marker-end="url(#arr)"'}/>`; };
    const y0 = 74;
    flowDraw(ch, ch.flow, PAD + (W - PAD * 2 - ch.flow.w) / 2, y0, out);
    const cx = W / 2, yEnd = y0 + ch.flow.h + (ch.flow.items.length ? 28 : 0);
    const H = yEnd + 34 + PAD;
    const startTxt = ch.title.replace(/ \(.*\)$/, '');
    const pre = `<div class="pap term" style="left:${cx - 90}px;top:${PAD - 14}px;width:180px;height:34px"><span>${esc(startTxt)}</span></div>`
      + `<div class="pap term" style="left:${cx - 90}px;top:${yEnd}px;width:180px;height:34px"><span>Ende</span></div>`;
    out.svg += `<path class="ln" d="M${cx},${PAD + 20} V${y0}"/>`;
    if (ch.flow.items.length) out.svg += `<path class="ln" d="M${cx},${y0 + ch.flow.h} V${yEnd}"/>`;
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker><marker id="arrh" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="arrowhead hot"/></marker></defs>${out.svg}</svg>`;
    stage.innerHTML = `<div class="chart-canvas flow" id="chartCanvas" style="width:${W}px;height:${H}px">${svg}${pre}${out.html}</div>`;
    state.layout = { W, H };
    wireChips(stage);
    stage.querySelectorAll('.pap[data-line]').forEach(el => {
      el.title = (el.title ? el.title + ' · ' : '') + 'Doppelklick: im Code zeigen';
      el.addEventListener('dblclick', () => jumpTo(ch.file, +el.dataset.line, 1));
    });
    state.flowEls = {
      nodes: out.nodes.map((nd, i) => ({ el: stage.querySelector(`[data-node="${i}"]`), hot: nd.hot })),
      edges: out.edges.map((e, i) => ({ el: stage.querySelector(`[data-e="${i}"]`), hot: e.hot, arrow: e.arrow, last: null })),
      chips: [...stage.querySelectorAll('.chip')],
      lamps: [],
      pvs: [...stage.querySelectorAll('[data-pv]')],
    };
    applyZoom();
  }

  function updateFlow(ch) {
    const els = state.flowEls;
    if (!els) return;
    const on = state.plc.cycleCount > 0;
    for (const x of els.nodes) if (x.el) x.el.classList.toggle('hot', on && !!x.hot());
    for (const x of els.edges) {
      if (!x.el) continue;
      const h = on && !!x.hot();
      if (h === x.last) continue;
      x.last = h;
      x.el.classList.toggle('hot', h);
      if (x.arrow) x.el.setAttribute('marker-end', h ? 'url(#arrh)' : 'url(#arr)');
    }
    updateChips(els);
    $('stepHist').innerHTML = `<span class="flow-note">${on ? `Zyklus ${state.plc.cycleCount}: hervorgehoben ist, was im letzten Zyklus gelaufen ist` : 'Noch kein Zyklus gelaufen – Start oder 1 Zyklus drücken'}</span>`;
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
    state.zoom = Math.max(0.3, Math.min(1, (sc.clientWidth - 8) / L.W));
    state.autoZoom = true;
    applyZoom();
  }
  $('btnZoomIn').addEventListener('click', () => { state.autoZoom = false; state.zoom = Math.min(2, (state.zoom || 1) * 1.15); applyZoom(); });
  $('btnZoomOut').addEventListener('click', () => { state.autoZoom = false; state.zoom = Math.max(0.3, (state.zoom || 1) / 1.15); applyZoom(); });
  // Fenstergröße geändert: eingepassten Plan neu einpassen (von Hand gezoomt bleibt)
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (state.mode === 'sim' && (state.autoZoom || state.zoom === null)) fitChart(); }, 150);
  });
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
  // TwinCAT-XML (.TcPOU/.TcGVL/.TcDUT) in ST-Text umwandeln
  function fromTwinCAT(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML nicht lesbar');
    const txt = (el, sel) => { const x = el.querySelector(sel); return x ? x.textContent.trim() : ''; };
    const out = [];
    for (const obj of doc.querySelectorAll('TcPlcObject > *')) {
      const decl = txt(obj, ':scope > Declaration');
      if (obj.tagName === 'POU') {
        const kind = (/^\s*(?:\{[^}]*\}\s*)*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b/i.exec(decl) || [])[1] || 'PROGRAM';
        out.push(decl, txt(obj, ':scope > Implementation > ST'));
        for (const a of obj.querySelectorAll(':scope > Action')) out.push(`ACTION ${a.getAttribute('Name')}:`, txt(a, 'Implementation > ST'), 'END_ACTION');
        for (const m of obj.querySelectorAll(':scope > Method')) out.push(txt(m, ':scope > Declaration'), txt(m, 'Implementation > ST'), 'END_METHOD');
        out.splice(out.length - obj.querySelectorAll(':scope > Action, :scope > Method').length * 3, 0, 'END_' + kind.toUpperCase());
      } else if (decl) out.push(decl);
    }
    return out.join('\n');
  }
  function importText(name, text) {
    if (/\.Tc(POU|GVL|DUT)$/i.test(name) || /<TcPlcObject/.test(text.slice(0, 400))) return fromTwinCAT(text);
    return text;
  }
  const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });

  // Beliebiges Programm laden: alle Dateien zusammen ins Programm, .sttest in die Tests,
  // dann übersetzen und den automatisch erzeugten Ablaufplan zeigen
  async function loadProgramFiles(list) {
    const files = [...list];
    if (!files.length) return;
    stop();
    const progs = [], tests = [];
    try {
      for (const f of files) {
        const t = await readFile(f);
        if (/\.sttest$/i.test(f.name)) tests.push({ name: f.name, text: t });
        else progs.push({ name: f.name, text: importText(f.name, t) });
      }
    } catch (e) { status(`Laden fehlgeschlagen: ${e.message}`, 'bad'); return; }
    // GVLs und Datentypen zuerst
    const rank = p => (/^\s*(?:\(\*[\s\S]*?\*\)\s*)*(TYPE|VAR_GLOBAL)\b/i.test(p.text) ? 0 : 1);
    progs.sort((a, b) => rank(a) - rank(b));
    if (progs.length) {
      eds.prog.value = progs.length === 1 ? progs[0].text : progs.map(p => `(* ===== ${p.name} ===== *)\n${p.text.trim()}\n`).join('\n');
      FILES.prog = progs[0].name;
      // das Anlagenmodell gehört zum alten Programm
      if (eds.model.value.trim()) { eds.model.value = ''; FILES.model = 'anlage.st'; }
      state.modelOn = false; store.set('modelOn', false);
      if (!tests.length && eds.tests.value.trim()) { eds.tests.value = ''; FILES.tests = 'tests.sttest'; }
    }
    if (tests.length) { eds.tests.value = tests.map(t => t.text).join('\n'); FILES.tests = tests[0].name; }
    for (const k of Object.keys(eds)) store.set('src.' + k, eds[k].value);
    store.set('files', FILES);
    state.plc = null; state.results = null; state.selTest = null; state.chartIdx = 0; state.charts = [];
    renderResults();
    const names = files.map(f => f.name).join(', ');
    if (!progs.length) { selectEditor('tests'); changed('tests'); status(`${names} geladen.`); return; }
    setMode('sim');
    if (compile()) {
      const chains = state.charts.filter(c => c.kind === 'chain').length;
      const w = state.plc.diags.filter(d => d.kind === 'warning' && d.file !== undefined).length;
      status(`${names} geladen – ${chains ? `${chains} Schrittkette${chains > 1 ? 'n' : ''} erkannt` : 'keine Schrittkette erkannt, Programmablaufplan erzeugt'}${w ? ` · ${w} Hinweis(e) unter Code › Meldungen` : ''}.`, 'ok');
    }
  }
  $('btnLoadProg').addEventListener('click', () => $('progInput').click());
  $('progInput').addEventListener('change', e => { loadProgramFiles(e.target.files); e.target.value = ''; });
  // Drag & Drop von Dateien auf die Seite
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('dropzone').hidden = true;
    loadProgramFiles(e.dataTransfer.files);
  });

  $('fileInput').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const target = /\.sttest$/i.test(f.name) ? 'tests' : state.activeEd;
      try { eds[target].value = importText(f.name, String(r.result)); }
      catch (err) { status(`${f.name}: ${err.message}`, 'bad'); return; }
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
      const txt = importText(name, await serverText(name));
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
    state.plc = null; state.results = null; state.selTest = null; state.charts = []; state.chartIdx = 0;
    renderResults();
    if (compile()) status(`Beispiel „${ex.name}“ geladen.`, 'ok');
  }

  // ---------- Bedienung ----------
  $('btnDiagClear').addEventListener('click', () => {
    dismiss(state.compileDiags.concat(state.testDiags).filter(d => !isDismissed(d)));
    status('Meldungen gelöscht. Fehler erscheinen wieder, solange sie im Code bestehen.');
  });
  $('btnDiagRestore').addEventListener('click', () => {
    dismissed.clear(); dismissedErr.clear(); store.set('dismissed', []);
    showDiagnostics(state.compileDiags, state.testDiags);
  });
  // Übersetzen per Knopf/Kürzel: bei Erfolg in die Simulation wechseln (wie in der Hilfe beschrieben)
  function compileAndShow() {
    if (compile() && state.mode === 'code') { setMode('sim'); fitChart(); run(); }
  }
  $('btnCompile').addEventListener('click', compileAndShow);
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) runAllTests(); else compileAndShow(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (isLocal) save(); }
  });
  window.addEventListener('resize', () => { if (state.mode === 'tests') renderTrace(); });

  // ---------- Hilfe ----------
  $('helpBox').innerHTML = `
<h2>Ablauf</h2>
<p>Programm unter <b>Programm</b> eingeben (CODESYS-Syntax) oder mit <b>ST-Programm laden…</b> bzw. per Drag &amp; Drop öffnen – auch mehrere Dateien (Programm, GVL, Datentypen) und TwinCAT-Dateien (<code>.TcPOU</code>, <code>.TcGVL</code>, <code>.TcDUT</code>). Fehler werden beim Tippen geprüft und am Zeilenrand markiert. <b>Übersetzen</b> lädt das Programm und wechselt in die Simulation.</p>
<p>Fehlt etwas, das in CODESYS in einer anderen Datei steht, wird es ergänzt und unter <b>Meldungen</b> als Hinweis aufgeführt: nicht deklarierte Variablen werden globale Variablen (Typ aus der Verwendung), unbekannte Bibliotheks-Bausteine (z.B. <code>MC_Power</code>) leere Platzhalter, deren Ausgänge du in der Simulation selbst setzt.</p>
<h2>Ablaufplan</h2>
<p>Der Ablaufplan wird automatisch aus dem Code erzeugt. Auswahl oben links:</p>
<p><b>Schrittketten</b> – erkannt werden Ganzzahl- oder Aufzählungsvariablen, die als Schrittmerker dienen: <code>CASE iStep OF</code>, IF/ELSIF-Ketten (<code>IF iStep = 10 THEN …</code>), einzelne IFs (<code>IF iStep = 10 AND x THEN iStep := 20;</code>) und relative Sprünge (<code>iStep := iStep + 10</code>), außerdem BOOL-Schrittmerker (<code>IF S1 AND x THEN S1 := FALSE; S2 := TRUE;</code>). In Funktionsbausteinen gibt es je Instanz eine eigene Kette. Der aktive Schritt ist blau, die Transitionen des aktiven Schritts gelb (wartet) oder grün (erfüllt). Klick auf einen Schritt setzt die Kette dorthin.</p>
<p><b>Programmablaufpläne</b> – für jedes Programm, jeden Funktionsbaustein, jede Aktion und Methode: Verzweigungen, CASE, Schleifen und Aufrufe als Flussdiagramm. Grün ist, was im letzten SPS-Zyklus durchlaufen wurde. Doppelklick auf ein Symbol springt in den Code.</p>
<p>Variablen in Bedingungen sind anklickbar. Rechts unter <b>Eingänge</b> schaltest du Sensoren und Taster. Vom Programm berechnete Variablen (z.B. <code>xAuto</code>) werden beim Anklicken festgehalten (geforct) – „lösen“ gibt sie wieder frei.</p>
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
<p>PROGRAM, FUNCTION_BLOCK, FUNCTION, METHOD, ACTION, EXTENDS mit <code>SUPER^</code>/<code>THIS^</code>, VAR_GLOBAL, TYPE (STRUCT, Aufzählung), ARRAY, STRING, alle Ganzzahl-Typen, REAL/LREAL, TIME, Bitzugriff <code>x.3</code>, direkte Adressen (<code>%IX0.0</code>), <code>S=</code>/<code>R=</code>, Pragmas, IF/CASE/FOR/WHILE/REPEAT. Standard-FBs TON, TOF, TP, R_TRIG, F_TRIG, CTU, CTD, CTUD, SR, RS und die üblichen Funktionen. Nicht unterstützt: Zeiger/REFERENCE, PROPERTY, DATE-Literale.</p>
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
