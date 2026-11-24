(* Schrittkette aus BOOL-Schrittmerkern S0..S3: IF S1 AND xOben THEN S1 := FALSE; S2 := TRUE; END_IF *)
PROGRAM PLC_PRG
VAR
  S0 : BOOL := TRUE;
  S1, S2, S3 : BOOL;
  xStart, xOben, xUnten, xReset : BOOL;
  xMotorAuf, xMotorAb : BOOL;
END_VAR
IF S0 AND xStart THEN S0 := FALSE; S1 := TRUE; END_IF
IF S1 AND xOben THEN S1 := FALSE; S2 := TRUE; END_IF
IF S2 AND xUnten THEN S2 := FALSE; S3 := TRUE; END_IF
IF S3 AND NOT xStart THEN S3 := FALSE; S0 := TRUE; END_IF
IF xReset THEN S1 := FALSE; S2 := FALSE; S3 := FALSE; S0 := TRUE; END_IF
xMotorAuf := S1;
xMotorAb := S2;
END_PROGRAM
