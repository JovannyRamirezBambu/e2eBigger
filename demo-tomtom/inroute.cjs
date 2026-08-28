/**
 * InRoute (Adsum) simulado — el proveedor de TomTom, del lado del panel.
 *
 * El satélite apunta acá por su `.env` (`INROUTE_BASE_URL`, puerto fijo 7803 que
 * escribe flows/tomtom/flow.sh). Este proceso decide qué hacer con cada llamada:
 *
 *   modo 'simulado' → contesta este archivo, con el formato del InRoute real.
 *   modo 'real'     → la reenvía a Adsum con Basic Auth y devuelve SU respuesta.
 *
 * Conmutar es instantáneo y no reinicia el satélite, así que en una reunión se
 * puede enseñar el mismo alta de viaje contra el simulador y contra el proveedor,
 * uno tras otro.
 *
 * Todo lo que entra queda registrado con su cuerpo de ida y de vuelta: ése es el
 * dato que le importa a Adsum —el payload exacto que le manda el satélite, en su
 * formato (`cClaveERP`, `nHoraSalidaPlaneada`, `cFechaSalidaPlaneada`…)—.
 */
const http = require('http');

// ── Formato de fechas de InRoute ───────────────────────────────────────────
// InRoute trabaja en CST (UTC-6, sin horario de verano) y en `dd/mm/yyyy HH:mm`.
// El satélite parsea esos timestamps como -06:00 fijo, así que acá se formatea en
// la misma zona: los dos lados hablan del mismo instante.
const MX = 'America/Mexico_City';

function partes(fecha) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: MX,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);
  const v = (t) => p.find((x) => x.type === t).value;
  return { dia: v('day'), mes: v('month'), anio: v('year'), hora: v('hour'), minuto: v('minute') };
}

const fechaInroute = (d) => {
  const { dia, mes, anio } = partes(d);
  return `${dia}/${mes}/${anio}`;
};

const horaInroute = (d) => {
  const { hora, minuto } = partes(d);
  return `${hora}:${minuto}`;
};

const fechaHoraInroute = (d) => `${fechaInroute(d)} ${horaInroute(d)}`;

/** "dd/mm/yyyy HH:mm" (CST) → Date. Lo usa el filtro de ventana de eventos. */
function parseFechaHora(texto) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(texto || ''));
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-06:00`);
}

// ── Estado ─────────────────────────────────────────────────────────────────
/**
 * Catálogo mínimo pero coherente: una terminal de origen y una de destino, y una
 * instrucción de viaje que las une. Es lo que el satélite necesita para resolver
 * `nVehiculo`, `nConductor`, `nGrupo` y `nInstruccionViaje` cuando el evento de
 * BCB no los trae ya resueltos (que es el caso en local: los mapeos de InRoute en
 * BCB están vacíos, y el satélite cae a la resolución dinámica — el mismo camino
 * que en producción cuando falta un mapeo).
 */
const GEOCERCA_ORIGEN = 311;
const GEOCERCA_DESTINO = 327;

function estadoInicial() {
  return {
    geocercas: [
      { nGeocerca: GEOCERCA_ORIGEN, cDescripcion: 'Terminal de origen (demo)', bActivo: true },
      { nGeocerca: GEOCERCA_DESTINO, cDescripcion: 'Terminal de destino (demo)', bActivo: true },
    ],
    ubicacionesFrecuentes: [
      { nUbicacionFrecuente: 51, cDescripcion: 'Terminal de origen (demo)', cClaveERP: 'E2E-ORI', bActivo: true },
      { nUbicacionFrecuente: 54, cDescripcion: 'Terminal de destino (demo)', cClaveERP: 'E2E-DST', bActivo: true },
    ],
    motivosCancelacion: [
      { nMotivoCancelacion: 1, cDescripcion: 'Cancelación operativa' },
      { nMotivoCancelacion: 2, cDescripcion: 'Falla mecánica' },
    ],
    vehiculos: [],
    conductores: [],
    grupos: [],
    instrucciones: [],
    viajes: [],
    eventos: [],
    ordenes: [],
    waypoints: [],
    documentos: [],
    // Contadores de ids. Arrancan altos para que un id de la demostración no se
    // confunda con uno real si alguien compara pantallas con Adsum.
    siguiente: {
      nVehiculo: 700, nConductor: 1800, nGrupo: 100, nInstruccionViaje: 4200,
      // nViaje/nOrden arrancan con offset temporal: el satélite persiste nTripId
      // (@unique) y nOrderId, así que un reinicio del simulador NO debe repetir
      // ids ya usados — reproduciría un P2002 que en el real no existe.
      nViaje: 100000 + (Math.floor(Date.now() / 1000) % 800000000),
      nOrden: 100000 + (Math.floor(Date.now() / 1000) % 800000000),
      nInstruccionViajeWayPoint: 9300, nInstruccionViajeDocumento: 1100,
    },
  };
}

class InrouteFalso {
  constructor() {
    this.estado = estadoInicial();
    this.recibidos = [];
  }

  reiniciar() {
    this.estado = estadoInicial();
  }

  siguienteId(clave) {
    this.estado.siguiente[clave] += 1;
    return this.estado.siguiente[clave];
  }

  /**
   * Id DETERMINISTA derivado de la clave de negocio (hash FNV-1a → 5 dígitos).
   * Un reinicio del simulador no debe invalidar el cache de equivalencias del
   * satélite (TomTomEquivalencia persiste nVehiculo/nConductor/nGrupo): con ids
   * por contenido, "E2E-BUS-8" vuelve a ser el mismo nVehiculo en cada arranque
   * — igual que en el InRoute real, donde los ids son estables.
   */
  idEstable(texto) {
    let h = 0x811c9dc5;
    for (let i = 0; i < texto.length; i += 1) {
      h ^= texto.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 10000 + (h % 89000);
  }

  /**
   * Da de alta —o reutiliza— la unidad, el operador, su grupo y la instrucción de
   * viaje de una corrida de BCB. Es el equivalente al `setup-mappings.ts` que en
   * un ambiente real se corre una vez: sin esto el satélite no encuentra a quién
   * asignarle el viaje y lo deja registrado como fallido.
   */
  registrarCorrida({ economicNumber, operatorKey, routeNumber, routeName }) {
    const e = this.estado;

    let vehiculo = e.vehiculos.find((v) => (v.cObjectNo || '').trim() === economicNumber);
    if (!vehiculo) {
      vehiculo = {
        nVehiculo: this.idEstable(`vehiculo:${economicNumber}`),
        // El InRoute real rellena cObjectNo con espacios ("966 ") — se simula
        // igual para que el trim del satélite quede ejercido.
        cObjectNo: `${economicNumber} `,
        nLatitud: 19074661,
        nLongitud: -98202567,
        cPosicion: 'Terminal de origen (demo)',
        bIgnicion: false,
        nVelocidad: 0,
        bActivo: true,
      };
      e.vehiculos.push(vehiculo);
    }

    // Contrato real: el campo es cDriverNo (singular) y el nombre va en
    // cDescripcion — el PARÁMETRO de consulta sí es plural (cDriversNo).
    let conductor = e.conductores.find((c) => (c.cDriverNo || '').trim() === operatorKey);
    if (!conductor) {
      conductor = {
        nConductor: this.idEstable(`conductor:${operatorKey}`),
        cDriverNo: operatorKey,
        cObjectNo: '',
        cDescripcion: `OPERADOR DEMO ${operatorKey}`,
        bActivo: true,
      };
      e.conductores.push(conductor);
    }

    let grupo = e.grupos.find((g) => g._nVehiculo === vehiculo.nVehiculo && g._nConductor === conductor.nConductor);
    if (!grupo) {
      grupo = {
        nGrupo: this.idEstable(`grupo:${economicNumber}|${operatorKey}`),
        // Internos (con _): el GET real filtrado devuelve solo nGrupo/cDescripcion.
        _nVehiculo: vehiculo.nVehiculo,
        _nConductor: conductor.nConductor,
        cDescripcion: 'Primera Clase',
      };
      e.grupos.push(grupo);
    }

    let instruccion = e.instrucciones.find((i) => i.cClaveERP === routeNumber);
    if (!instruccion) {
      const n = this.idEstable(`instruccion:${routeNumber}`);
      instruccion = {
        nInstruccionViaje: n,
        cClaveERP: routeNumber,
        cDescripcion: routeName || routeNumber,
        // Grafías del contrato REAL (verificado contra el sandbox): C mayúscula
        // en GeoCerca e "Ida" con i mayúscula. Las variantes viejas eran un
        // malentendido del PDF y ya no existen ni aquí ni en el satélite.
        cOrigen: 'Origen (demo)',
        cDestino: 'Destino (demo)',
        nGeoCercaSalida: GEOCERCA_ORIGEN,
        nGeoCercaEstancia: null,
        nGeoCercaLlegada: GEOCERCA_DESTINO,
        nTiempoIdaMinutos: 120,
        bViajeRedondo: false,
        nTiempoRegresoMinutos: null,
        nTiempoEsperaMinutos: 10,
        nKmIda: 130,
        nKmRegreso: null,
        nMinutosEstancia: 15,
        bVerificacionDeSellos: false,
        bActivo: true,
        bControlDePeso: false,
        bControlDeRemolque: false,
        bTraficoNocturno: true,
        cInstruccionesGenerales: 'Ruta de demostración BIGER',
        nTiempoMaximoConduccionMinutos: 300,
        nMinutosParadoCierreAutomatico: 30,
        nMinutosPromedioDeSalida: 5,
        nKmViaje: 130,
        nUbicacionFrecuenteDestino: 54,
        nUbicacionFrecuenteOrigen: 51,
      };
      e.instrucciones.push(instruccion);
    }

    return {
      nVehicleId: vehiculo.nVehiculo,
      nDriverId: conductor.nConductor,
      nGroupId: grupo.nGrupo,
      nTripInstructionId: instruccion.nInstruccionViaje,
      nGeocercaSalida: GEOCERCA_ORIGEN,
      nGeocercaLlegada: GEOCERCA_DESTINO,
    };
  }

  /** Programa un cruce de geocerca, como si la unidad acabara de pasar por ahí. */
  programarEvento({ nVehiculo, nGeoCerca, nTipo, at }) {
    const evento = {
      nVehiculo,
      nGeoCerca,
      nTipo, // 1 = entrada, 2 = salida
      dFechaHoraEvento: fechaHoraInroute(at || new Date()),
      cNombreGeocerca:
        (this.estado.geocercas.find((g) => g.nGeocerca === nGeoCerca) || {}).cDescripcion || 'Geocerca',
      bActivo: true,
    };
    this.estado.eventos.push(evento);
    return evento;
  }

  viajePorClaveERP(claveERP) {
    return this.estado.viajes.find((v) => v.cClaveERP === claveERP) || null;
  }

  /**
   * Marca un viaje como terminado (nStatusViaje = 6) y le carga la telemetría.
   * Es la condición que el proceso programado del satélite espera para descargar
   * los datos del recorrido.
   */
  terminarViaje(nViaje, telemetria = {}) {
    const viaje = this.estado.viajes.find((v) => v.nViaje === Number(nViaje));
    if (!viaje) return null;
    const salida = viaje._salida || new Date(Date.now() - 3 * 3_600_000);
    const llegada = viaje._llegada || new Date(Date.now() - 30 * 60_000);
    Object.assign(viaje, {
      nStatusViaje: 6,
      cFechaSalidaReal: fechaInroute(salida),
      cHoraSalidaReal: horaInroute(salida),
      cFechaLlegadaReal: fechaInroute(llegada),
      cHoraLlegadaReal: horaInroute(llegada),
      nDistanciaRecorrida: 128.4,
      nConsumoGasolina: 41.2,
      nRendimientoGasolina: 3.11,
      nVelocidadPromedio: 61.3,
      nVelocidadMaxima: 94,
      nTiempoDuracion: 126,
      nTiempoParado: 18,
      ...telemetria,
    });
    return viaje;
  }
}

// ── Rutas de la API ────────────────────────────────────────────────────────
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
const bool = (v) => (v === undefined || v === '' ? undefined : v === 'true' || v === true);

/** Filtra por los parámetros presentes; los ausentes no restringen. */
function coincide(fila, filtros) {
  return Object.entries(filtros).every(([campo, valor]) => valor === undefined || fila[campo] === valor);
}

function manejar(falso, metodo, ruta, query, cuerpo) {
  const e = falso.estado;

  // /viajes/motivosCancelacion antes que /viajes: el prefijo es el mismo.
  // El InRoute REAL responde 500 {codigo:1000} en este catálogo — se simula el
  // mismo comportamiento para ejercer el fallback del satélite (motivo 1).
  if (metodo === 'GET' && ruta === '/viajes/motivosCancelacion') {
    return { _status: 500, codigo: 1000, mensaje: 'Ocurrio un error inesperado, favor de contactar a su proveedor' };
  }

  if (metodo === 'POST' && ruta === '/viajes') {
    // Contrato real (error 3008): el viaje exige al menos una orden asignada.
    const ordenes = cuerpo.Ordenes || cuerpo.ordenes || [];
    if (!cuerpo.nViaje && (!Array.isArray(ordenes) || ordenes.length === 0)) {
      return { _status: 500, codigo: 3008, mensaje: 'Es necesario asignar al menos una orden.' };
    }

    const existente = cuerpo.nViaje
      ? e.viajes.find((v) => v.nViaje === Number(cuerpo.nViaje))
      : falso.viajePorClaveERP(cuerpo.cClaveERP);

    if (existente) {
      Object.assign(existente, {
        cDescripcion: cuerpo.cDescripcion,
        nConductor: cuerpo.nConductor,
        nVehiculo: cuerpo.nVehiculo,
        nGrupo: cuerpo.nGrupo,
        nInstruccionViaje: cuerpo.nInstruccionViaje,
        cFechaSalidaPlaneada: cuerpo.cFechaSalidaPlaneada,
        nHoraSalidaPlaneada: cuerpo.nHoraSalidaPlaneada,
        cHoraSalidaPlaneada: horaDeMinutos(cuerpo.nHoraSalidaPlaneada),
      });
      return { nViaje: existente.nViaje };
    }

    const viaje = {
      nViaje: falso.siguienteId('nViaje'),
      nStatusViaje: Number(cuerpo.nEstatus) || 1,
      cClaveERP: cuerpo.cClaveERP,
      cDescripcion: cuerpo.cDescripcion,
      nConductor: cuerpo.nConductor,
      nVehiculo: cuerpo.nVehiculo,
      nGrupo: cuerpo.nGrupo,
      nInstruccionViaje: cuerpo.nInstruccionViaje,
      cFechaSalidaPlaneada: cuerpo.cFechaSalidaPlaneada,
      nHoraSalidaPlaneada: cuerpo.nHoraSalidaPlaneada,
      cHoraSalidaPlaneada: horaDeMinutos(cuerpo.nHoraSalidaPlaneada),
      cFechaSalidaReal: null,
      cHoraSalidaReal: null,
      cFechaLlegadaReal: null,
      cHoraLlegadaReal: null,
      nDistanciaRecorrida: null,
      nConsumoGasolina: null,
      nRendimientoGasolina: null,
      nVelocidadPromedio: null,
      nVelocidadMaxima: null,
      nTiempoDuracion: null,
      nTiempoParado: null,
    };
    e.viajes.push(viaje);
    return { nViaje: viaje.nViaje };
  }

  if (metodo === 'DELETE' && ruta === '/viajes') {
    const viaje = e.viajes.find((v) => v.nViaje === Number(cuerpo.nViaje));
    if (!viaje) return { _status: 500, codigo: 3016, mensaje: 'No se encontraron viajes.' };
    if (!cuerpo.nMotivoCancelacion) {
      return { _status: 500, codigo: 3014, mensaje: 'No se encontró el motivo de cancelación con el id proporcionado' };
    }
    viaje.nStatusViaje = 7; // Cancelado
    viaje.cMotivoCancelacion = cuerpo.cMotivoDescripcion;
    return {};
  }

  if (metodo === 'GET' && ruta === '/viajes') {
    if (query.nViaje !== undefined) {
      const uno = e.viajes.filter((v) => v.nViaje === num(query.nViaje));
      // El InRoute real responde 500 {codigo:3016} cuando el id no existe.
      if (uno.length === 0) return { _status: 500, codigo: 3016, mensaje: 'No se encontraron viajes.' };
      return uno.map(publico);
    }
    return e.viajes
      .filter((v) =>
        coincide(v, {
          nViaje: num(query.nViaje),
          nVehiculo: num(query.nVehiculo),
          nConductor: num(query.nConductor),
          nGrupo: num(query.nGrupo),
          nInstruccionViaje: num(query.nInstruccionViaje),
          nStatusViaje: num(query.nEstatus),
        }),
      )
      .filter((v) => coincideClaveERP(query.clavesERP, v.cClaveERP))
      .map(publico);
  }

  // GET /eventosGeocerca NO existe en el API real (404 verificado): el modelo del
  // DCU es que TomTom EMPUJA los eventos al webhook del satélite. Se deja caer al
  // 404 genérico — si algo vuelve a consultarlo, que truene igual que en producción.

  if (metodo === 'GET' && ruta === '/vehiculos') {
    return e.vehiculos
      .filter((v) => coincide(v, { nVehiculo: num(query.nVehiculo), bActivo: bool(query.bActivo) }))
      .filter((v) => !query.cObjectsNo || (v.cObjectNo || '').trim() === String(query.cObjectsNo).trim());
  }

  if (metodo === 'GET' && ruta === '/conductores') {
    return e.conductores
      .filter((c) => coincide(c, { nConductor: num(query.nConductor), bActivo: bool(query.bActivo) }))
      .filter((c) => !query.cDriversNo || (c.cDriverNo || '').trim() === String(query.cDriversNo).trim());
  }

  if (metodo === 'GET' && ruta === '/grupos') {
    // La respuesta real filtrada trae solo nGrupo/cDescripcion (sin bActivo).
    return e.grupos
      .filter((g) => coincide(g, { nGrupo: num(query.nGrupo) }))
      .filter((g) => !query.nVehiculo || g._nVehiculo === num(query.nVehiculo))
      .filter((g) => !query.nConductor || g._nConductor === num(query.nConductor))
      .map(publico);
  }

  if (metodo === 'GET' && ruta === '/geocercas') {
    return e.geocercas.filter((g) => coincide(g, { nGeocerca: num(query.nGeocerca), bActivo: bool(query.bActivo) }));
  }

  if (metodo === 'GET' && ruta === '/ubicacionesFrecuentes') {
    return e.ubicacionesFrecuentes.filter((u) =>
      coincide(u, { nUbicacionFrecuente: num(query.nUbicacionFrecuente), bActivo: bool(query.bActivo) }),
    );
  }

  // ── Escrituras de instrucciones, waypoints, documentos y órdenes ─────────
  //
  // InRoute usa el MISMO verbo para alta y actualización: si el cuerpo trae el
  // id, actualiza; si no, crea. Y las bajas mandan el id en el CUERPO, no en la
  // ruta — es su convención, no una rareza del simulador.
  //
  // Estas rutas faltaban y el satélite traducía el 404 a un 500 pelón, así que
  // la carpeta de instrucciones y la de órdenes de la colección de demo no se
  // podían ejercer en local.

  const guardar = (coleccion, clave, campos) => {
    const id = Number(cuerpo[clave]);
    const existente = id ? coleccion.find((x) => x[clave] === id) : null;
    if (existente) {
      Object.assign(existente, campos(existente[clave]));
      return { [clave]: existente[clave] };
    }
    const nuevo = campos(falso.siguienteId(clave));
    coleccion.push(nuevo);
    return { [clave]: nuevo[clave] };
  };

  const borrar = (coleccion, clave) => {
    const id = Number(cuerpo[clave]);
    const i = coleccion.findIndex((x) => x[clave] === id);
    if (i === -1) return { _status: 500, codigo: 3007, mensaje: 'No se encontró la orden con el id proporcionado.' };
    coleccion.splice(i, 1);
    return {};
  };

  if (metodo === 'POST' && ruta === '/instruccionesViaje') {
    return guardar(e.instrucciones, 'nInstruccionViaje', (id) => ({
      nInstruccionViaje: id,
      cDescripcion: cuerpo.cDescripcion ?? null,
      cClaveERP: cuerpo.cClaveERP ?? null,
      nGeoCercaSalida: cuerpo.nGeoCercaSalida ?? null,
      nGeoCercaLlegada: cuerpo.nGeoCercaLlegada ?? null,
      nTiempoIdaMinutos: cuerpo.nTiempoIdaMinutos ?? null,
      bViajeRedondo: cuerpo.bViajeRedondo ?? false,
      nKmIda: cuerpo.nKmIda ?? null,
      nKmViaje: cuerpo.nKmViaje ?? null,
      cInstruccionesGenerales: cuerpo.cInstruccionesGenerales ?? null,
      bActivo: cuerpo.bActivo ?? true,
    }));
  }

  if (metodo === 'DELETE' && ruta === '/instruccionesViaje') {
    return borrar(e.instrucciones, 'nInstruccionViaje');
  }

  if (metodo === 'POST' && ruta === '/instruccionesViaje/waypoints') {
    return guardar(e.waypoints, 'nInstruccionViajeWayPoint', (id) => ({
      nInstruccionViajeWayPoint: id,
      nInstruccionViaje: cuerpo.nInstruccionViaje ?? null,
      cDescripcion: cuerpo.cDescripcion ?? null,
      cLatitud: cuerpo.cLatitud ?? null,
      cLongitud: cuerpo.cLongitud ?? null,
      nTipoWayPoint: cuerpo.nTipoWayPoint ?? null,
      nTiempoPermanenciaMinutos: cuerpo.nTiempoPermanenciaMinutos ?? null,
      nOrdenamiento: cuerpo.nOrdenamiento ?? null,
      cDomicilio: cuerpo.cDomicilio ?? null,
      bActivo: cuerpo.bActivo ?? true,
    }));
  }

  if (metodo === 'DELETE' && ruta === '/instruccionesViaje/waypoints') {
    return borrar(e.waypoints, 'nInstruccionViajeWayPoint');
  }

  if (metodo === 'POST' && ruta === '/instruccionesViaje/documentos') {
    return guardar(e.documentos, 'nInstruccionViajeDocumento', (id) => ({
      nInstruccionViajeDocumento: id,
      nInstruccionViaje: cuerpo.nInstruccionViaje ?? null,
      cDescripcion: cuerpo.cDescripcion ?? null,
      cClaveERP: cuerpo.cClaveERP ?? null,
      bRequiereFoto: cuerpo.bRequiereFoto ?? false,
      bActivo: cuerpo.bActivo ?? true,
    }));
  }

  if (metodo === 'DELETE' && ruta === '/instruccionesViaje/documentos') {
    return borrar(e.documentos, 'nInstruccionViajeDocumento');
  }

  if (metodo === 'POST' && ruta === '/ordenes') {
    // Contrato real (4001): clave ERP duplicada al crear sin nOrden.
    if (!cuerpo.nOrden && cuerpo.cObjectNo && e.ordenes.some((o) => (o.cObjectNo || '').trim() === String(cuerpo.cObjectNo).trim())) {
      return { _status: 500, codigo: 4001, mensaje: 'Ya existe una orden con la clave ERP proporcionada.' };
    }
    return guardar(e.ordenes, 'nOrden', (id) => ({
      nOrden: id,
      nViaje: cuerpo.nViaje ?? null,
      nVehiculo: cuerpo.nVehiculo ?? null,
      nConductor: cuerpo.nConductor ?? null,
      nGrupo: cuerpo.nGrupo ?? null,
      nTipoOrden: cuerpo.nTipoOrden ?? null,
      nEstatus: cuerpo.nEstatus ?? null,
      cObjectNo: cuerpo.cObjectNo ?? null,
      cFecha: cuerpo.cFecha ?? null,
      nHora: cuerpo.nHora ?? null,
      cDomicilio: cuerpo.cDomicilio ?? null,
      cLatitud: cuerpo.cLatitud ?? null,
      cLongitud: cuerpo.cLongitud ?? null,
      cDescripcion: cuerpo.cDescripcion ?? null,
      cCliente: cuerpo.cCliente ?? null,
      cContacto: cuerpo.cContacto ?? null,
      cContactoTelefono: cuerpo.cContactoTelefono ?? null,
      cNota: cuerpo.cNota ?? null,
      bActivo: cuerpo.bActivo ?? true,
    }));
  }

  if (metodo === 'DELETE' && ruta === '/ordenes') {
    // Verificado contra el API real: DELETE /ordenes responde 405 aunque la
    // guía v2.0.2 lo documente.
    return { _status: 405, mensaje: 'Method Not Allowed' };
  }

  if (metodo === 'GET' && ruta === '/instruccionesViaje') {
    return e.instrucciones
      .filter((i) => coincide(i, { nInstruccionViaje: num(query.nInstruccionViaje), bActivo: bool(query.bActivo) }))
      .filter((i) => coincideClaveERP(query.clavesERP, i.cClaveERP));
  }

  if (metodo === 'GET' && (ruta === '/instruccionesViaje/waypoints/all' || ruta === '/instruccionesViaje/waypoints/all/')) {
    return e.waypoints.filter((w) => coincide(w, { nInstruccionViaje: num(query.nInstruccionViaje) }));
  }

  if (metodo === 'GET' && (ruta === '/instruccionesViaje/documentos/all' || ruta === '/instruccionesViaje/documentos/all/')) {
    return e.documentos.filter((d) => coincide(d, { nInstruccionViaje: num(query.nInstruccionViaje) }));
  }

  if (metodo === 'GET' && ruta === '/ordenes') {
    return e.ordenes.filter((o) =>
      coincide(o, { nOrden: num(query.nOrden), nVehiculo: num(query.nVehiculo), nConductor: num(query.nConductor) }),
    );
  }

  if (metodo === 'GET' && ruta === '/rastreos') {
    // Un rastro corto alrededor de la posición de la unidad, para que la pestaña
    // de auditoría tenga qué mostrar sin depender de una corrida real.
    const nVehiculo = num(query.nVehiculo);
    const vehiculo = e.vehiculos.find((v) => v.nVehiculo === nVehiculo) || e.vehiculos[0];
    if (!vehiculo) return [];
    return [0, 10, 20].map((min) => ({
      nVehiculo: vehiculo.nVehiculo,
      nConductor: (e.conductores[0] || {}).nConductor ?? null,
      nViaje: (e.viajes[e.viajes.length - 1] || {}).nViaje ?? null,
      nLatitud: vehiculo.nLatitud + min * 1000,
      nLongitud: vehiculo.nLongitud - min * 900,
      nVelocidad: 60 + min,
      dFechaHoraEvento: fechaHoraInroute(new Date(Date.now() - (30 - min) * 60_000)),
      dFechaHora: fechaHoraInroute(new Date(Date.now() - (30 - min) * 60_000)),
      bIgnicion: true,
      bActivo: true,
    }));
  }

  if (metodo === 'GET' && ruta === '/bitacoraSensores') return [];

  if (metodo === 'GET' && ruta === '/consultas/consumoCombustible') {
    return e.viajes
      .filter((v) => v.nStatusViaje === 6)
      .map((v) => ({
        nVehiculo: v.nVehiculo,
        nConductor: v.nConductor,
        nViaje: v.nViaje,
        nGrupo: v.nGrupo,
        nDistanciaRecorrida: v.nDistanciaRecorrida,
        nConsumoGasolina: v.nConsumoGasolina,
        nRendimientoGasolina: v.nRendimientoGasolina,
        cFechaInicio: v.cFechaSalidaReal,
        cFechaFin: v.cFechaLlegadaReal,
      }));
  }

  return null; // 404
}

const horaDeMinutos = (min) =>
  min === undefined || min === null
    ? null
    : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Los campos internos (los que empiezan con _) no salen en la respuesta. */
const publico = (viaje) => Object.fromEntries(Object.entries(viaje).filter(([k]) => !k.startsWith('_')));

// ── Servidor ───────────────────────────────────────────────────────────────
/**
 * @param obtenerConfig  devuelve { modo, url, usuario, password, timeoutMs }
 * @param alRecibir      callback con el registro de cada llamada (para el panel)
 */
function coincideClaveERP(filtro, clave) {
  if (!filtro) return true;
  return Array.isArray(filtro) ? filtro.includes(clave) : clave === filtro;
}

function crearServidorInroute(falso, obtenerConfig, alRecibir) {
  return http.createServer((req, res) => {
    let crudo = '';
    req.on('data', (c) => (crudo += c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://inroute.local');
      const query = Object.fromEntries(url.searchParams.entries());
      // InRoute bindea clavesERP como lista .NET: el parámetro repetido
      // (clavesERP=A&clavesERP=B) une resultados; la forma con comas NO
      // matchea (verificado en sandbox). Se preservan todos los valores.
      const clavesERP = url.searchParams.getAll('clavesERP');
      if (clavesERP.length > 0) query.clavesERP = clavesERP;
      let cuerpo = {};
      try {
        cuerpo = crudo ? JSON.parse(crudo) : {};
      } catch {
        cuerpo = crudo;
      }

      const config = obtenerConfig();
      const registro = {
        at: new Date().toISOString(),
        modo: config.modo,
        metodo: req.method,
        ruta: url.pathname,
        query,
        // El dato de oro de la demostración: el cuerpo exacto que el satélite le
        // manda a Adsum, ya traducido a su formato.
        payloadEnviado: crudo ? cuerpo : null,
        reenvio: null,
        respuesta: null,
      };

      let status = 200;
      let salida;

      if (config.modo === 'real') {
        try {
          const r = await reenviarAlReal(config, req.method, url, crudo);
          registro.reenvio = r;
          salida = r.body;
          status = r.status;
        } catch (err) {
          registro.reenvio = { url: config.url, error: String((err && err.message) || err) };
          salida = { error: 1000, mensaje: `No se pudo contactar a InRoute: ${registro.reenvio.error}` };
          status = 502;
        }
      } else {
        salida = manejar(falso, req.method, url.pathname, query, cuerpo);
        if (salida === null) {
          status = 404;
          salida = { codigo: 1000, mensaje: `Ruta no simulada: ${req.method} ${url.pathname}` };
        } else if (salida && typeof salida === 'object' && !Array.isArray(salida) && salida._status) {
          // Los manejadores marcan el status real de InRoute con _status
          // (500 {codigo,mensaje}, 405, etc.) — el campo no sale en el body.
          status = salida._status;
          salida = Object.fromEntries(Object.entries(salida).filter(([k]) => k !== '_status'));
        }
      }

      registro.respuesta = { status, body: salida };
      alRecibir(registro);

      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(salida));
    });
  });
}

async function reenviarAlReal(config, metodo, url, crudo) {
  const destino = `${String(config.url).replace(/\/+$/, '')}${url.pathname}${url.search}`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.usuario) {
    headers.Authorization = `Basic ${Buffer.from(`${config.usuario}:${config.password}`).toString('base64')}`;
  }
  const t0 = Date.now();
  const res = await fetch(destino, {
    method: metodo,
    headers,
    body: crudo || undefined,
    signal: AbortSignal.timeout(config.timeoutMs || 20000),
  });
  const texto = await res.text();
  let body;
  try {
    body = JSON.parse(texto);
  } catch {
    body = texto;
  }
  return {
    url: destino,
    status: res.status,
    ms: Date.now() - t0,
    body,
    headers: { ...headers, ...(config.usuario ? { Authorization: `Basic ${config.usuario}:***` } : {}) },
  };
}

module.exports = { InrouteFalso, crearServidorInroute, GEOCERCA_ORIGEN, GEOCERCA_DESTINO };
