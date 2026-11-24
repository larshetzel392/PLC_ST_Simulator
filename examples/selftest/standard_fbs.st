(* Standard-Bausteine: TON, TOF, TP, R_TRIG, F_TRIG, CTU, CTD, CTUD, SR, RS *)
PROGRAM PLC_PRG
VAR
    xIn : BOOL;
    ton1 : TON; tof1 : TOF; tp1 : TP;
    rt : R_TRIG; ft : F_TRIG;
    ctu1 : CTU; ctd1 : CTD; ctud1 : CTUD;
    sr1 : SR; rs1 : RS;
    xCu, xCd, xRes, xLoad, xS, xR : BOOL;
    nRt, nFt : INT;
END_VAR
ton1(IN := xIn, PT := T#100MS);
tof1(IN := xIn, PT := T#100MS);
tp1(IN := xIn, PT := T#100MS);
rt(CLK := xIn); IF rt.Q THEN nRt := nRt + 1; END_IF
ft(CLK := xIn); IF ft.Q THEN nFt := nFt + 1; END_IF
ctu1(CU := xCu, RESET := xRes, PV := 3);
ctd1(CD := xCd, LOAD := xLoad, PV := 2);
ctud1(CU := xCu, CD := xCd, RESET := xRes, LOAD := xLoad, PV := 2);
sr1(SET1 := xS, RESET := xR);
rs1(SET := xS, RESET1 := xR);
END_PROGRAM
