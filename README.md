# ST Prüfstand

SPS-Simulator und Testumgebung für IEC 61131-3 **Structured Text** (CODESYS-Dialekt).
Code eingeben → wird übersetzt und geprüft (Syntax, Typen, Namen) → läuft in einer simulierten CPU → automatische Tests.

- **Code:** Editor mit Syntax-Hervorhebung, Fehlern direkt am Zeilenrand und Vorschlägen bei Tippfehlern
- **Simulation:** Live-Ablaufplan, automatisch aus der Schrittkette im Code erzeugt (`CASE iStep OF … iStep := n`): aktiver Schritt, erfüllte/wartende Transitionen, Aktionen mit Ausgängen. Eingänge per Schalter/Taster setzen, vom Programm berechnete Signale (z.B. `xAuto`) festhalten (Forcen wie in CODESYS), optional ein Anlagenmodell in ST, das die Sensoren nachbildet
- **Tests:** eigene Testsprache (`.sttest`) mit Zeitdiagramm, läuft in simulierter Zeit – auch als CLI für CI

## Benutzen

**Localhost:** `npm start` (oder `node serve.js [port]`) → http://localhost:8080. Der Server baut bei Änderungen an `src/`/`web/` automatisch neu, listet die `.st`/`.sttest`-Dateien im Projektordner zum Öffnen und speichert mit **Strg/Cmd+S** direkt zurück.

**Ohne Server:** `dist/ST-Pruefstand.html` direkt öffnen (eine Datei, läuft offline). Nach Änderungen an `src/` oder `web/`: `node build.js`.

**Kommandozeile:**

```sh
node st-test.js Saege_CODESYS.st                                   # nur übersetzen + Probezyklus
node st-test.js Saege_CODESYS.st Saege_Tests.sttest                # Unit-Tests
node st-test.js Saege_CODESYS.st --model Saege_Anlage.st Saege_Integration.sttest
npm test                                                           # alles
```

Optionen: `--model datei.st` (Anlagenmodell), `--cycle 10` (Zykluszeit in ms), `-v` (LOG-Ausgaben immer zeigen). Exit-Code 1 bei Fehlern → CI-tauglich.

## Testdateien (`.sttest`)

```
SETUP                          (* vor jedem Test, nach Kaltstart *)
    E9 := TRUE;
END_SETUP

TEST 'Name'
VAR n : INT; END_VAR
    E8 := TRUE;  CYCLE;         (* 1 Zyklus;  CYCLE 5; = 5 Zyklen *)
    WAIT T#2s;                  (* simulierte Zeit *)
    ASSERT SFC_Saege.iStep = 3, 'Text';
    RUN_UNTIL ROLLE_1 TIMEOUT T#5s;
    LOG 'Wert', PLC_PRG.x;
END_TEST
```

Im Test ist normales ST erlaubt. Zugriff: globale Variablen direkt, Programmvariablen als `Programm.Var`, Variablen des Haupt-Tasks auch ohne Präfix.

## Anlagenmodell

Ein zusätzliches ST-Programm (`role: model`), das in jedem Zyklus **vor** dem SPS-Programm läuft und aus den Ausgängen die Sensoren berechnet. `TIME()` liefert die Simulationszeit. Beispiel: `Saege_Anlage.st`.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/lexer.js`, `src/parser.js` | Tokenizer und Parser (mit Fehler-Recovery) |
| `src/types.js` | Datentypen, Standardfunktionen, TON/TOF/TP/R_TRIG/F_TRIG/CTU/CTD/CTUD/SR/RS |
| `src/compiler.js`, `src/codegen.js` | Typprüfung, Namensauflösung, Übersetzung in JS-Closures |
| `src/runtime.js` | Zyklus, Forcen, Variablenzugriff, Test-Runner, Zeitdiagramm |
| `src/sfc.js` | Erkennung von Schrittketten für den Ablaufplan |
| `serve.js` | lokaler Server (`npm start`) mit Dateizugriff auf den Projektordner |
| `web/` | Browser-Oberfläche; `build.js` baut `dist/` |
| `st-test.js` | CLI |

## Beispiel: Rohrsäge

`Saege_CODESYS.st` mit Unit-Tests (`Saege_Tests.sttest`), Anlagenmodell (`Saege_Anlage.st`) und Integrationstests (`Saege_Integration.sttest`). Zwei Tests sind absichtlich rot: Sie weisen nach, dass Schritt 10 mit dem Pegel von B1 statt mit der Flanke weiterschaltet – liegt das vorige Teil noch auf B1, fährt Anschlag 1 auf das neue Teil.

## Grenzen

Nicht unterstützt: Zeiger/REFERENCE, OOP (METHOD/EXTENDS), grafisches SFC, direkte Adressen im Code. Der Ablaufplan erkennt Schrittketten in Programmen (nicht in Funktionsbausteinen).
