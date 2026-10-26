// Página estática: lee docs/data/*.json, que actualizan los workflows de GitHub Actions.
const COLOR = { verde: '#1F7A4D', normal: '#1F7A4D', amarillo: '#F2C230', naranja: '#E07B20', rojo: '#C0362C', 'sin datos': '#9AA5A0',
  'dato dudoso': '#9AA5A0', referencia: '#9AA5A0' };
const TEXTO = { verde: 'normal', normal: 'normal', amarillo: 'amarillo', naranja: 'naranja', rojo: 'rojo', 'sin datos': 'sin datos',
  'dato dudoso': 'dato dudoso', referencia: 'referencia' };
const clase = n => 'n-' + String(n || 'sin datos').replace(/ /g, '-');
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
const PESTANAS = ['inicio', 'ahora', 'pronostico', 'riesgo', 'santafe', 'aporta'];
document.querySelectorAll('.pestanas button, .acceso').forEach(b => b.addEventListener('click', () => {
  mostrar(b.dataset.p || b.dataset.ir);
  if (b.dataset.ir) window.scrollTo(0, 0);
}));
// la marca lleva a la portada de todas las zonas (index.html)
function mostrar(p) {
  document.querySelectorAll('.pestanas button').forEach(b => b.setAttribute('aria-selected', b.dataset.p === p));
  document.querySelectorAll('.pagina').forEach(s => s.hidden = s.id !== 'p-' + p);
  try { history.replaceState(null, '', '#' + p); } catch (e) {}
  Object.values(mapas).forEach(m => m.invalidateSize());
  if (p === 'ahora' && !mapas.estaciones) ahora();
  if (p === 'riesgo' && !mapas.riesgo) riesgo();
  if (p === 'aporta' && !mapas.aporte) aporta();
  if (p === 'santafe' && !mapas.santafe) santaFe();
}

// ---------------------------------------------------------------- ahora
async function ahora() {
  const [a, e] = await Promise.all([leer('ahora.json'), leer('estaciones.json')]);
  const meta = document.getElementById('ahora-meta');
  if (!a) { meta.textContent = 'Todavía no hay datos: el monitor no corrió.'; return; }
  meta.textContent = `Estaciones: ${a.actualizado} · Pronóstico: ${a.boletin_generado || 'sin boletín'}`;
  // Las tarjetas salen de las estaciones y el pronóstico; si el radar ve una tormenta sobre la cuenca, se suma acá
  // para que no diga «normal» mientras más abajo el radar avisa por los pueblos de esa misma cuenca.
  const r = await leerRadar(), radarFresco = r && edadRadar(r) != null && edadRadar(r) <= 60;
  document.getElementById('ahora-cuencas').innerHTML = a.cuencas.map(c => {
    const t = radarFresco && r.cuencas && r.cuencas[c.cuenca];
    const sube = t && (c.nivel === 'verde' || c.nivel === 'normal');
    return `
    <article class="tarjeta ${clase(sube ? 'amarillo' : c.nivel)}"><div class="franja"></div><div class="cuerpo">
      <div class="nombre">${esc(c.nombre)}</div>
      <div class="nivel"><span class="punto"></span>${sube ? 'atención' : esc(TEXTO[c.nivel])}</div>
      ${t ? `<div class="det"><b>Radar: tormenta intensa sobre la cuenca ahora</b> (${t.max_dbz} dBZ).${sube ? ' Las estaciones todavía no miden lluvia fuerte ni crecida.' : ''}</div>` : `<div class="det">${esc(c.motivo)}</div>`}
      ${t && !sube ? `<div class="det">${esc(c.motivo)}</div>` : ''}
      ${c.suelo ? `<div class="det">Suelo: ${esc(c.suelo)}</div>` : ''}
    </div></article>`;
  }).join('');

  const est = (e && e.estaciones) || [];
  mapas.estaciones = mapaBase('mapa-estaciones');
  radarEnAhora();
  const marcas = new Map();
  est.filter(s => s.lat && s.lon && s.tipo !== 'otra').forEach(s => {
    const txt = s.tipo === 'rio'
      ? `Nivel ${s.nivel_m} m · subió ${s.subida_1h_m ?? '–'} m en 1 h`
      : `Lluvia 1 h: ${s.lluvia_1h ?? '–'} mm · 3 h: ${s.lluvia_3h ?? '–'} mm · 24 h: ${s.lluvia_24h ?? '–'} mm`;
    marcas.set(s, L.circleMarker([s.lat, s.lon], {
      radius: s.tipo === 'rio' ? 8 : 6, color: s.tipo === 'rio' ? '#0E5E5A' : '#fff', weight: 2,
      fillColor: COLOR[s.estado] || COLOR['sin datos'], fillOpacity: .9
    }).bindPopup(`<b>${esc(s.nombre)}</b> (${s.tipo === 'rio' ? 'río' : 'lluvia'})<br>${esc(txt)}<br>${esc(s.hora)} · ${esc(TEXTO[s.estado] || s.estado)}${s.nota ? `<br><i>${esc(s.nota)}</i>` : ''}`)
      .addTo(mapas.estaciones));
  });
  const orden = { rojo: 0, naranja: 1, amarillo: 2, normal: 3, 'sin datos': 4, 'dato dudoso': 5, referencia: 6 };
  const filas = est.filter(s => s.tipo !== 'otra').sort((x, y) => (orden[x.estado] - orden[y.estado]) || String(x.zona).localeCompare(y.zona));
  document.getElementById('tabla-estaciones').innerHTML =
    '<tr><th>Estado</th><th>Estación</th><th>Zona</th><th>Tipo</th><th>Hora</th><th>1 h mm</th><th>3 h mm</th><th>24 h mm</th><th>Nivel m</th><th>Sube 1 h</th></tr>' +
    filas.map((s, i) => `<tr class="${clase(s.estado)}${marcas.has(s) ? ' con-mapa' : ''}" data-i="${i}"><td title="${esc(s.nota || '')}"><span class="punto"></span>${esc(TEXTO[s.estado] || s.estado)}${s.nota ? ' *' : ''}</td>
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

// Semáforo «Ahora» (misma regla que scripts/condiciones_localidades.py, que es el que manda): rojo si se espera lluvia
// fuerte en un lugar muy expuesto, o una vez y media el umbral en uno expuesto; amarillo si se espera lluvia fuerte en
// otro lugar, o cerca del umbral en uno muy expuesto; verde en el resto.
function semaforo(c, expo) {
  if (!c) return null;
  const muy = expo === 'muy expuesta', expuesta = expo === 'expuesta', u = c.umbral_mm || 0;
  if (c.condicion === 'lluvia fuerte') return muy || (expuesta && c.max_3h_mm >= 1.5 * u) ? 'alerta' : 'atención';
  if (muy && u && c.max_3h_mm >= 0.75 * u) return 'atención';
  return 'normal';
}

// Tormenta que ve el radar en este momento: alerta si es muy intensa en un lugar expuesto o muy expuesto, o intensa
// en uno muy expuesto; atención en el resto de los casos.
function semaforoRadar(v, expo) {
  if (!v) return null;
  if (expo === 'muy expuesta' || (expo === 'expuesta' && v.nivel === 'muy intensa')) return 'alerta';
  return 'atención';
}

let RADAR = null;
function combinar(f) {
  const c = CONDICIONES && CONDICIONES.localidades[f.localidad];
  const pron = c && c.ahora ? c.ahora : semaforo(c, f.exposicion);   // el boletín ya lo calcula; si no, la misma regla acá
  const fresco = RADAR && edadRadar(RADAR) != null && edadRadar(RADAR) <= 60;
  const tormenta = fresco ? (RADAR.localidades || {})[f.localidad] || null : null;
  const rad = semaforoRadar(tormenta, f.exposicion);
  const a = (ORDEN_AHORA[rad] || 0) > (ORDEN_AHORA[pron] || 0) ? rad : (pron || (fresco ? 'normal' : null));
  return { ...f, ahora: a, ahora_por: a && a === rad && rad !== pron ? 'tormenta' : 'pronóstico', ahora_pronostico: pron, tormenta,
           condiciones: c || null, orden_ahora: (ORDEN_AHORA[a] || 0) * 10 + (ORDEN_EXPO[f.exposicion] || 0),
           orden_expo: ORDEN_EXPO[f.exposicion] || 0 };
}

function dibujarCapaAhora() {
  const con = LOCS.filter(f => f.ahora === 'alerta' || f.ahora === 'atención');
  capaAhora = L.layerGroup(con.map(f => L.circleMarker([f.lat, f.lon], { radius: f.ahora === 'alerta' ? 12 : 9, color: '#fff', weight: 2,
    fillColor: COLOR_AHORA[f.ahora], fillOpacity: .95 }).bindPopup(`<b>${esc(f.localidad)}</b> ${chipAhora(f.ahora)}<br>` +
    (f.ahora_por === 'tormenta' ? `Tormenta ${esc(f.tormenta.nivel)} a ${f.tormenta.km} km en este momento (radar).<br>` : '') +
    (f.condiciones ? `Hasta ${f.condiciones.max_3h_mm} mm en 3 horas en los próximos 3 días.<br>` : '') + `<button type="button" class="loc-link" data-ficha="${esc(f.localidad)}">Ver detalle</button>`)));
  capaAhora.addTo(mapas.riesgo);
  if (!mapas.riesgo._fichaEnPopup) {
    mapas.riesgo._fichaEnPopup = true;
    mapas.riesgo.on('popupopen', ev => ev.popup.getElement().querySelectorAll('[data-ficha]').forEach(b =>
      b.addEventListener('click', () => { mapas.riesgo.closePopup(); elegirLocalidad(LOCS.find(x => x.localidad === b.dataset.ficha)); })));
  }
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
  l.innerHTML = `<input type="checkbox" checked><span class="punto" style="--c:${COLOR_AHORA.alerta}"></span>Alerta o atención: tormenta ahora o lluvia pronosticada (${con.length})`;
  l.querySelector('input').addEventListener('change', ev => ev.target.checked ? capaAhora.addTo(mapas.riesgo) : capaAhora.remove());
  document.getElementById('capas').prepend(l);
  const n = { alerta: con.filter(f => f.ahora === 'alerta').length, 'atención': con.filter(f => f.ahora === 'atención').length };
  document.getElementById('resumen-ahora').innerHTML = !CONDICIONES ? 'Todavía no hay pronóstico por localidad.'
    : n.alerta || n['atención'] ? `Ahora: ${n.alerta ? `<b>${n.alerta}</b> localidad${n.alerta > 1 ? 'es' : ''} en ${chipAhora('alerta')}` : ''}${n.alerta && n['atención'] ? ' y ' : ''}${n['atención'] ? `<b>${n['atención']}</b> en ${chipAhora('atención')}` : ''}. El resto, ${chipAhora('normal')}.`
    : `Ahora: todas las localidades en ${chipAhora('normal')}. No se espera lluvia fuerte en los próximos 3 días.`;
}

let cargaLocs = null;
function cargarLocs() {
  cargaLocs ||= Promise.all([leer('localidades.json'), leer('condiciones_localidades.json'), leerRadar()]).then(([d, c, r]) => {
    CONDICIONES = c; RADAR = r;
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
function prepararSugerencias(idInput = 'buscar-loc', idLista = 'sugerencias-loc', alElegir = null, opciones = {}) {
  const fuente = opciones.lista || (() => LOCS), extra = opciones.extra || (f => `${f.ahora === 'alerta' || f.ahora === 'atención' ? chipAhora(f.ahora) + ' ' : ''}${chipExpo(f.exposicion)}`);
  const input = document.getElementById(idInput), lista = document.getElementById(idLista);
  let sugeridas = [], marcada = -1;
  const cerrar = () => { lista.hidden = true; input.setAttribute('aria-expanded', 'false'); marcada = -1; };
  const pintar = () => {
    const q = sinTildes(input.value.trim());
    if (!q) { cerrar(); return; }
    // primero las que empiezan así, después las que tienen una palabra que empieza así («car» → Villa Carlos Paz)
    const rango = f => { const n = sinTildes(f.localidad); return n.startsWith(q) ? 0 : (' ' + n).includes(' ' + q) ? 1 : 2; };
    sugeridas = fuente().filter(f => sinTildes(f.localidad).includes(q))
      .sort((a, b) => rango(a) - rango(b) || a.localidad.localeCompare(b.localidad))
      .slice(0, 8);
    lista.innerHTML = sugeridas.length ? sugeridas.map((f, i) => {
      const n = sinTildes(f.localidad), k = n.indexOf(q);
      const nombre = esc(f.localidad.slice(0, k)) + '<mark>' + esc(f.localidad.slice(k, k + q.length)) + '</mark>' + esc(f.localidad.slice(k + q.length));
      return `<li role="option" id="${idLista}-${i}" data-i="${i}" aria-selected="${i === marcada}"><span>${nombre}</span><span>${extra(f)}</span></li>`;
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
  // Encuadrar la localidad y los puntos donde sus arroyos entran al pueblo (pueden estar a varios km del centro)
  const puntos = [[f.lat, f.lon], ...(f.arroyos || []).map(a => [a.lat, a.lon])];
  setTimeout(() => puntos.length > 1
    ? mapas.riesgo.fitBounds(L.latLngBounds(puntos).pad(0.25), { maxZoom: 13 })
    : mapas.riesgo.setView([f.lat, f.lon], 13), 50);
  if (marcaLoc) marcaLoc.remove();
  marcaLoc = L.layerGroup().addTo(mapas.riesgo);
  (f.arroyos || []).forEach((a, i) => L.circleMarker([a.lat, a.lon], { radius: 11, color: '#0E5E5A', weight: 4, fillColor: '#fff', fillOpacity: .6 })
    .bindTooltip(`${i + 1}. ${esc(a.arroyo)}`, { permanent: true, direction: 'top', offset: [0, -10] }).addTo(marcaLoc));
  const arroyos = (f.arroyos || []).map((a, i) => `<li><button type="button" class="loc-link ver-arroyo" data-i="${i}">${i + 1}. Ver en el mapa</button> <b>${esc(a.arroyo)}</b> ${chipExpo(a.exposicion)} · cuenca de ${Math.round(a.area_km2)} km² · unas ${a.personas} personas cerca del cauce · ${a.margen_min != null && a.margen_min >= 30 ? `hay una estación río arriba que da unas ${Math.round(a.margen_min / 60 * 10) / 10} h de aviso` : 'ninguna estación río arriba da tiempo de avisar'}${a.razones && a.razones.length ? `<br><span class="nota">${esc(a.razones.join('; '))}.</span>` : ''}</li>`).join('');
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
    ${f.ahora_por === 'tormenta' ? `<div class="lluvia-fuerte">Está en ${esc(f.ahora)} por la tormenta que ve el radar en este momento${f.ahora_pronostico ? `; por el pronóstico de 3 días estaría en ${esc(f.ahora_pronostico)}` : ''}.</div>` : ''}
    <div id="smn-loc"></div>
    <div id="radar-loc"></div>
    ${textoCondiciones(f.condiciones)}
    ${f.razones && f.razones.length ? `<div><b>Por qué está ${esc(f.exposicion || 'en la lista')}</b><ul class="razones">${f.razones.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    ${f.parecido_scm != null && f.parecido_scm < 1.5 ? '<div>El terreno tiene rasgos de los que agravan las crecidas repentinas: cuenca empinada, cauce que se angosta o puentes que se pueden tapar.</div>' : ''}
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
  bloqueSMNLocalidad(f.localidad).then(h => { const el = document.getElementById('smn-loc'); if (el) el.innerHTML = h; });
  leerRadar().then(r => {
    const v = r && r.localidades && r.localidades[f.localidad], edad = edadRadar(r), el = document.getElementById('radar-loc');
    if (!el || edad == null || edad > 90) return;
    el.innerHTML = v ? `<span class="lluvia-fuerte">En este momento: tormenta ${esc(v.nivel)} ${v.cuenca_de ? `sobre la cuenca del ${esc(v.cuenca_de)}, ` : v.subcuenca ? `sobre la ${esc(v.subcuenca)}, ` : ''}a ${v.km} km, según el radar (hace ${edad} min).</span>`
      : `<b>En este momento</b>: el radar no ve tormentas intensas cerca (hace ${edad} min).`;
  });
  caja.querySelectorAll('.ver-arroyo').forEach(b => b.addEventListener('click', () => {
    const a = f.arroyos[Number(b.dataset.i)];
    document.getElementById('mapa-riesgo').scrollIntoView({ behavior: 'smooth', block: 'center' });
    mapas.riesgo.setView([a.lat, a.lon], 15);
  }));
  caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

pronostico();
portada();
avisoDatosViejos();
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

// Una localidad de Santa Fe elegida en el buscador de Inicio: a la pestaña Santa Fe, con su ficha
function irASantaFe(nombre) {
  mostrar('santafe');
  let n = 0;
  const esperar = setInterval(() => {   // la pestaña carga santafe.json la primera vez
    if (SF || ++n > 50) { clearInterval(esperar); if (SF) elegirSF(nombre); }
  }, 100);
}

async function portada() {
  const [locs, a, b, sf] = await Promise.all([cargarLocs(), leer('ahora.json'), leer('boletin.json'), leer('santafe.json')]);
  const deSantaFe = ((sf && sf.localidades) || []).map(f => ({ localidad: f.localidad, _sf: true }));
  prepararSugerencias('buscar-portada', 'sugerencias-portada', f => f._sf ? irASantaFe(f.localidad) : irALocalidad(f.localidad), {
    lista: () => [...LOCS, ...deSantaFe],
    extra: f => f._sf ? '<span class="chip expo">Santa Fe</span>'
      : `${f.ahora === 'alerta' || f.ahora === 'atención' ? chipAhora(f.ahora) + ' ' : ''}${chipExpo(f.exposicion)}`,
  });
  const alerta = locs.filter(f => f.ahora === 'alerta'), atencion = locs.filter(f => f.ahora === 'atención');
  const lista = fs => `<div class="locs">${fs.map(f => `<button type="button" class="loc-link" data-loc="${esc(f.localidad)}">${esc(f.localidad)}</button>`).join('')}</div>`;
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  // Siempre las tres cantidades, aunque sean cero: sirven para comparar
  const normales = locs.filter(f => f.ahora === 'normal');
  let h;
  if (!CONDICIONES) h = '<p>Todavía no hay pronóstico por localidad.</p>';
  else {
    h = `<div class="estado-titulo n-rojo"><span class="punto"></span>${plural(alerta.length, 'localidad en alerta', 'localidades en alerta')}</div>${alerta.length ? lista(alerta) : ''}` +
        `<div class="estado-titulo n-amarillo"><span class="punto"></span>${plural(atencion.length, 'localidad en atención', 'localidades en atención')}</div>${atencion.length ? lista(atencion) : ''}` +
        `<div class="estado-titulo n-verde"><span class="punto"></span>${plural(normales.length, 'localidad normal', 'localidades normales')}${!alerta.length && !atencion.length ? ': no se espera lluvia fuerte en los próximos 3 días' : ''}</div>`;
  }
  const altas = a ? a.cuencas.filter(c => c.nivel === 'rojo' || c.nivel === 'naranja') : [];
  if (altas.length) h += `<p class="nota">Ahora mismo, las estaciones marcan valores altos en ${altas.map(c => esc(c.nombre)).join(', ')}. <button type="button" class="loc-link" data-ir="ahora">Ver estaciones</button></p>`;
  if (CONDICIONES) h += `<p class="nota">El semáforo combina el pronóstico de los próximos 3 días (del ${esc(CONDICIONES.generado)}) con las tormentas que ve el radar en este momento. Tocá una localidad para ver el detalle.</p>`;
  const r = await leerRadar();
  const edad = edadRadar(r);
  if (r && edad != null && edad <= 90 && Object.keys(r.localidades || {}).length) h = `<div class="radar-ahora">${textoRadar(r, 8)}</div>` + h;
  if (r && r.observacion) document.getElementById('act-radar').textContent = `Último dato: ${r.observacion}`;
  leerSMN().then(d => { if (d) document.getElementById('act-smn').textContent = `Última consulta: ${d.consultado}`; });
  h = (await bloqueSMNInicio()) + h;
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

// ---------------------------------------------------------------- radar (OHMC)
// docs/data/radar.json lo escribe scripts/radar_ohmc.py cada 15 minutos con los núcleos de tormenta del radar de Córdoba.
function leerRadar() {   // declarada como función para poder usarla antes de esta línea
  leerRadar.carga ||= leer('radar.json');
  return leerRadar.carga;
}
const COLOR_DBZ = d => d >= 60 ? '#FF2A98' : d >= 50 ? '#FF2A0C' : d >= 40 ? '#f7a600' : '#7BB661';

function edadRadar(r) {
  if (!r || !r.observacion) return null;
  return Math.round((Date.now() - new Date(r.observacion.replace(' ', 'T') + ':00-03:00')) / 60000);
}

function textoRadar(r, lim = 20) {
  const edad = edadRadar(r);
  if (edad == null) return 'Sin datos del radar por ahora.';
  if (edad > 90) return `El último dato del radar es de hace más de una hora (${esc(r.observacion)}): puede estar fuera de servicio.`;
  const locs = Object.entries(r.localidades || {}).sort((a, b) => b[1].max_dbz - a[1].max_dbz || a[1].km - b[1].km);
  const hace = `hace ${edad} min`;
  if (!locs.length) {
    return `<div class="estado-titulo n-verde"><span class="punto"></span>Sin tormentas intensas cerca de las localidades serranas</div>` +
      `<p class="nota">Radar de Córdoba, ${hace}${r.nucleos.length ? ` · ${r.nucleos.length} núcleos débiles o lejanos en la zona` : ''}.</p>`;
  }
  const muy = locs.filter(([, v]) => v.nivel === 'muy intensa').length;
  return `<div class="estado-titulo ${muy ? 'n-rojo' : 'n-naranja'}"><span class="punto"></span>Tormenta ${muy ? 'muy intensa' : 'intensa'} cerca de ${locs.length} localidad${locs.length > 1 ? 'es' : ''} ahora</div>` +
    (lim ? `<div class="locs">${locs.slice(0, lim).map(([n, v]) => `<button type="button" class="loc-link" data-loc="${esc(n)}" title="${esc(v.nivel)}, a ${v.km} km">${esc(n)}</button>`).join('')}${locs.length > lim ? `<span class="nota">y ${locs.length - lim} más</span>` : ''}</div>` : '') +
    `<p class="nota">Radar de Córdoba, ${hace}. Una tormenta sobre la cuenca puede hacer crecer el arroyo en minutos, aunque en el pueblo todavía no llueva. Esto es lo que ve el radar, no un aviso oficial.</p>`;
}

async function radarEnAhora() {
  const r = await leerRadar();
  const caja = document.getElementById('radar-ahora');
  caja.innerHTML = textoRadar(r) + `<p class="nota">Fuente: radar del <a href="https://webmet.ohmc.ar/" target="_blank" rel="noopener">Observatorio Hidro-Meteorológico de Córdoba (OHMC)</a>. Los puntos en el mapa son los núcleos de tormenta detectados.</p>`;
  caja.querySelectorAll('[data-loc]').forEach(x => x.addEventListener('click', () => irALocalidad(x.dataset.loc)));
  if (!r || edadRadar(r) == null || edadRadar(r) > 90) return;
  r.nucleos.forEach(n => L.circleMarker([n.lat, n.lon], { radius: n.max_dbz >= 55 ? 9 : 6, color: '#16201C', weight: 1, dashArray: '2 2',
    fillColor: COLOR_DBZ(n.max_dbz || n.dbz), fillOpacity: .75 })
    .bindPopup(`<b>Núcleo de tormenta</b><br>Intensidad máxima: ${n.max_dbz} dBZ${n.tope_km ? `<br>Tope: ${n.tope_km} km de altura` : ''}<br>Radar de Córdoba (OHMC), ${esc(r.observacion.slice(11))}`)
    .addTo(mapas.estaciones));
}

// ---------------------------------------------------------------- datos viejos
// Si el monitor dejó de correr (GitHub Actions caído, por ejemplo), la página lo dice en vez de mostrar datos viejos como actuales.
async function avisoDatosViejos() {
  const a = await leer('ahora.json');
  const caja = document.getElementById('datos-viejos');
  if (!caja) return;
  const min = a && a.actualizado ? Math.round((Date.now() - new Date(a.actualizado.replace(' ', 'T') + ':00-03:00')) / 60000) : null;
  if (min != null && min <= 45) return;
  caja.hidden = false;
  caja.innerHTML = min == null
    ? '<b>No se pudieron cargar los datos de las estaciones.</b> Revisá tu conexión, o consultá los canales oficiales.'
    : `<b>Atención: los datos tienen ${min >= 120 ? `${Math.floor(min / 60)} horas` : `${min} minutos`} de antigüedad</b> (último: ${esc(a.actualizado)}). ` +
      'El monitor se actualiza cada 15 minutos; puede haber un problema. No tomes lo que ves como la situación actual: consultá los canales oficiales.';
}

// ---------------------------------------------------------------- alertas oficiales del SMN
// docs/data/smn.json lo escribe scripts/smn_alertas.py cada 15 minutos (feed CAP del Servicio Meteorológico Nacional).
function leerSMN() {
  leerSMN.carga ||= leer('smn.json');
  return leerSMN.carga;
}
const ICONO_SMN = { rojo: '🔴', naranja: '🟠', amarillo: '🟡' };
const CLASE_SMN = { rojo: 'n-rojo', naranja: 'n-naranja', amarillo: 'n-amarillo' };

function agruparSMN(alertas) {
  const g = new Map();
  for (const a of alertas) {
    const k = [a.tipo, a.titulo, a.nivel, a.hasta_local].join('|');
    if (!g.has(k)) g.set(k, { ...a, ids: [] });
    g.get(k).ids.push(a.id);
  }
  return [...g.values()];
}

function textoSMN(a, cuantas) {
  return `${ICONO_SMN[a.nivel]} <b>${a.tipo === 'aviso a corto plazo' ? 'Aviso a corto plazo' : 'Alerta'} oficial del SMN</b>: ` +
    `${esc(a.titulo)} (nivel ${esc(a.nivel)}), hasta ${esc(a.hasta_local)} h${cuantas != null ? ` · ${cuantas} localidad${cuantas === 1 ? '' : 'es'}` : ''}.`;
}

// clave: 'localidades' (Córdoba) o 'localidades_santafe'. Solo se muestran las alertas que tocan alguna localidad de esa zona.
async function bloqueSMNInicio(clave = 'localidades') {
  const d = await leerSMN();
  if (!d || !d.alertas.length) return '';
  const zona = d[clave] || {};
  const grupos = agruparSMN(d.alertas).map(a => ({ a, n: Object.values(zona).filter(v => v.some(i => a.ids.includes(i))).length })).filter(x => x.n);
  if (!grupos.length) return '';
  return `<div class="smn">${grupos.map(({ a, n }) =>
      `<div class="estado-titulo ${CLASE_SMN[a.nivel]}" style="font-weight:400">${textoSMN(a, n)}</div>`).join('')}<p class="nota">Avisos oficiales del <a href="https://www.smn.gob.ar/alertas" target="_blank" rel="noopener">Servicio Meteorológico Nacional</a>. Buscá tu localidad para ver si te toca.</p></div>`;
}

async function bloqueSMNLocalidad(nombre, clave = 'localidades') {
  const d = await leerSMN();
  const ids = d && (d[clave] || {})[nombre];
  if (!ids || !ids.length) return '';
  const propias = agruparSMN(d.alertas.filter(a => ids.includes(a.id)));
  return propias.map(a => `<div class="smn-loc ${CLASE_SMN[a.nivel]}">${textoSMN(a)}` +
    (a.instruccion ? `<details><summary>Qué recomienda el SMN</summary><p>${esc(a.instruccion)}</p></details>` : '') + '</div>').join('');
}

// ---------------------------------------------------------------- Santa Fe y región
// docs/data/santafe.json lo escribe scripts/santa_fe.py cada 6 horas: ríos (INA) y lluvia por localidad (Open-Meteo).
const TEXTO_RIO = { rojo: 'evacuación', naranja: 'alerta', amarillo: 'atención', normal: 'normal', 'sin dato reciente': 'sin dato reciente' };
const CLASE_RIO = { rojo: 'n-rojo', naranja: 'n-naranja', amarillo: 'n-amarillo', normal: 'n-verde', 'sin dato reciente': 'n-sin-datos' };
const COLOR_RIO = { rojo: '#C0362C', naranja: '#E07B20', amarillo: '#F2C230', normal: '#1F7A4D', 'sin dato reciente': '#9AA5A0' };
const CLASE_LLUVIA = { 'lluvia fuerte': 'n-rojo', 'atención': 'n-naranja', normal: 'n-verde' };
let SF = null;
const fechaCorta = f => f ? f.slice(8, 10) + '/' + f.slice(5, 7) : '–';
const metros = v => v == null ? '–' : v.toFixed(2).replace('.', ',') + ' m';

function graficoRio(r) {   // las alturas de los últimos 30 días, el pronóstico (medio y rango) y las líneas de alerta y evacuación
  const obs = r.historia || [], pr = (r.pronostico && r.pronostico.puntos) || [];
  if (obs.length < 2) return '';
  const dia = f => Date.parse(f + 'T12:00:00');
  const t0 = dia(obs[0][0]), t1 = Math.max(dia(obs[obs.length - 1][0]), ...pr.map(p => dia(p[0])));
  const valores = [...obs.map(o => o[1]), ...pr.flatMap(p => [p[1], p[3]]).filter(v => v != null), r.alerta_m, r.evacuacion_m].filter(v => v != null);
  const lo = Math.min(...valores) - 0.2, hi = Math.max(...valores) + 0.2, W = 300, H = 80;
  const x = t => ((t - t0) / Math.max(t1 - t0, 1)) * W, y = v => H - ((v - lo) / (hi - lo)) * H;
  const linea = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(dia(p[0])).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
  const ult = obs[obs.length - 1];
  let svg = '';
  if (r.evacuacion_m != null) svg += `<line x1="0" x2="${W}" y1="${y(r.evacuacion_m)}" y2="${y(r.evacuacion_m)}" stroke="#C0362C" stroke-dasharray="4 3"/>`;
  if (r.alerta_m != null) svg += `<line x1="0" x2="${W}" y1="${y(r.alerta_m)}" y2="${y(r.alerta_m)}" stroke="#E07B20" stroke-dasharray="4 3"/>`;
  if (pr.length) {
    const banda = [[ult[0], ult[1], ult[1]], ...pr.map(p => [p[0], p[1] ?? p[2], p[3] ?? p[2]])];
    svg += `<path d="${banda.map((p, i) => `${i ? 'L' : 'M'}${x(dia(p[0])).toFixed(1)} ${y(p[2]).toFixed(1)}`).join('')}${banda.slice().reverse().map(p => `L${x(dia(p[0])).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('')}Z" fill="var(--acento)" opacity=".15"/>`;
    svg += `<path d="${linea([ult, ...pr.map(p => [p[0], p[2]])])}" fill="none" stroke="var(--acento)" stroke-width="2" stroke-dasharray="5 3"/>`;
  }
  svg += `<path d="${linea(obs)}" fill="none" stroke="var(--tinta)" stroke-width="2"/>`;
  return `<svg class="grafico-rio" viewBox="-4 -4 ${W + 8} ${H + 8}" role="img" aria-label="Altura del río en ${esc(r.nombre)}">${svg}</svg>`;
}

function textoRio(r) {
  const t = r.tendencia_m_dia;
  const tend = t == null ? '' : Math.abs(t) < 0.01 ? 'estable' : `${t > 0 ? 'sube' : 'baja'} ${Math.round(Math.abs(t) * 100)} cm por día`;
  const falta = r.alerta_m != null && r.altura_m != null && r.altura_m < r.alerta_m ? `a ${Math.round((r.alerta_m - r.altura_m) * 100)} cm del nivel de alerta` : '';
  return [tend, falta].filter(Boolean).join(' · ');
}

async function santaFe() {
  SF = await leer('santafe.json');
  const meta = document.getElementById('sf-meta');
  if (!SF) { meta.textContent = 'Todavía no hay datos de Santa Fe.'; return; }
  meta.textContent = `Actualizado: ${SF.generado}`;
  bloqueSMNInicio('localidades_santafe').then(h => { document.getElementById('sf-smn').innerHTML = h; });

  // resumen
  const rios = SF.rios || [];
  const peor = ['rojo', 'naranja', 'amarillo'].find(n => rios.some(r => r.nivel === n));
  const enAlerta = rios.filter(r => r.nivel === 'rojo' || r.nivel === 'naranja');
  const lluvia = (SF.localidades || []).filter(f => f.condicion && f.condicion !== 'normal');
  const fuertes = lluvia.filter(f => f.condicion === 'lluvia fuerte');
  document.getElementById('sf-resumen').innerHTML =
    `<div class="estado-titulo ${CLASE_RIO[peor || 'normal']}"><span class="punto"></span>${enAlerta.length
      ? ['rojo', 'naranja'].map(n => { const l = enAlerta.filter(r => r.nivel === n); return l.length ? `${n === 'rojo' ? 'sobre el nivel de evacuación' : 'sobre el nivel de alerta'} en ${l.map(r => `${esc(r.nombre)}${r.rio !== 'Paraná' ? ` (${esc(r.rio)})` : ''}`).join(', ')}` : ''; }).filter(Boolean).join('; ').replace(/^/, enAlerta.every(r => r.rio === 'Paraná') ? 'Río Paraná ' : 'Ríos ')
      : peor === 'amarillo' ? 'Ríos: alguno se acerca al nivel de alerta' : 'Ríos: todos por debajo del nivel de alerta'}</div>` +
    `<div class="estado-titulo ${fuertes.length ? 'n-rojo' : lluvia.length ? 'n-naranja' : 'n-verde'}"><span class="punto"></span>${fuertes.length
      ? `Lluvia fuerte prevista en ${fuertes.length} localidad${fuertes.length > 1 ? 'es' : ''} en los próximos 3 días`
      : lluvia.length ? `Lluvia para tener en cuenta en ${lluvia.length} localidad${lluvia.length > 1 ? 'es' : ''} en los próximos 3 días`
      : 'Lluvia: no se espera lluvia como para anegamientos en los próximos 3 días'}</div>`;

  // tarjetas de los ríos
  const tarjeta = r => `<article class="tarjeta rio ${CLASE_RIO[r.nivel]}" data-rio="${r.id}" tabindex="0"><div class="franja"></div><div class="cuerpo">
      <div class="nombre">${esc(r.nombre)} <span class="nota">· ${esc(r.rio)}${r.provincia && r.provincia !== 'Santa Fe' ? `, ${esc(r.provincia)}` : ''}</span></div>
      <div class="nivel"><span class="punto"></span>${esc(TEXTO_RIO[r.nivel])}</div>
      <div class="altura">${metros(r.altura_m)} <span class="nota">el ${fechaCorta(r.fecha)}</span></div>
      <div class="det">${esc(textoRio(r))}</div>
      ${graficoRio(r)}
      <div class="det">Alerta ${metros(r.alerta_m)}${r.evacuacion_m != null ? ` · evacuación ${metros(r.evacuacion_m)}` : ''}</div>
      ${r.pronostico ? `<div class="det">Pronóstico del INA (${fechaCorta(r.pronostico.emitido)}): ${r.pronostico.puntos.map(p => `${fechaCorta(p[0])} ${metros(p[2])}${p[1] != null && p[3] != null ? ` <span class="nota">(${p[1].toFixed(2).replace('.', ',')} a ${p[3].toFixed(2).replace('.', ',')})</span>` : ''}`).join(' · ')}</div>` : ''}
    </div></article>`;
  document.getElementById('sf-parana').innerHTML = rios.filter(r => r.rio === 'Paraná').map(tarjeta).join('');
  document.getElementById('sf-salado').innerHTML = rios.filter(r => r.rio === 'Salado').map(tarjeta).join('');

  simulacion();

  // mapa
  const m = mapas.santafe = mapaBase('mapa-santafe', 7);
  m.setView([-31.2, -60.9], 7);
  const capaLluvia = L.layerGroup(lluvia.map(f => L.circleMarker([f.lat, f.lon], { radius: 5, color: '#fff', weight: 1,
    fillColor: f.condicion === 'lluvia fuerte' ? '#C0362C' : '#E07B20', fillOpacity: .9 })
    .bindPopup(`<b>${esc(f.localidad)}</b><br>${esc(f.condicion)}: hasta ${f.max_24h_mm} mm en 24 h (${f.max_3h_mm} mm en 3 h)`))).addTo(m);
  const marcas = {};
  rios.forEach(r => {
    marcas[r.id] = L.circleMarker([r.lat, r.lon], { radius: 9, color: '#16201C', weight: 2, fillColor: COLOR_RIO[r.nivel], fillOpacity: 1 })
      .bindPopup(`<b>${esc(r.rio)} en ${esc(r.nombre)}</b><br>${metros(r.altura_m)} el ${fechaCorta(r.fecha)} · ${esc(TEXTO_RIO[r.nivel])}<br>${esc(textoRio(r))}`)
      .bindTooltip(esc(r.nombre), { direction: 'top', offset: [0, -8] }).addTo(m);
  });
  document.querySelectorAll('[data-rio]').forEach(el => {
    const ir = () => { const r = rios.find(x => String(x.id) === el.dataset.rio); m.setView([r.lat, r.lon], 10); marcas[r.id].openPopup();
      document.getElementById('mapa-santafe').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    el.addEventListener('click', ir);
    el.addEventListener('keydown', e => { if (e.key === 'Enter') ir(); });
  });

  // lluvia por localidad
  const orden = { 'lluvia fuerte': 0, 'atención': 1 };
  document.getElementById('tabla-sf-lluvia').innerHTML = lluvia.length
    ? `<thead><tr><th>Localidad</th><th>Lluvia prevista</th><th>Máx. 24 h</th><th>Máx. 3 h</th><th>Cuándo</th><th>Últimos 7 días</th></tr></thead><tbody>` +
      lluvia.sort((a, b) => orden[a.condicion] - orden[b.condicion] || b.max_24h_mm - a.max_24h_mm).map(f => `<tr data-loc="${esc(f.localidad)}">
        <td>${esc(f.localidad)}</td><td><span class="chip ${CLASE_LLUVIA[f.condicion]}"><span class="punto"></span>${esc(f.condicion)}</span></td>
        <td class="num">${f.max_24h_mm} mm</td><td class="num">${f.max_3h_mm} mm</td><td>${f.cuando ? fechaCorta(f.cuando.slice(0, 10)) + ' ' + f.cuando.slice(11, 13) + ' h' : '–'}</td>
        <td class="num">${f.lluvia_7d_mm} mm${f.suelo_humedo ? ' <span class="nota">(suelo húmedo)</span>' : ''}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td>Ninguna localidad con lluvia como para anegamientos en los próximos 3 días.</td></tr></tbody>';
  document.querySelectorAll('#tabla-sf-lluvia [data-loc]').forEach(tr => tr.addEventListener('click', () => elegirSF(tr.dataset.loc)));

  prepararSugerencias('buscar-sf', 'sugerencias-sf', f => elegirSF(f.localidad), {
    lista: () => SF.localidades || [],
    extra: f => f.condicion && f.condicion !== 'normal' ? `<span class="chip ${CLASE_LLUVIA[f.condicion]}"><span class="punto"></span>${esc(f.condicion)}</span>` : '',
  });
  const u = SF.umbrales_lluvia || {};
  document.getElementById('sf-metodo').innerHTML =
    `<div><b>Ríos</b>: altura diaria del <a href="https://www.ina.gob.ar/alerta/" target="_blank" rel="noopener">Alerta Hidrológico del INA</a> (escalas de Prefectura en el Paraná y de la Red Hidrológica Nacional en el Salado), con los niveles de alerta y evacuación de cada lugar. <span class="chip n-naranja"><span class="punto"></span>alerta</span> y <span class="chip n-rojo"><span class="punto"></span>evacuación</span>: el río ya pasó ese nivel. <span class="chip n-amarillo"><span class="punto"></span>atención</span>: el pronóstico del INA llega al nivel de alerta, o está a menos de 30 cm y subiendo. El pronóstico del Paraná sale martes y viernes, con un rango (la franja celeste del gráfico).</div>` +
    `<div><b>Lluvia</b>: la mayor lluvia prevista en 24 h y en 3 h para los próximos 3 días (modelos vía Open-Meteo). <span class="chip n-rojo"><span class="punto"></span>lluvia fuerte</span> desde ${u.fuerte_24h} mm en 24 h o ${u.fuerte_3h} mm en 3 h; <span class="chip n-naranja"><span class="punto"></span>atención</span> desde ${u.atencion_24h} mm en 24 h o ${u.atencion_3h} mm en 3 h. Si en la última semana llovió ${u.humedo_7d} mm o más, el suelo está húmedo y cuenta menos lluvia (las tres cuartas partes). Son referencias aproximadas: cuánta agua anega cada barrio depende de los desagües.</div>`;
}

function elegirSF(nombre) {
  const f = (SF.localidades || []).find(x => x.localidad === nombre);
  if (!f) return;
  const caja = document.getElementById('sf-ficha');
  // estación de río más cercana a menos de 25 km
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180));
  const rio = (SF.rios || []).map(r => ({ r, d: km(f, r) })).filter(x => x.d <= 25).sort((a, b) => a.d - b.d)[0];
  caja.hidden = false;
  caja.innerHTML = `<h3>${esc(f.localidad)}</h3><div id="sf-smn-loc"></div>
    <div><b>Lluvia en los próximos 3 días</b>: ${f.condicion ? `<span class="chip ${CLASE_LLUVIA[f.condicion]}"><span class="punto"></span>${esc(f.condicion)}</span> hasta ${f.max_24h_mm} mm en 24 h y ${f.max_3h_mm} mm en 3 h${f.cuando && f.max_24h_mm > 0 ? `, sobre todo el ${fechaCorta(f.cuando.slice(0, 10))} cerca de las ${f.cuando.slice(11, 13)} h` : ''}.` : 'sin pronóstico.'}</div>
    <div class="nota">En la última semana llovieron ${f.lluvia_7d_mm ?? '–'} mm${f.suelo_humedo ? ': el suelo está húmedo y una lluvia más chica ya puede anegar' : ''}.</div>
    ${rio ? `<div><b>Río ${esc(rio.r.rio)} en ${esc(rio.r.nombre)}</b> (a ${Math.round(rio.d)} km): <span class="chip ${CLASE_RIO[rio.r.nivel]}"><span class="punto"></span>${esc(TEXTO_RIO[rio.r.nivel])}</span> ${metros(rio.r.altura_m)} el ${fechaCorta(rio.r.fecha)}. ${esc(textoRio(rio.r))}</div>` : ''}`;
  bloqueSMNLocalidad(f.localidad, 'localidades_santafe').then(h => { const el = document.getElementById('sf-smn-loc'); if (el) el.innerHTML = h; });
  if (mapas.santafe) mapas.santafe.setView([f.lat, f.lon], 10);
  caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------- simulación de crecida
// docs/data/simulacion.json y docs/data/simulacion/<id>.png los escribe scripts/simular_crecida.py. Cada píxel del PNG
// guarda la primera altura de la lista con la que ese lugar se moja (0 seco, 255 agua permanente): con eso el mapa se
// pinta en el navegador para cualquier altura sin volver a calcular nada.
async function simulacion() {
  const d = await leer('simulacion.json');
  const sel = document.getElementById('sim-escala'), rango = document.getElementById('sim-nivel');
  if (!d || !d.escalas || !d.escalas.length) {
    document.querySelector('.simulacion').innerHTML = '<p class="nota">La simulación todavía no está calculada.</p>';
    return;
  }
  sel.innerHTML = d.escalas.map(e => `<option value="${e.id}">Paraná en ${esc(e.nombre)}</option>`).join('');
  const m = mapas.sim = mapaBase('mapa-sim', 11);
  m.options.zoomSnap = 0.25;   // para que el recorte de 40 km llene el mapa
  let capa = null, capaSat = null, datos = null, e = null, satDatos = null;
  const cargarPNG = url => new Promise((ok, mal) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0); ok(x.getImageData(0, 0, c.width, c.height)); };
    img.onerror = mal; img.src = url;
  });
  const pintar = (fuente, color) => {   // color(v) → [r,g,b,a] o null
    const c = document.createElement('canvas'); c.width = fuente.width; c.height = fuente.height;
    const x = c.getContext('2d'), sal = x.createImageData(c.width, c.height), a = fuente.data, b = sal.data;
    for (let i = 0; i < a.length; i += 4) { const k = color(a[i]); if (k) { b[i] = k[0]; b[i + 1] = k[1]; b[i + 2] = k[2]; b[i + 3] = k[3]; } }
    x.putImageData(sal, 0, 0);
    return c.toDataURL();
  };
  const sat = document.getElementById('sim-satelite');
  const dibujar = () => {
    const k = Number(rango.value) + 1, h = e.niveles[k - 1];
    document.getElementById('sim-valor').textContent = metros(h);
    if (capa) capa.remove();
    capa = L.imageOverlay(pintar(datos, v => v === 255 ? [143, 188, 219, 200] : v && v <= k ? [31, 95, 168, 150] : null), e.limites, { opacity: 1 }).addTo(m);
    if (capaSat) capaSat.bringToFront();
    const area = e.area_km2[String(h)] ?? e.area_km2[h.toFixed(2)];
    const ref = h >= (e.evacuacion_m ?? 99) ? 'por encima del nivel de evacuación' : h >= (e.alerta_m ?? 99) ? 'por encima del nivel de alerta' : 'por debajo del nivel de alerta';
    document.getElementById('sim-texto').innerHTML = `<b>Con ${metros(h)} en ${esc(e.nombre)}</b> (${ref}) quedarían bajo el agua unos <b>${area != null ? Math.round(area) : '–'} km²</b> en este recorte, sin contar el cauce.`;
    document.querySelectorAll('#sim-atajos button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.k) === k - 1)));
  };
  const elegirEscala = async () => {
    e = d.escalas.find(x => String(x.id) === sel.value);
    datos = await cargarPNG(`data/simulacion/${e.id}.png?v=${encodeURIComponent(d.generado)}`);
    satDatos = null; if (capaSat) { capaSat.remove(); capaSat = null; }
    sat.checked = false;
    sat.disabled = !e.satelite;
    document.getElementById('sim-satelite-txt').textContent = e.satelite
      ? `Agua vista por el radar Sentinel-1 el ${fechaCorta(e.satelite.fecha)}${e.satelite.altura_m != null ? ` (río en ${metros(e.satelite.altura_m)})` : ''}` : 'Sin pasada reciente del radar Sentinel-1';
    const usadas = (e.calibracion || []).filter(c => c.coincidencia >= 0.4);
    const anios = [...new Set((usadas.length ? usadas : e.calibracion || []).map(c => (c.mes || c.fecha || '').slice(0, 4)))].filter(Boolean);
    document.getElementById('sim-ajuste').textContent = `Relieve ${e.relieve}. ` + (e.coincidencia_radar != null && anios.length
      ? `Calibrado con el agua que vieron los satélites Landsat en las crecidas de ${anios.join(' y ')}: la simulación coincide en un ${Math.round(e.coincidencia_radar * 100)} % con lo que se inundó de verdad.`
      : 'Sin calibrar con crecidas anteriores.')
      + (e.validacion && e.validacion.coincidencia != null ? ` Comparada con el agua que relevó la Provincia el 19/01/1998 (río en ${metros(e.validacion.altura_m)}): coincide en un ${Math.round(e.validacion.coincidencia * 100)} %.` : '')
      + (e.defensas ? ' Incluye las defensas de la Provincia como paredes (se supone que el agua no las sobrepasa).' : ' No incluye defensas: la capa de la Provincia solo las tiene cargadas para Santa Fe y alrededores. Si hay defensas en esta zona, la simulación muestra agua donde quizás no llegue.');
    rango.max = e.niveles.length - 1;
    // atajos: hoy, alerta, evacuación, pronóstico, récord
    const cerca = h => e.niveles.reduce((mej, v, i) => Math.abs(v - h) < Math.abs(e.niveles[mej] - h) ? i : mej, 0);
    const rio = SF && (SF.rios || []).find(r => r.id === e.id);
    const pron = rio && rio.pronostico ? Math.max(...rio.pronostico.puntos.map(p => p[2]).filter(v => v != null)) : null;
    const atajos = [['hoy', e.actual.altura_m], ['alerta', e.alerta_m], ['evacuación', e.evacuacion_m], ['pronóstico', pron], [`récord ${e.record.fecha.slice(0, 4)}`, e.record.altura_m]]
      .filter(a => a[1] != null);
    document.getElementById('sim-atajos').innerHTML = atajos.map(([n, h]) => `<button type="button" data-k="${cerca(h)}"><b>${metros(h)}</b>${esc(n)}</button>`).join('');
    document.querySelectorAll('#sim-atajos button').forEach(b => b.addEventListener('click', () => { rango.value = b.dataset.k; dibujar(); }));
    rango.value = cerca(e.actual.altura_m);
    dibujar();
    requestAnimationFrame(() => { m.invalidateSize(); m.fitBounds(e.limites, { animate: false, padding: [0, 0] }); });
  };
  let pendiente = false;
  rango.addEventListener('input', () => { if (pendiente) return; pendiente = true; requestAnimationFrame(() => { pendiente = false; dibujar(); }); });
  sel.addEventListener('change', elegirEscala);
  sat.addEventListener('change', async () => {
    if (capaSat) { capaSat.remove(); capaSat = null; }
    if (!sat.checked || !e.satelite) return;
    satDatos ||= await cargarPNG(`data/simulacion/${e.id}_satelite.png?v=${encodeURIComponent(d.generado)}`);
    capaSat = L.imageOverlay(pintar(satDatos, v => v ? [224, 69, 123, 140] : null), e.limites).addTo(m);
  });
  const santaFe = d.escalas.find(x => x.id === 30);
  if (santaFe) sel.value = '30';
  elegirEscala();
}
