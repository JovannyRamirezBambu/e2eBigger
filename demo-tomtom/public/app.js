/* Panel de demostración de TomTom — frontend sin dependencias.
   Todo el trabajo real lo hace `demo-tomtom/server.cjs`; acá solo se pinta. */

const estado = {
  servicios: [],
  escenario: null,
  /** Payload editable por servicio; se conserva al cambiar de pestaña. */
  payloads: {},
  /** Punto de entrada elegido en cada servicio que tiene más de uno. */
  entradas: { alta: 'bcb', cambios: 'actualizar', cu04: 'adapter', cu05: 'adapter', catalogos: 'vehiculos' },
  resultados: {},
  ejecutando: {},
  sql: {},
  config: null,
  salud: null,
  pestana: 'panorama',
};

// ── Utilidades ─────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Negritas, cursivas y `código` en las explicaciones, sin traer un parser. */
const rico = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

function resaltarJson(valor) {
  const texto = esc(JSON.stringify(valor, null, 2));
  return texto.replace(
    /("(\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?/g,
    (m, cadena, _b, dosPuntos, literal) => {
      if (cadena) return dosPuntos ? `<span class="k">${cadena}</span>${dosPuntos}` : `<span class="s">${cadena}</span>`;
      if (literal) return `<span class="b">${m}</span>`;
      return `<span class="n">${m}</span>`;
    },
  );
}

const PALABRAS_SQL =
  /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|ON|GROUP BY|ORDER BY|AND|OR|AS|COUNT|COALESCE|INTERVAL|DATE_TRUNC|NOW|NULL|IS|NOT|LIMIT|DESC|WITH)\b/gi;

const resaltarSql = (sql) =>
  esc(sql)
    .replace(/'([^']*)'/g, '<span class="str">\'$1\'</span>')
    .replace(PALABRAS_SQL, '<span class="kw">$&</span>')
    .replace(/\b(\d{3,})\b/g, '<span class="num">$&</span>');

const api = async (ruta, opciones) => {
  const res = await fetch(ruta, opciones);
  return res.json();
};

const postJson = (ruta, cuerpo) =>
  api(ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

// ── Carga inicial ──────────────────────────────────────────────────────────
async function iniciar() {
  const [servicios, config] = await Promise.all([api('/api/servicios'), api('/api/config')]);
  estado.servicios = servicios.servicios;
  estado.escenario = servicios.escenario;
  for (const s of estado.servicios) estado.payloads[s.id] = s.payload;
  estado.config = config;

  const pestanaUrl = new URL(location.href).searchParams.get('s');
  if (pestanaUrl) estado.pestana = pestanaUrl;

  pintarPestanas();
  pintar();
  refrescarSalud();
  setInterval(refrescarSalud, 8000);
}

async function refrescarSalud() {
  estado.salud = await api('/api/estado').catch(() => null);
  pintarSemaforos();
}

// ── Barra superior ─────────────────────────────────────────────────────────
function pintarPestanas() {
  const nav = $('#pestanas');
  const items = [{ id: 'panorama', nombre: 'Panorama' }, ...estado.servicios];
  nav.innerHTML = items
    .map(
      (s) =>
        `<button class="pestana ${estado.pestana === s.id ? 'activa' : ''}" data-pestana="${s.id}">` +
        (s.numero ? `<span class="num">${s.numero}</span>` : '') +
        `<span>${esc(s.nombre)}</span></button>`,
    )
    .join('');
  nav.querySelectorAll('[data-pestana]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.pestana = b.dataset.pestana;
      const url = new URL(location.href);
      url.searchParams.set('s', estado.pestana);
      history.replaceState(null, '', url);
      pintarPestanas();
      pintar();
      window.scrollTo({ top: 0 });
    }),
  );
}

function pintarSemaforos() {
  const cont = $('#semaforos');
  if (!estado.salud) return (cont.innerHTML = '');
  cont.innerHTML = estado.salud.servicios
    .map((s) => `<span class="luz ${s.up ? 'si' : 'no'}" title="${esc(s.label)}: ${s.up ? 'arriba' : 'abajo'}"></span>`)
    .join('');
  $('#aviso-real').hidden = !modoReal();
}

// ── Diagrama ───────────────────────────────────────────────────────────────
const FLECHA_SVG =
  '<svg width="26" height="12" viewBox="0 0 26 12" fill="none"><path d="M0 6h22M17 1l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function pintarDiagrama(servicio, avance = -1) {
  const partes = [];
  servicio.actores.forEach((a, i) => {
    if (i > 0) {
      const estadoFlecha = avance < 0 ? '' : i - 1 < avance ? 'completa' : i - 1 === avance ? 'activa' : '';
      partes.push(`<div class="flecha ${estadoFlecha}">${FLECHA_SVG}</div>`);
    }
    const clase = avance < 0 ? '' : i < avance ? 'completo' : i === avance ? 'destacado' : '';
    partes.push(
      `<div class="actor ${clase}" data-tipo="${a.tipo}">` +
        `<span class="actor-tipo">${etiquetaTipo(a.tipo)}</span>` +
        `<div class="actor-label">${esc(a.label)}</div>` +
        `<div class="actor-sub">${esc(a.sub)}</div>` +
        `</div>`,
    );
  });

  const pasos = servicio.pasos
    .map(
      (p, i) =>
        `<div class="paso-linea"><span class="paso-num">${i + 1}</span>` +
        `<span><b>${esc(p.texto)}</b>${p.detalle ? ` <span class="paso-detalle">— ${esc(p.detalle)}</span>` : ''}</span></div>`,
    )
    .join('');

  const vuelta = servicio.respuestaDeVuelta
    ? '<div class="nota-pie">La respuesta regresa por el mismo camino, en sentido inverso.</div>'
    : '';

  const compacta = servicio.actores.length > 6 ? ' compacta' : '';
  return `<div class="diagrama${compacta}">${partes.join('')}</div><div class="pasos-diagrama">${pasos}${vuelta}</div>`;
}

const etiquetaTipo = (tipo) =>
  ({ tercero: 'TomTom', bcb: 'BCB', biger: 'BIGER', satelite: 'Satélite', infra: 'Interno', bd: 'Datos' })[tipo] || tipo;

// ── Vista: panorama ────────────────────────────────────────────────────────
function vistaPanorama() {
  const tarjetas = estado.servicios
    .map(
      (s) =>
        `<div class="tarjeta-ciclo" data-ir="${s.id}">` +
        `<div class="numero">${s.numero}</div>` +
        `<h3>${esc(s.nombre)}</h3>` +
        `<p>${esc(s.resumen)}</p>` +
        `<div class="direccion">${esc(s.direccion)}</div>` +
        `</div>`,
    )
    .join('');

  return `
    <div class="encabezado-servicio">
      <div class="eyebrow">Demostración en vivo</div>
      <h1>El ciclo de una corrida entre BCB y TomTom</h1>
      <p class="resumen">
        El satélite TomTom es el puente entre <b>BCB</b>, el sistema central de Estrella Roja, e
        <b>InRoute</b>, la plataforma de TomTom que monitorea las unidades. No tiene pantallas propias:
        su trabajo es que cada corrida exista en el mapa y que lo que la unidad hace en la carretera
        vuelva a BCB sin que nadie lo capture a mano.
      </p>
    </div>

    ${estado.escenario ? tarjetaCorrida() : tarjetaSinCorrida()}

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Los seis momentos del ciclo</h3></div>
      <div class="tarjeta-cuerpo">
        <div class="parrafos" style="margin-bottom:22px">
          <p>Tráfico asigna unidad y operador a una corrida, y el viaje aparece en TomTom (1). Si algo
          cambia o se cancela, InRoute se entera por el mismo camino (2). Cuando la unidad sale de la
          terminal cruza una geocerca y la corrida queda <strong>despachada con su hora real</strong> (3);
          cuando entra a la terminal destino, la tarjeta se <strong>confirma sola</strong> y quedan libres
          el autobús y el operador (4). Los catálogos (5) son la traducción entre los identificadores de
          BCB y los de TomTom, y al cerrar el viaje se descarga el recorrido completo (6).</p>
        </div>
        <div class="ciclo">${tarjetas}</div>
      </div>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Cómo usar este panel</h3></div>
      <div class="tarjeta-cuerpo">
        <ul class="reglas">
          <li>Cada pestaña es un momento del ciclo: primero <strong>qué hace</strong> en palabras, después el
              <strong>camino que recorren los datos</strong>, y al final se puede <strong>ejecutar de verdad</strong>.</li>
          <li>Todo cuelga de una <strong>corrida de demostración</strong>. El botón <em>Generar corrida nueva</em>
              crea una en BCB y da de alta su unidad, su operador y su ruta en InRoute, para que dos
              ejecuciones seguidas nunca choquen.</li>
          <li>El orden natural es <strong>1 → 3 → 4 → 6</strong>: dar de alta el viaje, sacarlo de la terminal,
              hacerlo llegar y cerrarlo. Las pestañas 2 y 5 se pueden ver en cualquier momento.</li>
          <li>Después de ejecutar, el bloque <strong>Validar en base de datos</strong> corre el SQL a la vista y
              muestra el renglón tal como quedó guardado — en el satélite y, sobre todo, en BCB.</li>
          <li>En <strong>Configuración</strong> se puede conmutar entre el InRoute simulado y el
              <strong>InRoute real de Adsum</strong>, sin reiniciar nada.</li>
        </ul>
      </div>
    </div>`;
}

function tarjetaCorrida() {
  const e = estado.escenario;
  const salida = new Date(e.departure);
  const minutos = Math.round((Date.now() - salida.getTime()) / 60000);
  return `
    <div class="tarjeta">
      <div class="tarjeta-cabecera">
        <h3>La corrida de esta demostración</h3>
        <button class="boton secundario" id="btn-nuevo-panorama">Generar corrida nueva</button>
      </div>
      <div class="tarjeta-cuerpo">
        ${tablaDe([
          {
            autobús: e.economicNumber,
            operador: e.operatorKey,
            ruta: `${e.routeNumber} · ${e.routeName}`,
            'salida programada': `${salida.toLocaleString('es-MX')} (hace ${minutos} min)`,
            // Los tres identificadores de InRoute en una columna: son el mismo
            // dato —la equivalencia de esta corrida del otro lado— y en columnas
            // separadas empujaban la tabla fuera de la pantalla.
            'en InRoute (unidad · conductor · ruta)': [
              (e.inroute || {}).nVehicleId ?? '—',
              (e.inroute || {}).nDriverId ?? '—',
              (e.inroute || {}).nTripInstructionId ?? '—',
            ].join(' · '),
          },
        ])}
        <div class="nota-pie" style="margin-top:12px">
          Tarjeta de viaje <code>${esc(e.travelCardId)}</code> · corrida <code>${esc(e.tripId)}</code>
        </div>
      </div>
    </div>`;
}

function tarjetaSinCorrida() {
  return `
    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Falta la corrida de demostración</h3></div>
      <div class="tarjeta-cuerpo">
        <div class="parrafos"><p>Antes de empezar hay que crear una corrida en BCB y dar de alta su
        equivalencia en InRoute. Toma unos segundos y se puede repetir las veces que haga falta.</p></div>
        <div class="acciones"><button class="boton" id="btn-nuevo-panorama">Generar corrida nueva</button>
        <span class="nota-pie" id="nota-nuevo"></span></div>
      </div>
    </div>`;
}

// ── Vista: un servicio ─────────────────────────────────────────────────────
function vistaServicio(servicio) {
  const resultado = estado.resultados[servicio.id];
  const avance = resultado ? resultado.avance : -1;

  return `
    <div class="encabezado-servicio">
      <div class="eyebrow">${servicio.numero} · ${esc(servicio.alias)}</div>
      <h1>${esc(servicio.nombre)}</h1>
      <p class="resumen">${esc(servicio.resumen)}</p>
      <div class="fichas">
        <span class="ficha metodo"><b>${esc(servicio.metodo)}</b> ${esc(servicio.ruta)}</span>
        <span class="ficha">Lo dispara <b>${esc(servicio.quienLlama)}</b></span>
        <span class="ficha">Autenticación: <b>${esc(servicio.auth)}</b></span>
        <span class="ficha">${esc(servicio.direccion)}</span>
      </div>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Qué hace y por qué</h3></div>
      <div class="tarjeta-cuerpo">
        <div class="parrafos">${servicio.explicacion.map((p) => `<p>${rico(p)}</p>`).join('')}</div>
      </div>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Por dónde viajan los datos</h3></div>
      <div class="tarjeta-cuerpo" id="zona-diagrama">${pintarDiagrama(servicio, avance)}</div>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Reglas del servicio</h3></div>
      <div class="tarjeta-cuerpo"><ul class="reglas">${servicio.reglas.map((r) => `<li>${rico(r)}</li>`).join('')}</ul></div>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera">
        <h3>${servicio.campos.length ? 'Datos que se envían' : 'Qué se va a consultar'}</h3>
        <button class="boton secundario" id="btn-nuevo">Generar corrida nueva</button>
      </div>
      <div class="tarjeta-cuerpo">
        ${servicio.entradas ? selectorEntrada(servicio) : ''}
        <div class="rejilla-campos" id="rejilla"></div>
        ${
          servicio.campos.length
            ? `<details style="margin-top:20px">
                 <summary style="cursor:pointer;font-size:13.5px;color:var(--tinta-suave)">Ver y editar el cuerpo completo (JSON)</summary>
                 <textarea class="json" id="editor-json" spellcheck="false"></textarea>
                 <div class="nota-pie" id="aviso-json"></div>
               </details>`
            : ''
        }
        <div class="acciones" style="margin-top:22px">
          <button class="boton ${modoReal() ? 'peligro' : ''}" id="btn-ejecutar" ${estado.escenario ? '' : 'disabled'}>
            ${esc(textoBoton(servicio))}
          </button>
          <span class="nota-pie" id="nota-ejecucion">${
            estado.escenario ? '' : 'Primero hay que generar una corrida de demostración.'
          }</span>
        </div>
      </div>
    </div>

    <div id="zona-resultado"></div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Validar en base de datos</h3></div>
      <div class="tarjeta-cuerpo" id="zona-sql"></div>
    </div>`;
}

const modoReal = () => estado.config && estado.config.inroute && estado.config.inroute.modo === 'real';

function textoBoton(servicio) {
  if (servicio.id === 'alta') return modoReal() ? 'Dar de alta en InRoute REAL' : 'Dar de alta el viaje';
  if (servicio.id === 'cambios')
    return estado.entradas.cambios === 'cancelar' ? 'Cancelar el viaje' : 'Actualizar el viaje';
  if (servicio.id === 'cu04') return 'Sacar la unidad de la terminal';
  if (servicio.id === 'cu05') return 'Hacer llegar la unidad a destino';
  if (servicio.id === 'catalogos') return 'Consultar el catálogo';
  return 'Cerrar el viaje y descargar el recorrido';
}

function selectorEntrada(servicio) {
  return `<div class="selector-entrada">${servicio.entradas
    .map(
      (e) =>
        `<button class="opcion-entrada ${estado.entradas[servicio.id] === e.id ? 'activa' : ''}" data-entrada="${e.id}">` +
        `<div class="titulo">${esc(e.label)}</div><div class="ayuda">${esc(e.ayuda)}</div></button>`,
    )
    .join('')}</div>`;
}

// ── Formulario ─────────────────────────────────────────────────────────────
function pintarCampos(servicio) {
  const payload = estado.payloads[servicio.id] || {};
  $('#rejilla').innerHTML = servicio.campos
    .map(
      (c) =>
        `<div class="campo"><label>${esc(c.label)}${c.doc ? `<span class="ayuda">${esc(c.doc)}</span>` : ''}</label>` +
        `<input data-campo="${c.name}" data-tipo="${c.tipo}" value="${esc(payload[c.name] ?? '')}" /></div>`,
    )
    .join('');

  $('#rejilla')
    .querySelectorAll('[data-campo]')
    .forEach((input) =>
      input.addEventListener('input', () => {
        const bruto = input.value;
        estado.payloads[servicio.id][input.dataset.campo] =
          input.dataset.tipo === 'number' && bruto !== '' && !Number.isNaN(Number(bruto)) ? Number(bruto) : bruto;
        sincronizarJson(servicio);
      }),
    );

  sincronizarJson(servicio);
}

function sincronizarJson(servicio) {
  const editor = $('#editor-json');
  if (editor && document.activeElement !== editor) {
    editor.value = JSON.stringify(estado.payloads[servicio.id] || {}, null, 2);
    editor.classList.remove('invalido');
    $('#aviso-json').textContent = '';
  }
}

function conectarEditorJson(servicio) {
  const editor = $('#editor-json');
  if (!editor) return;
  editor.addEventListener('input', () => {
    try {
      estado.payloads[servicio.id] = JSON.parse(editor.value);
      editor.classList.remove('invalido');
      $('#aviso-json').textContent = 'Los cambios del JSON mandan sobre los campos de arriba.';
      pintarCamposSuave(servicio);
    } catch (e) {
      editor.classList.add('invalido');
      $('#aviso-json').textContent = `JSON inválido: ${e.message}`;
    }
  });
}

/** Actualiza los inputs sin volver a construirlos (no roba el foco al editor). */
function pintarCamposSuave(servicio) {
  const payload = estado.payloads[servicio.id] || {};
  $('#rejilla')
    .querySelectorAll('[data-campo]')
    .forEach((input) => {
      const valor = payload[input.dataset.campo];
      if (String(valor ?? '') !== input.value) input.value = valor ?? '';
    });
}

// ── Ejecución ──────────────────────────────────────────────────────────────
const NOTA_EJECUCION = {
  alta: 'La cadena pasa por la mensajería interna; puede tardar unos segundos.',
  cambios: 'La cadena pasa por la mensajería interna; puede tardar unos segundos.',
  cu04: 'El evento viaja por una cola durable hasta BCB: puede tardar unos segundos.',
  cu05: 'El evento viaja por una cola durable hasta BCB: puede tardar unos segundos.',
  catalogos: 'Consultando a InRoute…',
  telemetria: 'Levantando el proceso del satélite; la primera vez tarda más.',
};

async function ejecutar(servicio) {
  if (estado.ejecutando[servicio.id]) return;
  estado.ejecutando[servicio.id] = true;

  const boton = $('#btn-ejecutar');
  boton.disabled = true;
  boton.textContent = 'Ejecutando…';
  $('#nota-ejecucion').textContent = NOTA_EJECUCION[servicio.id] || 'Siguiendo el recorrido paso a paso…';

  // Animación del diagrama mientras corre: da la sensación del recorrido.
  let paso = 0;
  const animacion = setInterval(() => {
    paso = Math.min(paso + 1, servicio.actores.length - 1);
    $('#zona-diagrama').innerHTML = pintarDiagrama(servicio, paso);
  }, 700);

  const salida = await postJson('/api/ejecutar', {
    servicio: servicio.id,
    payload: estado.payloads[servicio.id],
    opciones: { entrada: estado.entradas[servicio.id] },
  }).catch((e) => ({ pasos: [{ titulo: 'No se pudo contactar al panel', error: true, nota: String(e) }], ms: 0 }));

  clearInterval(animacion);
  salida.avance = salida.pasos.some((p) => p.error) ? -1 : servicio.actores.length;
  estado.resultados[servicio.id] = salida;
  estado.ejecutando[servicio.id] = false;

  $('#zona-diagrama').innerHTML = pintarDiagrama(servicio, salida.avance);
  boton.disabled = false;
  boton.textContent = textoBoton(servicio);
  $('#nota-ejecucion').textContent = `Tomó ${((salida.ms || 0) / 1000).toFixed(1)} s`;
  pintarResultado(servicio);

  // Al terminar, las consultas de validación se corren solas: en una reunión no
  // hay que pedirle a nadie que además haga clic para ver la prueba.
  for (const bloque of servicio.sql) correrSql(servicio, bloque);
}

function pintarResultado(servicio) {
  const salida = estado.resultados[servicio.id];
  const zona = $('#zona-resultado');
  if (!salida) return (zona.innerHTML = '');

  const bloques = salida.pasos
    .map((p, i) => {
      const mal = !!p.error || (p.http && !p.http.ok) || (p.nats && !p.nats.ok);
      const partes = [
        `<div class="res-titulo"><span class="marca-estado ${mal ? 'mal' : 'ok'}">${mal ? '!' : '✓'}</span>${esc(p.titulo)}</div>`,
      ];
      if (p.nota) partes.push(`<div class="res-nota">${esc(p.nota)}</div>`);
      if (p.nats) {
        partes.push(
          `<div class="linea-nats" data-nats="${i}">` +
            `<span class="canal">NATS</span>` +
            `<span class="subject">${esc(p.nats.subject)}</span>` +
            `<span class="pastilla ${p.nats.ok ? 'ok' : 'mal'}">${p.nats.ok ? 'publicado' : 'falló'}</span>` +
            `<span class="ver">${p.nats.ms} ms · ver el mensaje</span></div>`,
        );
        if (p.nats.error) partes.push(`<div class="sql-error">${esc(p.nats.error)}</div>`);
      }
      if (p.http) {
        const ok = p.http.ok;
        partes.push(
          `<div class="linea-http" data-detalle="${i}">` +
            `<span class="metodo">${p.http.metodo}</span>` +
            `<span class="url">${esc(p.http.url)}</span>` +
            `<span class="pastilla ${ok ? 'ok' : 'mal'}">${p.http.status || 'sin respuesta'}</span>` +
            `<span class="ver">${p.http.ms} ms · ver detalle</span></div>`,
        );
        if (p.http.error) partes.push(`<div class="sql-error">${esc(p.http.error)}</div>`);
      }
      if (p.inroute) {
        partes.push(
          `<div class="linea-http" data-inroute="${i}">` +
            `<span class="metodo">${esc(p.inroute.metodo)}</span>` +
            `<span class="url">${esc(
              p.inroute.reenvio ? p.inroute.reenvio.url : `InRoute simulado · ${p.inroute.ruta}`,
            )}</span>` +
            `<span class="pastilla ${p.inroute.respuesta.status < 400 ? 'ok' : 'mal'}">${p.inroute.respuesta.status}</span>` +
            `<span class="ver">ver lo que se envió</span></div>`,
        );
      }
      if (p.datos) partes.push(tablaDe(Array.isArray(p.datos) ? p.datos : [p.datos]));
      if (p.diagnostico) partes.push(pintarDiagnostico(p.diagnostico));
      return `<div class="resultado ${mal ? 'mal' : 'ok'}">${partes.join('')}</div>`;
    })
    .join('');

  zona.innerHTML =
    `<div class="tarjeta"><div class="tarjeta-cabecera"><h3>Qué pasó</h3>` +
    `<span class="nota-pie">${new Date(salida.at).toLocaleTimeString('es-MX')}</span></div>` +
    `<div class="tarjeta-cuerpo">${bloques}</div></div>`;

  zona.querySelectorAll('[data-detalle]').forEach((el) =>
    el.addEventListener('click', () => abrirDetalleHttp(salida.pasos[Number(el.dataset.detalle)])),
  );
  zona.querySelectorAll('[data-inroute]').forEach((el) =>
    el.addEventListener('click', () => abrirDetalleInroute(salida.pasos[Number(el.dataset.inroute)].inroute)),
  );
  zona.querySelectorAll('[data-nats]').forEach((el) =>
    el.addEventListener('click', () => abrirDetalleNats(salida.pasos[Number(el.dataset.nats)].nats)),
  );
}

function pintarDiagnostico(d) {
  const pistas = (d.pistas || []).map((p) => `<div>${esc(p)}</div>`).join('');
  const errores = (d.errores || [])
    .map((e) => `<div class="err"><b style="display:inline">${esc(e.servicio)}</b> — ${esc(e.error)}</div>`)
    .join('');
  return `<div class="diagnostico"><b>Qué revisar</b>${pistas}${errores}</div>`;
}

function tablaDe(filas) {
  if (!filas || !filas.length) return '<div class="sql-vacio">Sin resultados.</div>';
  const columnas = [...new Set(filas.flatMap((f) => Object.keys(f)))];
  const encabezado = columnas.map((c) => `<th>${esc(c)}</th>`).join('');
  const cuerpo = filas
    .map(
      (f) =>
        '<tr>' +
        columnas
          .map((c) =>
            f[c] === null || f[c] === undefined
              ? '<td class="nulo">vacío</td>'
              : `<td>${esc(typeof f[c] === 'object' ? JSON.stringify(f[c]) : f[c])}</td>`,
          )
          .join('') +
        '</tr>',
    )
    .join('');
  return `<div class="tabla-envoltorio"><table><thead><tr>${encabezado}</tr></thead><tbody>${cuerpo}</tbody></table></div>`;
}

// ── SQL ────────────────────────────────────────────────────────────────────
function pintarZonaSql(servicio) {
  const zona = $('#zona-sql');
  zona.innerHTML = servicio.sql
    .map((b) => {
      const r = (estado.sql[servicio.id] || {})[b.id];
      const sqlMostrado = r ? r.sql : sustituir(b.query, estado.payloads[servicio.id] || {});
      let salida = '';
      if (r && r.error) salida = `<div class="sql-error">${esc(r.error)}</div>`;
      else if (r)
        salida = r.filas.length
          ? tablaDe(r.filas)
          : '<div class="sql-vacio">La consulta no devolvió ningún renglón todavía.</div>';
      return `<div class="bloque-sql">
        <div class="sql-titulo">${esc(b.titulo)}</div>
        <div class="sql-desc">${esc(b.descripcion)}</div>
        <pre class="sql">${resaltarSql(sqlMostrado)}</pre>
        <div class="sql-acciones">
          <button class="boton secundario" data-sql="${b.id}">Ejecutar consulta</button>
          <span class="nota-pie">${esc(
            b.base === 'bcb' ? 'Base de datos de BCB · fuente principal' : 'Base del satélite TomTom',
          )}</span>
        </div>
        ${salida}
      </div>`;
    })
    .join('');

  zona.querySelectorAll('[data-sql]').forEach((boton) =>
    boton.addEventListener('click', () => {
      const bloque = servicio.sql.find((b) => b.id === boton.dataset.sql);
      boton.disabled = true;
      boton.textContent = 'Consultando…';
      correrSql(servicio, bloque);
    }),
  );
}

const sustituir = (plantilla, valores) =>
  plantilla.replace(/\{\{(\w+)\}\}/g, (_, k) => (valores[k] === undefined || valores[k] === null ? 'NULL' : valores[k]));

async function correrSql(servicio, bloque) {
  const salida = await postJson('/api/sql', {
    base: bloque.base,
    sql: bloque.query,
    valores: estado.payloads[servicio.id] || {},
  }).catch((e) => ({ error: String(e), filas: [], sql: bloque.query }));

  estado.sql[servicio.id] = { ...(estado.sql[servicio.id] || {}), [bloque.id]: salida };
  if (estado.pestana === servicio.id) pintarZonaSql(servicio);
}

// ── Modales de detalle ─────────────────────────────────────────────────────
function abrirModal(id, titulo, cuerpo) {
  if (titulo) $('#titulo-detalle').textContent = titulo;
  $('#cuerpo-detalle').innerHTML = cuerpo;
  $(id).hidden = false;
}

const seccion = (titulo, contenido) => `<div class="seccion-detalle"><h4>${esc(titulo)}</h4>${contenido}</div>`;

function abrirDetalleHttp(paso) {
  const h = paso.http;
  const partes = [
    seccion('Petición', `<pre class="json">${esc(h.metodo)} ${esc(h.url)}\n\n${resaltarJson(h.headers)}</pre>`),
  ];
  if (h.request) partes.push(seccion('Datos enviados', `<pre class="json">${resaltarJson(h.request)}</pre>`));
  partes.push(
    seccion(
      `Respuesta · HTTP ${h.status || 'sin respuesta'} · ${h.ms} ms`,
      `<pre class="json">${h.response === null ? esc(h.error || '(sin cuerpo)') : resaltarJson(h.response)}</pre>`,
    ),
  );
  abrirModal('#modal-detalle', 'Detalle de la llamada', partes.join(''));
}

function abrirDetalleNats(nats) {
  const partes = [
    `<div class="res-nota" style="margin-bottom:18px">Los eventos entre BCB y BIGER no son llamadas HTTP: son mensajes.
     Éste es el que se publicó, con el mismo formato que emite BCB en producción.</div>`,
    seccion(`Subject · ${esc(nats.subject)}`, `<pre class="json">${resaltarJson(nats.request)}</pre>`),
  ];
  if (nats.error) partes.push(seccion('Error al publicar', `<div class="sql-error">${esc(nats.error)}</div>`));
  abrirModal('#modal-detalle', 'Mensaje publicado', partes.join(''));
}

function abrirDetalleInroute(r) {
  const partes = [
    `<div class="res-nota" style="margin-bottom:18px">Éste es el intercambio exacto entre el satélite e InRoute, en el
     formato del proveedor: nombres con prefijo (<code>cClaveERP</code>, <code>nHoraSalidaPlaneada</code>), fechas
     <code>dd/mm/yyyy</code> y horas en minutos desde la medianoche.</div>`,
    seccion(
      `Lo que el satélite le pidió a InRoute — ${esc(r.metodo)} ${esc(r.ruta)}`,
      `<pre class="json">${resaltarJson(r.payloadEnviado ?? r.query ?? {})}</pre>`,
    ),
  ];
  if (r.reenvio) {
    partes.push(
      seccion(
        `Reenviado al InRoute REAL — ${esc(r.reenvio.url)}`,
        r.reenvio.error
          ? `<div class="sql-error">${esc(r.reenvio.error)}</div>`
          : `<pre class="json">HTTP ${r.reenvio.status} · ${r.reenvio.ms} ms\n\n${resaltarJson(r.reenvio.body)}</pre>`,
      ),
    );
  }
  partes.push(seccion('Respuesta que recibió el satélite', `<pre class="json">${resaltarJson(r.respuesta.body)}</pre>`));
  abrirModal('#modal-detalle', r.modo === 'real' ? 'Intercambio con InRoute REAL' : 'Intercambio con InRoute simulado', partes.join(''));
}

// ── Configuración ──────────────────────────────────────────────────────────
function abrirConfig() {
  const c = estado.config;
  $('#cuerpo-config').innerHTML = `
    <div class="grupo-config">
      <h4>Destino de las llamadas a InRoute</h4>
      <div class="desc">El satélite siempre le habla a este panel; acá se decide qué hacer con esas llamadas.
        Conmutar no reinicia ningún servicio.</div>
      <div class="interruptor">
        <button data-modo="simulado" class="${c.inroute.modo === 'simulado' ? 'activa' : ''}">
          <span class="t">Simulado</span><span class="s">Respondemos nosotros. No sale nada a internet.</span>
        </button>
        <button data-modo="real" class="${c.inroute.modo === 'real' ? 'activa peligrosa' : ''}">
          <span class="t">InRoute REAL</span><span class="s">Se registra de verdad en Adsum.</span>
        </button>
      </div>
      <div class="campo"><label>URL base de InRoute</label><input id="cfg-url" value="${esc(c.inroute.url)}" /></div>
      <div class="campo"><label>Usuario (HTTP Basic)</label><input id="cfg-usuario" value="${esc(c.inroute.usuario)}" /></div>
      <div class="campo"><label>Contraseña</label><input id="cfg-password" type="password" value="${esc(c.inroute.password)}" /></div>
    </div>

    <div class="grupo-config">
      <h4>Direcciones de los servicios</h4>
      <div class="desc">Por defecto apuntan al entorno local que levanta <code>./e2e up tomtom</code>.</div>
      <div class="campo"><label>Satélite TomTom</label><input id="cfg-satelite" value="${esc(c.satelite)}" /></div>
      <div class="campo"><label>adapter-tomtom</label><input id="cfg-adapter-tt" value="${esc(c.adapterTomtom)}" /></div>
      <div class="campo"><label>adapter-bcb</label><input id="cfg-adapter-bcb" value="${esc(c.adapterBcb)}" /></div>
    </div>

    <div class="acciones"><button class="boton" id="cfg-guardar">Guardar</button></div>`;

  $('#cuerpo-config')
    .querySelectorAll('[data-modo]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        estado.config.inroute.modo = b.dataset.modo;
        abrirConfig();
      }),
    );

  $('#cfg-guardar').addEventListener('click', async () => {
    estado.config = await postJson('/api/config', {
      satelite: $('#cfg-satelite').value.trim(),
      adapterTomtom: $('#cfg-adapter-tt').value.trim(),
      adapterBcb: $('#cfg-adapter-bcb').value.trim(),
      inroute: {
        modo: estado.config.inroute.modo,
        url: $('#cfg-url').value.trim(),
        usuario: $('#cfg-usuario').value.trim(),
        password: $('#cfg-password').value,
      },
    });
    $('#modal-config').hidden = true;
    pintarSemaforos();
    pintar();
  });

  $('#modal-config').hidden = false;
}

// ── Pintado general ────────────────────────────────────────────────────────
function pintar() {
  const cont = $('#contenido');

  if (estado.pestana === 'panorama') {
    cont.innerHTML = vistaPanorama();
    cont.querySelectorAll('[data-ir]').forEach((el) =>
      el.addEventListener('click', () => {
        estado.pestana = el.dataset.ir;
        pintarPestanas();
        pintar();
        window.scrollTo({ top: 0 });
      }),
    );
    const boton = $('#btn-nuevo-panorama');
    if (boton) boton.addEventListener('click', () => nuevaCorrida(boton));
    return;
  }

  const servicio = estado.servicios.find((s) => s.id === estado.pestana);
  if (!servicio) {
    estado.pestana = 'panorama';
    return pintar();
  }

  cont.innerHTML = vistaServicio(servicio);
  pintarCampos(servicio);
  conectarEditorJson(servicio);
  pintarResultado(servicio);
  pintarZonaSql(servicio);

  $('#btn-ejecutar').addEventListener('click', () => ejecutar(servicio));
  $('#btn-nuevo').addEventListener('click', () => nuevaCorrida($('#btn-nuevo')));
  cont.querySelectorAll('[data-entrada]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.entradas[servicio.id] = b.dataset.entrada;
      pintar();
    }),
  );
}

async function nuevaCorrida(boton) {
  if (boton) {
    boton.disabled = true;
    boton.textContent = 'Creando la corrida…';
  }
  const salida = await api('/api/escenario').catch((e) => ({ error: String(e) }));
  if (salida.error) {
    if (boton) {
      boton.disabled = false;
      boton.textContent = 'Generar corrida nueva';
    }
    const nota = $('#nota-nuevo') || $('#nota-ejecucion');
    if (nota) nota.textContent = `No se pudo crear la corrida: ${salida.error}`;
    return;
  }
  estado.escenario = salida.escenario;
  estado.payloads = { ...estado.payloads, ...salida.payloads };
  estado.resultados = {};
  estado.sql = {};
  pintar();
}

// ── Arranque ───────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-cerrar]') || e.target.classList.contains('modal-fondo')) {
    document.querySelectorAll('.modal-fondo').forEach((m) => (m.hidden = true));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-fondo').forEach((m) => (m.hidden = true));
});
$('#btn-config').addEventListener('click', abrirConfig);

iniciar();
