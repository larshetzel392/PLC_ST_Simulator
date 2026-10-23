#!/usr/bin/env node
// CLI: node st-test.js programm.st [weitere.st] [--model anlage.st] [--tests tests.sttest] [--cycle 10] [--trace]
'use strict';
const fs = require('fs');
const path = require('path');
const ST = require('./src/index.js');

const args = process.argv.slice(2);
const sources = [];
let testFile = null, cycleMs = 10, verbose = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--model') sources.push({ file: args[++i], role: 'model' });
  else if (a === '--tests' || a === '-t') testFile = args[++i];
  else if (a === '--cycle') cycleMs = parseInt(args[++i], 10);
  else if (a === '-v' || a === '--verbose') verbose = true;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.endsWith('.sttest')) testFile = a;
  else sources.push({ file: a, role: 'main' });
}
function usage() {
  console.log('Verwendung: node st-test.js <programm.st> [--model anlage.st] [--tests datei.sttest] [--cycle ms] [-v]');
}
if (!sources.length) { usage(); process.exit(2); }

const tty = process.stdout.isTTY;
const col = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const red = s => col(31, s), green = s => col(32, s), yellow = s => col(33, s), dim = s => col(2, s), bold = s => col(1, s);

for (const s of sources) s.src = fs.readFileSync(s.file, 'utf8');
const plc = new ST.PLC(sources, { cycleMs });

function printDiag(d) {
  const where = `${d.file || ''}${d.line ? ':' + d.line + ':' + d.col : ''}`;
  const tag = d.kind === 'error' ? red('Fehler') : yellow('Warnung');
  console.log(`  ${tag} ${dim(where)}  ${d.msg}`);
}

console.log(bold('▶ Übersetzen'));
const errs = plc.diags.filter(d => d.kind === 'error'), warns = plc.diags.filter(d => d.kind === 'warning');
plc.diags.forEach(printDiag);
if (!plc.ok) { console.log(red(`✗ ${errs.length} Fehler, ${warns.length} Warnung(en)`)); process.exit(1); }
console.log(green(`✓ OK`) + dim(` – ${warns.length} Warnung(en), Tasks: ${plc.tasks.join(', ')}, Zyklus ${cycleMs} ms`));

if (!testFile) {
  // Ohne Tests: 1 Zyklus Probelauf
  try { plc.cycle(); console.log(green('✓ Probezyklus ohne Laufzeitfehler')); }
  catch (e) { console.log(red(`✗ Laufzeitfehler: ${e.message}`) + (e.loc ? dim(` (${e.loc.file}:${e.loc.line})`) : '')); process.exit(1); }
  process.exit(0);
}

console.log(bold(`\n▶ Tests (${path.basename(testFile)})`));
const r = ST.runTests(plc, fs.readFileSync(testFile, 'utf8'), { file: testFile });
r.diags.forEach(printDiag);
if (r.diags.some(d => d.kind === 'error')) console.log(red('✗ Testdatei enthält Fehler'));
let pass = 0, fail = 0;
for (const t of r.results) {
  const time = dim(`${t.cycles} Zyklen, ${ST.T.formatTime(t.simTime).slice(2)}, ${t.asserts} Asserts`);
  if (t.status === 'pass') { pass++; console.log(`  ${green('✓')} ${t.name}  ${time}${t.warning ? ' ' + yellow('⚠ ' + t.warning) : ''}`); }
  else {
    fail++;
    const where = t.loc ? dim(` [${t.loc.file}:${t.loc.line}]`) : '';
    console.log(`  ${red('✗')} ${t.name}  ${time}\n      ${red(t.msg)}${where}`);
  }
  if (verbose || t.status !== 'pass') for (const l of t.log) console.log(dim(`      LOG @${ST.T.formatTime(l.time)}: `) + l.text);
}
console.log(`\n${fail ? red(`✗ ${fail} fehlgeschlagen`) : green('✓ alle bestanden')}, ${pass}/${r.results.length} bestanden`);
process.exit(fail || r.diags.some(d => d.kind === 'error') ? 1 : 0);
