// ST Parser – erzeugt einen AST aus den Tokens
(function (ST) {
  'use strict';
  const { STError } = ST;

  const BLOCK_END = { IF: 'END_IF', CASE: 'END_CASE', FOR: 'END_FOR', WHILE: 'END_WHILE', REPEAT: 'END_REPEAT' };
  const VAR_KINDS = ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_GLOBAL', 'VAR_EXTERNAL', 'VAR_STAT'];

  class Parser {
    constructor(src, opts) {
      this.opts = opts || {};
      this.toks = ST.lex(src, opts);
      this.p = 0;
      this.errors = [];
    }
    get t() { return this.toks[this.p]; }
    peek(k) { return this.toks[Math.min(this.p + (k || 0), this.toks.length - 1)]; }
    next() { const t = this.toks[this.p]; if (t.type !== 'eof') this.p++; return t; }
    isKw(v) { return this.t.type === 'kw' && this.t.value === v; }
    isOp(v) { return this.t.type === 'op' && this.t.value === v; }
    err(msg, tok) { tok = tok || this.t; return new STError(msg, tok.line, tok.col); }
    expectKw(v) {
      if (!this.isKw(v)) throw this.err(`'${v}' erwartet, gefunden '${this.t.text}'`);
      return this.next();
    }
    expectOp(v) {
      if (!this.isOp(v)) {
        // Fehlendes ';' am Zeilenende: Fehler an das Ende des vorherigen Tokens hängen
        if (v === ';' && this.p > 0) {
          const prev = this.toks[this.p - 1];
          throw new STError(`';' erwartet nach '${prev.text}'`, prev.line, prev.col + String(prev.text).length);
        }
        throw this.err(`'${v}' erwartet, gefunden '${this.t.text}'`);
      }
      return this.next();
    }
    acceptOp(v) { if (this.isOp(v)) { this.next(); return true; } return false; }
    acceptKw(v) { if (this.isKw(v)) { this.next(); return true; } return false; }
    ident(what) {
      if (this.t.type !== 'ident') throw this.err(`${what || 'Bezeichner'} erwartet, gefunden '${this.t.text}'`);
      return this.next();
    }

    // ---------- Dateiebene ----------
    parseFile() {
      const file = { globals: [], types: [], pous: [] };
      let last = null;
      while (this.t.type !== 'eof') {
        if (this.isKw('VAR_GLOBAL')) file.globals.push(this.parseVarSection());
        else if (this.isKw('TYPE')) file.types.push(...this.parseTypeBlock());
        else if (this.isKw('PROGRAM') || this.isKw('FUNCTION_BLOCK') || this.isKw('FUNCTION')) { last = this.parsePou(); file.pous.push(last); }
        else if (this.isKw('METHOD') || this.isKw('ACTION')) {
          // Methoden/Aktionen nach END_FUNCTION_BLOCK gehören zum Baustein davor (CODESYS-/TwinCAT-Textexport)
          const t = this.t;
          const m = this.isKw('METHOD') ? this.parseMethod() : this.parseAction();
          let owner = last;
          if (m.owner) owner = file.pous.find(p => p.name === m.owner) || null;
          if (!owner || owner.kind === 'FUNCTION') throw this.err(`${t.value} '${m.display}' gehört zu keinem FUNCTION_BLOCK/PROGRAM`, t);
          (m.kind === 'METHOD' ? owner.methods : owner.actions).push(m);
        }
        else if (this.t.type === 'ident' && (this.t.value === 'INTERFACE' || this.t.value === 'PROPERTY')) {
          const t = this.next();
          // Schnittstellen enthalten nur Signaturen – überspringen; Eigenschaften werden nicht unterstützt
          if (t.value === 'PROPERTY') throw this.err('PROPERTY wird vom Simulator nicht unterstützt', t);
          while (this.t.type !== 'eof' && !(this.t.type === 'ident' && this.t.value === 'END_INTERFACE')) this.next();
          this.next();
        }
        else if (this.isOp(';')) this.next();
        else throw this.err(`PROGRAM, FUNCTION_BLOCK, FUNCTION, TYPE oder VAR_GLOBAL erwartet, gefunden '${this.t.text}'`);
      }
      return file;
    }

    skipModifiers() {
      while (this.t.type === 'ident' && /^(PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL|ABSTRACT)$/.test(this.t.value)) this.next();
    }

    parseMethod() {
      const kw = this.expectKw('METHOD');
      this.skipModifiers();
      let nameTok = this.ident('Methodenname');
      let owner = null;
      if (this.isOp('.') && this.peek(1).type === 'ident') { this.next(); owner = nameTok.value; nameTok = this.next(); }
      const m = { kind: 'METHOD', name: nameTok.value, display: nameTok.text, owner, line: kw.line, sections: [], body: [], retType: null };
      if (this.acceptOp(':')) m.retType = this.parseTypeSpec(false);
      this.acceptOp(';');
      while (VAR_KINDS.includes(this.t.value) && this.t.type === 'kw') m.sections.push(this.parseVarSection());
      m.body = this.parseStatements(['END_METHOD']);
      this.expectKw('END_METHOD');
      return m;
    }

    parseAction() {
      const kw = this.expectKw('ACTION');
      let nameTok = this.ident('Aktionsname');
      let owner = null;
      if (this.isOp('.') && this.peek(1).type === 'ident') { this.next(); owner = nameTok.value; nameTok = this.next(); }
      this.acceptOp(':');
      const body = this.parseStatements(['END_ACTION']);
      this.expectKw('END_ACTION');
      return { kind: 'ACTION', name: nameTok.value, display: nameTok.text, owner, line: kw.line, body };
    }

    parseTypeBlock() {
      this.expectKw('TYPE');
      const out = [];
      do {
        const nameTok = this.ident('Typname');
        // CODESYS: TYPE X : STRUCT ... END_STRUCT END_TYPE  oder  TYPE X : (A, B) ; END_TYPE
        this.expectOp(':');
        const spec = this.parseTypeSpec(true);
        let init = null;
        if (this.acceptOp(':=')) init = this.parseExpr();
        this.acceptOp(';');
        out.push({ name: nameTok.value, display: nameTok.text, spec, init, line: nameTok.line });
      } while (this.t.type === 'ident');
      this.expectKw('END_TYPE');
      return out;
    }

    parsePou() {
      const kindTok = this.next();
      const kind = kindTok.value;
      this.skipModifiers();
      const nameTok = this.ident(`Name für ${kind}`);
      const pou = { kind, name: nameTok.value, display: nameTok.text, line: nameTok.line, sections: [], body: [], retType: null, methods: [], actions: [], extends: null };
      if (kind === 'FUNCTION') {
        if (this.acceptOp(':')) pou.retType = this.parseTypeSpec(false);
      }
      // CODESYS-OOP: EXTENDS (Vererbung) und IMPLEMENTS (Schnittstellen, nur Signaturen)
      for (;;) {
        if (this.t.type === 'ident' && this.t.value === 'EXTENDS') {
          this.next();
          const b = this.ident('Basis-Baustein');
          pou.extends = { name: b.value, display: b.text, line: b.line, col: b.col };
        } else if (this.t.type === 'ident' && this.t.value === 'IMPLEMENTS') {
          this.next();
          do this.ident('Schnittstelle'); while (this.acceptOp(','));
        } else break;
      }
      while (VAR_KINDS.includes(this.t.value) && this.t.type === 'kw') pou.sections.push(this.parseVarSection());
      const endKw = 'END_' + kind;
      const inner = () => {
        while (this.isKw('METHOD') || this.isKw('ACTION')) {
          if (kind === 'FUNCTION') throw this.err(`${this.t.value} ist in einer FUNCTION nicht möglich`);
          const m = this.isKw('METHOD') ? this.parseMethod() : this.parseAction();
          (m.kind === 'METHOD' ? pou.methods : pou.actions).push(m);
        }
      };
      inner();
      pou.body = this.parseStatements([endKw, 'METHOD', 'ACTION']);
      inner();
      this.expectKw(endKw);
      return pou;
    }

    parseVarSection() {
      const kTok = this.next();
      const sec = { kind: kTok.value, constant: false, retain: false, vars: [], line: kTok.line };
      for (;;) {
        if (this.acceptKw('CONSTANT')) sec.constant = true;
        else if (this.acceptKw('RETAIN') || this.acceptKw('PERSISTENT')) sec.retain = true;
        else break;
      }
      while (!this.isKw('END_VAR')) {
        if (this.t.type === 'eof') throw this.err("'END_VAR' fehlt");
        sec.vars.push(...this.parseVarDecl());
      }
      this.expectKw('END_VAR');
      return sec;
    }

    parseVarDecl() {
      const names = [this.ident('Variablenname')];
      while (this.acceptOp(',')) names.push(this.ident('Variablenname'));
      let address = null;
      if (this.acceptKw('AT')) {
        if (this.t.type !== 'address') throw this.err('Adresse (z.B. %IX0.0) erwartet');
        address = this.next().value;
      }
      this.expectOp(':');
      const type = this.parseTypeSpec(false);
      let init = null;
      if (this.acceptOp(':=')) init = this.parseInitializer();
      this.expectOp(';');
      return names.map(n => ({ name: n.value, display: n.text, type, init, address, line: n.line, col: n.col }));
    }

    parseInitializer() {
      if (this.isOp('[')) {
        const t = this.next();
        const items = [];
        if (!this.isOp(']')) {
          do {
            // n(wert) Wiederholung
            if (this.t.type === 'int' && this.peek(1).type === 'op' && this.peek(1).value === '(') {
              const cnt = this.next().value; this.next();
              const v = this.isOp(')') ? null : this.parseInitializer();
              this.expectOp(')');
              items.push({ repeat: cnt, value: v });
            } else items.push({ repeat: 1, value: this.parseInitializer() });
          } while (this.acceptOp(','));
        }
        this.expectOp(']');
        return { e: 'arrinit', items, line: t.line, col: t.col };
      }
      // Struct-Initialisierung (a := 1, b := 2)
      if (this.isOp('(') && this.peek(1).type === 'ident' && this.peek(2).type === 'op' && this.peek(2).value === ':=') {
        const t = this.next();
        const fields = [];
        do {
          const f = this.ident('Feldname');
          this.expectOp(':=');
          fields.push({ name: f.value, display: f.text, value: this.parseInitializer() });
        } while (this.acceptOp(','));
        this.expectOp(')');
        return { e: 'structinit', fields, line: t.line, col: t.col };
      }
      return this.parseExpr();
    }

    parseTypeSpec(inTypeBlock) {
      const t = this.t;
      if (this.isKw('ARRAY')) {
        this.next();
        this.expectOp('[');
        const dims = [];
        do {
          const lo = this.parseExpr();
          this.expectOp('..');
          const hi = this.parseExpr();
          dims.push({ lo, hi });
        } while (this.acceptOp(','));
        this.expectOp(']');
        this.expectKw('OF');
        const elem = this.parseTypeSpec(false);
        return { k: 'array', dims, elem, line: t.line };
      }
      if (this.isKw('STRUCT')) {
        this.next();
        const fields = [];
        while (!this.isKw('END_STRUCT')) {
          if (this.t.type === 'eof') throw this.err("'END_STRUCT' fehlt");
          fields.push(...this.parseVarDecl());
        }
        this.next();
        return { k: 'struct', fields, line: t.line };
      }
      if (this.isOp('(')) {
        // Aufzählungstyp
        this.next();
        const values = [];
        do {
          const n = this.ident('Enum-Wert');
          let v = null;
          if (this.acceptOp(':=')) v = this.parseExpr();
          values.push({ name: n.value, display: n.text, value: v, line: n.line });
        } while (this.acceptOp(','));
        this.expectOp(')');
        let base = null;
        if (this.t.type === 'ident') base = this.next().value; // TYPE E : (A,B) INT;
        return { k: 'enum', values, base, line: t.line };
      }
      if (this.t.type === 'ident') {
        const n = this.next();
        if (n.value === 'POINTER' || n.value === 'REFERENCE')
          throw this.err(`${n.text} TO wird vom Simulator nicht unterstützt`, n);
        if ((n.value === 'STRING' || n.value === 'WSTRING') && (this.isOp('(') || this.isOp('['))) {
          const close = this.isOp('(') ? ')' : ']';
          this.next();
          const len = this.parseExpr();
          this.expectOp(close);
          return { k: 'string', name: n.value, len, line: n.line };
        }
        // Unterbereich INT(0..100)
        if (this.isOp('(') && !inTypeBlock) {
          this.next();
          const lo = this.parseExpr(); this.expectOp('..'); const hi = this.parseExpr();
          this.expectOp(')');
          return { k: 'named', name: n.value, display: n.text, range: { lo, hi }, line: n.line, col: n.col };
        }
        if (this.isOp('(') && inTypeBlock) {
          this.next();
          const lo = this.parseExpr(); this.expectOp('..'); const hi = this.parseExpr();
          this.expectOp(')');
          return { k: 'named', name: n.value, display: n.text, range: { lo, hi }, line: n.line, col: n.col };
        }
        return { k: 'named', name: n.value, display: n.text, line: n.line, col: n.col };
      }
      throw this.err(`Datentyp erwartet, gefunden '${this.t.text}'`);
    }

    // ---------- Anweisungen ----------
    parseStatements(terminators) {
      const list = [];
      for (;;) {
        const t = this.t;
        if (t.type === 'eof') {
          throw this.err(`'${terminators[0]}' fehlt (Dateiende erreicht)`);
        }
        if (t.type === 'kw' && terminators.includes(t.value)) break;
        // CASE-Label-Erkennung: Zahl/Ident gefolgt von ':' oder ',' oder '..' beendet Block innerhalb CASE
        if (terminators.includes('#CASELABEL') && this.looksLikeCaseLabel()) break;
        if (this.acceptOp(';')) continue;
        const start = this.p;
        try { list.push(this.parseStatement()); }
        catch (e) {
          if (!(e instanceof STError) || this.errors.length > 50) throw e;
          this.errors.push(e);
          const st = this.toks[start];
          if (st.type === 'kw' && BLOCK_END[st.value] && this.skipBlock(start)) continue;
          // Synchronisieren: bis hinter das nächste ';' oder zum Blockende springen
          if (this.p === start) this.next();
          while (this.t.type !== 'eof' && !this.isOp(';') && !(this.t.type === 'kw' && /^END_|^(ELSE|ELSIF|UNTIL)$/.test(this.t.value))) this.next();
          this.acceptOp(';');
        }
      }
      return list;
    }

    // Fehler im Kopf von IF/CASE/FOR/WHILE/REPEAT: ganzen Block bis zum passenden END_… überspringen,
    // damit keine Folgefehler entstehen
    skipBlock(start) {
      const stack = [];
      for (let k = start; k < this.toks.length; k++) {
        const t = this.toks[k];
        if (t.type === 'eof') return false;
        if (t.type !== 'kw') continue;
        if (BLOCK_END[t.value]) stack.push(BLOCK_END[t.value]);
        else if (t.value === stack[stack.length - 1]) {
          stack.pop();
          if (!stack.length) {
            this.p = k + 1;
            this.acceptOp(';');
            return true;
          }
        }
      }
      return false;
    }

    looksLikeCaseLabel() {
      // Label: [-] literal | ident | typeprefix ident  gefolgt von ':' ',' '..'
      let k = 0;
      let t = this.peek(k);
      if (t.type === 'op' && t.value === '-') { k++; t = this.peek(k); }
      if (t.type === 'typeprefix') { k++; t = this.peek(k); }
      if (!['int', 'ident', 'string'].includes(t.type)) return false;
      // Ident-Pfad mit Punkt (Enum.Wert)
      k++;
      while (this.peek(k).type === 'op' && this.peek(k).value === '.' && this.peek(k + 1).type === 'ident') k += 2;
      const nt = this.peek(k);
      if (nt.type !== 'op') return false;
      if (nt.value === ':' || nt.value === '..') return true;
      if (nt.value === ',') return true; // in Anweisungen ist ',' am Anfang nie gültig
      return false;
    }

    parseStatement() {
      const t = this.t;
      if (t.type === 'kw') {
        switch (t.value) {
          case 'IF': return this.parseIf();
          case 'CASE': return this.parseCase();
          case 'FOR': return this.parseFor();
          case 'WHILE': {
            this.next();
            const cond = this.parseExpr();
            this.expectKw('DO');
            const body = this.parseStatements(['END_WHILE']);
            this.expectKw('END_WHILE'); this.acceptOp(';');
            return { s: 'while', cond, body, line: t.line, col: t.col };
          }
          case 'REPEAT': {
            this.next();
            const body = this.parseStatements(['UNTIL']);
            this.expectKw('UNTIL');
            const cond = this.parseExpr();
            this.expectKw('END_REPEAT'); this.acceptOp(';');
            return { s: 'repeat', cond, body, line: t.line, col: t.col };
          }
          case 'EXIT': this.next(); this.expectOp(';'); return { s: 'exit', line: t.line, col: t.col };
          case 'CONTINUE': this.next(); this.expectOp(';'); return { s: 'continue', line: t.line, col: t.col };
          case 'RETURN': this.next(); this.expectOp(';'); return { s: 'return', line: t.line, col: t.col };
          // Test-DSL
          case 'CYCLE': {
            this.next();
            let n = null;
            if (!this.isOp(';')) n = this.parseExpr();
            this.expectOp(';');
            return { s: 'cycle', n, line: t.line, col: t.col };
          }
          case 'WAIT': {
            this.next();
            const dur = this.parseExpr();
            this.expectOp(';');
            return { s: 'wait', dur, line: t.line, col: t.col };
          }
          case 'ASSERT': {
            this.next();
            const i0 = this.p;
            const cond = this.parseExpr();
            const src = this.srcText(i0, this.p);
            let msg = null;
            if (this.acceptOp(',')) msg = this.parseExpr();
            this.expectOp(';');
            return { s: 'assert', cond, msg, line: t.line, col: t.col, src };
          }
          case 'RUN_UNTIL': {
            this.next();
            const cond = this.parseExpr();
            let timeout = null;
            if (this.acceptKw('TIMEOUT')) timeout = this.parseExpr();
            this.expectOp(';');
            return { s: 'rununtil', cond, timeout, line: t.line, col: t.col };
          }
          case 'LOG': {
            this.next();
            const args = [this.parseExpr()];
            while (this.acceptOp(',')) args.push(this.parseExpr());
            this.expectOp(';');
            return { s: 'log', args, line: t.line, col: t.col };
          }
        }
      }
      // Zuweisung oder Aufruf
      const lhs = this.parsePostfix();
      if (this.isOp(':=')) {
        this.next();
        const value = this.parseExpr();
        this.expectOp(';');
        return { s: 'assign', target: lhs, value, line: t.line, col: t.col };
      }
      // CODESYS: x S= Bedingung;  x R= Bedingung;
      if (this.t.type === 'ident' && (this.t.value === 'S' || this.t.value === 'R') && this.peek(1).type === 'op' && this.peek(1).value === '=') {
        const set = this.next().value === 'S'; this.next();
        const value = this.parseExpr();
        this.expectOp(';');
        return { s: 'setreset', set, target: lhs, value, line: t.line, col: t.col };
      }
      if (lhs.e === 'call') {
        this.expectOp(';');
        return { s: 'call', call: lhs, line: t.line, col: t.col };
      }
      if (this.isOp('=')) throw this.err("'=' ist ein Vergleich – für Zuweisungen ':=' verwenden");
      if (lhs.e === 'id' || lhs.e === 'member') {
        // FB-Instanz ohne Klammern aufgerufen? -> Fehlende ':=' oder ';'
        throw this.err(`':=' oder '(' erwartet nach '${this.toks[this.p - 1].text}', gefunden '${this.t.text}'`);
      }
      throw this.err(`Anweisung erwartet, gefunden '${t.text}'`, t);
    }

    srcText(i0, i1) {
      // Rekonstruiert den Quelltext eines Ausdrucks aus den Tokens (für Meldungen)
      let out = '';
      for (let i = i0; i < i1; i++) {
        const tk = this.toks[i], prev = this.toks[i - 1];
        const glue = i === i0 || (tk.type === 'op' && ['.', ')', ']', ','].includes(tk.value)) ||
          (prev.type === 'op' && ['.', '(', '['].includes(prev.value)) ||
          (tk.type === 'op' && tk.value === '(' && prev.type === 'ident') ||
          (prev.type === 'op' && prev.value === '-' && (i - 2 < i0 || this.toks[i - 2].type === 'op' || this.toks[i - 2].type === 'kw'));
        out += (glue ? '' : ' ') + (tk.type === 'string' ? "'" + tk.value + "'" : tk.text);
      }
      return out;
    }

    parseIf() {
      const t = this.next();
      const branches = [];
      const cond = this.parseExpr();
      this.expectKw('THEN');
      const body = this.parseStatements(['ELSIF', 'ELSE', 'END_IF']);
      branches.push({ cond, body });
      let elseBody = null;
      for (;;) {
        if (this.acceptKw('ELSIF')) {
          const c = this.parseExpr();
          this.expectKw('THEN');
          branches.push({ cond: c, body: this.parseStatements(['ELSIF', 'ELSE', 'END_IF']) });
        } else if (this.acceptKw('ELSE')) {
          elseBody = this.parseStatements(['END_IF']);
        } else break;
      }
      this.expectKw('END_IF');
      this.acceptOp(';');
      return { s: 'if', branches, elseBody, line: t.line, col: t.col };
    }

    parseCase() {
      const t = this.next();
      const expr = this.parseExpr();
      this.expectKw('OF');
      const cases = [];
      let elseBody = null;
      for (;;) {
        if (this.isKw('END_CASE')) break;
        if (this.acceptKw('ELSE')) { this.acceptOp(':'); elseBody = this.parseStatements(['END_CASE']); break; }
        if (this.acceptOp(';')) continue;
        const labels = [];
        const lt = this.t;
        do {
          const lo = this.parseCaseValue();
          if (this.acceptOp('..')) labels.push({ lo, hi: this.parseCaseValue() });
          else labels.push({ lo, hi: null });
        } while (this.acceptOp(','));
        if (!this.isOp(':')) throw this.err(`':' nach CASE-Marke erwartet, gefunden '${this.t.text}'`);
        this.next();
        const body = this.parseStatements(['END_CASE', 'ELSE', '#CASELABEL']);
        cases.push({ labels, body, line: lt.line });
      }
      this.expectKw('END_CASE');
      this.acceptOp(';');
      return { s: 'case', expr, cases, elseBody, line: t.line, col: t.col };
    }

    parseCaseValue() {
      // Ausdruck ohne Vergleichsoperatoren (':' darf nicht verschluckt werden)
      return this.parseAdd();
    }

    parseFor() {
      const t = this.next();
      const v = this.ident('Laufvariable');
      if (this.isOp('.') || this.isOp('[')) throw this.err('Die FOR-Laufvariable muss eine einfache Variable sein (z.B. i), kein Element oder Feld');
      this.expectOp(':=');
      const from = this.parseExpr();
      this.expectKw('TO');
      const to = this.parseExpr();
      let by = null;
      if (this.acceptKw('BY')) by = this.parseExpr();
      this.expectKw('DO');
      const body = this.parseStatements(['END_FOR']);
      this.expectKw('END_FOR');
      this.acceptOp(';');
      return { s: 'for', v: { e: 'id', name: v.value, display: v.text, line: v.line, col: v.col }, from, to, by, body, line: t.line, col: t.col };
    }

    // ---------- Ausdrücke ----------
    // Priorität (niedrig → hoch): OR/OR_ELSE, XOR, AND/&/AND_THEN, = <>, < > <= >=, + -, * / MOD, **, unär, postfix
    parseExpr() { return this.parseOr(); }
    bin(op, a, b, t) { return { e: 'bin', op, a, b, line: t.line, col: t.col }; }
    parseOr() {
      let a = this.parseXor();
      while (this.isKw('OR') || this.isKw('OR_ELSE')) { const t = this.next(); a = this.bin(t.value, a, this.parseXor(), t); }
      return a;
    }
    parseXor() {
      let a = this.parseAnd();
      while (this.isKw('XOR')) { const t = this.next(); a = this.bin('XOR', a, this.parseAnd(), t); }
      return a;
    }
    parseAnd() {
      let a = this.parseEq();
      while (this.isKw('AND') || this.isOp('&') || this.isKw('AND_THEN')) {
        const t = this.next(); a = this.bin(t.value === '&' ? 'AND' : t.value, a, this.parseEq(), t);
      }
      return a;
    }
    parseEq() {
      let a = this.parseRel();
      while (this.isOp('=') || this.isOp('<>')) { const t = this.next(); a = this.bin(t.value, a, this.parseRel(), t); }
      return a;
    }
    parseRel() {
      let a = this.parseAdd();
      while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) { const t = this.next(); a = this.bin(t.value, a, this.parseAdd(), t); }
      return a;
    }
    parseAdd() {
      let a = this.parseMul();
      while (this.isOp('+') || this.isOp('-')) { const t = this.next(); a = this.bin(t.value, a, this.parseMul(), t); }
      return a;
    }
    parseMul() {
      let a = this.parsePow();
      while (this.isOp('*') || this.isOp('/') || this.isKw('MOD')) { const t = this.next(); a = this.bin(t.value, a, this.parsePow(), t); }
      return a;
    }
    parsePow() {
      let a = this.parseUnary();
      while (this.isOp('**')) { const t = this.next(); a = this.bin('**', a, this.parseUnary(), t); }
      return a;
    }
    parseUnary() {
      const t = this.t;
      if (this.isOp('-')) {
        this.next();
        const x = this.parseUnary();
        if (x.e === 'lit' && typeof x.v === 'number') return Object.assign({}, x, { v: -x.v, line: t.line, col: t.col });
        return { e: 'un', op: '-', x, line: t.line, col: t.col };
      }
      if (this.isOp('+')) { this.next(); return this.parseUnary(); }
      if (this.isKw('NOT')) { this.next(); return { e: 'un', op: 'NOT', x: this.parseUnary(), line: t.line, col: t.col }; }
      return this.parsePostfix();
    }

    parsePostfix() {
      let x = this.parsePrimary();
      for (;;) {
        const t = this.t;
        if (this.isOp('.')) {
          this.next();
          if (this.t.type === 'int') { const b = this.next(); x = { e: 'bit', obj: x, bit: b.value, line: t.line, col: t.col }; continue; }
          const n = this.t.type === 'ident' || this.t.type === 'kw' ? this.next() : null;
          if (!n) throw this.err(`Name nach '.' erwartet, gefunden '${this.t.text}'`);
          x = { e: 'member', obj: x, name: n.value, display: n.text, line: n.line, col: n.col };
        } else if (this.isOp('[')) {
          this.next();
          const idx = [this.parseExpr()];
          while (this.acceptOp(',')) idx.push(this.parseExpr());
          this.expectOp(']');
          x = { e: 'index', obj: x, idx, line: t.line, col: t.col };
        } else if (this.isOp('(') && (x.e === 'id' || x.e === 'member' || x.e === 'index' || x.e === 'super')) {
          this.next();
          const args = [];
          if (!this.isOp(')')) {
            do {
              if (this.t.type === 'ident' && this.peek(1).type === 'op' && (this.peek(1).value === ':=' || this.peek(1).value === '=>')) {
                const n = this.next(); const op = this.next().value;
                if (op === '=>') {
                  const target = this.parsePostfix();
                  args.push({ name: n.value, display: n.text, value: target, out: true, line: n.line, col: n.col });
                } else {
                  args.push({ name: n.value, display: n.text, value: this.parseExpr(), out: false, line: n.line, col: n.col });
                }
              } else if (this.isKw('NOT') && this.peek(1).type === 'ident' && this.peek(2).type === 'op' && this.peek(2).value === '=>') {
                throw this.err('NOT bei Ausgangszuweisung (=>) wird nicht unterstützt');
              } else {
                args.push({ name: null, value: this.parseExpr(), line: this.t.line, col: this.t.col });
              }
            } while (this.acceptOp(','));
          }
          this.expectOp(')');
          x = { e: 'call', fn: x, args, line: x.line, col: x.col };
        } else if (this.isOp('^')) {
          if (x.e === 'id' && (x.name === 'THIS' || x.name === 'SUPER')) { this.next(); x = { e: x.name === 'THIS' ? 'this' : 'super', display: x.display + '^', line: x.line, col: x.col }; continue; }
          throw this.err('Pointer-Dereferenzierung (^) wird nicht unterstützt');
        } else break;
      }
      return x;
    }

    parsePrimary() {
      const t = this.t;
      switch (t.type) {
        case 'int': this.next(); return { e: 'lit', v: t.value, t: 'ANY_INT', line: t.line, col: t.col };
        case 'real': this.next(); return { e: 'lit', v: t.value, t: 'ANY_REAL', line: t.line, col: t.col };
        case 'time': this.next(); return { e: 'lit', v: t.value, t: 'TIME', line: t.line, col: t.col };
        case 'string': this.next(); return { e: 'lit', v: t.value, t: t.wide ? 'WSTRING' : 'STRING', line: t.line, col: t.col };
        case 'date': throw this.err('DATE/TOD/DT-Literale werden nicht unterstützt');
        case 'typeprefix': {
          this.next();
          const lt = this.t;
          let neg = false;
          if (this.isOp('-')) { this.next(); neg = true; }
          const v = this.next();
          if (v.type === 'int' || v.type === 'real') return { e: 'lit', v: neg ? -v.value : v.value, t: t.value, line: t.line, col: t.col };
          if (v.type === 'kw' && (v.value === 'TRUE' || v.value === 'FALSE')) return { e: 'lit', v: v.value === 'TRUE', t: t.value, line: t.line, col: t.col };
          if (v.type === 'ident') return { e: 'enumval', type: t.value, typeDisplay: t.text.replace(/#$/, ''), name: v.value, display: v.text, line: t.line, col: t.col };
          if (v.type === 'string') return { e: 'lit', v: v.value, t: t.value, line: t.line, col: t.col };
          throw this.err(`Literal nach '${t.text}' erwartet`, lt);
        }
        case 'ident': this.next(); return { e: 'id', name: t.value, display: t.text, line: t.line, col: t.col };
        case 'kw':
          if (t.value === 'TRUE' || t.value === 'FALSE') { this.next(); return { e: 'lit', v: t.value === 'TRUE', t: 'BOOL', line: t.line, col: t.col }; }
          break;
        case 'op':
          if (t.value === '(') {
            this.next();
            const x = this.parseExpr();
            this.expectOp(')');
            return x;
          }
          break;
        case 'address': {
          // direkte Adresse wie %IX0.0 – wird beim Übersetzen der Variablen mit dieser Adresse zugeordnet
          this.next();
          const a = t.value.toUpperCase();
          if (!/^%[IQM][XBWDL]?\d+(\.\d+)?$/.test(a)) throw this.err(`Ungültige Adresse '${t.text}'`, t);
          return { e: 'id', name: a, display: t.text, addr: true, line: t.line, col: t.col };
        }
      }
      if (t.type === 'eof') throw this.err('Unerwartetes Dateiende im Ausdruck');
      throw this.err(`Ausdruck erwartet, gefunden '${t.text}'`);
    }

    // ---------- Testdatei ----------
    parseTestFile() {
      const tf = { globals: [], setup: [], tests: [] };
      while (this.t.type !== 'eof') {
        if (this.isKw('VAR') || this.isKw('VAR_GLOBAL')) tf.globals.push(this.parseVarSection());
        else if (this.isKw('SETUP')) {
          this.next();
          tf.setup.push(...this.parseStatements(['END_SETUP']));
          this.expectKw('END_SETUP');
        } else if (this.isKw('TEST')) {
          const t = this.next();
          let name;
          if (this.t.type === 'string') name = this.next().value;
          else if (this.t.type === 'ident') name = this.next().text;
          else throw this.err('Testname (in Anführungszeichen) erwartet');
          const sections = [];
          while (this.isKw('VAR')) sections.push(this.parseVarSection());
          const body = this.parseStatements(['END_TEST']);
          this.expectKw('END_TEST');
          tf.tests.push({ name, sections, body, line: t.line });
        } else if (this.isOp(';')) this.next();
        else throw this.err(`TEST, SETUP oder VAR erwartet, gefunden '${this.t.text}'`);
      }
      return tf;
    }
  }

  // Wirft den ersten Fehler; alle Fehler stehen in err.all
  function run(src, opts, fn) {
    const p = new Parser(src, opts);
    let res;
    try { res = fn(p); }
    catch (e) { if (!(e instanceof STError)) throw e; p.errors.push(e); }
    if (p.errors.length) {
      const errs = p.errors.sort((a, b) => a.line - b.line || a.col - b.col);
      const e = errs[0]; e.all = errs; throw e;
    }
    return res;
  }
  ST.parse = function (src) { return run(src, null, p => p.parseFile()); };
  ST.parseTests = function (src) { return run(src, { testMode: true }, p => p.parseTestFile()); };
  ST.Parser = Parser;
})(globalThis.ST);
