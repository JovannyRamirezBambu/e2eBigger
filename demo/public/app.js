/* Panel de demostración de Venta a Bordo — frontend sin dependencias.
   Todo el trabajo real lo hace `demo/server.cjs`; acá solo se pinta. */

const estado = {
  servicios: [],
  escenario: null,
  /** Payload editable por servicio; se conserva al cambiar de pestaña. */
  payloads: {},
  /** Punto de entrada elegido (solo el Servicio 1 tiene más de uno). */
  entradas: { ws1: 'bcb' },
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
  /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|ON|GROUP BY|ORDER BY|AND|OR|AS|COUNT|COALESCE|INTERVAL|DATE_TRUNC|NOW|NULL|IS|NOT|LIMIT|WITH)\b/gi;

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
  const real = estado.config && estado.config.smartmac.modo === 'real';
  $('#aviso-real').hidden = !real;
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
    ? '<div class="nota-pie">La respuesta regresa por el mismo camino, en sentido inverso, hasta el equipo a bordo.</div>'
    : '';

  return `<div class="diagrama">${partes.join('')}</div><div class="pasos-diagrama">${pasos}${vuelta}</div>`;
}

const etiquetaTipo = (tipo) =>
  ({ tercero: 'TECNITRANS', bcb: 'BCB', biger: 'BIGER', satelite: 'Satélite', infra: 'Interno', bd: 'Datos' })[tipo] ||
  tipo;

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
      <h1>Los 3 servicios del satélite Venta a Bordo</h1>
      <p class="resumen">
        Venta a Bordo es el puente entre <b>BCB</b>, el sistema central de Estrella Roja, y
        <b>SmartMac</b>, el equipo que TECNITRANS instala en las unidades. No tiene pantallas
        propias: su único trabajo es que los datos del viaje lleguen íntegros de un lado al otro.
      </p>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>El ciclo de una corrida</h3></div>
      <div class="tarjeta-cuerpo">
        <div class="parrafos" style="margin-bottom:22px">
          <p>Una corrida sale de la terminal y BIGER le entrega su <strong>tarjeta de viaje</strong> al
          equipo a bordo (Servicio 1). Durante el trayecto se venden boletos. Al cerrar la corrida,
          el equipo reporta <strong>todo lo que vendió</strong> y eso queda guardado en BCB (Servicio 2).
          En cualquier momento —si el equipo se reinicia, cambia de operador o perdió un despacho—
          puede <strong>volver a preguntar</strong> qué corridas tiene hoy y cómo va cada tarjeta (Servicio 3).</p>
        </div>
        <div class="ciclo">${tarjetas}</div>
      </div>
    </div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Cómo usar este panel</h3></div>
      <div class="tarjeta-cuerpo">
        <ul class="reglas">
          <li>Cada pestaña es un servicio: primero <strong>qué hace</strong> en palabras, después el
              <strong>camino que recorren los datos</strong>, y al final se puede <strong>ejecutar de verdad</strong>.</li>
          <li>Los datos que se envían son <strong>editables</strong>. El botón <em>Generar corrida nueva</em> arma
              una corrida con folios frescos para que dos ejecuciones seguidas nunca choquen.</li>
          <li>Después de ejecutar, el bloque <strong>Validar en base de datos</strong> corre el SQL a la vista y
              muestra el renglón tal como quedó guardado — sobre todo en BCB, que es la fuente principal.</li>
          <li>En <strong>Configuración</strong> se puede conmutar entre el SmartMac simulado y el
              <strong>SmartMac real de TECNITRANS</strong>, sin reiniciar nada.</li>
        </ul>
      </div>
    </div>`;
}

// ── Vista: un servicio ─────────────────────────────────────────────────────
function vistaServicio(servicio) {
  const resultado = estado.resultados[servicio.id];
  const avance = resultado ? resultado.avance : -1;

  return `
    <div class="encabezado-servicio">
      <div class="eyebrow">Servicio ${servicio.numero} · ${esc(servicio.alias)}</div>
      <h1>${esc(servicio.nombre)}</h1>
      <p class="resumen">${esc(servicio.resumen)}</p>
      <div class="fichas">
        <span class="ficha metodo"><b>${servicio.metodo}</b> ${esc(servicio.ruta)}</span>
        <span class="ficha">Lo llama <b>${esc(servicio.quienLlama)}</b></span>
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
        <h3>Datos que se envían</h3>
        <button class="boton secundario" id="btn-nuevo">Generar corrida nueva</button>
      </div>
      <div class="tarjeta-cuerpo">
        ${servicio.entradas ? selectorEntrada(servicio) : ''}
        <div class="rejilla-campos" id="rejilla"></div>
        <details style="margin-top:20px">
          <summary style="cursor:pointer;font-size:13.5px;color:var(--tinta-suave)">Ver y editar el cuerpo completo (JSON)</summary>
          <textarea class="json" id="editor-json" spellcheck="false"></textarea>
          <div class="nota-pie" id="aviso-json"></div>
        </details>
        <div class="acciones" style="margin-top:22px">
          <button class="boton ${modoReal() ? 'peligro' : ''}" id="btn-ejecutar">
            ${esc(textoBoton(servicio))}
          </button>
          <span class="nota-pie" id="nota-ejecucion"></span>
        </div>
      </div>
    </div>

    <div id="zona-resultado"></div>

    <div class="tarjeta">
      <div class="tarjeta-cabecera"><h3>Validar en base de datos</h3></div>
      <div class="tarjeta-cuerpo" id="zona-sql"></div>
    </div>`;
}

const modoReal = () => estado.config && estado.config.smartmac.modo === 'real';

function textoBoton(servicio) {
  if (servicio.id === 'ws1') return modoReal() ? 'Despachar hacia SmartMac REAL' : 'Despachar la corrida';
  if (servicio.id === 'ws2') return 'Enviar la venta como lo hace SmartMac';
  return 'Consultar las corridas del operador';
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
  const payload = estado.payloads[servicio.id];
  $('#rejilla').innerHTML = servicio.campos
    .map(
      (c) =>
        `<div class="campo"><label>${esc(c.label)}<span class="ayuda">${esc(c.doc)}</span></label>` +
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
    editor.value = JSON.stringify(estado.payloads[servicio.id], null, 2);
    editor.classList.remove('invalido');
    $('#aviso-json').textContent = '';
  }
}

function conectarEditorJson(servicio) {
  const editor = $('#editor-json');
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
  const payload = estado.payloads[servicio.id];
  $('#rejilla')
    .querySelectorAll('[data-campo]')
    .forEach((input) => {
      const valor = payload[input.dataset.campo];
      if (String(valor ?? '') !== input.value) input.value = valor ?? '';
    });
}

// ── Ejecución ──────────────────────────────────────────────────────────────
async function ejecutar(servicio) {
  if (estado.ejecutando[servicio.id]) return;
  estado.ejecutando[servicio.id] = true;

  const boton = $('#btn-ejecutar');
  boton.disabled = true;
  boton.textContent = 'Ejecutando…';
  $('#nota-ejecucion').textContent =
    servicio.id === 'ws2'
      ? 'El viaje hasta BCB es asíncrono; puede tardar unos segundos.'
      : 'Siguiendo el recorrido paso a paso…';

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
  }).catch((e) => ({ pasos: [{ titulo: 'No se pudo contactar al panel', error: true, nota: String(e) }] }));

  clearInterval(animacion);
  salida.avance = salida.pasos.some((p) => p.error) ? -1 : servicio.actores.length;
  estado.resultados[servicio.id] = salida;
  estado.ejecutando[servicio.id] = false;

  $('#zona-diagrama').innerHTML = pintarDiagrama(servicio, salida.avance);
  boton.disabled = false;
  boton.textContent = textoBoton(servicio);
  $('#nota-ejecucion').textContent = `Tomó ${(salida.ms / 1000).toFixed(1)} s`;
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
      const mal = !!p.error || (p.http && !p.http.ok);
      const partes = [
        `<div class="res-titulo"><span class="marca-estado ${mal ? 'mal' : 'ok'}">${mal ? '!' : '✓'}</span>${esc(p.titulo)}</div>`,
      ];
      if (p.nota) partes.push(`<div class="res-nota">${esc(p.nota)}</div>`);
      if (p.semaforo)
        partes.push(`<div class="semaforo-grande ${p.semaforo}"><span class="punto"></span>${p.semaforo}</div>`);
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
      if (p.smartmac) {
        partes.push(
          `<div class="linea-http" data-smartmac="${i}">` +
            `<span class="metodo">POST</span>` +
            `<span class="url">${esc(p.smartmac.reenvio ? p.smartmac.reenvio.url : `SmartMac simulado · ${p.smartmac.path}`)}</span>` +
            `<span class="pastilla ${p.smartmac.respuesta.status < 400 ? 'ok' : 'mal'}">${p.smartmac.respuesta.status}</span>` +
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
  zona.querySelectorAll('[data-smartmac]').forEach((el) =>
    el.addEventListener('click', () => abrirDetalleSmartmac(salida.pasos[Number(el.dataset.smartmac)].smartmac)),
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
      const sqlMostrado = r ? r.sql : sustituir(b.query, estado.payloads[servicio.id]);
      let salida = '';
      if (r && r.error) salida = `<div class="sql-error">${esc(r.error)}</div>`;
      else if (r) salida = r.filas.length ? tablaDe(r.filas) : '<div class="sql-vacio">La consulta no devolvió ningún renglón todavía.</div>';
      return `<div class="bloque-sql">
        <div class="sql-titulo">${esc(b.titulo)}</div>
        <div class="sql-desc">${esc(b.descripcion)}</div>
        <pre class="sql">${resaltarSql(sqlMostrado)}</pre>
        <div class="sql-acciones">
          <button class="boton secundario" data-sql="${b.id}">Ejecutar consulta</button>
          <span class="nota-pie">${esc(b.base === 'bcb' ? 'Base de datos de BCB · fuente principal' : 'Base del satélite Venta a Bordo')}</span>
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
    valores: estado.payloads[servicio.id],
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

const seccion = (titulo, contenido) =>
  `<div class="seccion-detalle"><h4>${esc(titulo)}</h4>${contenido}</div>`;

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

function abrirDetalleSmartmac(sm) {
  const partes = [
    `<div class="res-nota" style="margin-bottom:18px">Éste es el cuerpo exacto que el satélite le entrega a SmartMac, ya traducido al formato de TECNITRANS (nombres en español, identificadores numéricos).</div>`,
    seccion('Lo que se envió a SmartMac', `<pre class="json">${resaltarJson(sm.payloadEnviado)}</pre>`),
  ];
  if (sm.reenvio) {
    partes.push(
      seccion(
        `Reenviado al SmartMac REAL — ${esc(sm.reenvio.url)}`,
        sm.reenvio.error
          ? `<div class="sql-error">${esc(sm.reenvio.error)}</div>`
          : `<pre class="json">HTTP ${sm.reenvio.status} · ${sm.reenvio.ms} ms\n\n${resaltarJson(sm.reenvio.body)}</pre>`,
      ),
    );
  }
  partes.push(seccion('Respuesta que recibió el satélite', `<pre class="json">${resaltarJson(sm.respuesta.body)}</pre>`));
  abrirModal('#modal-detalle', sm.modo === 'real' ? 'Envío al SmartMac REAL' : 'Envío al SmartMac simulado', partes.join(''));
}

// ── Configuración ──────────────────────────────────────────────────────────
function abrirConfig() {
  const c = estado.config;
  $('#cuerpo-config').innerHTML = `
    <div class="grupo-config">
      <h4>Destino de las tarjetas de viaje (Servicio 1)</h4>
      <div class="desc">El satélite siempre entrega la tarjeta a este panel; acá se decide qué hacer con ella.
        Conmutar no reinicia ningún servicio.</div>
      <div class="interruptor">
        <button data-modo="simulado" class="${c.smartmac.modo === 'simulado' ? 'activa' : ''}">
          <span class="t">Simulado</span><span class="s">Respondemos nosotros. No sale nada a internet.</span>
        </button>
        <button data-modo="real" class="${c.smartmac.modo === 'real' ? 'activa peligrosa' : ''}">
          <span class="t">SmartMac REAL</span><span class="s">Se envía de verdad a TECNITRANS.</span>
        </button>
      </div>
      <div class="campo"><label>URL de SmartMac</label><input id="cfg-url" value="${esc(c.smartmac.url)}" /></div>
      <div class="campo"><label>Usuario (HTTP Basic)</label><input id="cfg-usuario" value="${esc(c.smartmac.usuario)}" /></div>
      <div class="campo"><label>Contraseña</label><input id="cfg-password" type="password" value="${esc(c.smartmac.password)}" /></div>
    </div>

    <div class="grupo-config">
      <h4>Credencial entrante (Servicios 2 y 3)</h4>
      <div class="desc">La que SmartMac usa para llamarnos. El panel la manda en cada petición de estos dos servicios.</div>
      <div class="campo"><label>Usuario</label><input id="cfg-in-usuario" value="${esc(c.smartmacEntrante.usuario)}" /></div>
      <div class="campo"><label>Contraseña</label><input id="cfg-in-password" type="password" value="${esc(c.smartmacEntrante.password)}" /></div>
    </div>

    <div class="grupo-config">
      <h4>Direcciones de los servicios</h4>
      <div class="desc">Por defecto apuntan al entorno local que levanta <code>./e2e up ventaabordo</code>.</div>
      <div class="campo"><label>Satélite Venta a Bordo</label><input id="cfg-satelite" value="${esc(c.satelite)}" /></div>
      <div class="campo"><label>adapter-bcb</label><input id="cfg-adapter" value="${esc(c.adapterBcb)}" /></div>
    </div>

    <div class="acciones"><button class="boton" id="cfg-guardar">Guardar</button></div>`;

  $('#cuerpo-config')
    .querySelectorAll('[data-modo]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        estado.config.smartmac.modo = b.dataset.modo;
        abrirConfig();
      }),
    );

  $('#cfg-guardar').addEventListener('click', async () => {
    estado.config = await postJson('/api/config', {
      satelite: $('#cfg-satelite').value.trim(),
      adapterBcb: $('#cfg-adapter').value.trim(),
      smartmac: {
        modo: estado.config.smartmac.modo,
        url: $('#cfg-url').value.trim(),
        usuario: $('#cfg-usuario').value.trim(),
        password: $('#cfg-password').value,
      },
      smartmacEntrante: {
        usuario: $('#cfg-in-usuario').value.trim(),
        password: $('#cfg-in-password').value,
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
  $('#btn-nuevo').addEventListener('click', nuevaCorrida);
  cont.querySelectorAll('[data-entrada]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.entradas[servicio.id] = b.dataset.entrada;
      pintar();
    }),
  );
}

async function nuevaCorrida() {
  const { escenario, payloads } = await api('/api/escenario');
  estado.escenario = escenario;
  // La consulta por operador lee del catálogo sembrado en BCB, no de una corrida
  // recién generada: si se pisara, el Servicio 3 dejaría de encontrar nada.
  for (const id of ['ws1', 'ws2']) estado.payloads[id] = payloads[id];
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
