/**
 * Ids fijos de los datos de prueba. Única fuente de verdad: los usan el seed, los
 * casos y el panel. Son deterministas a propósito — permiten correr un caso
 * suelto sin parsear la salida del seed, y hacen los fallos legibles.
 */
import { TravelCardStatus, TripStatus } from '@bcb/prisma-enums';

const pad = (n: number) => String(n).padStart(12, '0');

export const catalog = {
  adminId: 'e2e00000-0000-4000-8000-00000000ad01',
  companyId: 'e2e00000-0000-4000-8000-00000000c001',
  serviceId: 'e2e00000-0000-4000-8000-00000000e001',
  origenId: 'e2e00000-0000-4000-8000-0000000051a1',
  destinoId: 'e2e00000-0000-4000-8000-0000000051a2',
  routeId: 'e2e00000-0000-4000-8000-0000000000a1',
} as const;

export type Scenario = {
  n: number;
  tripStatus: TripStatus;
  cardStatus: TravelCardStatus;
  desc: string;
  tripId: string;
  cardId: string;
  busId: string;
  operadorId: string;
};

function scenario(n: number, tripStatus: TripStatus, cardStatus: TravelCardStatus, desc: string): Scenario {
  return {
    n,
    tripStatus,
    cardStatus,
    desc,
    tripId: `e2e00001-0000-4000-8000-${pad(n)}`,
    cardId: `e2e00002-0000-4000-8000-${pad(n)}`,
    busId: `e2e00003-0000-4000-8000-${pad(n)}`,
    operadorId: `e2e00004-0000-4000-8000-${pad(n)}`,
  };
}

export const scenarios = {
  HAPPY: scenario(1, TripStatus.DISPATCHED, TravelCardStatus.OPEN,
    'corrida despachada por operación, tarjeta abierta — el caso normal'),
  OPEN: scenario(2, TripStatus.OPEN, TravelCardStatus.OPEN,
    'corrida nunca despachada — la geocerca no debe poder despacharla ni confirmarla'),
  CANCELLED: scenario(3, TripStatus.CANCELLED, TravelCardStatus.OPEN,
    'corrida cancelada — no se resucita con un evento de geocerca'),
  MANUALCONFIRM: scenario(4, TripStatus.CONFIRMED, TravelCardStatus.CONFIRMED,
    'ya confirmada a mano (abordaje móvil / operación) antes de que llegue la geocerca'),
  CADENA_T10: scenario(5, TripStatus.DISPATCHED, TravelCardStatus.OPEN,
    'reservado para el recorrido de cadena completa de CU04'),
  CADENA_T11: scenario(6, TripStatus.DISPATCHED, TravelCardStatus.OPEN,
    'reservado para el recorrido de cadena completa de CU05'),
  VALIDACIONES: scenario(7, TripStatus.DISPATCHED, TravelCardStatus.OPEN,
    'datos que no cuadran (bus/estación equivocados) y happy path de T11 directo'),
} as const;

export const allScenarios = Object.values(scenarios);
