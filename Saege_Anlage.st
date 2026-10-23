(* ============================================================
   Anlagenmodell Rohrsäge  –  läuft im Simulator in jedem Zyklus
   VOR dem SPS-Programm und bildet die Sensoren (E0..E15, B1)
   aus den Ausgängen (A1..A4, K1..K7) nach.

   Geometrie (mm, ab Sägeblatt):  Anschlag 1 = 300, Anschlag 2 = 500,
   Lichtschranke B1 = 1500.  Rohrlänge 1700 mm.
   ============================================================ *)

PROGRAM SIM_Saege
VAR_INPUT
    xNaechstesDick : BOOL := FALSE;   (* Typ des nächsten Rohres *)
    xNachladen     : BOOL := TRUE;    (* automatisch neues Rohr auflegen *)
END_VAR
VAR_OUTPUT
    iSchnitte      : INT;             (* Anzahl Schnitte gesamt *)
    iAbtransport   : INT;             (* Teile, die die Anlage verlassen haben *)
    iRohre         : INT;             (* aufgelegte Rohre *)
    xKollision     : BOOL;            (* mechanische Kollision erkannt *)
    sKollision     : STRING;
END_VAR
VAR CONSTANT
    POS_A1   : REAL := 300.0;
    POS_A2   : REAL := 500.0;
    POS_B1   : REAL := 1500.0;
    ROHR_LEN : REAL := 1700.0;
    V_ROLLE  : REAL := 0.5;     (* mm/ms *)
    V_SAEGE  : REAL := 0.1;     (* %/ms  -> 1 s Hub *)
    V_SPANN  : REAL := 0.4;     (* %/ms  -> 250 ms *)
    V_ANSCHL : REAL := 0.25;    (* %/ms  -> 400 ms *)
    MAX_TEILE : INT := 8;
END_VAR
VAR
    xInit      : BOOL;
    tLast      : TIME;
    dt         : REAL;
    rSaege     : REAL := 100.0;  (* 100 = oben, 0 = unten *)
    rSpann     : REAL := 0.0;    (* 0 = entspannt, 100 = gespannt *)
    rAnschlag1 : REAL := 0.0;    (* 0 = oben, 100 = unten *)
    rAnschlag2 : REAL := 0.0;
    xRohrDick  : BOOL;
    rRohrFront : REAL;           (* Rohranfang hinter dem Sägeblatt *)
    rRohrLen   : REAL;           (* Restlänge auf der Zuführung *)
    aFront     : ARRAY[1..8] OF REAL;   (* abgesägte Teile auf Rollenbahn 2 *)
    aLen       : ARRAY[1..8] OF REAL;
    nTeile     : INT;
    xGeschnitten : BOOL;
    tonLaden   : TON;
    i, k       : INT;
    rWeg, rHinten : REAL;
END_VAR

(* ---------- Initialisierung beim ersten Zyklus ---------- *)
IF NOT xInit THEN
    xInit := TRUE;
    tLast := TIME();
    E9 := TRUE;  E11 := TRUE;   (* Öffner nicht betätigt *)
    mot_schutz_saege := TRUE;  mot_schutz_rolle1 := TRUE;  mot_schutz_rolle2 := TRUE;
    mot_schutz_anschlag1 := TRUE;  mot_schutz_anschlag2 := TRUE;
END_IF
dt := TIME_TO_REAL(TIME() - tLast);
tLast := TIME();

(* ---------- Säge ---------- *)
IF SAEGE_RUNTER AND NOT SAEGE_HOCH THEN
    rSaege := MAX(0.0, rSaege - V_SAEGE * dt);
ELSIF SAEGE_HOCH AND NOT SAEGE_RUNTER THEN
    rSaege := MIN(100.0, rSaege + V_SAEGE * dt);
END_IF
IF rSaege < 60.0 AND rRohrLen > 0.0 AND NOT SAEGE_ANTRIEB AND NOT xKollision THEN
    xKollision := TRUE;  sKollision := 'Säge fährt ohne Antrieb ins Rohr';
END_IF
IF rSaege < 60.0 AND rRohrLen > 0.0 AND rSpann < 100.0 AND NOT xKollision THEN
    xKollision := TRUE;  sKollision := 'Sägen ohne gespanntes Rohr';
END_IF

(* ---------- Spannbacken ---------- *)
IF SPANNEN AND NOT ENTSPANNEN THEN
    rSpann := MIN(100.0, rSpann + V_SPANN * dt);
ELSIF ENTSPANNEN AND NOT SPANNEN THEN
    rSpann := MAX(0.0, rSpann - V_SPANN * dt);
END_IF

(* ---------- Längenanschläge ---------- *)
IF ANSCHLAG1_RUNTER AND NOT ANSCHLAG1_HOCH THEN rAnschlag1 := MIN(100.0, rAnschlag1 + V_ANSCHL * dt);
ELSIF ANSCHLAG1_HOCH AND NOT ANSCHLAG1_RUNTER THEN rAnschlag1 := MAX(0.0, rAnschlag1 - V_ANSCHL * dt); END_IF
IF ANSCHLAG2_RUNTER AND NOT ANSCHLAG2_HOCH THEN rAnschlag2 := MIN(100.0, rAnschlag2 + V_ANSCHL * dt);
ELSIF ANSCHLAG2_HOCH AND NOT ANSCHLAG2_RUNTER THEN rAnschlag2 := MAX(0.0, rAnschlag2 - V_ANSCHL * dt); END_IF

(* Anschlag fährt auf ein Teil, das unter ihm liegt? *)
FOR i := 1 TO nTeile DO
    rHinten := aFront[i] - aLen[i];
    IF ANSCHLAG1_RUNTER AND rHinten < POS_A1 - 1.0 AND aFront[i] > POS_A1 + 1.0 AND NOT xKollision THEN
        xKollision := TRUE;  sKollision := 'Anschlag 1 fährt auf ein Teil';
    END_IF
    IF ANSCHLAG2_RUNTER AND rHinten < POS_A2 - 1.0 AND aFront[i] > POS_A2 + 1.0 AND NOT xKollision THEN
        xKollision := TRUE;  sKollision := 'Anschlag 2 fährt auf ein Teil';
    END_IF
END_FOR

IF ANSCHLAG1_RUNTER AND rRohrLen > 0.0 AND rRohrFront > POS_A1 + 1.0 AND NOT xKollision THEN
    xKollision := TRUE;  sKollision := 'Anschlag 1 fährt auf das Rohr';
END_IF
IF ANSCHLAG2_RUNTER AND rRohrLen > 0.0 AND rRohrFront > POS_A2 + 1.0 AND NOT xKollision THEN
    xKollision := TRUE;  sKollision := 'Anschlag 2 fährt auf das Rohr';
END_IF

(* ---------- Rohr auf der Zuführung (Rollenbahn 1) ---------- *)
IF ROLLE_1 AND rRohrLen > 0.0 THEN
    IF rSpann > 0.0 THEN
        IF NOT xKollision THEN xKollision := TRUE; sKollision := 'Vorschub gegen gespanntes Rohr'; END_IF
    ELSE
        rWeg := V_ROLLE * dt;
        rRohrFront := rRohrFront + rWeg;
        IF rAnschlag1 > 0.0 AND rRohrFront - rWeg <= POS_A1 + 0.01 THEN rRohrFront := MIN(rRohrFront, POS_A1); END_IF
        IF rAnschlag2 > 0.0 AND rRohrFront - rWeg <= POS_A2 + 0.01 THEN rRohrFront := MIN(rRohrFront, POS_A2); END_IF
        (* Rohrende hat die Säge passiert -> Reststück auf Rollenbahn 2 *)
        IF rRohrFront >= rRohrLen AND nTeile < MAX_TEILE THEN
            nTeile := nTeile + 1;
            aFront[nTeile] := rRohrFront;  aLen[nTeile] := rRohrLen;
            rRohrLen := 0.0;  rRohrFront := 0.0;
        END_IF
    END_IF
END_IF

(* ---------- Schnitt ---------- *)
IF SAEGE_ANTRIEB AND rSaege <= 0.0 AND rSpann >= 100.0 AND NOT xGeschnitten AND rRohrFront > 0.0 AND nTeile < MAX_TEILE THEN
    xGeschnitten := TRUE;
    iSchnitte := iSchnitte + 1;
    nTeile := nTeile + 1;
    aFront[nTeile] := rRohrFront;  aLen[nTeile] := rRohrFront;
    rRohrLen := rRohrLen - rRohrFront;
    rRohrFront := 0.0;
END_IF
IF rSaege >= 100.0 THEN xGeschnitten := FALSE; END_IF

(* ---------- Teile auf Rollenbahn 2 ---------- *)
IF ROLLE_2 THEN
    rWeg := V_ROLLE * dt;
    FOR i := 1 TO nTeile DO
        aFront[i] := aFront[i] + rWeg;
        IF rAnschlag1 > 0.0 AND aFront[i] - rWeg <= POS_A1 + 0.01 THEN aFront[i] := MIN(aFront[i], POS_A1); END_IF
        IF rAnschlag2 > 0.0 AND aFront[i] - rWeg <= POS_A2 + 0.01 THEN aFront[i] := MIN(aFront[i], POS_A2); END_IF
    END_FOR
END_IF
(* Teile, die die Rollenbahn verlassen haben, entfernen *)
i := 1;
WHILE i <= nTeile DO
    IF aFront[i] - aLen[i] > POS_B1 + 300.0 THEN
        FOR k := i TO nTeile - 1 DO
            aFront[k] := aFront[k + 1];  aLen[k] := aLen[k + 1];
        END_FOR
        nTeile := nTeile - 1;
        iAbtransport := iAbtransport + 1;
    ELSE
        i := i + 1;
    END_IF
END_WHILE

(* ---------- Rohr nachladen ---------- *)
tonLaden(IN := xNachladen AND rRohrLen <= 0.0 AND NOT ROLLE_1, PT := T#1s);   (* Werker legt nur bei stehender Bahn auf *)
IF tonLaden.Q THEN
    rRohrLen := ROHR_LEN;  rRohrFront := 0.0;
    xRohrDick := xNaechstesDick;
    iRohre := iRohre + 1;
END_IF

(* ---------- Sensoren ---------- *)
E0  := rRohrLen > 0.0 AND rAnschlag1 >= 100.0 AND rRohrFront >= POS_A1 - 0.5;
E1  := rRohrLen > 0.0 AND rAnschlag2 >= 100.0 AND rRohrFront >= POS_A2 - 0.5;
E2  := rSpann >= 100.0;
E3  := rSpann <= 0.0;
E4  := rSaege >= 100.0;
E5  := rSaege <= 0.0;
E6  := rAnschlag1 <= 0.0;
E7  := rAnschlag1 >= 100.0;
E12 := rAnschlag2 <= 0.0;
E13 := rAnschlag2 >= 100.0;
E14 := rRohrLen > 0.0 AND xRohrDick;
E15 := rRohrLen > 0.0 AND NOT xRohrDick;
WST_ABTRANSPORT := FALSE;
FOR i := 1 TO nTeile DO
    IF aFront[i] >= POS_B1 AND aFront[i] - aLen[i] <= POS_B1 THEN WST_ABTRANSPORT := TRUE; END_IF
END_FOR
END_PROGRAM
