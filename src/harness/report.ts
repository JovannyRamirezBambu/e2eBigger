/**
 * Asertos y acumulación de resultados.
 *
 * El formato de salida es EXACTAMENTE el del harness en bash (`PASS …` / `FAIL …`
 * / `N pass / M fail`) porque el panel lo parsea y porque no quiero que migrar de
 * lenguaje cambie lo que ves en la terminal.
 */
const tty = process.stdout.isTTY;
const C = {
  reset: tty ? '\x1b[0m' : '',
  dim: tty ? '\x1b[2m' : '',
  bold: tty ? '\x1b[1m' : '',
  green: tty ? '\x1b[32m' : '',
  red: tty ? '\x1b[31m' : '',
  yellow: tty ? '\x1b[33m' : '',
};

export class Report {
  pass = 0;
  fail = 0;
  private failedNames: string[] = [];
  /** nombre del caso → 'ok' | 'fail' */
  readonly caseResults = new Map<string, 'ok' | 'fail'>();
  private currentCase: string | null = null;
  private failsAtCaseStart = 0;

  beginCase(name: string): void {
    this.currentCase = name;
    this.failsAtCaseStart = this.fail;
  }

  endCase(): void {
    if (!this.currentCase) return;
    this.caseResults.set(this.currentCase, this.fail > this.failsAtCaseStart ? 'fail' : 'ok');
    this.currentCase = null;
  }

  /** Un caso que revienta cuenta como fallo, con el error como detalle. */
  crashed(name: string, err: unknown): void {
    this.fail++;
    this.failedNames.push(name);
    this.caseResults.set(name, 'fail');
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.log(`${C.red}FAIL${C.reset} ${name} ${C.red}(excepción)${C.reset}`);
    console.log(`${C.dim}     ${msg.split('\n').slice(0, 4).join('\n     ')}${C.reset}`);
  }

  private ok(desc: string, shown: string): void {
    this.pass++;
    console.log(`${C.green}PASS${C.reset} ${desc} ${C.dim}[${shown}]${C.reset}`);
  }

  private bad(desc: string, detail: string, hint?: string): void {
    this.fail++;
    this.failedNames.push(desc);
    console.log(`${C.red}FAIL${C.reset} ${desc} ${C.red}${detail}${C.reset}`);
    if (hint) console.log(`${C.dim}     ${hint}${C.reset}`);
  }

  is(desc: string, expected: unknown, actual: unknown, hint?: string): void {
    if (Object.is(expected, actual) || String(expected) === String(actual)) {
      this.ok(desc, String(actual));
    } else {
      this.bad(desc, `esperado=${String(expected)} obtenido=${String(actual)}`, hint);
    }
  }

  present(desc: string, value: unknown, hint?: string): void {
    if (value !== null && value !== undefined && value !== '') this.ok(desc, String(value));
    else this.bad(desc, '(vacío / timeout)', hint);
  }

  /** Para cuando la condición ya se evaluó afuera. */
  assert(desc: string, cond: boolean, detail = '', hint?: string): void {
    if (cond) this.ok(desc, detail || 'ok');
    else this.bad(desc, detail || 'no se cumplió', hint);
  }

  step(title: string): void {
    console.log(`\n${C.bold}── ${title} ${C.reset}`);
  }

  summary(flow: string): number {
    console.log(`\n${C.bold}── Resultado: ${flow} ${C.reset}`);
    if (this.fail === 0) {
      console.log(`${C.green}${this.pass} pass / 0 fail${C.reset}`);
    } else {
      console.log(`${C.red}${this.pass} pass / ${this.fail} fail${C.reset}`);
      for (const n of this.failedNames) console.log(`   ${C.red}· ${n}${C.reset}`);
    }
    return this.fail;
  }
}
