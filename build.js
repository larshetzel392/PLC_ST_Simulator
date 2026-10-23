#!/usr/bin/env node
// Baut die Web-Oberfläche zu einer einzelnen HTML-Datei zusammen:
//   dist/ST-Pruefstand.html  – lokal im Browser öffnen
//   dist/artifact.html       – ohne Dokument-Gerüst (für die Veröffentlichung als Artifact)
'use strict';
const fs = require('fs');
const path = require('path');
const rd = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

const examples = [
  { name: 'Säge – manuell schalten (Unit-Tests)', prog: rd('Saege_CODESYS.st'), model: rd('Saege_Anlage.st'), tests: rd('Saege_Tests.sttest'), modelOn: false,
    files: { prog: 'Saege_CODESYS.st', model: 'Saege_Anlage.st', tests: 'Saege_Tests.sttest' } },
  { name: 'Säge – mit Anlagenmodell (Integrationstests)', prog: rd('Saege_CODESYS.st'), model: rd('Saege_Anlage.st'), tests: rd('Saege_Integration.sttest'), modelOn: true,
    files: { prog: 'Saege_CODESYS.st', model: 'Saege_Anlage.st', tests: 'Saege_Integration.sttest' } },
  { name: 'Sprachumfang (Selbsttest)', prog: rd('examples/selftest/features.st'), model: '', tests: rd('examples/selftest/features.sttest'), modelOn: false,
    files: { prog: 'features.st', model: 'anlage.st', tests: 'features.sttest' } },
];
const engine = ['lexer', 'parser', 'types', 'compiler', 'codegen', 'runtime', 'sfc'].map(n => rd(`src/${n}.js`)).join('\n');
const js = engine + '\n;globalThis.ST_EXAMPLES = ' + JSON.stringify(examples).replace(/<\//g, '<\\/') + ';\n' + rd('web/app.js');

const head = `<title>ST Prüfstand</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Semi+Condensed:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
${rd('web/app.css')}
</style>`;
const body = rd('web/app.html') + `\n<script>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>\n`;

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/ST-Pruefstand.html'),
  `<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${body}</body>\n</html>\n`);
fs.writeFileSync(path.join(__dirname, 'dist/artifact.html'), `${head}\n${body}`);
console.log('dist/ST-Pruefstand.html und dist/artifact.html gebaut (' + Math.round(fs.statSync(path.join(__dirname, 'dist/ST-Pruefstand.html')).size / 1024) + ' KB)');
