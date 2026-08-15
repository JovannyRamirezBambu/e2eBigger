# Panel de demostración — Venta a Bordo

Para presentar los **3 servicios del contrato TI-FT-45** a cliente y a
TECNITRANS/SmartMac: qué hace cada uno, por dónde viajan los datos, y ejecutarlos
de verdad contra el entorno local, con la validación en base de datos a la vista.

```bash
cd ER/e2e
./e2e up ventaabordo      # levanta el stack (una vez)
./e2e seed ventaabordo    # catálogo del Servicio 3 (una vez)
./e2e demo                # → http://localhost:7788
```

No es el panel de diagnóstico (`./e2e ui`, `:7777`). Aquél sirve para depurar el
harness; éste está hecho para **explicarle el flujo a otras personas**, incluidas
las que no son técnicas.

## Qué muestra

Una pestaña por servicio, y cada una en el mismo orden:

1. **Qué hace y por qué** — en palabras, sin jerga.
2. **Por dónde viajan los datos** — el diagrama de la cadena, entidad por entidad,
   que se ilumina mientras la ejecución avanza.
3. **Reglas del servicio** — las del documento, incluidos los puntos abiertos.
4. **Datos que se envían** — editables, campo por campo o como JSON completo.
5. **Qué pasó** — cada salto con su petición y su respuesta; un clic abre el
   detalle (headers, credencial usada, cuerpo de ida y de vuelta).
6. **Validar en base de datos** — el SQL a la vista y su resultado. Se corre solo
   al terminar la ejecución.

| Servicio | Qué se demuestra | Dónde se valida |
|---|---|---|
| **1 · Despacho (WS1)** | BCB despacha y la tarjeta de viaje llega hasta SmartMac | `TarjetaViaje` en el satélite + el payload exacto que recibió SmartMac |
| **2 · Recepción de venta (WS2)** | SmartMac reporta la venta y ésta termina en BCB | `BoardingSale` + `BoardingSaleItem` en **BCB** |
| **3 · Consulta por operador** | El equipo pregunta sus corridas del día y BCB responde | `Trip` / `TravelCard` / `CashRegister` en **BCB** |

## Enviar de verdad a SmartMac

El satélite siempre entrega la tarjeta de viaje a este panel (su `SMARTMAC_WS1_URL`
apunta acá). En **Configuración** se elige qué hace el panel con ella:

- **Simulado** — contesta el panel, con el mismo formato que el real (HTTP 200 y el
  veredicto en `responseCode`). Nada sale a internet.
- **SmartMac REAL** — se reenvía a TECNITRANS con las credenciales que se capturen,
  y la respuesta de ellos vuelve al satélite tal cual.

Conmutar es instantáneo: **no reinicia ningún servicio**, así que se puede enseñar
el mismo despacho contra el simulador y contra el real, uno tras otro. En modo real
aparece una franja roja en la parte superior durante toda la sesión.

El payload que se ve en el panel lo construyó el código real del satélite, no el
panel: es el que sale hacia TECNITRANS, ya traducido a su formato
(`autobus`, `clave_corrida`, `id_tarjeta_viaje`…).

## Durante la reunión

- **«Generar corrida nueva»** arma folios frescos con la forma de los ejemplos del
  documento (`180001…`, folio de 22 caracteres). Dos ejecuciones seguidas nunca
  chocan, así que se puede repetir la demostración las veces que haga falta.
- El **Servicio 1 y el 2 comparten la corrida**: se despacha y después se reporta su
  venta, que es el ciclo real. El **Servicio 3 usa el catálogo sembrado** en BCB
  (operador `E2EVACO-OP-1`, caja `E2EVACO-CAJA-1`), porque su fuente es la
  programación del día de BCB, no una corrida recién creada.
- El Servicio 1 tiene dos puntos de entrada. **«Desde BCB»** pega en
  `POST /bcb/travel-cards/despachar` de `adapter-bcb`, que es un relay puro: es
  exactamente el evento que BCB emite al despachar, no una simulación. **«Directo al
  satélite»** salta la mensajería interna y sirve para aislar al satélite si algo
  falla en un eslabón intermedio.
- Si un paso falla, el panel muestra el último error de cada servicio de la cadena y
  qué revisar, en vez de mandar a leer tres logs.

## Antes de la reunión (5 minutos)

```bash
./e2e up ventaabordo && ./e2e seed ventaabordo && ./e2e demo
```

Y en el panel: ejecutar los 3 servicios una vez. Los semáforos del encabezado deben
estar todos en verde.

**El puerto 7801 no se puede compartir.** El panel y el harness de pruebas
(`./e2e test ventaabordo`) escuchan los dos ahí; el que arranque segundo falla con
un mensaje que lo explica. No corras las pruebas con el panel abierto.

## Por qué está hecho así

Sin dependencias y sin capa TypeScript, a diferencia del harness de pruebas
(`src/`). Es deliberado: en una reunión importa que arranque al instante y que un
valor se pueda cambiar en caliente sin reconstruir nada. La detección de cambios de
contrato —payloads tipados contra los DTOs reales de los satélites— vive en el
harness, que es donde tiene sentido; acá los datos son editables a propósito.
