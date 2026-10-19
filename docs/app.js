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
  const m = L.map(id, { scrollWheelZoom: false }).setView(CENTRO, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: '&copy; OpenStreetMap'
  }).addTo(m);
  return m;
}

// ---------------------------------------------------------------- pestañas
const mapas = {};
document.querySelectorAll('.pestanas button').forEach(b => b.addEventListener('click', () => mostrar(b.dataset.p)));
function mostrar(p) {
  document.querySelectorAll('.pestanas button').forEach(b => b.setAttribute('aria-selected', b.dataset.p === p));
  document.querySelectorAll('.pagina').forEach(s => s.hidden = s.id !== 'p-' + p);
  try { history.replaceState(null, '', '#' + p); } catch (e) {}
  Object.values(mapas).forEach(m => m.invalidateSize());
  if (p === 'riesgo' && !mapas.riesgo) riesgo();
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
  est.filter(s => s.lat && s.lon && s.tipo !== 'otra').forEach(s => {
    const txt = s.tipo === 'rio'
      ? `Nivel ${s.nivel_m} m · subió ${s.subida_1h_m ?? '–'} m en 1 h`
      : `Lluvia 1 h: ${s.lluvia_1h ?? '–'} mm · 3 h: ${s.lluvia_3h ?? '–'} mm · 24 h: ${s.lluvia_24h ?? '–'} mm`;
    L.circleMarker([s.lat, s.lon], {
      radius: s.tipo === 'rio' ? 8 : 6, color: s.tipo === 'rio' ? '#0E5E5A' : '#fff', weight: 2,
      fillColor: COLOR[s.estado] || COLOR['sin datos'], fillOpacity: .9
    }).bindPopup(`<b>${esc(s.nombre)}</b> (${s.tipo === 'rio' ? 'río' : 'lluvia'})<br>${esc(txt)}<br>${esc(s.hora)} · ${esc(TEXTO[s.estado])}`)
      .addTo(mapas.estaciones);
  });
  const orden = { rojo: 0, naranja: 1, amarillo: 2, normal: 3, 'sin datos': 4 };
  const filas = est.filter(s => s.tipo !== 'otra').sort((x, y) => (orden[x.estado] - orden[y.estado]) || String(x.zona).localeCompare(y.zona));
  document.getElementById('tabla-estaciones').innerHTML =
    '<tr><th>Estación</th><th>Zona</th><th>Tipo</th><th>Hora</th><th>1 h mm</th><th>3 h mm</th><th>24 h mm</th><th>Nivel m</th><th>Sube 1 h</th><th>Estado</th></tr>' +
    filas.map(s => `<tr class="${clase(s.estado)}"><td>${esc(s.nombre)}</td><td>${esc(s.zona)}</td><td>${s.tipo === 'rio' ? 'río' : 'lluvia'}</td>
      <td>${esc(s.hora)}</td><td class="num">${s.lluvia_1h ?? ''}</td><td class="num">${s.lluvia_3h ?? ''}</td><td class="num">${s.lluvia_24h ?? ''}</td>
      <td class="num">${s.nivel_m ?? ''}</td><td class="num">${s.subida_1h_m ?? ''}</td>
      <td><span class="punto"></span>${esc(TEXTO[s.estado])}</td></tr>`).join('');
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

  document.getElementById('suelo').innerHTML = b.cuencas.map(c => {
    const s = c.suelo;
    if (!s) return `<article class="tarjeta n-sin-datos"><div class="franja"></div><div class="cuerpo"><div class="nombre">${esc(c.nombre)}</div><div class="det">Sin dato de SMAP.</div></div></article>`;
    const n = s.estado === 'saturado' ? 'naranja' : s.estado === 'seco' ? 'amarillo' : 'verde';
    return `<article class="tarjeta ${clase(n)}"><div class="franja"></div><div class="cuerpo">
      <div class="nombre">${esc(c.nombre)}</div>
      <div class="nivel">${esc(s.estado)} · percentil ${s.percentil}${s.es_estimado ? ' (estimado hoy)' : ''}</div>
      <div class="det">SMAP p${s.smap_percentil} del ${esc(String(s.smap_fecha).slice(0, 10))}${s.estimado_hoy_percentil != null ? ` · estimado hoy p${s.estimado_hoy_percentil}` : ''}</div>
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
  };
  const capas = {};
  g.features.forEach(f => {
    const p = f.properties, e = estilos[p.capa] || { color: '#555', radio: 5, titulo: p.capa };
    const [lon, lat] = f.geometry.coordinates;
    const det = Object.entries(p).filter(([k, v]) => k !== 'capa' && v != null && v !== '')
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
  if (todos.length) mapas.riesgo.fitBounds(L.latLngBounds(todos).pad(0.1));
}

ahora();
pronostico();
const inicial = location.hash.slice(1);
if (['ahora', 'pronostico', 'riesgo'].includes(inicial)) mostrar(inicial);
window.addEventListener('hashchange', () => {
  const p = location.hash.slice(1);
  if (['ahora', 'pronostico', 'riesgo'].includes(p)) mostrar(p);
});
