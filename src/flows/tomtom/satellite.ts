/**
 * Dispara CU04/CU05 con el código REAL del satélite TomTom.
 *
 * Se importa `AdapterTomtomCallbackClient` tal cual del repo del satélite, así que
 * la firma del JWT y el contrato HTTP que se ejercen son los suyos, no una
 * reimplementación. La versión en bash tenía que copiar un script dentro de ese
 * repo para resolver alias de tsconfig; desde TypeScript el import directo
 * funciona y ese hack desaparece.
 *
 * Por qué este punto de entrada y no `POST /tomtom/geocercas`: ese endpoint hace
 * polling contra InRoute (servicio de terceros, sin sandbox). CU04/CU05 empiezan
 * justo después, cuando el satélite ya decidió que hubo un evento de geocerca.
 */
import { AdapterTomtomCallbackClient } from '../../../../BIGER_EstrellaRoja_TomTom/src/bcb/bcb.client';
import { readKey } from '@harness/paths';

const ADAPTER_TOMTOM_URL = process.env.E2E_ADAPTER_TOMTOM_URL ?? 'http://localhost:8090';
/** Debe coincidir con lo que espera el JwtFilter de adapter-tomtom. */
const ISSUER = 'biger-tomtom-satellite';

let client: AdapterTomtomCallbackClient | undefined;

/**
 * El cliente lee su configuración de `process.env` en onModuleInit. Se la damos
 * desde el harness (llave incluida, desde run/keys) para no depender del `.env`
 * del satélite: una pieza móvil menos.
 */
function satelliteClient(): AdapterTomtomCallbackClient {
  if (!client) {
    process.env.BIGER_ADAPTER_TOMTOM_URL = ADAPTER_TOMTOM_URL;
    process.env.TOMTOM_CALLBACK_PRIVATE_KEY = readKey('tomtom-sat', 'private');
    process.env.TOMTOM_CALLBACK_JWT_ISSUER = ISSUER;
    delete process.env.TOMTOM_CALLBACK_JWT_AUDIENCE;
    client = new AdapterTomtomCallbackClient();
    client.onModuleInit();
  }
  return client;
}

export async function despacharCorrida(tripId: string, body: { autobusId: string; salidaReal: string }): Promise<void> {
  await satelliteClient().despacharCorrida(tripId, body);
}

export async function confirmarLlegada(
  travelCardId: string,
  body: {
    corridaId: string;
    autobusId: string;
    operadorId: string;
    estacionDestinoId: string;
    llegadaReal: string;
  },
): Promise<void> {
  await satelliteClient().confirmarLlegada(travelCardId, body);
}
