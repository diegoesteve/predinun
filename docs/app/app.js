// Crecidas · la app para todos: el zorro gris te dice si viene agua a tu casa y a la de los tuyos, y qué hacer.
// Los datos salen de ../data/app.json (scripts/armar_app.py, cada 15 minutos). Nada de esto sale del celular salvo,
// si se activan los avisos, la dirección de push del navegador y el lugar elegido.
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ZONA = { cba: 'Córdoba', sf: 'Santa Fe' };
const nom = x => (x && (x.nom || x.n)) || '';   // nombre para mostrar (con tildes)

// Preferencias en el celular (si el navegador no deja guardar, la app igual funciona)
const PREF = {
  get(k, d) { try { const v = localStorage.getItem('crecidas.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem('crecidas.' + k) : localStorage.setItem('crecidas.' + k, JSON.stringify(v)); } catch (e) { /* sin guardar */ } },
};

// Servicio de avisos al celular: el mismo de Piedrazón (Cloudflare), con el lugar como «crecidas:<zona>:<lugar>».
// Los avisos los manda piedrazon-codigo/scripts/notificar_crecidas.py cada 15 minutos. Vacío = no se ofrecen avisos.
const AVISOS = {
  url: 'https://piedrazon-avisos.predinun.workers.dev',
  clave: 'BBM77Qa6Tgc4JkqqKM4pPobW34_W4_DwOrYRXpxnI3ZTu12EQDAic8ETYQoSHoEne89qZFc-2pxLSkzptzSTcdU',   // clave pública VAPID
};
const claveAviso = sel => `crecidas:${sel.z}:${sel.n}`;

let DATOS = null;
const lugarDe = sel => sel && DATOS && DATOS.lugares.find(x => x.n === sel.n && x.z === sel.z);
let BARRIOS = null, EVENTOS = {};   // barrios de OpenStreetMap (se bajan al buscar) y lo que contaron los vecinos
async function cargarBarrios() {
  if (BARRIOS) return BARRIOS;
  try { BARRIOS = ((await (await fetch('../data/barrios.json')).json()).barrios || []).map(b => ({ b: b[0], n: b[1], z: b[2], la: b[3], lo: b[4] })); }
  catch (e) { BARRIOS = []; }
  return BARRIOS;
}

async function cargar() {
  try {
    const r = await fetch('../data/app.json?t=' + Date.now());
    if (!r.ok) throw new Error(r.status);
    DATOS = await r.json();
    try { EVENTOS = (await (await fetch('../data/barrios_eventos.json?t=' + Date.now())).json()) || {}; } catch (e) { EVENTOS = {}; }
  } catch (e) {
    $('#sin-datos').hidden = false;
    $('#sin-datos').textContent = 'No se pudieron cargar los datos. Revisá la conexión y volvé a abrir la app.';
    return;
  }
  // un link compartido trae el lugar: ?l=Unquillo&z=cba
  const q = new URLSearchParams(location.search);
  if (q.get('l')) {
    const x = DATOS.lugares.find(y => y.n === q.get('l') && (!q.get('z') || y.z === q.get('z')));
    if (x && !PREF.get('lugar', null)) PREF.set('lugar', { n: x.n, z: x.z, b: q.get('b') || null });
  }
  mostrar();
}

const VISTAS = ['hola', 'elegir', 'tuyos', 'lugar', 'agua', 'contar'];
function mostrar() {
  const x = lugarDe(PREF.get('lugar', null));
  const h = location.hash.slice(1);
  let v;
  if (h === 'elegir' || (!x && PREF.get('visto-hola', false))) v = 'elegir';
  else if (!x) v = 'hola';
  else v = ['contar', 'tuyos', 'agua'].includes(h) ? h : 'lugar';
  VISTAS.forEach(k => { $('#v-' + k).hidden = k !== v; });
  $('#barra').hidden = !(v === 'lugar' || v === 'agua');
  $('#n-hoy').toggleAttribute('aria-current', v === 'lugar');
  $('#n-agua').toggleAttribute('aria-current', v === 'agua');
  if (v === 'contar') prepararContar(x);
  else if (v === 'tuyos') pintarTuyosEditar();
  else if (v === 'agua') pintarAgua(x);
  else if (v === 'lugar') pintarLugar(x);
  else if (v === 'elegir') { $('#b-elegir-volver').hidden = false; }
  window.scrollTo(0, 0);
}
const ir = h => { if (location.hash.slice(1) === h) mostrar(); else location.hash = h; };
window.addEventListener('hashchange', () => { if (DATOS) mostrar(); });

// ---------------------------------------------------------------- elegir lugar
async function buscarLugares(texto) {
  const q = sinTildes(texto);
  if (q.length < 2) return null;
  const barrios = await cargarBarrios();
  const rango = t => { const n = sinTildes(t); return n.startsWith(q) ? 0 : (' ' + n).includes(' ' + q) ? 1 : 2; };
  return [
    ...DATOS.lugares.filter(x => sinTildes(x.n).includes(q)).map(x => ({ x, nombre: nom(x), r: rango(x.n), sub: `${ZONA[x.z]}${x.rio ? ' · ' + x.rio : ''}` })),
    ...barrios.filter(b => sinTildes(b.b).includes(q) || sinTildes(b.b + ' ' + b.n).includes(q)).map(b => ({ x: lugarDe(b), barrio: b, nombre: b.b, r: rango(b.b) + 0.5, sub: `Barrio de ${nom(lugarDe(b)) || b.n}` })),
  ].filter(o => o.x).sort((a, b) => a.r - b.r || a.nombre.localeCompare(b.nombre)).slice(0, 10);
}
async function mostrarResultados(entrada, lista, alElegir) {
  const texto = entrada.value.trim();
  const r = await buscarLugares(texto);
  if (entrada.value.trim() !== texto) return;   // ya escribió otra cosa
  if (!r) { lista.innerHTML = ''; return; }
  lista.innerHTML = r.length ? r.map((o, i) => `<li><button type="button" data-i="${i}"><span><b>${esc(o.nombre)}</b><br><small>${esc(o.sub)}</small></span><span aria-hidden="true">›</span></button></li>`).join('')
    : '<li><p class="nota" style="padding:14px 16px">No encontramos ese lugar. Por ahora están las sierras de Córdoba y la provincia de Santa Fe.</p></li>';
  lista.querySelectorAll('button').forEach(b => b.addEventListener('click', () => alElegir(r[b.dataset.i])));
}
const buscar = () => mostrarResultados($('#buscar'), $('#resultados'), o =>
  elegir(o.x, o.barrio ? { la: o.barrio.la, lo: o.barrio.lo, barrio: true } : null, o.barrio ? o.barrio.b : null));

function elegir(x, coords, barrio) {
  PREF.set('lugar', { n: x.n, z: x.z, b: barrio || null });
  PREF.set('coords', coords);
  $('#buscar').value = ''; $('#resultados').innerHTML = '';
  sincronizarAvisos();
  // la primera vez sigue el paso 2 (¿a quién más cuidás?); después, vuelve a Hoy
  if (!PREF.get('armado', false)) { history.replaceState(null, '', location.pathname + location.search); ir('tuyos'); }
  else { history.replaceState(null, '', location.pathname + location.search); mostrar(); }
}

const kmEntre = (a, b, c, d) => Math.hypot((a - c) * 111.3, (b - d) * 111.3 * Math.cos(a * Math.PI / 180));

function usarUbicacion() {
  const estado = $('#ubicacion-estado');
  if (!navigator.geolocation) { estado.textContent = 'Este celular no deja usar la ubicación. Escribí tu pueblo abajo.'; return; }
  estado.textContent = 'Buscando dónde estás…';
  navigator.geolocation.getCurrentPosition(p => {
    const la = p.coords.latitude, lo = p.coords.longitude;
    const cerca = DATOS.lugares.map(x => ({ x, d: kmEntre(la, lo, x.la, x.lo) })).sort((a, b) => a.d - b.d)[0];
    if (!cerca || cerca.d > 30) { estado.textContent = 'No tenemos datos para donde estás. Por ahora: sierras de Córdoba y provincia de Santa Fe.'; return; }
    estado.textContent = '';
    elegir(cerca.x, { la: +la.toFixed(5), lo: +lo.toFixed(5) });
  }, () => { estado.textContent = 'No pudimos saber dónde estás. Escribí tu pueblo abajo.'; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 600000 });
}

// ---------------------------------------------------------------- hoy y mañana
const NIVEL = ['Tranquilo', 'Atención', 'Alerta', 'Peligro'];
const ZORRO = ['tranquilo', 'atencion', 'alerta', 'peligro'].map(n => `zorro/${n}.png`);
const ZORRO_ALT = ['tranquilo', 'atento', 'en alerta', 'en peligro'].map(t => `El zorro gris, ${t}`);
const peorDe = x => Math.max(x.hoy.nivel, x.man.nivel);

const HACER = {
  sierras: {
    alto: ['No cruces vados ni badenes, ni a pie ni en auto.', 'Alejate de la orilla del arroyo y no acampes cerca.', 'Si el agua sube o se pone marrón, subí a un lugar alto.'],
    medio: ['Mirá el cielo y seguí los avisos de la app.', 'Si llueve fuerte, no cruces vados ni te quedes en la orilla.'],
    nada: ['Tené a mano el número de Defensa Civil: 103.', 'Si vivís cerca del arroyo, pensá a dónde ir si crece.'],
  },
  ciudad: {
    alto: ['Subí a lo alto lo que no se puede mojar: documentos, remedios, electrodomésticos.', 'Limpiá la vereda y las rejillas, y no dejes el auto en calles que se inundan.', 'No camines ni manejes por calles con agua corriendo: arrastra más de lo que parece.'],
    medio: ['Limpiá la vereda y las rejillas para que corra el agua.', 'No dejes el auto en calles que se anegan.'],
    nada: ['Tené a mano el número de Defensa Civil: 103.'],
  },
  llanura: {
    alto: ['Subí a lo alto documentos, remedios y lo que no se puede mojar.', 'Cargá el celular y tené a mano una linterna.', 'Si tenés que salir, avisá a un vecino y seguí las indicaciones de Protección Civil.'],
    medio: ['Limpiá la vereda y las rejillas para que corra el agua.', 'No dejes el auto en calles que se anegan.', 'Seguí los avisos de la app.'],
    nada: ['Tené a mano el número de Protección Civil: 103.', 'Si tu calle se anega seguido, guardá lo importante en alto.'],
  },
};

// Lo que contaron los vecinos del barrio: si la lluvia prevista llega a la que ya lo inundó, el día sube a «alerta»
function conBarrio(x, b) {
  const ev = b && EVENTOS[`${x.z}:${x.n}:${b}`];
  if (!ev || !ev.umbral_mm || !x.mm) return { x, ev };
  const y = { ...x };
  const fecha = f => f.slice(8, 10) + '/' + f.slice(5, 7) + '/' + f.slice(0, 4);
  const ref = ev.eventos.find(e => e.lluvia_mm) || ev.eventos[0];
  ['hoy', 'man'].forEach((dia, i) => {
    const mm = x.mm[i] || 0;
    if (mm >= ev.umbral_mm && y[dia].nivel < 2) {
      y[dia] = { nivel: 2, titulo: 'Tu barrio ya se inundó con lluvias así',
                 texto: `Se esperan unos ${Math.round(mm)} mm ${dia === 'hoy' ? 'hoy' : 'mañana'}. El ${fecha(ref.fecha)} el barrio se inundó con unos ${Math.round(ref.lluvia_mm || 0)} mm, según contaron los vecinos.`,
                 tambien: x[dia].nivel ? x[dia].titulo : null };
    }
  });
  return { x: y, ev };
}

function pintarVecinos(x, b, ev) {
  const caja = $('#l-vecinos');
  const fecha = f => f.slice(8, 10) + '/' + f.slice(5, 7) + '/' + f.slice(0, 4);
  caja.innerHTML = (ev && ev.eventos.length
    ? `<h2>Lo que contaron los vecinos</h2><ul class="eventos">${ev.eventos.slice(0, 5).map(e => `<li><b>${fecha(e.fecha)}</b>${e.lluvia_mm ? ` · llovieron unos ${Math.round(e.lluvia_mm)} mm` : ''}${e.que ? `<br>${esc(e.que)}` : ''}</li>`).join('')}</ul>`
      + (ev.umbral_mm ? `<p class="nota" style="color:inherit">Si se esperan ${ev.umbral_mm} mm o más, te avisamos que tu barrio ya se inundó con lluvias así.</p>` : '')
    : `<h2>¿Se inundó ${b ? 'tu barrio' : 'tu calle o tu barrio'} alguna vez?</h2><p class="nota" style="color:inherit">Contanos cuándo y hasta dónde llegó el agua. Con eso aprendemos con cuánta lluvia se inunda cada barrio y podemos avisar antes.</p>`)
    + `<button type="button" class="boton chico" id="b-contar" style="align-self:flex-start">${ev && ev.eventos.length ? 'Contar otra vez que se inundó' : 'Contalo'}</button>`;
  $('#b-contar').addEventListener('click', () => ir('contar'));
}

// ---------------------------------------------------------------- lugar alto de referencia (scripts/lugares_altos.py)
const slugLugar = t => sinTildes(t).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function pintarAlto(x, b, peor, caja = $('#a-alto')) {
  caja.hidden = true;
  let datos = null;
  try { const r = await fetch(`../data/altos/${x.z}/${slugLugar(x.n)}.json`); if (r.ok) datos = await r.json(); } catch (e) { /* sin datos */ }
  const v = datos && ((b && datos[b]) || datos['']);
  if (!v) return;
  const agua = x.tipo === 'sierras' ? 'del arroyo' : 'del río o el canal';
  // La altura del propio barrio no se muestra: el relieve satelital falla en islas y bañados (Alto Verde da 10 m) y podría tranquilizar de más.
  const propio = '';
  caja.className = 'caja oscura';
  caja.hidden = false;
  if (!v.d) {
    caja.innerHTML = `<h2>A dónde ir</h2>${propio}<p class="nota">No encontramos un lugar público alto a menos de 3 km. Preguntá en tu municipio cuál es el centro de evacuación.</p>`;
    return;
  }
  const d = v.d;
  const ruta = `https://www.google.com/maps/dir/?api=1&destination=${d.la},${d.lo}&travelmode=walking`;
  caja.innerHTML = `<h2>A dónde ir</h2>
    <p class="nota">Lugar alto más cercano:</p>
    <p class="alto-destino">${esc(d.n)}</p>
    <p class="nota">${esc(d.t.charAt(0).toUpperCase() + d.t.slice(1))} a unos ${d.m >= 1000 ? (d.m / 1000).toFixed(1).replace('.', ',') + ' km' : d.m + ' m'} hacia el ${esc(d.r)}, unos ${Math.round(d.h)} m por encima ${agua} más cercano.</p>
    ${propio}
    <a class="boton claro" href="${ruta}" target="_blank" rel="noopener" style="align-self:flex-start">Cómo llegar</a>
    <p class="nota" style="font-size:13px">Es una referencia por el relieve, no un centro de evacuación oficial. Si Defensa Civil o Protección Civil indican otro lugar, andá ahí. Si el agua ya corre fuerte por la calle, no la cruces: subí a un lugar alto cerca.</p>`;
}

// ---------------------------------------------------------------- contar una inundación (mismo receptor que «Aportá»)
let fotosContar = [], puntoContar = null, widgetContar = null;
function prepararContar(x) {
  const sel = PREF.get('lugar', null) || {};
  const f = $('#f-contar');
  f.elements.localidad.value = nom(x);
  f.elements.barrio.value = sel.b || '';
  $('#c-lugar').textContent = sel.b ? `Barrio ${sel.b}, ${nom(x)}` : nom(x);
  $('#c-estado').textContent = '';
  const cfgA = window.PREDINUN || {};
  if (!cfgA.aportesUrl || !cfgA.turnstileSitekey) { $('#c-estado').textContent = 'El envío todavía no está activo.'; $('#c-enviar').disabled = true; return; }
  if (widgetContar == null && !window.turnstile) {
    window.onTurnstileApp = () => { widgetContar = window.turnstile.render('#c-turnstile', { sitekey: cfgA.turnstileSitekey, language: 'es' }); };
    const sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileApp&render=explicit';
    sc.async = true; document.head.appendChild(sc);
  }
}
function achicarFoto(archivo) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? ok(b) : mal(new Error('no se pudo procesar')), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('formato no soportado')); };
    img.src = url;
  });
}
$('#c-fotos').addEventListener('change', async ev => {
  fotosContar = []; $('#c-vista').innerHTML = '';
  for (const a of [...ev.target.files].slice(0, 3)) {
    try { const b = await achicarFoto(a); fotosContar.push(b); const i = document.createElement('img'); i.src = URL.createObjectURL(b); i.alt = 'Foto elegida'; $('#c-vista').appendChild(i); }
    catch (e) { $('#c-estado').textContent = 'No se pudo usar una de las fotos. Probá con otra.'; }
  }
});
$('#c-ubicacion').addEventListener('click', () => navigator.geolocation && navigator.geolocation.getCurrentPosition(p => {
  puntoContar = { lat: p.coords.latitude, lon: p.coords.longitude };
  $('#c-punto').textContent = 'Listo: marcamos dónde estás.';
}, () => { $('#c-punto').textContent = 'No pudimos saber dónde estás.'; }, { enableHighAccuracy: true, timeout: 15000 }));
$('#f-contar').elements.relato.addEventListener('input', e => {
  const n = e.target.value.trim().length;
  $('#c-largo').textContent = n < 20 ? `Escribí al menos 20 letras (van ${n}).` : 'Gracias, con eso alcanza. Si querés, contá más.';
});
$('#f-contar').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target, estado = $('#c-estado'), boton = $('#c-enviar'), cfgA = window.PREDINUN || {};
  const fd = new FormData(f);
  if (String(fd.get('relato') || '').trim().length < 20) { estado.textContent = 'Contanos un poco más qué pasó (al menos 20 letras).'; f.elements.relato.focus(); return; }
  if (!fd.get('fecha') && !String(fd.get('fecha_evento') || '').trim()) { estado.textContent = 'Decinos cuándo fue, aunque sea aproximado.'; return; }
  if (fd.get('acepto') !== 'si') { estado.textContent = 'Falta tildar que aceptás que se publique.'; return; }
  if (!fd.get('fecha_evento') && fd.get('fecha')) { const t = fd.get('fecha'); fd.set('fecha_evento', `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)}`); }
  const token = widgetContar != null && window.turnstile ? window.turnstile.getResponse(widgetContar) : '';
  if (!token) { estado.textContent = 'Esperá unos segundos a que termine la verificación y tocá Enviar de nuevo.'; return; }
  fd.set('cf-turnstile-response', token);
  fotosContar.forEach((b, i) => fd.append('fotos', b, `foto-${i + 1}.jpg`));
  if (puntoContar) { fd.set('lat', puntoContar.lat); fd.set('lon', puntoContar.lon); }
  boton.disabled = true; estado.textContent = 'Enviando…';
  try {
    const r = await fetch(cfgA.aportesUrl.replace(/\/$/, '') + '/aportes', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `error ${r.status}`);
    f.reset(); fotosContar = []; puntoContar = null; $('#c-vista').innerHTML = '';
    estado.innerHTML = '<b>¡Gracias!</b> Recibimos tu relato. Lo revisamos y, si está todo bien, en unos días aparece en tu barrio.';
  } catch (e) {
    estado.textContent = `No se pudo enviar: ${e.message}`;
  } finally {
    boton.disabled = false;
    if (window.turnstile && widgetContar != null) window.turnstile.reset(widgetContar);
  }
});
$('#b-volver').addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search); mostrar(); });

function pintarLugar(x0) {
  const sel = PREF.get('lugar', null) || {};
  const { x, ev } = conBarrio(x0, sel.b);
  $('#l-nombre').textContent = sel.b || nom(x);
  $('#l-zona').textContent = sel.b ? `Barrio de ${nom(x)}${nom(x) !== ZONA[x.z] ? ' · ' + ZONA[x.z] : ''}` : `${ZONA[x.z]}${x.rio ? ' · ' + x.rio : ''}`;
  const peor = peorDe(x);
  const primeroManana = x.man.nivel > x.hoy.nivel;
  pintarEstado(x, peor, primeroManana);
  pintarHacer(x, peor, primeroManana);
  pintarTuyosHoy();
  const texto = `${sel.b || nom(x)}: ${primeroManana ? 'mañana' : 'hoy'} ${((t => t.charAt(0).toLowerCase() + t.slice(1))((primeroManana ? x.man : x.hoy).titulo))}. El zorro gris avisa si viene agua a tu barrio:`;
  const enlace = new URL(`?l=${encodeURIComponent(x.n)}&z=${x.z}${sel.b ? '&b=' + encodeURIComponent(sel.b) : ''}`, location.href.split('?')[0].split('#')[0]).href;
  $('#b-whatsapp').href = 'https://wa.me/?text=' + encodeURIComponent(`${texto} ${enlace}`);
  // «Ver todos los datos» abre la zona y la localidad elegidas, no la portada de Córdoba
  $('#l-todo').href = `../mapa.html?localidad=${encodeURIComponent(x.n)}#${x.z === 'sf' ? 'santafe' : 'riesgo'}`;
  $('#l-fuente').textContent = `Datos de las ${DATOS.generado.slice(11)} del ${DATOS.generado.slice(8, 10)}/${DATOS.generado.slice(5, 7)}. ` +
    (x.tipo === 'sierras' ? 'Radar del OHMC, pronóstico de lluvia y alertas del SMN.' : 'Ríos del INA y Prefectura, pronóstico de lluvia y alertas del SMN.');
  pintarVecinos(x, sel.b, ev);
  pintarArroyo(x);
  pintarAvisos();
  pintarInstalar();
}

// El estado de tu casa: el zorro en su color, lo más importante primero
function pintarEstado(x, peor, primeroManana) {
  const d = primeroManana ? x.man : x.hoy;
  const man = DATOS.dia_manana ? `Mañana (${DATOS.dia_manana})` : 'Mañana';
  const cuando = peor ? (primeroManana ? ' mañana' : ' hoy') : '';
  const fila = (t, y) => `<li><span class="punto n${y.nivel}" aria-hidden="true"></span><span><b>${t}:</b> ${esc(y.titulo)}</span></li>`;
  $('#l-estado').className = 'estado n' + peor;
  $('#l-estado').innerHTML = `
    <div class="estado-arriba"><div><p class="nivel">${NIVEL[peor]}${cuando}</p><p class="sub">${esc(d.titulo)}</p></div>
      <img class="zorro" src="${ZORRO[peor]}" alt="${ZORRO_ALT[peor]}" width="92" height="92"></div>
    <p class="globo">${esc(d.texto)}${d.tambien ? ` También: ${esc(d.tambien)}.` : ''}${peor >= 2 ? ' <b>Si yo me muevo, vos también.</b>' : ''}</p>
    <ul class="dias-mini">${fila('Hoy', x.hoy)}${fila(man, x.man)}</ul>`;
}

// Qué hacer: con aviso, una lista para tildar (se guarda en el celular, por día); sin aviso, cómo prepararse
function pintarHacer(x, peor, primeroManana) {
  const caja = $('#l-hacer');
  const porBarrio = [x.hoy, x.man].some(d => d.titulo === 'Tu barrio ya se inundó con lluvias así');
  const tipo = porBarrio ? 'ciudad' : x.tipo;
  if (peor < 2) {
    const lista = HACER[tipo][peor === 1 ? 'medio' : 'nada'];
    caja.innerHTML = `<h2>${peor ? 'Qué hacer' : 'Para estar preparado'}</h2><ol>${lista.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`;
    return;
  }
  const tareas = [...HACER[tipo].alto];
  tuyosConEstado().filter(t => t.peor >= 2).forEach(t => tareas.push(`Llamá a ${t.nombre}: en ${t.donde} también hay ${NIVEL[t.peor].toLowerCase()}.`));
  const hecho = PREF.get('hecho', {});
  const clave = `${DATOS.hoy}:${x.z}:${x.n}`;
  const marcadas = hecho.clave === clave ? hecho.k : [];
  const n = marcadas.length;
  caja.innerHTML = `<h2 class="con-cuenta">${primeroManana ? 'Qué hacer hoy, para mañana' : 'Qué hacer hoy'} <span class="nota">${n} de ${tareas.length}</span></h2>
    <ul class="tildar">${tareas.map((t, i) => `<li><label><input type="checkbox" data-i="${i}"${marcadas.includes(i) ? ' checked' : ''}><span>${esc(t)}</span></label></li>`).join('')}</ul>`;
  caja.querySelectorAll('input').forEach(c => c.addEventListener('change', () => {
    const k = [...caja.querySelectorAll('input:checked')].map(e => +e.dataset.i);
    PREF.set('hecho', { clave, k });
    caja.querySelector('.con-cuenta .nota').textContent = `${k.length} de ${tareas.length}`;
  }));
}

// ---------------------------------------------------------------- los tuyos (familia y vecinos, solo en el celular)
const tuyos = () => PREF.get('tuyos', []) || [];
function tuyosConEstado() {
  return tuyos().map(t => {
    const x0 = lugarDe(t);
    if (!x0) return { ...t, peor: null };
    const { x } = conBarrio(x0, t.b);
    const peor = peorDe(x);
    return { ...t, x, peor, cuando: peor ? (x.man.nivel > x.hoy.nivel ? 'mañana' : 'hoy') : '', donde: t.b || nom(x0) };
  });
}
const inicial = t => esc((t.trim()[0] || '?').toUpperCase());
function pintarTuyosHoy() {
  const caja = $('#l-tuyos'), ls = tuyosConEstado();
  if (!ls.length) {
    caja.innerHTML = `<h2>Los tuyos</h2><p class="nota">¿Tenés familia o vecinos en otro barrio o pueblo? Agregalos y te muestro cómo están.</p>
      <a class="boton chico" href="#tuyos" style="align-self:flex-start">Agregar a alguien</a>`;
    return;
  }
  caja.innerHTML = `<h2 class="con-cuenta">Los tuyos <a href="#tuyos" class="nota">Editar</a></h2><ul class="tuyos">${ls.map(t => `
    <li><span class="avatar" aria-hidden="true">${inicial(t.nombre)}</span>
      <span class="quien"><b>${esc(t.nombre)}</b><br><span class="nota">${esc(t.donde)}</span></span>
      ${t.peor == null ? '<span class="nota">Sin datos</span>' : `<span class="chip n${t.peor}"><img src="${ZORRO[t.peor]}" alt="" width="22" height="22">${NIVEL[t.peor]}${t.peor ? ' ' + t.cuando : ''}</span>`}</li>`).join('')}</ul>`;
}
let enAlta = false;
function pintarTuyosEditar() {
  const primeraVez = !PREF.get('armado', false);   // primera vez: es el paso 2 de 2
  $('#t-puntos').hidden = !primeraVez;
  $('#t-listo').textContent = primeraVez ? 'Listo: activar los avisos' : 'Listo';
  $('#t-despues').hidden = !primeraVez;
  const ls = tuyos();
  $('#t-lista').innerHTML = ls.map((t, i) => `<li><span class="avatar" aria-hidden="true">${inicial(t.nombre)}</span>
    <span class="quien"><b>${esc(t.nombre)}</b><br><span class="nota">${esc(t.b || nom(lugarDe(t)) || t.n)}</span></span>
    <button type="button" class="redondo" data-i="${i}" aria-label="Quitar a ${esc(t.nombre)}">✕</button></li>`).join('');
  $('#t-lista').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const l = tuyos(); l.splice(+b.dataset.i, 1); PREF.set('tuyos', l); pintarTuyosEditar();
  }));
  $('#t-form').hidden = !enAlta;
  $('#t-agregar').hidden = enAlta || ls.length >= 6;
}
function cerrarAlta() { enAlta = false; $('#t-nombre').value = ''; $('#t-buscar').value = ''; $('#t-resultados').innerHTML = ''; $('#t-estado').textContent = ''; pintarTuyosEditar(); }
function terminarTuyos(avisos) {
  PREF.set('armado', true);
  enAlta = false;
  history.replaceState(null, '', location.pathname + location.search);
  mostrar();
  if (avisos && AVISOS.url && avisosPosibles() && !(enIOS && !instalada())) activarAvisos().then(pintarAvisos).catch(() => {});
}

// ---------------------------------------------------------------- ¿está entrando agua a tu casa?
function pintarAgua(x) {
  const sel = PREF.get('lugar', null) || {};
  const quien = x.z === 'sf' ? 'Protección Civil' : 'Defensa Civil';
  $('#a-quien').textContent = quien;
  $('#a-llamar').textContent = `Llamar al 103 (${quien})`;
  pintarAlto(x, sel.b, 3, $('#a-alto'));
}

// ---------------------------------------------------------------- a cuántos metros del arroyo
// En Sierras Chicas, el 15/02/2015 el agua llegó hasta 300 m de la orilla (informe de la UNC).
async function pintarArroyo(x) {
  const caja = $('#l-arroyo');
  const c = PREF.get('coords', null);
  caja.hidden = true;
  if (x.z !== 'cba') return;
  if (!c || kmEntre(c.la, c.lo, x.la, x.lo) > 15) {
    caja.hidden = false;
    caja.innerHTML = `<h2>¿Vivís cerca de un arroyo?</h2><p class="nota" style="color:inherit">Con tu ubicación te decimos a cuántos metros estás del arroyo más cercano. No la guardamos en ningún lado.</p>
      <button type="button" class="boton chico" id="b-arroyo">Calcular con mi ubicación</button>`;
    $('#b-arroyo').addEventListener('click', () => navigator.geolocation && navigator.geolocation.getCurrentPosition(p => {
      PREF.set('coords', { la: +p.coords.latitude.toFixed(5), lo: +p.coords.longitude.toFixed(5) }); pintarArroyo(x);
    }, () => { caja.querySelector('.nota').textContent = 'No pudimos saber dónde estás.'; }, { enableHighAccuracy: true, timeout: 15000 }));
    return;
  }
  const d = await arroyoMasCercano(c.la, c.lo);
  if (!d) return;
  caja.hidden = false;
  const m = Math.round(d.m / 10) * 10;
  caja.innerHTML = m <= 300
    ? `<h2>${c.barrio ? 'El barrio está' : 'Estás'} a unos ${m} m ${d.nombre ? 'del ' + esc(d.nombre) : 'de un arroyo'}</h2><p class="nota" style="color:inherit">En la crecida de 2015 en Sierras Chicas el agua llegó hasta 300 m de la orilla. Con tormenta fuerte, alejate del arroyo.</p>`
    : `<h2>${c.barrio ? 'El barrio está' : 'Estás'} a unos ${m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m + ' m'} del arroyo más cercano</h2><p class="nota" style="color:inherit">Más lejos que los 300 m a los que llegó el agua en la crecida de 2015 en Sierras Chicas. Igual, no cruces vados con tormenta.</p>`;
}

async function arroyoMasCercano(la, lo) {
  const x0 = Math.floor(lo * 10), y0 = Math.floor(la * 10);
  const celdas = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) celdas.push(`${x0 + dx}_${y0 + dy}`);
  const kx = 111320 * Math.cos(la * Math.PI / 180), ky = 110540;
  let mejor = null;
  await Promise.all(celdas.map(async c => {
    try {
      const r = await fetch(`../data/cursos/${c}.json`);
      if (!r.ok) return;
      const j = await r.json();
      for (const [i, pts] of j.lineas) {
        for (let k = 1; k < pts.length; k++) {
          const ax = (pts[k - 1][0] - lo) * kx, ay = (pts[k - 1][1] - la) * ky, bx = (pts[k][0] - lo) * kx, by = (pts[k][1] - la) * ky;
          const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / ((vx * vx + vy * vy) || 1)));
          const d = Math.hypot(ax + t * vx, ay + t * vy);
          if (!mejor || d < mejor.m) mejor = { m: d, nombre: j.nombres[i] };
        }
      }
    } catch (e) { /* sin esa parte */ }
  }));
  return mejor;
}

// ---------------------------------------------------------------- instalar en la pantalla de inicio
let pedidoInstalar = null;
const enIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const instalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); pedidoInstalar = e; pintarInstalar(); });
function pintarInstalar() {
  const caja = $('#l-instalar');
  if (instalada() || PREF.get('sin-instalar', false) || (!pedidoInstalar && !enIOS)) { caja.hidden = true; return; }
  caja.hidden = false;
  caja.innerHTML = `<h2>Agregala a tu pantalla de inicio</h2><p class="nota">Queda como una app: la abrís con un toque${AVISOS.url ? ' y te llegan los avisos aunque no la abras' : ''}.</p>` +
    (pedidoInstalar ? '<button type="button" class="boton claro" id="b-instalar">Agregar a inicio</button>'
      : '<p class="nota"><b>En iPhone:</b> tocá el botón Compartir (el cuadrado con la flecha) y después «Agregar a inicio».</p>') +
    '<button type="button" class="boton chico" id="b-no-instalar" style="align-self:flex-start">Ahora no</button>';
  const b = $('#b-instalar');
  if (b) b.addEventListener('click', async () => { pedidoInstalar.prompt(); await pedidoInstalar.userChoice; pedidoInstalar = null; pintarInstalar(); });
  $('#b-no-instalar').addEventListener('click', () => { PREF.set('sin-instalar', true); pintarInstalar(); });
}

// ---------------------------------------------------------------- avisos al celular
const avisosPosibles = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const bytesDeClave = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
async function alServicio(ruta, cuerpo) {
  const r = await fetch(AVISOS.url.replace(/\/$/, '') + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  if (!r.ok) throw new Error('servicio ' + r.status);
}
async function activarAvisos() {
  const sel = PREF.get('lugar', null);
  if (await Notification.requestPermission() !== 'granted') throw new Error('permiso');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDeClave(AVISOS.clave) });
  await alServicio('/suscribir', { subscription: sub.toJSON(), localidad: claveAviso(sel), umbral: 'enojado' });
  PREF.set('push', claveAviso(sel));
}
async function apagarAvisos() {
  PREF.set('push', null);
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await alServicio('/desuscribir', { endpoint: sub.endpoint }); } catch (e) { /* se borra sola cuando vence */ }
  await sub.unsubscribe();
}
async function sincronizarAvisos() {
  const p = PREF.get('push', null), sel = PREF.get('lugar', null);
  if (!p || !sel || !AVISOS.url || !avisosPosibles() || Notification.permission !== 'granted') return;
  if (p !== claveAviso(sel)) { try { await activarAvisos(); } catch (e) { /* se reintenta */ } }
}
function pintarAvisos() {
  const caja = $('#l-avisos');
  if (!AVISOS.url) { caja.hidden = true; return; }
  caja.hidden = false;
  const activos = !!PREF.get('push', null) && avisosPosibles() && Notification.permission === 'granted';
  if (enIOS && !instalada()) {
    caja.innerHTML = '<h2>Avisos en el celular</h2><p class="nota">En iPhone los avisos llegan solo con la app agregada a la pantalla de inicio. Agregala y abrila desde el ícono.</p>';
    return;
  }
  caja.innerHTML = activos
    ? '<h2>Avisos activados</h2><p class="nota">Te avisamos a la noche si mañana viene agua o tormenta fuerte, y en el momento si hay peligro. Nada más.</p><button type="button" class="boton chico" id="b-avisos">Apagar avisos</button>'
    : '<h2>Recibí el aviso en el celular</h2><p class="nota">Solo los importantes: uno a la noche si mañana viene agua o tormenta fuerte, y uno en el momento si hay peligro.</p><button type="button" class="boton claro" id="b-avisos">Activar avisos</button>';
  $('#b-avisos').addEventListener('click', async () => {
    try { activos ? await apagarAvisos() : await activarAvisos(); } catch (e) {
      caja.querySelector('.nota').textContent = e.message === 'permiso' ? 'Para recibir avisos, el celular tiene que dar permiso de notificaciones.' : 'No se pudo. Probá de nuevo en un rato.';
      return;
    }
    pintarAvisos();
  });
}

// ---------------------------------------------------------------- arranque
$('#buscar').addEventListener('input', buscar);
$('#b-ubicacion').addEventListener('click', usarUbicacion);
$('#b-cambiar').addEventListener('click', () => ir('elegir'));
$('#b-empezar').addEventListener('click', () => { PREF.set('visto-hola', true); mostrar(); });
$('#b-elegir-volver').addEventListener('click', () => {
  if (lugarDe(PREF.get('lugar', null))) { history.replaceState(null, '', location.pathname + location.search); mostrar(); }
  else { PREF.set('visto-hola', false); history.replaceState(null, '', location.pathname + location.search); mostrar(); }
});
$('#b-tuyos-volver').addEventListener('click', () => PREF.get('armado', false) ? terminarTuyos(false) : ir('elegir'));
$('#t-agregar').addEventListener('click', () => { enAlta = true; pintarTuyosEditar(); $('#t-nombre').focus(); });
$('#t-cancelar').addEventListener('click', cerrarAlta);
$('#t-buscar').addEventListener('input', () => mostrarResultados($('#t-buscar'), $('#t-resultados'), o => {
  const nombre = $('#t-nombre').value.trim();
  if (!nombre) { $('#t-estado').textContent = 'Escribí arriba cómo le decís (por ejemplo «Mamá»).'; $('#t-nombre').focus(); return; }
  PREF.set('tuyos', [...tuyos(), { nombre: nombre.slice(0, 30), n: o.x.n, z: o.x.z, b: o.barrio ? o.barrio.b : null }]);
  cerrarAlta();
}));
$('#t-listo').addEventListener('click', () => terminarTuyos(!PREF.get('armado', false)));   // la primera vez, además, pide los avisos
$('#t-despues').addEventListener('click', () => terminarTuyos(false));
$('#n-hoy').addEventListener('click', e => { e.preventDefault(); history.replaceState(null, '', location.pathname + location.search); mostrar(); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && DATOS) cargar(); });
cargar();
