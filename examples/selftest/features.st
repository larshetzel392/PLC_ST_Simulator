TYPE E_Mode : (IDLE, RUN := 5, ERR); END_TYPE
TYPE ST_Pt : STRUCT x : INT := 3; y : REAL; END_STRUCT END_TYPE

VAR_GLOBAL
  gIn : BOOL;
  gCnt : INT;
  gArr : ARRAY[1..5] OF INT := [1, 2, 3(7)];
  gMode : E_Mode;
  gW : WORD := 16#00F0;
  gT : TIME;
END_VAR
VAR_GLOBAL CONSTANT
  N : INT := 5;
END_VAR

FUNCTION Add3 : INT
VAR_INPUT a, b : INT; c : INT := 100; END_VAR
Add3 := a + b + c;
END_FUNCTION

FUNCTION_BLOCK FB_Blink
VAR_INPUT en : BOOL; tOn : TIME := T#100ms; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
VAR t1, t2 : TON; END_VAR
t1(IN := en AND NOT t2.Q, PT := tOn);
t2(IN := t1.Q, PT := tOn);
q := t1.Q;
END_FUNCTION_BLOCK

PROGRAM PLC_PRG
VAR
  i, sum : INT;
  overflow : INT := 32767;
  r : REAL;
  p : ST_Pt;
  blink : FB_Blink;
  ton1 : TON;
  ctu1 : CTU;
  rt : R_TRIG;
  s : STRING := 'abc';
  div : INT := 7;
  bits : BYTE;
  m2 : ARRAY[0..2, 0..1] OF DINT;
  res : INT;
END_VAR
sum := 0;
FOR i := 1 TO N DO
  IF i = 4 THEN CONTINUE; END_IF
  sum := sum + gArr[i];
END_FOR
overflow := overflow + 1;
r := INT_TO_REAL(div) / 2;
div := 7 / 2;
res := Add3(1, 2) + Add3(a := 1, b := 1, c := 1);
s := CONCAT(s, 'def');
bits := SHL(BYTE#1, 3) OR 2#1;
gW.0 := TRUE;
m2[2, 1] := 42;
gMode := E_Mode.RUN;
p.y := p.x * 1.5;
blink(en := gIn);
ton1(IN := gIn, PT := T#1s);
rt(CLK := gIn);
ctu1(CU := gIn, PV := 3);
IF rt.Q THEN gCnt := gCnt + 1; END_IF
gT := ton1.ET;
CASE gCnt OF
  0: ;
  1..2: i := 100;
ELSE
  i := -1;
END_CASE
WHILE i < 105 DO i := i + 1; IF i = 103 THEN EXIT; END_IF END_WHILE
END_PROGRAM
