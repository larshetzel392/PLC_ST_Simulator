# ST Prüfstand

SPS-Simulator und Testumgebung für IEC 61131-3 **Structured Text** (CODESYS-Dialekt).
Code eingeben → wird übersetzt und geprüft (Syntax, Typen, Namen) → läuft in einer simulierten CPU → automatische Tests.

- **Code:** Editor mit Syntax-Hervorhebung, Fehlern direkt am Zeilenrand und Vorschlägen bei Tippfehlern
- **Simulation:** Live-Ablaufplan, automatisch aus beliebigem ST-Code erzeugt (siehe unten): aktiver Schritt, erfüllte/wartende Transitionen, Aktionen mit Ausgängen bzw. der im letzten Zyklus durchlaufene Programmpfad. Eingänge per Schalter/Taster setzen, vom Programm berechnete Signale (z.B. `xAuto`) festhalten (Forcen wie in CODESYS), optional ein Anlagenmodell in ST, das die Sensoren nachbildet
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

## Eigene Programme laden

**ST-Programm laden…** (über dem Ablaufplan) oder Dateien auf die Seite ziehen: `.st`, `.exp`, TwinCAT `.TcPOU`/`.TcGVL`/`.TcDUT` – mehrere Dateien werden zu einem Programm zusammengefügt, `.sttest` landet bei den Tests. Danach wird übersetzt und der Ablaufplan erzeugt.

Was beim Laden eines einzelnen Programms typischerweise fehlt, wird ergänzt und als Hinweis gemeldet:

- nicht deklarierte Variablen (fehlende GVL) → globale Variable, Typ aus der Verwendung (`IF x THEN` → BOOL, `n := n + 1` → INT …); `GVL.x` wird als `x` gelesen
- unbekannte Bausteine (Bibliotheken wie `MC_Power`) → leerer Platzhalter mit den benutzten Ein-/Ausgängen; die Ausgänge setzt man in der Simulation von Hand
- unbekannte Aufzählungstypen → INT, ihre Werte (`IDLE`, `RUN`) → Konstanten
- direkte Adressen im Code (`%IX0.0`) → Variable mit dieser AT-Adresse oder neue globale Variable

## Ablaufplan

Erzeugt aus dem Code (`src/sfc.js`), Auswahl über das Menü neben dem Titel:

- **Schrittketten** über eine Ganzzahl- oder Aufzählungsvariable – `CASE iStep OF`, IF/ELSIF-Ketten (`IF iStep = 10 THEN`), einzelne IFs (`IF iStep = 10 AND x THEN iStep := 20`), relative Sprünge (`iStep := iStep + 10`). Aktionen aus `Motor := (iStep = 3)`, aus Anweisungen im Schritt und aus Eintrittsaktionen (`IF xNeu THEN CASE iStep OF …`); Zuweisungen außerhalb der Kette (Reset) erscheinen als „Aus jedem Schritt“.
- **BOOL-Schrittmerker** – `IF S1 AND x THEN S1 := FALSE; S2 := TRUE; END_IF`
- **Programmablaufplan** (DIN 66001) für jedes Programm, jeden FB, jede Aktion und Methode; hervorgehoben ist der Pfad des letzten SPS-Zyklus.

Schrittketten in Funktionsbausteinen werden pro Instanz angezeigt (`PLC_PRG.st1.nSchritt`).

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
| `src/infer.js` | ergänzt fehlende Deklarationen (GVL, Bibliotheks-FBs, Adressen) |
| `src/runtime.js` | Zyklus, Forcen, Variablenzugriff, Test-Runner, Zeitdiagramm |
| `src/sfc.js` | Ablaufpläne: Schrittketten, Schrittmerker, Programmablaufplan |
| `serve.js` | lokaler Server (`npm start`) mit Dateizugriff auf den Projektordner |
| `web/` | Browser-Oberfläche; `build.js` baut `dist/` |
| `st-test.js` | CLI |

## Beispiel: Rohrsäge

`Saege_CODESYS.st` mit Unit-Tests (`Saege_Tests.sttest`), Anlagenmodell (`Saege_Anlage.st`) und Integrationstests (`Saege_Integration.sttest`). Zwei Tests sind absichtlich rot: Sie weisen nach, dass Schritt 10 mit dem Pegel von B1 statt mit der Flanke weiterschaltet – liegt das vorige Teil noch auf B1, fährt Anschlag 1 auf das neue Teil.

## Weitere Beispiele

`examples/allgemein/`: Ampel (Aufzählung als Zustand), zwei Stationen (Schrittkette im FB als IF/ELSIF mit relativer Weiterschaltung, mit Tests), Schrittmerker (BOOL-Kette). `examples/selftest/`: Sprachumfang und OOP (METHOD, ACTION, EXTENDS, `S=`/`R=`, Adressen).

## Bedienung: Werte eingeben

Im Bedienfeld und in der Variablentabelle werden Werte wie in ST eingegeben; zusätzlich gehen `2,5` (Komma), `3s`/`500ms` ohne `T#` und `1`/`0` für BOOL. Werte außerhalb des Datentyps (z.B. `99999` für INT) werden abgelehnt statt still überzulaufen.

## Selbsttests

`npm test` führt neben der Säge auch Sprachumfang, OOP, eine Konformitätsprüfung (Überlauf, Division/MOD, Bits, REAL, TIME, Strings, Kopiersemantik, Funktionen/FBs, Schleifen, CASE) und die Standard-Bausteine (TON/TOF/TP, Flanken, Zähler, SR/RS) aus – `examples/selftest/`.

## Grenzen

Nicht unterstützt: Zeiger/REFERENCE, PROPERTY, Schnittstellen als Typ, DATE/TOD-Literale, grafisches SFC/FUP/KOP, PLCopen-XML. Methoden werden statisch gebunden (keine virtuellen Aufrufe über die Basis). `REAL_TO_INT` rundet kaufmännisch (2,5 → 3); Steuerungen unterscheiden sich hier (manche runden auf die gerade Zahl, 2,5 → 2). TIME ist wie in CODESYS vorzeichenlos – negative Zeiten werden zu 0.
