(* Zwei Bearbeitungsstationen als Instanzen eines FB.
   Schrittkette als IF/ELSIF über nSchritt mit relativer Weiterschaltung (nSchritt := nSchritt + 10).
   Der Ablaufplan wird je Instanz erzeugt: PLC_PRG.st1.nSchritt und PLC_PRG.st2.nSchritt. *)
VAR_GLOBAL
    xStart  AT %IX0.0 : BOOL;   (* Starttaster *)
    xTeil1  AT %IX0.1 : BOOL;   (* Teil in Station 1 *)
    xB1     AT %IX0.2 : BOOL;   (* Zylinder 1 vorne *)
    xB2     AT %IX0.3 : BOOL;   (* Zylinder 1 hinten *)
    xTeil2  AT %IX0.4 : BOOL;   (* Teil in Station 2 *)
    xB3     AT %IX0.5 : BOOL;   (* Zylinder 2 vorne *)
    xB4     AT %IX0.6 : BOOL;   (* Zylinder 2 hinten *)
    xY1     AT %QX0.0 : BOOL;   (* Zylinder 1 ausfahren *)
    xY2     AT %QX0.1 : BOOL;   (* Zylinder 2 ausfahren *)
END_VAR

FUNCTION_BLOCK FB_Station
VAR_INPUT
    xStart     : BOOL;
    xTeilDa    : BOOL;
    xZylVorne  : BOOL;
    xZylHinten : BOOL;
END_VAR
VAR_OUTPUT
    xZylAus : BOOL;
    xFertig : BOOL;
END_VAR
VAR
    nSchritt : INT := 0;
    tWarte   : TON;
END_VAR

tWarte(IN := nSchritt = 30, PT := T#500MS);

IF nSchritt = 0 AND xStart AND xTeilDa THEN
    nSchritt := 10;
END_IF

IF nSchritt = 10 THEN           (* ausfahren *)
    xZylAus := TRUE;
    IF xZylVorne THEN nSchritt := nSchritt + 10; END_IF
ELSIF nSchritt = 20 THEN        (* einfahren *)
    xZylAus := FALSE;
    IF xZylHinten THEN nSchritt := 30; END_IF
ELSIF nSchritt = 30 THEN        (* warten *)
    IF tWarte.Q THEN nSchritt := 40; END_IF
ELSIF nSchritt = 40 THEN        (* fertig, Teil entnehmen *)
    xFertig := TRUE;
    IF NOT xTeilDa THEN
        xFertig := FALSE;
        nSchritt := 0;
    END_IF
END_IF
END_FUNCTION_BLOCK

PROGRAM PLC_PRG
VAR
    st1, st2 : FB_Station;
END_VAR
st1(xStart := xStart, xTeilDa := xTeil1, xZylVorne := xB1, xZylHinten := xB2, xZylAus => xY1);
st2(xStart := st1.xFertig, xTeilDa := xTeil2, xZylVorne := xB3, xZylHinten := xB4, xZylAus => xY2);
END_PROGRAM
