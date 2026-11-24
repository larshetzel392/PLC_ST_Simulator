(* Ampel als Zustandsautomat über eine Aufzählung (CASE eZustand OF …). *)
TYPE E_Ampel : (AUS := 0, ROT, ROT_GELB, GRUEN, GELB); END_TYPE

PROGRAM PLC_PRG
VAR
  xEin AT %IX0.0 : BOOL;
  xRot AT %QX0.0 : BOOL;
  xGelb AT %QX0.1 : BOOL;
  xGruen AT %QX0.2 : BOOL;
  eZustand : E_Ampel := E_Ampel.AUS;
  tonPhase : TON;
END_VAR
tonPhase(IN := eZustand <> E_Ampel.AUS, PT := T#2S);
CASE eZustand OF
  E_Ampel.AUS:
    IF xEin THEN eZustand := E_Ampel.ROT; END_IF
  E_Ampel.ROT:
    IF tonPhase.Q THEN eZustand := E_Ampel.ROT_GELB; tonPhase(IN := FALSE); END_IF
  E_Ampel.ROT_GELB:
    IF tonPhase.Q THEN eZustand := E_Ampel.GRUEN; tonPhase(IN := FALSE); END_IF
  E_Ampel.GRUEN:
    IF tonPhase.Q THEN eZustand := E_Ampel.GELB; tonPhase(IN := FALSE); END_IF
  E_Ampel.GELB:
    IF tonPhase.Q THEN eZustand := E_Ampel.ROT; tonPhase(IN := FALSE); END_IF
END_CASE
IF NOT xEin THEN eZustand := E_Ampel.AUS; END_IF
xRot := eZustand = E_Ampel.ROT OR eZustand = E_Ampel.ROT_GELB;
xGelb := eZustand = E_Ampel.ROT_GELB OR eZustand = E_Ampel.GELB;
xGruen := eZustand = E_Ampel.GRUEN;
END_PROGRAM
