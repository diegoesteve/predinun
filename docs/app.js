// Página estática: lee docs/data/*.json, que actualizan los workflows de GitHub Actions.
const COLOR = { verde: '#1F7A4D', normal: '#1F7A4D', amarillo: '#F2C230', naranja: '#E07B20', rojo: '#C0362C', 'sin datos': '#9AA5A0' };
const TEXTO = { verde: 'normal', normal: 'normal', amarillo: 'amarillo', naranja: 'naranja', rojo: 'rojo', 'sin datos': 'sin datos' };
const clase = n => 'n-' + String(n || 'sin datos').replace(' ', '-');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CENTRO = [-31.25, -64.38];

async function leer(nombre) {
  try {
    const r = await fetch(`data/${nombre}?t=${Date.now()}`);
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function mapaBase(id, zoom = 10) {
  // En pantallas táctiles, un dedo baja la página y dos dedos mueven y acercan el mapa.
  const m = L.map(id, { scrollWheelZoom: false, dragging: !TACTIL }).setView(CENTRO, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: '&copy; OpenStreetMap'
  }).addTo(m);
  zoomConCtrl(m);
  return m;
}

const TACTIL = window.matchMedia('(pointer: coarse)').matches;

// La rueda sola sigue bajando la página; con Ctrl (o Cmd en Mac, o pellizcando el trackpad) acerca y aleja el mapa.
function zoomConCtrl(m) {
  const cont = m.getContainer();
  const aviso = L.DomUtil.create('div', 'aviso-zoom', cont);
  aviso.dataset.texto = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Usá ⌘ + rueda para acercar o alejar el mapa' : 'Usá Ctrl + rueda para acercar o alejar el mapa';
  let acumulado = 0, ultimo = 0, temporizador;
  const mostrar = texto => {
    aviso.dataset.texto = texto;
    aviso.classList.add('visible');
    clearTimeout(temporizador);
    temporizador = setTimeout(() => aviso.classList.remove('visible'), 1200);
  };
  if (TACTIL) {
    // Con un dedo se baja la página; si lo arrastra sobre el mapa, se recuerda cómo moverlo
    let inicio = null;
    cont.addEventListener('touchstart', e => { inicio = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
    cont.addEventListener('touchmove', e => {
      if (e.touches.length === 1 && inicio != null && Math.abs(e.touches[0].clientY - inicio) > 10) mostrar('Usá dos dedos para mover el mapa');
      if (e.touches.length > 1) aviso.classList.remove('visible');
    }, { passive: true });
    return;
  }
  cont.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) { mostrar(/Mac|iPhone|iPad/.test(navigator.platform) ? 'Usá ⌘ + rueda para acercar o alejar el mapa' : 'Usá Ctrl + rueda para acercar o alejar el mapa'); return; }
    e.preventDefault();
    aviso.classList.remove('visible');
    acumulado += e.deltaY * (e.deltaMode === 1 ? 33 : 1);
    const ahora = Date.now();
    if (Math.abs(acumulado) < 60 || ahora - ultimo < 120) return;
    const paso = acumulado < 0 ? 1 : -1;
    acumulado = 0; ultimo = ahora;
    m.setZoomAround(m.mouseEventToContainerPoint(e), m.getZoom() + paso);
  }, { passive: false });
}

// ---------------------------------------------------------------- pestañas
const mapas = {};
const PESTANAS = ['inicio', 'ahora', 'pronostico', 'riesgo', 'aporta'];
document.querySelectorAll('.pestanas button, .acceso').forEach(b => b.addEventListener('click', () => {
  mostrar(b.dataset.p || b.dataset.ir);
  if (b.dataset.ir) window.scrollTo(0, 0);
}));
const marca = document.querySelector('.marca');
marca.addEventListener('click', () => mostrar('inicio'));
marca.addEventListener('keydown', e => { if (e.key === 'Enter') mostrar('inicio'); });
function mostrar(p) {
  document.querySelectorAll('.pestanas button').forEach(b => b.setAttribute('aria-selected', b.dataset.p === p));
  document.querySelectorAll('.pagina').forEach(s => s.hidden = s.id !== 'p-' + p);
  try { history.replaceState(null, '', '#' + p); } catch (e) {}
  Object.values(mapas).forEach(m => m.invalidateSize());
  if (p === 'ahora' && !mapas.estaciones) ahora();
  if (p === 'riesgo' && !mapas.riesgo) riesgo();
  if (p === 'aporta' && !mapas.aporte) aporta();
}

// ---------------------------------------------------------------- ahora
async function ahora() {
  const [a, e] = await Promise.all([leer('ahora.json'), leer('estaciones.json')]);
  const meta = document.getElementById('ahora-meta');
  if (!a) { meta.textContent = 'Todavía no hay datos: el monitor no corrió.'; return; }
  meta.textContent = `Estaciones: ${a.actualizado} · Pronóstico: ${a.boletin_generado || 'sin boletín'}`;
  document.getElementById('ahora-cuencas').innerHTML = a.cuencas.map(c => `
    <article class="tarjeta ${clase(c.nivel)}"><div class="franja"></div><div class="cuerpo">
      <div class="nombre">${esc(c.nombre)}</div>
      <div class="nivel"><span class="punto"></span>${esc(TEXTO[c.nivel])}</div>
      <div class="det">${esc(c.motivo)}</div>
      ${c.suelo ? `<div class="det">Suelo: ${esc(c.suelo)}</div>` : ''}
    </div></article>`).join('');

  const est = (e && e.estaciones) || [];
  mapas.estaciones = mapaBase('mapa-estaciones');
  const marcas = new Map();
  est.filter(s => s.lat && s.lon && s.tipo !== 'otra').forEach(s => {
    const txt = s.tipo === 'rio'
      ? `Nivel ${s.nivel_m} m · subió ${s.subida_1h_m ?? '–'} m en 1 h`
      : `Lluvia 1 h: ${s.lluvia_1h ?? '–'} mm · 3 h: ${s.lluvia_3h ?? '–'} mm · 24 h: ${s.lluvia_24h ?? '–'} mm`;
    marcas.set(s, L.circleMarker([s.lat, s.lon], {
      radius: s.tipo === 'rio' ? 8 : 6, color: s.tipo === 'rio' ? '#0E5E5A' : '#fff', weight: 2,
      fillColor: COLOR[s.estado] || COLOR['sin datos'], fillOpacity: .9
    }).bindPopup(`<b>${esc(s.nombre)}</b> (${s.tipo === 'rio' ? 'río' : 'lluvia'})<br>${esc(txt)}<br>${esc(s.hora)} · ${esc(TEXTO[s.estado])}`)
      .addTo(mapas.estaciones));
  });
  const orden = { rojo: 0, naranja: 1, amarillo: 2, normal: 3, 'sin datos': 4 };
  const filas = est.filter(s => s.tipo !== 'otra').sort((x, y) => (orden[x.estado] - orden[y.estado]) || String(x.zona).localeCompare(y.zona));
  document.getElementById('tabla-estaciones').innerHTML =
    '<tr><th>Estado</th><th>Estación</th><th>Zona</th><th>Tipo</th><th>Hora</th><th>1 h mm</th><th>3 h mm</th><th>24 h mm</th><th>Nivel m</th><th>Sube 1 h</th></tr>' +
    filas.map((s, i) => `<tr class="${clase(s.estado)}${marcas.has(s) ? ' con-mapa' : ''}" data-i="${i}"><td><span class="punto"></span>${esc(TEXTO[s.estado])}</td>
      <td>${esc(s.nombre)}</td><td>${esc(s.zona)}</td><td>${s.tipo === 'rio' ? 'río' : 'lluvia'}</td>
      <td>${esc(s.hora)}</td><td class="num">${s.lluvia_1h ?? ''}</td><td class="num">${s.lluvia_3h ?? ''}</td><td class="num">${s.lluvia_24h ?? ''}</td>
      <td class="num">${s.nivel_m ?? ''}</td><td class="num">${s.subida_1h_m ?? ''}</td></tr>`).join('');
  // Tocar una fila centra el mapa en esa estación y abre su ficha
  document.querySelectorAll('#tabla-estaciones tr.con-mapa').forEach(tr => tr.addEventListener('click', () => {
    const m = marcas.get(filas[Number(tr.dataset.i)]);
    document.querySelectorAll('#tabla-estaciones tr.elegida').forEach(x => x.classList.remove('elegida'));
    tr.classList.add('elegida');
    document.getElementById('mapa-estaciones').scrollIntoView({ behavior: 'smooth', block: 'center' });
    mapas.estaciones.setView(m.getLatLng(), 13);
    m.openPopup();
  }));
}

// ---------------------------------------------------------------- pronóstico
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
function colorProb(p) {
  if (p == null) return 'transparent';
  if (p >= 0.6) return 'rgba(192,54,44,.55)';
  if (p >= 0.3) return 'rgba(224,123,32,.45)';
  if (p >= 0.1) return 'rgba(242,194,48,.45)';
  return 'transparent';
}
async function pronostico() {
  const b = await leer('boletin.json');
  const meta = document.getElementById('pron-meta');
  if (!b) { meta.textContent = 'Todavía no hay boletín.'; return; }
  meta.textContent = `Boletín generado ${b.generado}` + (b.smap_atraso_dias != null ? ` · SMAP con ${b.smap_atraso_dias} días de atraso` : '');
  const modelos = [...new Set(b.cuencas.flatMap(c => Object.keys(c.modelos)))];
  const ens = [...new Set(b.cuencas.flatMap(c => Object.keys(c.ensambles)))];
  document.getElementById('tabla-48h').innerHTML =
    `<tr><th>Cuenca</th><th>Nivel</th>${modelos.map(m => `<th>${esc(m)} máx 3 h</th>`).join('')}<th>Umbral</th>${ens.map(m => `<th>${esc(m)}</th>`).join('')}</tr>` +
    b.cuencas.map(c => {
      const u = Object.values(c.modelos)[0];
      return `<tr class="${clase(c.nivel)}"><td>${esc(c.nombre)}</td>
        <td><span class="punto"></span>${esc(TEXTO[c.nivel])}${c.agravado_por_suelo ? ' (por suelo)' : ''}</td>
        ${modelos.map(m => `<td class="num">${c.modelos[m] ? c.modelos[m].max_3h_mm + ' mm' : '–'}</td>`).join('')}
        <td class="num">${u ? u.umbral_mm + ' mm' : '–'}</td>
        ${ens.map(m => `<td class="num">${c.ensambles[m] != null ? Math.round(100 * c.ensambles[m]) + ' %' : '–'}</td>`).join('')}</tr>`;
    }).join('');

  const p = b.perspectiva || { dias: [], cuencas: {} };
  const cab = p.dias.map(d => { const f = new Date(d + 'T12:00'); return `<th>${DIAS[f.getDay()]} ${f.getDate()}/${f.getMonth() + 1}</th>`; }).join('');
  document.getElementById('tabla-10d').innerHTML = `<tr><th>Cuenca</th>${cab}</tr>` +
    Object.values(p.cuencas).map(c => `<tr><td>${esc(c.nombre)}${c.suelo_saturado ? ' 💧' : ''}</td>` +
      c.prob.map((x, i) => `<td class="prob" style="background:${colorProb(x)}" title="${c.mm[i] ?? '–'} mm en el día (mediana)">${x == null ? '–' : Math.round(100 * x) + '%'}<br><small>${c.mm[i] ?? '–'} mm</small></td>`).join('') + '</tr>').join('');

  const textoSecado = x => {
    if (!x || x.et0_ult_pct == null) return '';
    const antes = x.et0_ult_pct < 75 ? `<b>evaporó poco</b>: ${x.et0_ult_pct} % de lo normal` :
      x.et0_ult_pct > 125 ? `evaporó más que lo normal (${x.et0_ult_pct} %)` : `evaporación normal (${x.et0_ult_pct} %)`;
    const nubes = x.nubosidad_ult_media != null ? `, ${x.dias_nublados_ult} de ${x.dias_atras} días nublados (nubosidad media ${x.nubosidad_ult_media} %, lo normal es ${x.nubosidad_ult_normal} %)` : '';
    const prox = x.et0_prox_pct != null ? `<div class="det">Próximos ${x.dias_adelante} días: se espera ${x.et0_prox_pct} % de la evaporación normal (${x.et0_prox_mm} mm).</div>` : '';
    return `<div class="det">Últimos ${x.dias_atras} días: ${antes}${nubes}.</div>${prox}`;
  };
  document.getElementById('suelo').innerHTML = b.cuencas.map(c => {
    const s = c.suelo;
    if (!s) return `<article class="tarjeta n-sin-datos"><div class="franja"></div><div class="cuerpo"><div class="nombre">${esc(c.nombre)}</div><div class="det">Sin dato de SMAP.</div>${textoSecado(c.secado)}</div></article>`;
    const n = s.estado === 'saturado' ? 'naranja' : s.estado === 'seco' ? 'amarillo' : 'verde';
    return `<article class="tarjeta ${clase(n)}"><div class="franja"></div><div class="cuerpo">
      <div class="nombre">${esc(c.nombre)}</div>
      <div class="nivel">${esc(s.estado)} · percentil ${s.percentil}${s.es_estimado ? ' (estimado hoy)' : ''}</div>
      <div class="det">SMAP p${s.smap_percentil} del ${esc(String(s.smap_fecha).slice(0, 10))}${s.estimado_hoy_percentil != null ? ` · estimado hoy p${s.estimado_hoy_percentil}` : ''}</div>
      ${textoSecado(c.secado)}
    </div></article>`;
  }).join('');
}

// ---------------------------------------------------------------- riesgo
async function riesgo() {
  mapas.riesgo = mapaBase('mapa-riesgo', 10);
  const g = await leer('riesgo.geojson');
  if (!g) return;
  const estilos = {
    'daño confirmado': { color: '#C0362C', radio: 7, titulo: 'Daños confirmados (2014–2016)' },
    'tramo de río': { color: '#0E5E5A', radio: 5, titulo: 'Tramos de río inestables o con casas cerca' },
    'microcuenca': { color: '#E07B20', radio: 5, titulo: 'Microcuencas prioritarias' },
    'comunidad análoga': { color: '#5B2A86', radio: 7, titulo: 'Arroyos serranos que entran a un pueblo (más oscuro, más expuesto)' },
    'camping o balneario bajo': { color: '#1F6FB2', radio: 5, titulo: 'Campings y balnearios a menos de 5 m sobre un río' },
    'aporte': { color: '#B8860B', radio: 7, titulo: 'Relatos de vecinos y visitantes' },
  };
  const capas = {};
  g.features.forEach(f => {
    const p = f.properties, e0 = estilos[p.capa] || { color: '#555', radio: 5, titulo: p.capa };
    const e = p.capa === 'comunidad análoga' && p.exposicion ? { ...e0, color: COLOR_EXPO[p.exposicion] } : e0;
    const [lon, lat] = f.geometry.coordinates;
    const det = p.capa === 'aporte' ? popupAporte(p) : p.capa === 'comunidad análoga' ? popupComunidad(p) : Object.entries(p).filter(([k, v]) => k !== 'capa' && v != null && v !== '')
      .map(([k, v]) => `<b>${esc(k.replace(/_/g, ' '))}:</b> ${esc(v)}`).join('<br>');
    (capas[p.capa] ||= L.layerGroup()).addLayer(
      L.circleMarker([lat, lon], { radius: e.radio, color: '#fff', weight: 1.5, fillColor: e.color, fillOpacity: .85 })
        .bindPopup(`<div style="max-width:260px;white-space:normal">${det}</div>`));
  });
  const caja = document.getElementById('capas');
  Object.entries(capas).forEach(([nombre, capa]) => {
    capa.addTo(mapas.riesgo);
    const e = estilos[nombre] || { color: '#555', titulo: nombre };
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" checked><span class="punto" style="--c:${e.color}"></span>${esc(e.titulo)} (${capa.getLayers().length})`;
    l.querySelector('input').addEventListener('change', ev => ev.target.checked ? capa.addTo(mapas.riesgo) : capa.remove());
    caja.appendChild(l);
  });
  const todos = Object.values(capas).flatMap(c => c.getLayers().map(x => x.getLatLng()));
  if (todos.length) mapas.riesgo.fitBounds(L.latLngBounds(todos).pad(0.1), { animate: false });
  tablaLocalidades();
}

// ---------------------------------------------------------------- tabla por localidad
// Dos escalas separadas: el semáforo «Ahora» (pronóstico de 3 días cruzado con la exposición) y la exposición
// permanente (historial y terreno), en violetas para que no se lea como una alarma.
const COLOR_AHORA = { alerta: '#C0362C', 'atención': '#F2C230', normal: '#1F7A4D' };
const CLASE_AHORA = { alerta: 'n-rojo', 'atención': 'n-amarillo', normal: 'n-verde' };
const ORDEN_AHORA = { alerta: 3, 'atención': 2, normal: 1 };
const COLOR_EXPO = { 'muy expuesta': '#5B2A86', 'expuesta': '#9B7BC0', 'poco expuesta': '#D9CCE8' };
const ORDEN_EXPO = { 'muy expuesta': 3, 'expuesta': 2, 'poco expuesta': 1 };
const chipAhora = a => a ? `<span class="chip ${CLASE_AHORA[a]}"><span class="punto"></span>${esc(a)}</span>` : '<span class="nota">sin dato</span>';
const chipExpo = x => x ? `<span class="chip expo"><span class="cuadro" style="--c:${COLOR_EXPO[x]}"></span>${esc(x)}</span>` : '<span class="nota">sin análisis</span>';
const TEXTO_AVISO = { 'sí': 'sí', 'parcial': 'en parte', 'no': 'no' };
const CLASE_AVISO = { 'sí': 'si', 'parcial': 'parcial', 'no': 'no' };
const sinTildes = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
let LOCS = [], ordenLoc = { campo: null, asc: false }, marcaLoc = null;

let CONDICIONES = null, capaAhora = null;

// Semáforo «Ahora»: rojo solo si se espera lluvia fuerte donde hay exposición; amarillo si se espera lluvia
// fuerte en un lugar poco expuesto o lluvia cerca de ese nivel en uno muy expuesto; verde en el resto.
function semaforo(c, expo) {
  if (!c) return null;
  const expuesta = expo === 'muy expuesta' || expo === 'expuesta';
  if (c.condicion === 'lluvia fuerte') return expuesta ? 'alerta' : 'atención';
  if (expo === 'muy expuesta' && c.umbral_mm && c.max_3h_mm >= 0.75 * c.umbral_mm) return 'atención';   // cerca del umbral
  return 'normal';
}

function combinar(f) {
  const c = CONDICIONES && CONDICIONES.localidades[f.localidad];
  const a = c && c.ahora ? c.ahora : semaforo(c, f.exposicion);   // el boletín ya lo calcula; si no, la misma regla acá
  return { ...f, ahora: a, condiciones: c || null, orden_ahora: (ORDEN_AHORA[a] || 0) * 10 + (ORDEN_EXPO[f.exposicion] || 0),
           orden_expo: ORDEN_EXPO[f.exposicion] || 0 };
}

function dibujarCapaAhora() {
  const con = LOCS.filter(f => f.ahora === 'alerta' || f.ahora === 'atención');
  capaAhora = L.layerGroup(con.map(f => L.circleMarker([f.lat, f.lon], { radius: f.ahora === 'alerta' ? 12 : 9, color: '#fff', weight: 2,
    fillColor: COLOR_AHORA[f.ahora], fillOpacity: .95 }).bindPopup(`<b>${esc(f.localidad)}</b> ${chipAhora(f.ahora)}<br>` +
    `Hasta ${f.condiciones.max_3h_mm} mm en 3 horas en los próximos 3 días.<br><a href="?localidad=${encodeURIComponent(f.localidad)}#riesgo">Ver detalle</a>`)));
  capaAhora.addTo(mapas.riesgo);
  // El mapa arranca mostrando las localidades en alerta o atención (si hay); si no, todo el mapa
  if (con.length && !new URLSearchParams(location.search).get('localidad')) {
    const zona = L.latLngBounds(con.map(f => [f.lat, f.lon]));
    const encuadrar = () => mapas.riesgo.fitBounds(zona.pad(0.1), { maxZoom: 11, animate: false });
    encuadrar();
    if (document.getElementById('p-riesgo').hidden) {    // el mapa oculto no sabe su tamaño: encuadrar al mostrarlo
      const obs = new ResizeObserver(() => { if (mapas.riesgo.getContainer().offsetWidth) { mapas.riesgo.invalidateSize(); encuadrar(); obs.disconnect(); } });
      obs.observe(mapas.riesgo.getContainer());
    }
  }
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" checked><span class="punto" style="--c:${COLOR_AHORA.alerta}"></span>Alerta o atención por lluvia, próximos 3 días (${con.length})`;
  l.querySelector('input').addEventListener('change', ev => ev.target.checked ? capaAhora.addTo(mapas.riesgo) : capaAhora.remove());
  document.getElementById('capas').prepend(l);
  const n = { alerta: con.filter(f => f.ahora === 'alerta').length, 'atención': con.filter(f => f.ahora === 'atención').length };
  document.getElementById('resumen-ahora').innerHTML = !CONDICIONES ? 'Todavía no hay pronóstico por localidad.'
    : n.alerta || n['atención'] ? `Ahora: ${n.alerta ? `<b>${n.alerta}</b> localidad${n.alerta > 1 ? 'es' : ''} en ${chipAhora('alerta')}` : ''}${n.alerta && n['atención'] ? ' y ' : ''}${n['atención'] ? `<b>${n['atención']}</b> en ${chipAhora('atención')}` : ''}. El resto, ${chipAhora('normal')}.`
    : `Ahora: todas las localidades en ${chipAhora('normal')}. No se espera lluvia fuerte en los próximos 3 días.`;
}

let cargaLocs = null;
function cargarLocs() {
  cargaLocs ||= Promise.all([leer('localidades.json'), leer('condiciones_localidades.json')]).then(([d, c]) => {
    CONDICIONES = c;
    LOCS = d ? d.localidades.map(combinar) : [];
    return LOCS;
  });
  return cargaLocs;
}

async function tablaLocalidades() {
  await cargarLocs();
  if (!LOCS.length) return;
  const c = CONDICIONES;
  if (c) document.getElementById('condiciones-meta').textContent = `Última actualización del pronóstico por localidad: ${c.generado}.`;
  dibujarCapaAhora();
  ['buscar-loc', 'solo-eventos', 'sin-aviso'].forEach(id =>
    document.getElementById(id).addEventListener('input', dibujarLocalidades));
  prepararSugerencias();
  dibujarLocalidades();
  const pedida = new URLSearchParams(location.search).get('localidad');
  if (pedida) {
    const f = LOCS.find(x => sinTildes(x.localidad) === sinTildes(pedida));
    if (f) setTimeout(() => elegirLocalidad(f), 400);   // después de que el mapa termine de encuadrar
  }
}

const COLUMNAS = [
  ['localidad', 'Localidad'], ['ahora', 'Ahora', 'orden_ahora'], ['exposicion', 'Exposición', 'orden_expo'],
  ['aviso', 'Aviso'], ['n_eventos', 'Crecidas'],
];

function dibujarLocalidades() {
  const q = sinTildes(document.getElementById('buscar-loc').value);
  const soloEv = document.getElementById('solo-eventos').checked;
  const sinAviso = document.getElementById('sin-aviso').checked;
  let filas = LOCS.filter(f => (!q || sinTildes(f.localidad).includes(q))
    && (!soloEv || f.n_eventos > 0) && (!sinAviso || f.aviso === 'no'));
  if (!ordenLoc.campo) filas = [...filas].sort((a, b) => b.orden_ahora - a.orden_ahora);   // primero las que están en alerta
  else {
    const k = ordenLoc.campo, sgn = ordenLoc.asc ? 1 : -1;
    filas = [...filas].sort((a, b) => {
      const x = a[k] ?? -1, y = b[k] ?? -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sgn;
    });
  }
  const t = document.getElementById('tabla-loc');
  t.innerHTML = '<thead><tr>' + COLUMNAS.map(([k, n, ko]) =>
      `<th data-k="${ko || k}">${n}${ordenLoc.campo === (ko || k) ? (ordenLoc.asc ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>' +
    filas.map(f => `<tr data-loc="${esc(f.localidad)}">
      <td>${esc(f.localidad)}</td><td>${chipAhora(f.ahora)}</td><td>${chipExpo(f.exposicion)}</td>
      <td>${f.aviso ? `<span class="aviso-${CLASE_AVISO[f.aviso]}">${TEXTO_AVISO[f.aviso]}</span>` : '–'}</td>
      <td class="num">${f.n_eventos || '–'}</td></tr>`).join('') + '</tbody>';
  t.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    ordenLoc = { campo: k, asc: ordenLoc.campo === k ? !ordenLoc.asc : k === 'localidad' };
    dibujarLocalidades();
  }));
  t.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () =>
    elegirLocalidad(LOCS.find(f => f.localidad === tr.dataset.loc))));
  if (!filas.length) t.innerHTML += '<tbody><tr><td colspan="6">No hay localidades con ese filtro.</td></tr></tbody>';
}

// ---------------------------------------------------------------- buscador con sugerencias
function prepararSugerencias(idInput = 'buscar-loc', idLista = 'sugerencias-loc', alElegir = null) {
  const input = document.getElementById(idInput), lista = document.getElementById(idLista);
  let sugeridas = [], marcada = -1;
  const cerrar = () => { lista.hidden = true; input.setAttribute('aria-expanded', 'false'); marcada = -1; };
  const pintar = () => {
    const q = sinTildes(input.value.trim());
    if (!q) { cerrar(); return; }
    // primero las que empiezan así, después las que tienen una palabra que empieza así («car» → Villa Carlos Paz)
    const rango = f => { const n = sinTildes(f.localidad); return n.startsWith(q) ? 0 : (' ' + n).includes(' ' + q) ? 1 : 2; };
    sugeridas = LOCS.filter(f => sinTildes(f.localidad).includes(q))
      .sort((a, b) => rango(a) - rango(b) || a.localidad.localeCompare(b.localidad))
      .slice(0, 8);
    lista.innerHTML = sugeridas.length ? sugeridas.map((f, i) => {
      const n = sinTildes(f.localidad), k = n.indexOf(q);
      const nombre = esc(f.localidad.slice(0, k)) + '<mark>' + esc(f.localidad.slice(k, k + q.length)) + '</mark>' + esc(f.localidad.slice(k + q.length));
      return `<li role="option" id="${idLista}-${i}" data-i="${i}" aria-selected="${i === marcada}"><span>${nombre}</span><span>${f.ahora === 'alerta' || f.ahora === 'atención' ? chipAhora(f.ahora) + ' ' : ''}${chipExpo(f.exposicion)}</span></li>`;
    }).join('') : '<li class="vacio">No hay localidades con ese nombre.</li>';
    lista.hidden = false; input.setAttribute('aria-expanded', 'true');
  };
  const elegir = i => {
    const f = sugeridas[i];
    if (!f) return;
    input.value = f.localidad; cerrar();
    if (alElegir) alElegir(f); else { dibujarLocalidades(); elegirLocalidad(f); }
  };
  input.addEventListener('input', () => { marcada = -1; pintar(); });
  input.addEventListener('focus', pintar);
  input.addEventListener('keydown', e => {
    if (lista.hidden) return;
    if (e.key === 'ArrowDown') { marcada = Math.min(marcada + 1, sugeridas.length - 1); pintar(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { marcada = Math.max(marcada - 1, 0); pintar(); e.preventDefault(); }
    else if (e.key === 'Enter') { elegir(marcada >= 0 ? marcada : 0); e.preventDefault(); }
    else if (e.key === 'Escape') cerrar();
  });
  lista.addEventListener('mousedown', e => {           // mousedown: antes de que el input pierda el foco
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); elegir(Number(li.dataset.i)); }
  });
  input.addEventListener('blur', () => setTimeout(cerrar, 150));
}

function textoCondiciones(c) {
  if (!c) return '<div><b>Próximos 3 días</b>: sin pronóstico por ahora.</div>';
  const cuando = c.cuando ? new Date(c.cuando.replace(' ', 'T')) : null;
  const dia = cuando ? `${DIAS[cuando.getDay()]} ${cuando.getDate()}/${cuando.getMonth() + 1} a las ${cuando.getHours()} h` : '';
  const estado = c.condicion === 'lluvia fuerte' ? '<span class="lluvia-fuerte">se espera lluvia fuerte</span>'
    : c.condicion === 'atención' ? '<span class="lluvia-atencion">se espera lluvia moderada</span>' : 'sin lluvia fuerte a la vista';
  const lluvia = c.max_3h_mm > 0 ? `Hasta ${c.max_3h_mm} mm en 3 horas${dia ? ` (${dia})` : ''}` : 'No se pronostica lluvia';
  return `<div><b>Próximos 3 días</b>: ${estado}. ${lluvia}. ` +
    `Suelo ${esc(c.suelo)}${c.suelo_humedo ? ', así que cuenta como lluvia fuerte desde menos milímetros' : ''}.</div>`;
}

function elegirLocalidad(f) {
  if (!f) return;
  document.querySelectorAll('#tabla-loc tbody tr').forEach(tr => tr.classList.toggle('elegida', tr.dataset.loc === f.localidad));
  try { history.replaceState(null, '', `?localidad=${encodeURIComponent(f.localidad)}#riesgo`); } catch (e) {}
  mapas.riesgo.invalidateSize();
  setTimeout(() => mapas.riesgo.setView([f.lat, f.lon], 13), 50);
  if (marcaLoc) marcaLoc.remove();
  marcaLoc = L.layerGroup().addTo(mapas.riesgo);
  (f.arroyos || []).forEach(a => L.circleMarker([a.lat, a.lon], { radius: 9, color: '#0E5E5A', weight: 3, fill: false })
    .bindTooltip(esc(a.arroyo)).addTo(marcaLoc));
  const arroyos = (f.arroyos || []).map(a => `<li><b>${esc(a.arroyo)}</b> ${chipExpo(a.exposicion)} · cuenca de ${Math.round(a.area_km2)} km² · unas ${a.personas} personas cerca del cauce · ${a.margen_min != null && a.margen_min >= 30 ? `hay una estación río arriba que da unas ${Math.round(a.margen_min / 60 * 10) / 10} h de aviso` : 'ninguna estación río arriba da tiempo de avisar'}${a.razones && a.razones.length ? `<br><span class="nota">${esc(a.razones.join('; '))}.</span>` : ''}</li>`).join('');
  const eventos = (f.eventos || []).sort((a, b) => String(b.fecha).localeCompare(a.fecha)).map(e =>
    `<li><b>${esc(String(e.fecha).slice(0, 10))}</b>${e.severidad ? ` (${esc(e.severidad)})` : ''}: ${esc(e.impacto || 'sin detalle')}${e.url ? ` <a href="${esc(e.url)}" target="_blank" rel="noopener">fuente</a>` : ''}</li>`).join('');
  const caja = document.getElementById('detalle-loc');
  caja.hidden = false;
  const enlace = new URL(`l/${slug(f.localidad)}/`, location.href.split(/[?#]/)[0]).href;
  const textoCompartir = `${f.localidad}: ${f.ahora ? `${f.ahora} para los próximos 3 días` : 'crecidas en las sierras'}`;
  caja.innerHTML = `<h3>${esc(f.localidad)}</h3>
    <div class="compartir"><button type="button" class="boton-sec" id="compartir-loc">Compartir</button>
      <a class="boton-sec" href="https://wa.me/?text=${encodeURIComponent(`${textoCompartir} ${enlace}`)}" target="_blank" rel="noopener">Enviar por WhatsApp</a></div>
    <div><b>Ahora</b> ${chipAhora(f.ahora)} · <b>Exposición</b> ${chipExpo(f.exposicion)}</div>
    ${textoCondiciones(f.condiciones)}
    ${f.razones && f.razones.length ? `<div><b>Por qué está ${esc(f.exposicion || 'en la lista')}</b><ul class="razones">${f.razones.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    ${f.parecido_scm != null && f.parecido_scm < 1.5 ? '<div>Sus condiciones se parecen mucho a las de <b>San Carlos Minas en 1992</b>.</div>' : ''}
    <div>Estación que avisa: ${f.aviso ? `<span class="aviso-${CLASE_AVISO[f.aviso]}">${TEXTO_AVISO[f.aviso]}</span>` : 'sin datos'}${f.danos_registrados ? ` · ${f.danos_registrados} daños verificados en imágenes a menos de 4 km` : ''}</div>
    ${arroyos ? `<div><b>Arroyos que entran al pueblo</b><ul>${arroyos}</ul></div>` : '<div>No se encontraron arroyos serranos que entren a esta localidad.</div>'}
    <div><b>Crecidas registradas</b>${eventos ? `<ul>${eventos}</ul>` : ' ninguna en el inventario todavía.'}</div>
    ${f.campings_bajos ? `<div><b>Campings y balnearios a menos de 5 m sobre un río</b> (según el relieve satelital; no es una evaluación del lugar)<ul>${f.campings_bajos.map(c => `<li>${esc(c.nombre)} (${esc(c.tipo)}${c.altura_m != null ? `, ~${c.altura_m} m sobre el cauce` : ''})</li>`).join('')}</ul></div>` : ''}
    ${relatosDe(f)}`;
  document.getElementById('compartir-loc').addEventListener('click', async ev => {
    try {
      if (navigator.share) await navigator.share({ title: textoCompartir, text: textoCompartir, url: enlace });
      else { await navigator.clipboard.writeText(enlace); ev.target.textContent = 'Link copiado'; }
    } catch (e) { /* la persona canceló */ }
  });
  caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

pronostico();
portada();
const inicial = location.hash.slice(1);
mostrar(PESTANAS.includes(inicial) ? inicial : 'inicio');
window.addEventListener('hashchange', () => {
  const p = location.hash.slice(1);
  if (PESTANAS.includes(p)) mostrar(p);
});


function popupComunidad(p) {
  return `<b>${esc(p.localidad)}</b>${p.arroyo ? ` · ${esc(p.arroyo)}` : ''}<br>Exposición ${chipExpo(p.exposicion)}` +
    (p.razones ? `<br>${esc(p.razones)}.` : '') +
    `<br>Unas ${p.personas_expuestas ?? '?'} personas cerca del cauce.` +
    `<br>${p.margen_aprox_min >= 30 ? `Una estación río arriba da unas ${Math.round(p.margen_aprox_min / 6) / 10} h de aviso.` : 'Ninguna estación río arriba da tiempo de avisar.'}`;
}

// ---------------------------------------------------------------- relatos aprobados
const httpsSeguro = u => /^https:\/\//.test(String(u || '')) ? u : '';

function fotosHtml(fotos, clase = 'fotos-relato') {
  const ok = (fotos || []).map(httpsSeguro).filter(Boolean);
  return ok.length ? `<div class="${clase}">${ok.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Foto del aporte" loading="lazy"></a>`).join('')}</div>` : '';
}

function popupAporte(p) {
  return `<b>${esc(p.localidad)}</b> · ${esc(p.fecha_evento || '')}<br>${esc(p.relato || '')}` +
    (p.altura_agua ? `<br><i>Hasta dónde llegó el agua:</i> ${esc(p.altura_agua)}` : '') + fotosHtml(p.fotos);
}

function relatosDe(f) {
  if (!f.relatos || !f.relatos.length) return '';
  return `<div><b>Relatos de vecinos y visitantes</b><div class="relatos">${f.relatos.map(r => `<div class="relato">
    <b>${esc(r.fecha_evento || 'sin fecha')}</b>: ${esc(r.relato)}${r.altura_agua ? ` <i>(hasta dónde llegó el agua: ${esc(r.altura_agua)})</i>` : ''}
    ${fotosHtml(r.fotos)}</div>`).join('')}</div></div>`;
}

// ---------------------------------------------------------------- formulario de aportes
const MAX_FOTOS = 3, LADO_MAX = 1600;
let fotosListas = [], puntoAporte = null, marcaAporte = null, widgetTurnstile = null;

async function aporta() {
  const cfgA = window.PREDINUN || {};
  const activo = cfgA.aportesUrl && cfgA.turnstileSitekey;
  const form = document.getElementById('form-aporte');
  if (!activo) {
    document.getElementById('aporta-inactivo').hidden = false;
    form.querySelectorAll('input, textarea, button').forEach(el => el.disabled = true);
  }
  mapas.aporte = mapaBase('mapa-aporte', 9);
  mapas.aporte.on('click', e => marcar(e.latlng.lat, e.latlng.lng));
  document.getElementById('usar-ubicacion').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => { marcar(pos.coords.latitude, pos.coords.longitude); mapas.aporte.setView([pos.coords.latitude, pos.coords.longitude], 15); },
      () => { document.getElementById('punto-elegido').textContent = 'No se pudo obtener tu ubicación.'; },
      { enableHighAccuracy: true, timeout: 15000 });
  });
  document.getElementById('borrar-punto').addEventListener('click', () => marcar(null));
  const d = await leer('localidades.json');
  if (d) document.getElementById('lista-localidades').innerHTML =
    d.localidades.map(f => `<option value="${esc(f.localidad)}">`).join('');
  document.getElementById('fotos').addEventListener('change', prepararFotos);
  form.addEventListener('submit', enviarAporte);
  if (activo) cargarTurnstile(cfgA.turnstileSitekey);
}

function marcar(lat, lon) {
  if (marcaAporte) { marcaAporte.remove(); marcaAporte = null; }
  puntoAporte = lat == null ? null : { lat, lon };
  document.getElementById('borrar-punto').hidden = !puntoAporte;
  document.getElementById('punto-elegido').textContent = puntoAporte ? `Punto: ${lat.toFixed(4)}, ${lon.toFixed(4)}` : '';
  if (puntoAporte) marcaAporte = L.marker([lat, lon]).addTo(mapas.aporte);
}

function cargarTurnstile(sitekey) {
  window.onTurnstileListo = () => {
    widgetTurnstile = window.turnstile.render('#turnstile', { sitekey, language: 'es' });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileListo&render=explicit';
  s.async = true;
  document.head.appendChild(s);
}

// Achica cada foto en el navegador y la vuelve a codificar como JPEG: así pesa poco y pierde los datos EXIF (GPS)
function achicar(archivo) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, LADO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
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

async function prepararFotos(ev) {
  const estado = document.getElementById('estado-aporte');
  const archivos = [...ev.target.files].slice(0, MAX_FOTOS);
  if (ev.target.files.length > MAX_FOTOS) estado.textContent = `Se usan solo las primeras ${MAX_FOTOS} fotos.`;
  fotosListas = [];
  const vista = document.getElementById('vista-fotos');
  vista.innerHTML = '';
  for (const a of archivos) {
    try {
      const b = await achicar(a);
      fotosListas.push(b);
      const img = document.createElement('img');
      img.src = URL.createObjectURL(b); img.alt = 'Foto elegida';
      vista.appendChild(img);
    } catch (e) {
      estado.textContent = `No se pudo usar la foto «${a.name}» (${e.message}). Probá con otra.`;
    }
  }
}

async function enviarAporte(ev) {
  ev.preventDefault();
  const form = ev.target, estado = document.getElementById('estado-aporte'), boton = document.getElementById('enviar-aporte');
  const cfgA = window.PREDINUN || {};
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  if (String(fd.get('relato') || '').trim().length < 20) { estado.textContent = 'Contanos un poco más: el relato es muy corto.'; return; }
  const token = widgetTurnstile != null && window.turnstile ? window.turnstile.getResponse(widgetTurnstile) : '';
  if (!token) { estado.textContent = 'Esperá a que termine la verificación antispam y probá de nuevo.'; return; }
  fd.set('cf-turnstile-response', token);
  fd.delete('fotos');
  fotosListas.forEach((b, i) => fd.append('fotos', b, `foto-${i + 1}.jpg`));
  if (puntoAporte) { fd.set('lat', puntoAporte.lat); fd.set('lon', puntoAporte.lon); }
  boton.disabled = true; estado.textContent = 'Enviando…';
  try {
    const r = await fetch(cfgA.aportesUrl.replace(/\/$/, '') + '/aportes', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `error ${r.status}`);
    form.reset(); fotosListas = []; document.getElementById('vista-fotos').innerHTML = ''; marcar(null);
    estado.innerHTML = '<b>¡Gracias!</b> Recibimos tu aporte. Lo vamos a revisar y, si está todo bien, va a aparecer en el mapa en unos días.';
  } catch (e) {
    estado.textContent = `No se pudo enviar: ${e.message}`;
  } finally {
    boton.disabled = false;
    if (window.turnstile && widgetTurnstile != null) window.turnstile.reset(widgetTurnstile);
  }
}

// ---------------------------------------------------------------- inicio
// Igual que slug() en scripts/paginas_compartir.py: las páginas docs/l/<slug>/ dan la vista previa al compartir.
const slug = n => sinTildes(n).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function irALocalidad(nombre) {
  try { history.replaceState(null, '', `?localidad=${encodeURIComponent(nombre)}#riesgo`); } catch (e) {}
  const yaEstaba = !!mapas.riesgo;
  mostrar('riesgo');
  if (yaEstaba) elegirLocalidad(LOCS.find(f => f.localidad === nombre));
}

async function portada() {
  const [locs, a, b] = await Promise.all([cargarLocs(), leer('ahora.json'), leer('boletin.json')]);
  prepararSugerencias('buscar-portada', 'sugerencias-portada', f => irALocalidad(f.localidad));
  const alerta = locs.filter(f => f.ahora === 'alerta'), atencion = locs.filter(f => f.ahora === 'atención');
  const lista = fs => `<div class="locs">${fs.map(f => `<button type="button" class="loc-link" data-loc="${esc(f.localidad)}">${esc(f.localidad)}</button>`).join('')}</div>`;
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  let h;
  if (!CONDICIONES) h = '<p>Todavía no hay pronóstico por localidad.</p>';
  else if (!alerta.length && !atencion.length) {
    h = `<div class="estado-titulo n-verde"><span class="punto"></span>No se espera lluvia fuerte en las sierras en los próximos 3 días.</div>`;
  } else {
    h = (alerta.length ? `<div class="estado-titulo n-rojo"><span class="punto"></span>${plural(alerta.length, 'localidad en alerta', 'localidades en alerta')}: se espera lluvia fuerte</div>${lista(alerta)}` : '') +
        (atencion.length ? `<div class="estado-titulo n-amarillo"><span class="punto"></span>${plural(atencion.length, 'localidad en atención', 'localidades en atención')}</div>${lista(atencion)}` : '') +
        `<div class="estado-titulo n-verde"><span class="punto"></span>El resto, normal</div>`;
  }
  const altas = a ? a.cuencas.filter(c => c.nivel === 'rojo' || c.nivel === 'naranja') : [];
  if (altas.length) h += `<p class="nota">Ahora mismo, las estaciones marcan valores altos en ${altas.map(c => esc(c.nombre)).join(', ')}. <button type="button" class="loc-link" data-ir="ahora">Ver estaciones</button></p>`;
  if (CONDICIONES) h += `<p class="nota">Para los próximos 3 días, según el pronóstico del ${esc(CONDICIONES.generado)}. Tocá una localidad para ver el detalle.</p>`;
  const caja = document.getElementById('estado-hoy');
  caja.innerHTML = h;
  caja.querySelectorAll('[data-loc]').forEach(x => x.addEventListener('click', () => irALocalidad(x.dataset.loc)));
  caja.querySelectorAll('[data-ir]').forEach(x => x.addEventListener('click', () => { mostrar(x.dataset.ir); window.scrollTo(0, 0); }));

  const poner = (id, t) => { if (t) document.getElementById(id).textContent = t; };
  poner('act-estaciones', a && a.actualizado && `Último dato: ${a.actualizado}`);
  poner('act-pronostico', b && b.generado && `Último pronóstico: ${b.generado}`);
  const smap = b && (b.cuencas || []).map(c => c.suelo && c.suelo.smap_fecha).find(Boolean);
  poner('act-smap', smap && `Último dato: ${smap.slice(0, 10)}`);
  const eventos = new Set(locs.flatMap(f => (f.eventos || []).map(e => `${e.fecha}|${e.impacto}`))).size;
  poner('act-inventario', eventos && `${eventos} eventos ubicados en localidades del mapa`);
}
