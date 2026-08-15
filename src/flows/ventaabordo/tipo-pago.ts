/**
 * Espejo local de `TipoPagoSmartmac`, **verificado contra el enum real en tiempo
 * de compilación**.
 *
 * Por qué no se importa el enum directo: vive en `detalle-venta.dto.ts`, junto a
 * clases con decoradores de `class-validator`. Importarlo como VALOR ejecuta ese
 * módulo, y el lowering de decoradores de esbuild (que usa `tsx`) no es compatible
 * con lo que espera class-validator — revienta con
 * `Cannot read properties of undefined (reading 'constructor')`. Los tipos sí se
 * importan sin problema, porque se borran al compilar.
 *
 * Para que el espejo no se desincronice en silencio, el bloque de abajo falla al
 * compilar si el satélite agrega, quita o renombra un valor del enum.
 */
import type { TipoPagoSmartmac } from '../../../../BIGER_EstrellaRoja_VentaABordo/src/dto/detalle-venta.dto';

const VALORES = ['EFECTIVO', 'PREPAGO', 'CANJE', 'RECARGA'] as const;
type Valor = (typeof VALORES)[number];

/** El enum del satélite, como unión de sus strings. */
type ValorReal = `${TipoPagoSmartmac}`;

// Guarda bidireccional: ni sobra ni falta ninguno.
type Sobran = Exclude<Valor, ValorReal>;
type Faltan = Exclude<ValorReal, Valor>;
type Coincide = [Sobran] extends [never]
  ? [Faltan] extends [never]
    ? true
    : { 'el enum del satélite tiene valores que este espejo no cubre': Faltan }
  : { 'este espejo tiene valores que el enum del satélite ya no tiene': Sobran };

const _coincide: Coincide = true;
void _coincide;

/**
 * Los valores, tipados como el enum real. El cast es seguro precisamente por la
 * guarda de arriba: si el enum cambia, esto no compila.
 */
export const TipoPago = {
  EFECTIVO: 'EFECTIVO' as TipoPagoSmartmac,
  PREPAGO: 'PREPAGO' as TipoPagoSmartmac,
  CANJE: 'CANJE' as TipoPagoSmartmac,
  RECARGA: 'RECARGA' as TipoPagoSmartmac,
} as const;
