(* Autowaschanlage (Portalwäsche)
   Ablauf: Auto einfahren → Vorwäsche → Bürsten (Hin- und Rückfahrt, Anzahl je Programm)
           → Spülen → Trocknen → Ausfahrt frei.
   Not-Halt oder Lichtschranke während der Fahrt → Störung, Quittieren → Grundstellung. *)

TYPE E_Wasch : (BEREIT, EINFAHREN, VORWAESCHE, BUERSTEN_VOR, BUERSTEN_ZURUECK, SPUELEN, TROCKNEN, AUSFAHRT, STOERUNG); END_TYPE

VAR_GLOBAL
    (* Eingänge *)
    xStartTaster   AT %IX0.0 : BOOL;   (* Münze eingeworfen / Start *)
    xProgPremium   AT %IX0.1 : BOOL;   (* Programmwahl: TRUE = Premium (3× bürsten) *)
    xAutoInPos     AT %IX0.2 : BOOL;   (* Auto steht richtig (Radsensor) *)
    xPortalVorne   AT %IX0.3 : BOOL;   (* Endschalter Portal vorne *)
    xPortalHinten  AT %IX0.4 : BOOL;   (* Endschalter Portal hinten *)
    xLichtschranke AT %IX0.5 : BOOL;   (* Person im Bereich *)
    xNotHalt       AT %IX0.6 : BOOL;   (* Öffner: TRUE = in Ordnung *)
    xQuittieren    AT %IX0.7 : BOOL;
    (* Ausgänge *)
    xAmpelRot      AT %QX0.0 : BOOL;
    xAmpelGruen    AT %QX0.1 : BOOL;
    xPortalVor     AT %QX0.2 : BOOL;
    xPortalZurueck AT %QX0.3 : BOOL;
    xBuersten      AT %QX0.4 : BOOL;
    xShampoo       AT %QX0.5 : BOOL;
    xWasser        AT %QX0.6 : BOOL;
    xGeblaese      AT %QX0.7 : BOOL;
    xStoerLampe    AT %QX1.0 : BOOL;
END_VAR

PROGRAM PLC_PRG
VAR
    eSchritt    : E_Wasch := E_Wasch.BEREIT;
    rtStart     : R_TRIG;
    tonVorwasch : TON;
    tonSpuelen  : TON;
    tonTrocknen : TON;
    tonAusfahrt : TON;
    nDurchgang  : INT;          (* gefahrene Bürstendurchgänge *)
    nSoll       : INT := 2;
    nAutosHeute : UDINT;
    tBlink      : TON;
    xBlink      : BOOL;
END_VAR

rtStart(CLK := xStartTaster);

(* Störung hat Vorrang vor allem *)
IF NOT xNotHalt OR (xLichtschranke AND (xPortalVor OR xPortalZurueck)) THEN
    eSchritt := E_Wasch.STOERUNG;
END_IF

tonVorwasch(IN := eSchritt = E_Wasch.VORWAESCHE, PT := T#4S);
tonSpuelen (IN := eSchritt = E_Wasch.SPUELEN,    PT := T#3S);
tonTrocknen(IN := eSchritt = E_Wasch.TROCKNEN,   PT := T#5S);
tonAusfahrt(IN := eSchritt = E_Wasch.AUSFAHRT AND NOT xAutoInPos, PT := T#2S);

CASE eSchritt OF
    E_Wasch.BEREIT:
        IF rtStart.Q THEN
            IF xProgPremium THEN nSoll := 3; ELSE nSoll := 2; END_IF
            nDurchgang := 0;
            eSchritt := E_Wasch.EINFAHREN;
        END_IF

    E_Wasch.EINFAHREN:
        IF xAutoInPos AND xPortalHinten AND NOT xLichtschranke THEN
            eSchritt := E_Wasch.VORWAESCHE;
        END_IF

    E_Wasch.VORWAESCHE:
        IF tonVorwasch.Q THEN eSchritt := E_Wasch.BUERSTEN_VOR; END_IF

    E_Wasch.BUERSTEN_VOR:
        IF xPortalVorne THEN eSchritt := E_Wasch.BUERSTEN_ZURUECK; END_IF

    E_Wasch.BUERSTEN_ZURUECK:
        IF xPortalHinten THEN
            nDurchgang := nDurchgang + 1;
            IF nDurchgang < nSoll THEN
                eSchritt := E_Wasch.BUERSTEN_VOR;
            ELSE
                eSchritt := E_Wasch.SPUELEN;
            END_IF
        END_IF

    E_Wasch.SPUELEN:
        IF tonSpuelen.Q THEN eSchritt := E_Wasch.TROCKNEN; END_IF

    E_Wasch.TROCKNEN:
        IF tonTrocknen.Q THEN eSchritt := E_Wasch.AUSFAHRT; END_IF

    E_Wasch.AUSFAHRT:
        IF tonAusfahrt.Q THEN
            nAutosHeute := nAutosHeute + 1;
            eSchritt := E_Wasch.BEREIT;
        END_IF

    E_Wasch.STOERUNG:
        IF xQuittieren AND xNotHalt AND NOT xLichtschranke THEN
            eSchritt := E_Wasch.BEREIT;
        END_IF
END_CASE

(* Ausgänge *)
tBlink(IN := NOT tBlink.Q, PT := T#500MS);
IF tBlink.Q THEN xBlink := NOT xBlink; END_IF

xPortalVor     := eSchritt = E_Wasch.BUERSTEN_VOR;
xPortalZurueck := eSchritt = E_Wasch.BUERSTEN_ZURUECK OR (eSchritt = E_Wasch.EINFAHREN AND NOT xPortalHinten);
xBuersten      := eSchritt = E_Wasch.BUERSTEN_VOR OR eSchritt = E_Wasch.BUERSTEN_ZURUECK;
xShampoo       := eSchritt = E_Wasch.VORWAESCHE;
xWasser        := eSchritt = E_Wasch.VORWAESCHE OR eSchritt = E_Wasch.SPUELEN;
xGeblaese      := eSchritt = E_Wasch.TROCKNEN;
xAmpelGruen    := eSchritt = E_Wasch.EINFAHREN OR eSchritt = E_Wasch.AUSFAHRT;
xAmpelRot      := NOT xAmpelGruen;
xStoerLampe    := eSchritt = E_Wasch.STOERUNG AND xBlink;
END_PROGRAM
