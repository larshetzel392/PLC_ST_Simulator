

VAR_GLOBAL
    E0  : BOOL;  (* S0  Rohr an Anschlag 1 *)
    E1  : BOOL;  (* S1  Rohr an Anschlag 2 *)
    E2  : BOOL;  (* S2  gespannt *)
    E3  : BOOL;  (* S3  entspannt *)
    E4  : BOOL;  (* S4  Säge oben *)
    E5  : BOOL;  (* S5  Säge unten *)
    E6  : BOOL;  (* S6  Anschlag 1 oben *)
    E7  : BOOL;  (* S7  Anschlag 1 unten *)
    E8  : BOOL;  (* S8  EIN *)
    E9  : BOOL;  (* S9  AUS, Öffner *)
    E10 : BOOL;  (* S10 Start *)
    E11 : BOOL;  (* S11 Stopp, Öffner *)
    E12 : BOOL;  (* S12 Anschlag 2 oben *)
    E13 : BOOL;  (* S13 Anschlag 2 unten *)
    E14 : BOOL;  (* S14 dickes Rohr *)
    E15 : BOOL;  (* S15 dünnes Rohr *)
    WST_ABTRANSPORT      : BOOL;  (* B1 *)
    mot_schutz_saege     : BOOL;  (* F1..F5 Öffner *)
    mot_schutz_rolle1    : BOOL;
    mot_schutz_rolle2    : BOOL;
    mot_schutz_anschlag1 : BOOL;
    mot_schutz_anschlag2 : BOOL;

    SAEGE_RUNTER     : BOOL;  (* A1 *)
    SAEGE_HOCH       : BOOL;  (* A2 *)
    SPANNEN          : BOOL;  (* A3 *)
    ENTSPANNEN       : BOOL;  (* A4 *)
    SAEGE_ANTRIEB    : BOOL;  (* K1 *)
    ROLLE_1          : BOOL;  (* K2 *)
    ROLLE_2          : BOOL;  (* K3 *)
    ANSCHLAG1_HOCH   : BOOL;  (* K4 *)
    ANSCHLAG1_RUNTER : BOOL;  (* K5 *)
    ANSCHLAG2_HOCH   : BOOL;  (* K6 *)
    ANSCHLAG2_RUNTER : BOOL;  (* K7 *)
END_VAR


FUNCTION_BLOCK FB_Betriebsart
VAR_OUTPUT
    xEin      : BOOL;
    xAuto     : BOOL;
    xStoerung : BOOL;
END_VAR

xStoerung := NOT (mot_schutz_saege AND mot_schutz_rolle1 AND mot_schutz_rolle2
                  AND mot_schutz_anschlag1 AND mot_schutz_anschlag2);

IF E8 THEN xEin := TRUE;END_IF
IF NOT E9 OR xStoerung THEN xEin := FALSE; END_IF

(* Stopp: laufendes Rohr wird fertig bearbeitet *)
IF E10 AND xEin THEN xAuto := TRUE; END_IF
IF NOT E11 OR NOT xEin THEN xAuto := FALSE; END_IF
END_FUNCTION_BLOCK



PROGRAM SFC_Saege
VAR_INPUT
    xAuto      : BOOL;
    xB1_Flanke : BOOL;
    xReset     : BOOL;   (* zurueck in Grundstellung S1 *)
END_VAR
VAR
    iStep     : INT := 1;
    iStepOld  : INT := 0;
    xNeu      : BOOL;    (* Schritt wurde in diesem Zyklus betreten *)
    xDuenn    : BOOL;
    xDick     : BOOL;
    iSoll     : INT;
    iZaehler  : INT;
    xK1, xK2, xK3, xK5, xK7 : BOOL;
    xAbtransport : BOOL;
    xA1, xA2, xA3, xA4 : BOOL;
END_VAR

(* Reset *)
IF xReset THEN
    iStep    := 1;
    iZaehler := 0;
    xDuenn   := FALSE;
    xDick    := FALSE;
END_IF


xNeu     := (iStep <> iStepOld);
iStepOld := iStep;
(* Start *)
IF xNeu THEN
    CASE iStep OF
        2:  (* ACT_Rohrtyp *)
            xDuenn := E15;
            xDick  := E14 AND NOT E15;
            IF xDuenn THEN iSoll := 4; ELSE iSoll := 3; END_IF
        10: (* ACT_Zaehlen *)
            iZaehler := iZaehler + 1;
        11: (* ACT_Ruecksetzen *)
            iZaehler := 0;
            xDuenn   := FALSE;
            xDick    := FALSE;
    END_CASE
END_IF

(*Schrittekette *)
CASE iStep OF
    1:  IF xAuto AND E3 AND E4 AND E6 AND E12 AND (E14 OR E15) THEN iStep := 2;  END_IF
    2:  IF xDuenn THEN iStep := 3;
        ELSIF xDick THEN iStep := 4; END_IF
    3:  IF E7  THEN iStep := 5; END_IF
    4:  IF E13 THEN iStep := 5; END_IF
    5:  IF (xDuenn AND E0) OR (xDick AND E1) THEN iStep := 6; END_IF
    6:  IF E2  THEN iStep := 7; END_IF
    7:  IF E5  THEN iStep := 8; END_IF
    8:  IF E4  THEN iStep := 9; END_IF
    9:  IF E3  THEN iStep := 10; END_IF
    10: IF WST_ABTRANSPORT AND E6 AND E12 THEN
            IF iZaehler < iSoll THEN
                IF xDuenn THEN iStep := 3; ELSE iStep := 4; END_IF
            ELSE
                iStep := 11;
            END_IF
        END_IF
    11: IF xB1_Flanke THEN iStep := 1; END_IF
END_CASE

(* Schrittverriegelungen*)
xK1          := (iStep = 7) OR (iStep = 8);
xK2          := (iStep = 5) OR (iStep = 11);
xK3          := (iStep = 5) OR (iStep = 10) OR (iStep = 11);
xK5          := (iStep = 3);
xK7          := (iStep = 4);
xA1          := (iStep = 7);
xA2          := (iStep = 8);
xA3          := (iStep = 6);
xA4          := (iStep = 9);
xAbtransport := (iStep = 10);
END_PROGRAM


PROGRAM PRG_Ausgaenge
VAR_INPUT
    xFreigabe : BOOL;
END_VAR

ROLLE_1          := xFreigabe AND SFC_Saege.xK2 AND E3;
ROLLE_2          := xFreigabe AND SFC_Saege.xK3;
SPANNEN          := xFreigabe AND SFC_Saege.xA3 AND NOT SFC_Saege.xA4;
ENTSPANNEN       := xFreigabe AND SFC_Saege.xA4 AND E4;
SAEGE_ANTRIEB    := xFreigabe AND SFC_Saege.xK1 AND E2;
SAEGE_RUNTER     := xFreigabe AND SFC_Saege.xA1 AND E2 AND NOT SFC_Saege.xA2;
SAEGE_HOCH       := xFreigabe AND SFC_Saege.xA2;
ANSCHLAG1_HOCH   := xFreigabe AND SFC_Saege.xAbtransport AND SFC_Saege.xDuenn;
ANSCHLAG2_HOCH   := xFreigabe AND SFC_Saege.xAbtransport AND SFC_Saege.xDick;
ANSCHLAG1_RUNTER := xFreigabe AND SFC_Saege.xK5 AND NOT ANSCHLAG1_HOCH;
ANSCHLAG2_RUNTER := xFreigabe AND SFC_Saege.xK7 AND NOT ANSCHLAG2_HOCH;
END_PROGRAM


PROGRAM PLC_PRG
VAR
    fbBetriebsart : FB_Betriebsart;
    rtB1          : R_TRIG;
END_VAR

fbBetriebsart();
rtB1(CLK := WST_ABTRANSPORT);

SFC_Saege(xAuto := fbBetriebsart.xAuto, xB1_Flanke := rtB1.Q, xReset := NOT fbBetriebsart.xEin);

PRG_Ausgaenge(xFreigabe := fbBetriebsart.xEin AND NOT fbBetriebsart.xStoerung);
END_PROGRAM
