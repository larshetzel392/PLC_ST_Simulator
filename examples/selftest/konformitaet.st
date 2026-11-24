(* Konformität: Ganzzahl-Überlauf, Division, Bits, REAL, TIME, Strings, Kopiersemantik, Funktionen/FBs, Schleifen, CASE *)
TYPE ST_P : STRUCT x : INT; y : INT; a : ARRAY[0..2] OF INT; END_STRUCT END_TYPE
TYPE E_C : (ROT := 1, GRUEN := 2, BLAU := 4); END_TYPE

FUNCTION F_Out : INT
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT doppelt : INT; END_VAR
VAR tmp : INT; END_VAR
tmp := tmp + 1;           (* Funktionen haben kein Gedächtnis *)
doppelt := a * 2;
F_Out := tmp;
END_FUNCTION

FUNCTION F_Early : INT
VAR_INPUT a : INT; END_VAR
F_Early := 1;
IF a > 0 THEN RETURN; END_IF
F_Early := 2;
END_FUNCTION

FUNCTION_BLOCK FB_Mem
VAR_INPUT inc : INT; END_VAR
VAR_OUTPUT sum : INT; END_VAR
VAR_TEMP t : INT; END_VAR
VAR n : INT; END_VAR
t := t + 1;      (* TEMP wird jedes Mal neu initialisiert *)
n := n + inc;
sum := n * 10 + t;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Swap
VAR_IN_OUT a, b : INT; END_VAR
VAR t : INT; END_VAR
t := a; a := b; b := t;
END_FUNCTION_BLOCK

PROGRAM PLC_PRG
VAR
    i : INT; si : SINT; usi : USINT; ui : UINT; di : DINT; ud : UDINT; li : LINT;
    b : BYTE; w : WORD; dw : DWORD;
    r : REAL; lr : LREAL;
    t : TIME;
    s : STRING; s5 : STRING(5);
    x : BOOL;
    p1, p2 : ST_P;
    a1, a2 : ARRAY[1..3] OF INT;
    m : ARRAY[1..2, 1..3] OF INT;
    c : E_C;
    fm : FB_Mem; fm2 : FB_Mem;
    sw : FB_Swap;
    o : INT; k : INT; n : INT;
END_VAR
;
END_PROGRAM
