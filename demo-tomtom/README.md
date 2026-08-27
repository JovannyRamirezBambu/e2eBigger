# Panel de demostración — TomTom / InRoute

Para presentar el ciclo de una corrida entre **BCB** y **TomTom (InRoute / Adsum)**
a cliente y a proveedor: qué hace cada parte, por dónde viajan los datos, y
ejecutarlo de verdad contra el entorno local, con la validación en base de datos a
la vista.

```bash
cd ER/e2e
./e2e up tomtom        # levanta el stack (una vez)
./e2e seed tomtom      # escenarios en BCB (una vez)
./e2e demo tomtom      # → http://localhost:7789
```

No es el panel de diagnóstico (`./e2e ui tomtom`, `:7777`). Aquél sirve para
depurar el harness; éste está hecho para **explicarle el flujo a otras personas**,
incluidas las que no son técnicas. Tampoco es el panel de Venta a Bordo
(`./e2e demo`, `:7788`): son dos programas distintos porque el guion de la
reunión, los actores del diagrama y las validaciones no se parecen.

## Qué muestra

Una pestaña por momento del ciclo, y cada una en el mismo orden:

1. **Qué hace y por qué** — en palabras, sin jerga.
2. **Por dónde viajan los datos** — el diagrama de la cadena, entidad por
   entidad, que se ilumina mientras la ejecución avanza.
3. **Reglas del servicio** — las del documento, incluidos los puntos abiertos.
4. **Datos que se envían** — editables, campo por campo o como JSON completo.
5. **Qué pasó** — cada salto con su petición y su respuesta; un clic abre el
   detalle (mensaje publicado, cuerpo hacia InRoute, credencial usada).
6. **Validar en base de datos** — el SQL a la vista y su resultado. Se corre solo
   al terminar la ejecución.

| Momento | Qué se demuestra | Dónde se valida |
|---|---|---|
| **1 · Registro del viaje** | Tráfico despacha y el viaje aparece en InRoute | `TomTomTrip` + `TomTomSync` en el satélite, y el cuerpo exacto que recibió InRoute |
| **2 · Cambios y cancelación** | El cambio o la cancelación llegan a InRoute | `TomTomSync` en el satélite |
| **3 · Salida de la terminal (CU04)** | La geocerca despacha la corrida en BCB con su hora real | `Trip.realDepartureAt` y el autobús en viaje, en **BCB** |
| **4 · Llegada a destino (CU05)** | La tarjeta se confirma sola y se liberan autobús y operador | `TravelCard` / `Trip` / `Bus` / `Operator` en **BCB** |
| **5 · Catálogos de InRoute** | La traducción entre los identificadores de BCB y los de TomTom | `TomTomGroup` (el único catálogo que se cachea) |
| **6 · Telemetría del viaje** | Al cerrar el viaje se descarga el recorrido | `TomTomTripData` en el satélite |

El orden natural de la reunión es **1 → 3 → 4 → 6**. Las pestañas 2 y 5 se pueden
ver en cualquier momento.

## Enviar de verdad a InRoute

El satélite siempre le habla a este panel (su `INROUTE_BASE_URL` apunta acá). En
**Configuración** se elige qué hace el panel con esas llamadas:

- **Simulado** — contesta el panel, con el formato del InRoute real y un catálogo
  coherente (unidad, operador, grupo, instrucción de viaje con sus geocercas).
  Nada sale a internet.
- **InRoute REAL** — se reenvía a Adsum con las credenciales que se capturen, y su
  respuesta vuelve al satélite tal cual.

Conmutar es instantáneo: **no reinicia ningún servicio**, así que se puede enseñar
la misma alta contra el simulador y contra el real, una tras otra. En modo real
aparece una franja roja en la parte superior durante toda la sesión.

El cuerpo que se ve en el panel lo construyó el código real del satélite, no el
panel: es el que sale hacia Adsum, ya traducido a su formato (`cClaveERP`,
`cFechaSalidaPlaneada`, `nHoraSalidaPlaneada` en minutos desde la medianoche…).

## Durante la reunión

- **«Generar corrida nueva»** crea una corrida despachada en BCB con ids frescos y
  da de alta su equivalencia en InRoute. Dos ejecuciones seguidas nunca chocan, así
  que la demostración se puede repetir las veces que haga falta. También limpia los
  cruces de geocerca anteriores: la corrida nueva empieza sin haber salido.
- La corrida se crea con **salida hace ~20 minutos**. No es un detalle estético: el
  polling solo mira los últimos 35 minutos, así que una corrida que sale más tarde
  no tendría ningún cruce que mirar.
- El **cruce de geocerca se expresa como desfase** respecto a la salida programada
  («salió cinco minutos tarde»), que es como lo piensa operación y es lo que decide
  si cae dentro de la ventana de despacho (−45 / +60 min). Poner −90 es la forma
  rápida de enseñar el rechazo por ventana.
- Los servicios 1, 3 y 4 tienen **dos puntos de entrada**. El primero recorre la
  cadena completa desde el evento que emite BCB; el segundo va directo al satélite
  y sirve para aislarlo si algo falla en un eslabón intermedio.
- Si un paso falla, el panel muestra lo que los servicios escribieron **durante esa
  ejecución** (no el log entero) y qué revisar, en vez de mandar a leer cuatro logs.

## Dos huecos que el panel deja a la vista

Los dos aparecen solos al recorrer el ciclo con la entrada «desde BCB», y los dos
están anotados en las reglas de su pestaña:

- **La estación destino no llega al satélite.** `adapter-bcb` arma el evento con
  `destinationId: ""` (`TravelCardRelayService.buildViajePayload`). BCB valida ese
  dato contra la ruta al confirmar la llegada, así que **CU05 se rechaza** para
  cualquier viaje dado de alta por la cadena. El panel lo avisa al terminar el alta
  y otra vez antes de disparar la llegada, en lugar de dejar que el evento se
  pierda con un 400 en un log.
- **La actualización nunca llega a InRoute.** El mismo relay manda `claveERP` en el
  cuerpo, y el contrato de actualización no lo lleva (va en la URL). El satélite
  valida en modo estricto y responde `400 property claveERP should not exist`.

En las dos pestañas hay una entrada **«Directo al satélite»** que manda el cuerpo
correcto: sirve para mostrar el comportamiento bueno mientras se corrige el relay.

## Antes de la reunión (5 minutos)

```bash
./e2e up tomtom && ./e2e seed tomtom && ./e2e demo tomtom
```

Y en el panel: generar una corrida y correr 1 → 3 → 4 → 6 una vez. Los semáforos
del encabezado deben estar todos en verde.

**El puerto 7803 no se puede compartir**: es el InRoute simulado, y el satélite lo
tiene fijo en su `.env`. Si hay dos copias del panel abiertas, la segunda no
arranca y lo dice.

## Por qué está hecho así

Sin dependencias propias y sin capa TypeScript, igual que el panel de Venta a
Bordo: en una reunión importa que arranque al instante y que un valor se pueda
cambiar en caliente. Las dos cosas que el panel no puede hacer solo se delegan al
código de quien corresponde:

- la **corrida de demostración** la crea el harness, que tiene el Prisma de BCB
  (`tsx src/cli.ts tomtom demo-trip`, en `src/flows/tomtom/demo.ts`);
- la **telemetría** la corre el satélite con su propio código compilado
  (`sync-runner.cjs` levanta un contexto de Nest sobre `dist/`, que es lo mismo que
  ejecuta la Lambda `tomtomSync`). No pasa por `tsx` porque esbuild no emite la
  metadata de decoradores que Nest necesita para inyectar dependencias.

La detección de cambios de contrato —payloads tipados contra los DTOs reales— vive
en el harness de pruebas, que es donde tiene sentido; acá los datos son editables a
propósito.
