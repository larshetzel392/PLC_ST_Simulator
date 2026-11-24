(* Selbsttest: METHOD, ACTION, EXTENDS/SUPER^/THIS^, S=/R=, direkte Adressen, Pragmas *)
{attribute 'qualified_only'}
VAR_GLOBAL
    xTaster AT %IX0.0 : BOOL;
    xLampe  AT %QX0.0 : BOOL;
END_VAR

FUNCTION_BLOCK FB_Zaehler
VAR_INPUT  xEin : BOOL; END_VAR
VAR_OUTPUT iWert : INT; END_VAR
VAR rtEin : R_TRIG; END_VAR
rtEin(CLK := xEin);
IF rtEin.Q THEN Plus(n := 1); END_IF
END_FUNCTION_BLOCK

METHOD Plus : INT
VAR_INPUT n : INT; END_VAR
iWert := iWert + n;
Plus := iWert;
END_METHOD

ACTION Nullen:
iWert := 0;
END_ACTION

FUNCTION_BLOCK FB_Grenze EXTENDS FB_Zaehler
VAR_INPUT  iMax : INT := 3; END_VAR
VAR_OUTPUT xVoll : BOOL; END_VAR
SUPER^();
xVoll := THIS^.iWert >= iMax;
END_FUNCTION_BLOCK

PROGRAM PLC_PRG
VAR
    fb   : FB_Grenze;
    iRet : INT;
END_VAR
fb(xEin := %IX0.0);
IF fb.xVoll AND %IX0.1 THEN fb.Nullen(); END_IF
iRet := fb.Plus(n := 0);
xLampe S= fb.xVoll;
xLampe R= %IX0.1;
END_PROGRAM
