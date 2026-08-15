/**
 * SmartMac falso, en proceso.
 *
 * SmartMac es un tercero real (`er-smartmac.dyndns.org:5056`) sin sandbox, igual
 * que InRoute en el flujo de TomTom. Pero a diferencia de InRoute, el satélite lo
 * apunta por variables de entorno (`SMARTMAC_BASE_URL` / `SMARTMAC_WS1_PATH`), así
 * que se puede sustituir por esto y **verificar el payload exacto que sale** — que
 * es lo que convierte WS1 en una prueba de contrato y no en un "no explotó".
 *
 * También permite lo que contra el SmartMac real no se puede: forzar un rechazo y
 * comprobar que el satélite NO da la tarjeta por enviada.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

export type SmartmacRequest = {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  at: Date;
};

export type SmartmacBehavior =
  | { kind: 'ok'; response?: unknown }
  /** Rechazo de negocio: HTTP 200 con cuerpo de error, como el real. */
  | { kind: 'rechazo'; response?: unknown }
  /** Error de transporte. */
  | { kind: 'error'; status: number };

/**
 * Puerto FIJO, no efímero: el satélite lee `SMARTMAC_BASE_URL` al arrancar, mucho
 * antes de que corra una prueba, así que la URL tiene que ser predecible.
 */
export const FAKE_SMARTMAC_PORT = Number(process.env.E2E_FAKE_SMARTMAC_PORT ?? 7801);

export class FakeSmartmac {
  private server?: http.Server;
  private port = FAKE_SMARTMAC_PORT;
  readonly received: SmartmacRequest[] = [];
  behavior: SmartmacBehavior = { kind: 'ok' };

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Última petición recibida, que es lo que se asevera casi siempre. */
  get last(): SmartmacRequest | undefined {
    return this.received[this.received.length - 1];
  }

  clear(): void {
    this.received.length = 0;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* cuerpo no-JSON: se guarda crudo */
        }
        this.received.push({ path: req.url ?? '', headers: req.headers, body, at: new Date() });

        const b = this.behavior;
        if (b.kind === 'error') {
          res.writeHead(b.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'fake smartmac error' }));
          return;
        }
        // El SmartMac real contesta HTTP 200 incluso al rechazar: el veredicto va
        // en `responseCode` del cuerpo ("200" = aceptada). Por eso el satélite
        // tiene que leer el cuerpo, y por eso el falso replica ese formato — si acá
        // se inventara otro, WS1 pasaría en la prueba y fallaría contra el real.
        const payload =
          b.response ??
          (b.kind === 'ok'
            ? { responseCode: '200', mensaje: 'Tarjeta de viaje recibida' }
            : { responseCode: '500', mensaje: 'Corrida no encontrada en SmartMac' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(FAKE_SMARTMAC_PORT, '127.0.0.1', () => {
        this.port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
