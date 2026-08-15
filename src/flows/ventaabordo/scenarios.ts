/**
 * Datos de prueba de Venta a Bordo. Ids fijos, misma razón que en tomtom: hacen
 * los fallos legibles y permiten correr un caso suelto.
 *
 * Ojo con los tipos: SmartMac identifica todo con enteros grandes
 * (`idTarjetaViaje`, `idCorrida`, folios), que en el satélite son `BigInt` y en
 * BCB `Int`. Los valores de acá caben en Int a propósito — el desbordamiento es
 * un bug real que ya se corrigió, no algo que este flujo deba provocar.
 */

/** Base de los ids numéricos, para no chocar con datos reales del satélite. */
const BASE = 900_000_001;

export type VaScenario = {
  tag: string;
  /** `idTarjetaViaje` de SmartMac (BigInt en el satélite). */
  tarjetaViajeId: number;
  /** `idCorrida` de SmartMac. */
  corridaId: number;
  /** Clave de negocio de la corrida (11–22 caracteres). */
  claveCorrida: string;
  folioTarjeta: string;
  operador: string;
  /** `smartmacId` de la venta en WS2; es la llave de idempotencia en BCB. */
  ventaId: number;
  /** Folios preimpresos de los boletos; únicos por boleto. */
  folios: number[];
  desc: string;
};

function scenario(n: number, tag: string, desc: string, folios = 2): VaScenario {
  const id = BASE + n;
  return {
    tag,
    tarjetaViajeId: id,
    corridaId: id,
    claveCorrida: `E2EVA${String(n).padStart(6, '0')}`,
    // Exactamente 22 caracteres: el DTO de WS2 pone MinLength(22) Y MaxLength(22)
    // sobre folioTarjeta, así que cualquier otro largo da 400.
    folioTarjeta: `E2EVAFOLIO${String(n).padStart(12, '0')}`,
    operador: `E2E-OP-VA-${n}`,
    ventaId: id,
    folios: Array.from({ length: folios }, (_, i) => id * 10 + i),
    desc,
  };
}

export const vaScenarios = {
  /** WS1 completo: se despacha y SmartMac (falso) responde OK. */
  WS1_OK: scenario(1, 'WS1_OK', 'despacho que SmartMac acepta'),
  /** WS1 con SmartMac rechazando: la tarjeta NO debe quedar como enviada. */
  WS1_RECHAZO: scenario(2, 'WS1_RECHAZO', 'despacho que SmartMac rechaza'),
  /** WS2 completo: la venta viaja hasta BoardingSale en BCB. */
  WS2_OK: scenario(3, 'WS2_OK', 'venta a bordo que llega hasta BCB', 3),
  /** WS2 con validaciones: folio duplicado, totales que no cuadran. */
  WS2_VALIDA: scenario(4, 'WS2_VALIDA', 'validaciones de la recaudación'),
  /** SM04: consulta de tarjeta de viaje, fallback cuando el push de WS1 falló. */
  SM04: scenario(5, 'SM04', 'consulta de tarjeta de viaje (fallback de BIG01)'),
} as const;

export const allVaScenarios = Object.values(vaScenarios);
