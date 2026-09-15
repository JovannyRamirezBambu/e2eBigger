# Harness E2E — BIGER ↔ satélites

Levanta el stack mínimo de un flujo de negocio y lo prueba de punta a punta con el
código real de todos los repos involucrados, antes de desplegar a `dev`.

```bash
cd ER/e2e
pnpm install          # una vez
./e2e run tomtom      # levantar → sembrar → probar → verificar
```

## Cómo está partido

Dos lenguajes, cada uno donde rinde:

| Capa | Lenguaje | Qué hace |
|---|---|---|
| `e2e`, `lib/`, `flows/*/flow.sh` | bash | Infraestructura: docker, maven, puertos, ciclo de vida de procesos, llaves. Acá viven las trampas del monorepo. |
| `src/` | TypeScript | Pruebas: casos, seed, probe, snapshot de BD. |
| `ui/` | React + Vite + Tailwind (frontend) / Node sin dependencias (`server.cjs`) | El panel. |

Lo que gana TypeScript en la capa de pruebas, concretamente:

- **Payloads tipados con los DTOs reales de los satélites** (`import type` cross-repo).
  Si alguien agrega o renombra un campo del contrato, el harness **deja de
  compilar** — que es el momento correcto para enterarse, en vez de descubrirlo
  como un 400 que en producción significa un evento perdido.
- **Prisma tipado** en vez de `SELECT` en strings: `db.travelCard.findUnique(...)`
  con autocompletado, y si una columna cambia de nombre no compila.
- **Cliente NATS real**: se puede leer el *contenido* de la DLQ y sus headers
  (`x-dlq-reason`, `x-error-detail`), no solo el contador. En bash era imposible.
- **El código real del satélite se importa directo** (`AdapterTomtomCallbackClient`),
  así que la firma del JWT que se ejerce es la suya. La versión en bash tenía que
  copiar un script dentro de ese repo; ese hack desapareció.

`pnpm typecheck` valida todo eso sin correr nada.

## Comandos

| Comando | Qué hace |
|---|---|
| `./e2e run <flujo>` | Ciclo completo. Es lo que querés el 90 % del tiempo. |
| `./e2e ui <flujo>` | Panel en el navegador: diagrama con estado vivo, un botón por caso, logs de los 3 servicios juntos. |
| `./e2e up <flujo>` | Solo levanta infra + servicios (idempotente). |
| `./e2e seed <flujo>` | Recrea los datos de prueba. Se puede correr N veces. |
| `./e2e test <flujo> [caso]` | Corre todos los casos, o uno solo. |
| `./e2e verify <flujo>` | Imprime el estado en BD, formateado para leerlo a ojo. |
| `./e2e status <flujo>` | Qué está arriba y qué no. |
| `./e2e psql <flujo>` | `psql` en la BD principal del flujo. |
| `./e2e token <flujo> [segundos]` | Token de administración para pegarle a mano al satélite. Solo lo emiten los flujos que lo necesitan (hoy `agencias`). |
| `./e2e logs <flujo> [srv]` | `tail -f` de un servicio. |
| `./e2e down <flujo>` | Baja los servicios del flujo. `--all` baja también la infra compartida. |
| `./e2e demo` | Panel de **demostración** de Venta a Bordo, para presentar los 3 servicios del contrato TI-FT-45 a cliente y proveedor. Ver [`demo/README.md`](demo/README.md). |
| `./e2e demo tomtom` | Panel de **demostración** de TomTom: el ciclo de una corrida entre BCB e InRoute (Adsum). Ver [`demo-tomtom/README.md`](demo-tomtom/README.md). |
| `./e2e list` | Flujos disponibles. |

Correr un caso suelto mientras depurás:

```bash
./e2e test tomtom t11-carrera-manual
```

## Paneles, para dos cosas distintas

`./e2e ui <flujo>` (`:7777`) es el **panel de diagnóstico**: estado de la cadena y
botones para correr los casos.

Los **paneles de demostración** son otra cosa: están pensados para explicarle el
flujo a gente de fuera del equipo —diagramas, datos editables y el SQL de
validación a la vista— y para poder ejercer de verdad al proveedor sin reiniciar
nada. Hay uno por integración, porque el guion de la reunión y las validaciones no
se parecen:

| Panel | Puerto | De qué habla |
|---|---|---|
| `./e2e demo` | `:7788` | Venta a Bordo: los 3 servicios del contrato TI-FT-45, con SmartMac simulado o el real de TECNITRANS. [`demo/README.md`](demo/README.md) |
| `./e2e demo tomtom` | `:7789` | TomTom: el ciclo de una corrida entre BCB e InRoute, con InRoute simulado o el real de Adsum. [`demo-tomtom/README.md`](demo-tomtom/README.md) |

## El panel

```bash
./e2e ui tomtom      # abre http://localhost:7777
```

El flujo se elige **dentro del panel**, con el selector del encabezado — no hay que
reiniciar el servidor. El argumento del comando es solo el flujo inicial. La
elección queda en la URL (`?flow=ventaabordo`), así que el enlace es compartible, y
se recuerda entre recargas. El desplegable de logs y los nodos clicables se arman
con los servicios del flujo activo, para no mezclar logs de otro.

Sirve para dos cosas distintas: **explicar el flujo** (el diagrama de la cadena
con el estado de cada eslabón) y **diagnosticar** cuando algo se rompe. Eso
último es lo que el CLI no puede darte: si `adapter-bcb` se cae, el panel lo
marca en rojo, muestra su último error, y JetStream aparece con los mensajes
acumulándose — el diagnóstico completo de un vistazo, en vez de grepear tres logs.

Es **solo lectura + correr casos**: levantar/bajar servicios y recrear la base
siguen siendo del CLI, a propósito, para que un clic no deje el entorno a medias.
El backend (`ui/server.cjs`, sin dependencias) no reimplementa nada: invoca este
mismo `./e2e` y transforma su salida a JSON o a un stream SSE. Si el panel y la
terminal discrepan alguna vez, es un bug del servidor, no dos verdades.

Los comandos `cases`, `probe`, `db-json`, `traffic` y `results` existen para eso
y también te sirven a vos para scriptear.

Cada caso muestra el tráfico HTTP que generó (método, URL, status) y un clic abre
el detalle completo: headers, credencial usada —decodificada, JWT o Basic—, el
body de ida y de vuelta con JSON resaltado, y un `curl` listo para reproducirlo a
mano.

### Frontend del panel (React/Vite/Tailwind)

El backend sigue siendo Node puro y sin dependencias, pero el frontend
(`ui/src/`) es un proyecto aparte: React + TypeScript + Tailwind + componentes
estilo shadcn/ui sobre Radix, con Vite como build. Vive en su propio
`ui/package.json` (propio `pnpm install`, propio lockfile) para no meter React
en la capa de pruebas.

`./e2e ui <flujo>` arma `ui/dist/` solo si hace falta —compara fuentes contra el
build, igual que hace con los jars— y el `server.cjs` lo sirve como archivos
estáticos. Para iterar el panel con recarga en vivo:

```bash
cd ui && pnpm install   # una vez
pnpm dev                # servidor de Vite en :5173, proxea /api a :7777
```

Con eso corriendo en paralelo a `./e2e ui <flujo>` (que sigue sirviendo la API en
`:7777`), los cambios en `ui/src/` se ven al instante sin reconstruir.

## Cómo confirmar a mano que salió bien

`./e2e verify <flujo>` corre `flows/<flujo>/verify.sql`, que está escrito para que
el resultado se entienda sin leer el código: por ejemplo, para TomTom muestra el
reloj administrativo (`dispatchedAt`) al lado del reloj real de geocerca
(`realDepartureAt` / `realArrivalAt`), y dónde quedó cada bus y operador.

Para explorar por tu cuenta:

```bash
./e2e psql tomtom
# o desde cualquier cliente (DataGrip, DBeaver):
#   host localhost  puerto 5436  base bcb  usuario bcb  password bcb
```

## Flujos

### `ventaabordo` — WS1/WS2

**SmartMac (falso) ← satélite Venta a Bordo → adapter-ventaabordo → JetStream → adapter-bcb → apps/webhooks**

| Componente | Repo | Puerto |
|---|---|---|
| SmartMac falso | el harness | `:7801` |
| Satélite Venta a Bordo | `BIGER_EstrellaRoja_VentaABordo` | `:3001`, BD `:5435` |
| `adapter-ventaabordo` | `BIGER_EstrellaRoja_Main` | `:8088` |
| `adapter-bcb` | `BIGER_EstrellaRoja_Main` | `:8085` (compartido) |
| `apps/webhooks` | `BCB_EstrellaRoja_Backend` | `:3011` |

13 casos: WS1 (envío aceptado, rechazo que **no** marca la tarjeta como enviada,
clave de corrida de largo variable), WS2 (cadena completa hasta `BoardingSale`,
idempotencia por `smartmacId`, recargas compartiendo folio —válidas—, folio de
boleto duplicado —inválido—, tarjeta inexistente, y que sin credencial de SmartMac
o con una equivocada responda 401), y SM04 (fallback de consulta de tarjeta de
viaje cuando el push de WS1 falló: por folio, por número económico del autobús,
tarjeta inexistente → 404, y el mismo guard de SmartMac que protege WS2).

**SmartMac es un tercero real** (`er-smartmac.dyndns.org:5056`) sin sandbox, pero el
satélite lo apunta por configuración, así que el harness lo sustituye por uno propio
y **verifica el payload exacto que sale**. El falso replica el formato real —HTTP 200
con el veredicto en `responseCode`— porque inventar otro haría pasar la prueba y
fallar contra el real.

**Las dos direcciones autentican distinto, y el harness lo espeja del repo.** WS1 lo
llama BCB y va con el JWT `bcb-system`; WS2 / canje / consulta los llama SmartMac y
van con Basic Auth (`SMARTMAC_INBOUND_BASIC_*`). Mientras esa rama no esté en
develop, tanto el `.env` que se escribe como la credencial que mandan los casos se
eligen según exista `src/shared/guards/smartmac-basic-auth.guard.ts` — igual que el
`shiftId` de `ticketcolectoroffline`. Fijar uno de los dos dejaría el flujo en rojo
en la mitad de los checkouts, o —peor— en verde contra un guard que no corre.

Las credenciales entrantes que usa el flujo son desechables y las escribe el propio
harness: no lee las del `.env`, que pueden ser las reales de TECNITRANS.

### `tomtom` — CU04/CU05 (geocercas)

Cadena completa: **satélite TomTom → adapter-tomtom → NATS JetStream → adapter-bcb → BCB**.

| Componente | Repo | Puerto |
|---|---|---|
| Satélite TomTom | `BIGER_EstrellaRoja_TomTom` | `:3003`, BD `:5440` |
| `adapter-tomtom` | `BIGER_EstrellaRoja_Main` | `:8090` (`:8088` lo reserva ventaabordo) |
| NATS ×3 + `adapter-invoice` + Postgres | `BIGER_EstrellaRoja_Main` | `:4222` / `:8222` / `:5433` |
| `adapter-bcb` | `BIGER_EstrellaRoja_Main` | `:8085` |
| `apps/bcb` | `BCB_EstrellaRoja_Backend` | `:3009`, BD `:5436` |
| InRoute falso | el panel de demostración | `:7803` |

Las pruebas ejercitan CU04/CU05 invocando el cliente de callbacks del satélite
directamente, así que no necesitan que el satélite corra como proceso ni que
InRoute exista. El **ciclo completo** —alta del viaje en InRoute, polling de
geocercas, telemetría— sí lo necesita, y por eso `up` levanta el satélite en
`:3003` con `INROUTE_BASE_URL` apuntando al InRoute falso del panel: ver
[`demo-tomtom/README.md`](demo-tomtom/README.md).

33 casos: autenticación, T1 (contexto), T10 (despacho), T11 (llegada),
idempotencia, precondiciones de estado, validación de DTOs, dos recorridos de
cadena completa por NATS, y que la DLQ quede vacía.

El punto de entrada es `AdapterTomtomCallbackClient` del satélite —el código real
que firma el JWT y llama al adapter—, no `POST /tomtom/geocercas`, porque ese hace
polling contra InRoute (servicio de terceros, sin sandbox). CU04/CU05 empiezan
justo después de esa detección.

### `ticketcolectoroffline` — sincronización offline de la tablet

Cadena completa: **tablet del taquillero → adapter-ticketcolectoroffline → NATS
request/reply → adapter-bcb → `apps/bcb` (módulo `sync`)**.

| Componente | Repo | Puerto |
|---|---|---|
| Tablet del taquillero (la simula el harness) | — | — |
| Emisor JWKS de prueba | `e2e/lib/jwks-server.js` | `:7802` |
| `adapter-ticketcolectoroffline` | `BIGER_EstrellaRoja_Main` | `:8092` |
| NATS ×3 + `adapter-invoice` + Postgres | `BIGER_EstrellaRoja_Main` | `:4222` / `:8222` / `:5433` |
| `adapter-bcb` | `BIGER_EstrellaRoja_Main` | `:8085` |
| `apps/bcb` (módulo `sync`) | `BCB_EstrellaRoja_Backend` | `:3009`, BD `:5436` |

15 casos: lote completo, idempotencia por `sync_id`, conflicto de payload,
cancelación dentro del mismo lote, recolección de efectivo, corrida existente e
inexistente, tipo de pasajero, turno explícito, eventos a JetStream con dedup,
autenticación (sin token y con firma inválida) y propagación de los 400/404 de BCB.

**Es el único flujo que NO corre con `JWT_BYPASS`,** y no es un capricho: sus dos
controllers llevan `@BcbAuth({ADVISOR})` y la identidad del taquillero **no viaja
en el payload**. Sale del `SecurityContext`, se copia al `_auth` del mensaje NATS y
adapter-bcb la vuelve a firmar como los claims `userId`/`role` del contrato-token
2.0 que exige BCB. Con el bypass ese contexto queda vacío y BCB responde 401 sin
decir en qué eslabón se perdió la identidad — así que el flujo levanta un emisor
JWKS local y firma un token ADVISOR de verdad. Es la única cobertura que existe de
esa cadena.

El `kid` del token sale del thumbprint RFC 7638 de la llave, no de una constante:
Nimbus cachea el JWKS por `kid`, y con un valor fijo, regenerar `run/keys/` dejaría
al adapter validando contra la llave vieja y daría un 401 inexplicable.

`shiftId` (el turno explícito del lote) es un cambio de dos repos que hoy vive en
una rama. El caso `t09` **espeja el DTO del adapter** en vez de fijar un
comportamiento: afirma lo que el repo dice que hace, y se pone en rojo justo en el
caso que importa — que el adapter lo mande y BCB lo ignore.

### `agencias` — login de agencias del Portal de Agencias

Cadena completa: **satélite Portal de Agencias → adapter-portalagencias → NATS
request/reply → adapter-bcb → `apps/auth` (`/agency/*`)**.

| Componente | Repo | Puerto |
|---|---|---|
| Satélite Portal de Agencias | `BIGER_EstrellaRoja_PortalAgenciasAdmin` | `:3002`, BD `:5434` |
| `adapter-portalagencias` (jar en el host) | `BIGER_EstrellaRoja_Main` | `:8094` |
| NATS ×3 + `adapter-invoice` + Postgres | `BIGER_EstrellaRoja_Main` | `:4222` / `:8222` / `:5433` |
| `adapter-bcb` (con `BCB_AUTH_SATELLITE_URL` local) | `BIGER_EstrellaRoja_Main` | `:8085` |
| `apps/auth` (login de agencias) | `BCB_EstrellaRoja_Backend` | `:3012`, BD `:5436` |
| Emisor JWKS de prueba (rol `agency`) | `e2e/lib/jwks-server.js` | `:7804` |

16 casos: login correcto (tokens, claims, una sesión en BD), contraseña incorrecta y
correo inexistente (401), agencia inactiva (403 al entrar y con token válido),
`/auth/me` en el satélite y en BCB, refresh token como Bearer (401), deny-by-default
de `@AgencyAccess()` (endpoint admin → 403, detalle ajeno → 403, propio → 200),
refresh que rota el access token, logout que revoca, dos logins concurrentes que
dejan UNA sesión, rutas públicas del adapter (`/agencies/auth/*` sin token → 200,
el resto → 401) y payload inválido → 400.

**No hay seed versionado.** La agencia de prueba se da de alta ejecutando los
mismos SQL manuales que se corren en develop (`ER/_portal-agencias-docs/`), así que
el harness también los prueba. `apps/auth` arranca con `lib/bcb-auth-bootstrap.ts`:
sustituye solo `SecretManagerService` (devuelve la privada del leg `bcb-agency`) y
el JWKS que BCB consulta para verificar lo sirve `lib/jwks-server.js` con la
pública del mismo par. Ningún eslabón corre con `JWT_BYPASS`: en el adapter lo que
se prueba es justamente que `app.security.public-paths` abre solo las tres rutas de
auth.

`adapter-bcb` se reinicia siempre en `up`: necesita `BCB_AUTH_SATELLITE_URL`
apuntando al `apps/auth` local (por defecto va al API Gateway de develop), y otro
flujo pudo haberlo dejado arriba sin esa variable.

## Agregar un flujo

Dos piezas, y el entrypoint no se toca.

> **Elegí un prefijo que no caiga dentro del de otro flujo.** Los tres comparten la
> base de BCB y cada seed limpia por llave de negocio, así que un prefijo contenido
> en otro (`E2E-TCO-` dentro de `E2E-`) hace que el barrido del vecino borre tus
> filas, choque con tus FKs y deje **su** suite en rojo por culpa de la tuya.

**1. Infraestructura** — `flows/<nombre>/flow.sh`:

```bash
FLOW_DESC="descripción de una línea"
flow_up()     { ... }   # infra, migraciones, credenciales, servicios
flow_down()   { ... }
flow_status() { ... }
flow_psql()   { ... }
```

`lib/common.sh` ya trae logging, esperas con timeout (`wait_for`), arranque y paro
de procesos (cerrando por puerto, no por PID), llaves RSA en los dos formatos,
detección de jars desactualizados y limpieza de scripts injertados.

**2. Pruebas** — `src/flows/<nombre>/index.ts`, exportando un `Flow`:

```ts
export const flow: Flow = {
  name, description,
  cases,            // CaseDef[]: { name, label, run(t) }
  seed,             // idempotente
  probe,            // nodos de la cadena para el panel
  dbSnapshot,       // filas para verify y el panel
  close,
};
```

Y registralo en el mapa `FLOWS` de `src/cli.ts` (una línea).

`src/harness/` ya trae asertos con el formato de salida esperado, cliente HTTP con
firma JWT RS256, Prisma tipado, cliente NATS (streams + DLQ) y esperas.

Candidatos siguientes: **`ventaabordo`** (WS1 despacho + WS2 retorno de SmartMac;
tablas `BoardingSale`/`BoardingSaleItem` en BCB y `TarjetaViaje`/`VentaABordo` en el
satélite) y **`ticketcolectoroffline`** (sincronización de ventas offline).

## Trampas que el harness ya resuelve por vos

Cada una costó tiempo de depuración en su momento:

- **Jar desactualizado.** Un `adapter-*.jar` compilado antes de que existiera un
  consumer arranca **sin ningún error** y simplemente no lo registra. `up`
  compara fechas de fuentes vs. jar y recompila solo si hace falta.
- **Jar recompilado pero no reiniciado.** La otra mitad de la trampa anterior: la
  JVM leyó el jar al arrancar, así que recompilar no cambia nada en el proceso que
  ya corre. Como `adapter-bcb` lo comparten los tres flujos, era fácil recompilarlo
  y seguir probando el binario de hace horas. Todo módulo reconstruido baja su
  servicio (`stop_rebuilt`) para que el `start_*` lo levante con el código nuevo.
- **Streams de JetStream.** No se auto-crean. Sin `make nats-init` el publish da
  `503 No Responders` y el consumer durable nunca enlaza. `up` los aplica y
  verifica que existan.
- **PKCS#1 vs PKCS#8.** `openssl genrsa` produce PKCS#1, que `jsonwebtoken`
  (Node) acepta pero `PemRsaKeyParser` (Java) rechaza con
  `InvalidKeySpecException`. El harness genera **los dos** formatos y le da a
  cada lado el que le corresponde.
- **Procesos huérfanos.** `pnpm exec …` es un wrapper: matar su PID deja al hijo
  `node` sosteniendo el puerto, el servicio nuevo muere con `EADDRINUSE` y las
  pruebas le siguen pegando al proceso viejo — un falso verde muy difícil de
  ver. `up`/`down` cierran por puerto, no por PID.
- **Pipes globales.** `apps/bcb` monta sus pipes de validación en `main.ts` /
  `serverless.ts`, no en el `AppModule`. Un bootstrap de test que solo llame a
  `app.init()` **no valida ningún DTO** y da falsos PASS. El bootstrap del
  harness los replica; así se encontró el bug del PR #1534.
- **Client de Prisma desincronizado.** Cambiar de rama —o cualquier
  `prisma generate` corrido desde una rama sin las columnas nuevas, que es lo que
  hace el hook de pre-push— deja un client que no compila contra el código
  actual, y la app muere con errores de tipos sin relación aparente. `up` lo
  regenera siempre (tarda <1 s).
- **Dedup de JetStream al repetir un caso de cadena.** `adapter-tomtom` deriva el
  `Nats-Msg-Id` del id del viaje (`despacho:<tripId>`) y **no incluye el
  timestamp**, con ventana de dedup de 2 min. Con un viaje fijo, dos corridas
  seguidas no publicaban nada y el caso fallaba con un mensaje desconcertante —
  y randomizar la hora enviada no ayudaba, porque no participa en la llave.
  **Por eso los casos de cadena crean un viaje nuevo en cada corrida**
  (`createChainTrip`), reusando el bus y el operador del escenario y borrando el
  efímero anterior. Verificado: la suite corre las veces que quieras, seguidas,
  sin esperas. Queda una detección de dedup como red de seguridad, que ya no
  debería dispararse.
- **`.env` con PEM partido.** Si alguien mete una llave con `sed` cuyo reemplazo
  trae `\n`, sed lo convierte en saltos de línea reales y `docker compose` deja
  de poder leer el `.env`. `up` descarta esas líneas huérfanas.

## Notas

- `run/` (logs, PIDs, llaves) está en `.gitignore`. Las llaves son de un solo uso
  local: **nunca** credenciales reales.
- `up` copia dos scripts efímeros dentro de los repos (`scripts/e2e/` en BCB,
  `src/e2e-trigger.ts` en el satélite) porque necesitan resolver alias de
  `tsconfig`. `down` los borra.
- `down` **no** apaga NATS ni el Postgres de BIGER: otros flujos los usan. Para
  eso, `./e2e down <flujo> --all`.
- El `.env` del satélite TomTom lo reescribe `up` con placeholders de InRoute.
  Está en `.gitignore` de ese repo. Si tenés credenciales reales de InRoute ahí,
  hacé respaldo antes.
