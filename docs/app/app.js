// Crecidas · la app para todos: elegís tu lugar una vez y ves hoy y mañana en palabras simples.
// Los datos salen de ../data/app.json (scripts/armar_app.py, cada 15 minutos). Nada de esto sale del celular salvo,
// si se activan los avisos, la dirección de push del navegador y el lugar elegido.
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ZONA = { cba: 'Córdoba', sf: 'Santa Fe' };

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

async function cargar() {
  try {
    const r = await fetch('../data/app.json?t=' + Date.now());
    if (!r.ok) throw new Error(r.status);
    DATOS = await r.json();
  } catch (e) {
    $('#sin-datos').hidden = false;
    $('#sin-datos').textContent = 'No se pudieron cargar los datos. Revisá la conexión y volvé a abrir la app.';
    return;
  }
  // un link compartido trae el lugar: ?l=Unquillo&z=cba
  const q = new URLSearchParams(location.search);
  if (q.get('l')) {
    const x = DATOS.lugares.find(y => y.n === q.get('l') && (!q.get('z') || y.z === q.get('z')));
    if (x && !PREF.get('lugar', null)) PREF.set('lugar', { n: x.n, z: x.z });
  }
  mostrar();
}

function mostrar() {
  const x = lugarDe(PREF.get('lugar', null));
  $('#v-elegir').hidden = !!x;
  $('#v-lugar').hidden = !x;
  if (x) pintarLugar(x); else $('#buscar').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- elegir lugar
function buscar() {
  const q = sinTildes($('#buscar').value.trim());
  const lista = $('#resultados');
  if (q.length < 2) { lista.innerHTML = ''; return; }
  const rango = x => { const n = sinTildes(x.n); return n.startsWith(q) ? 0 : (' ' + n).includes(' ' + q) ? 1 : 2; };
  const r = DATOS.lugares.filter(x => sinTildes(x.n).includes(q)).sort((a, b) => rango(a) - rango(b) || a.n.localeCompare(b.n)).slice(0, 8);
  lista.innerHTML = r.length ? r.map((x, i) => `<li><button type="button" data-i="${i}"><span><b>${esc(x.n)}</b><br><small>${ZONA[x.z]}${x.rio ? ' · ' + esc(x.rio) : ''}</small></span><span aria-hidden="true">›</span></button></li>`).join('')
    : '<li><p class="nota" style="padding:14px 16px">No encontramos ese lugar. Por ahora están las sierras de Córdoba y la provincia de Santa Fe.</p></li>';
  lista.querySelectorAll('button').forEach(b => b.addEventListener('click', () => elegir(r[b.dataset.i], null)));
}

function elegir(x, coords) {
  PREF.set('lugar', { n: x.n, z: x.z });
  PREF.set('coords', coords);
  $('#buscar').value = ''; $('#resultados').innerHTML = '';
  mostrar();
  sincronizarAvisos();
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
const ICONO = {
  0: c => `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  1: c => `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.5 20h19z" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.3" fill="${c}"/></svg>`,
};
ICONO[2] = ICONO[1]; ICONO[3] = ICONO[1];
const COLOR_ICONO = { 0: '#fff', 1: '#F2C230', 2: '#D9711C', 3: '#C23A2E' };

function tarjetaDia(d, cuando, chico) {
  return `<div class="dia n${d.nivel}${chico ? ' chico' : ''}" role="group" aria-label="${esc(cuando)}: ${esc(d.titulo)}">
    <div class="fila"><span class="icono">${ICONO[d.nivel](COLOR_ICONO[d.nivel])}</span>
      <span><span class="cuando">${esc(cuando)}</span><br><span class="titulo">${esc(d.titulo)}</span></span></div>
    ${d.nivel ? `<p class="texto">${esc(d.texto)}</p>` : `<p class="texto">${esc(d.texto)}</p>`}
    ${d.tambien ? `<p class="tambien">También: ${esc(d.tambien)}.</p>` : ''}
  </div>`;
}

const HACER = {
  sierras: {
    alto: ['No cruces vados ni badenes, ni a pie ni en auto.', 'Alejate de la orilla del arroyo y no acampes cerca.', 'Si el agua sube o se pone marrón, subí a un lugar alto.'],
    medio: ['Mirá el cielo y seguí los avisos de la app.', 'Si llueve fuerte, no cruces vados ni te quedes en la orilla.'],
    nada: ['Tené a mano el número de Defensa Civil: 103.', 'Si vivís cerca del arroyo, pensá a dónde ir si crece.'],
  },
  llanura: {
    alto: ['Subí a lo alto documentos, remedios y lo que no se puede mojar.', 'Cargá el celular y tené a mano una linterna.', 'Si tenés que salir, avisá a un vecino y seguí las indicaciones de Protección Civil.'],
    medio: ['Limpiá la vereda y las rejillas para que corra el agua.', 'No dejes el auto en calles que se anegan.', 'Seguí los avisos de la app.'],
    nada: ['Tené a mano el número de Protección Civil: 103.', 'Si tu calle se anega seguido, guardá lo importante en alto.'],
  },
};

function pintarLugar(x) {
  $('#l-nombre').textContent = x.n;
  $('#l-zona').textContent = `${ZONA[x.z]}${x.rio ? ' · ' + x.rio : ''}`;
  const man = DATOS.dia_manana ? `Mañana, ${DATOS.dia_manana}` : 'Mañana';
  // lo más importante arriba: si mañana es peor que hoy, mañana va primero y grande; si sigue igual, no se repite
  const primeroManana = x.man.nivel > x.hoy.nivel;
  const igual = x.man.nivel === x.hoy.nivel && x.man.titulo === x.hoy.titulo;
  const manTarjeta = igual && x.hoy.nivel ? { ...x.man, titulo: 'Sigue igual', texto: 'No se espera que mejore todavía.', tambien: null } : x.man;
  $('#l-dias').innerHTML = primeroManana ? tarjetaDia(x.man, man) + tarjetaDia(x.hoy, 'Hoy', true)
    : tarjetaDia(x.hoy, 'Hoy') + tarjetaDia(manTarjeta, man, manTarjeta.nivel === 0 || igual);
  const peor = Math.max(x.hoy.nivel, x.man.nivel);
  const lista = HACER[x.tipo][peor >= 2 ? 'alto' : peor === 1 ? 'medio' : 'nada'];
  $('#l-hacer').innerHTML = `<h2>${peor ? (primeroManana ? 'Qué hacer hoy, para mañana' : 'Qué hacer') : 'Para estar preparado'}</h2><ol>${lista.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`;
  const texto = `${x.n}: ${primeroManana ? 'mañana' : 'hoy'} ${(primeroManana ? x.man : x.hoy).titulo.toLowerCase()}. Mirá cómo está tu barrio:`;
  const enlace = new URL(`?l=${encodeURIComponent(x.n)}&z=${x.z}`, location.href.split('?')[0]).href;
  $('#b-whatsapp').href = 'https://wa.me/?text=' + encodeURIComponent(`${texto} ${enlace}`);
  $('#l-fuente').textContent = `Datos de las ${DATOS.generado.slice(11)} del ${DATOS.generado.slice(8, 10)}/${DATOS.generado.slice(5, 7)}. ` +
    (x.tipo === 'sierras' ? 'Radar del OHMC, pronóstico de lluvia y alertas del SMN.' : 'Ríos del INA y Prefectura, pronóstico de lluvia y alertas del SMN.');
  pintarArroyo(x);
  pintarAvisos();
  pintarInstalar();
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
    ? `<h2>Estás a unos ${m} m ${d.nombre ? 'del ' + esc(d.nombre) : 'de un arroyo'}</h2><p class="nota" style="color:inherit">En la crecida de 2015 en Sierras Chicas el agua llegó hasta 300 m de la orilla. Con tormenta fuerte, alejate del arroyo.</p>`
    : `<h2>Estás a unos ${m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m + ' m'} del arroyo más cercano</h2><p class="nota" style="color:inherit">Más lejos que los 300 m a los que llegó el agua en la crecida de 2015 en Sierras Chicas. Igual, no cruces vados con tormenta.</p>`;
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
$('#b-cambiar').addEventListener('click', () => { PREF.set('lugar', null); mostrar(); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && DATOS) cargar(); });
cargar();
