// Portada por regiones: data/regiones.json dice qué regiones y zonas hay; data/app.json, cómo está cada zona hoy y mañana.
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const leer = n => fetch(`data/${n}?t=${Date.now()}`).then(r => r.ok ? r.json() : null).catch(() => null);
const NOMBRE = ['Tranquilo', 'Atención', 'Alerta', 'Peligro'];
let LUGARES = [], ZONA_DE = {};

function estadoZona(z) {
  const ls = LUGARES.filter(x => x.z === z);
  if (!ls.length) return null;
  const peorHoy = Math.max(...ls.map(x => x.hoy.nivel)), peorMan = Math.max(...ls.map(x => x.man.nivel));
  const peor = Math.max(peorHoy, peorMan);
  const lista = (dia, n) => ls.filter(x => x[dia].nivel === n).map(x => x.n);
  let texto;
  if (peor === 0) texto = 'Sin lluvias fuertes ni crecidas para hoy y mañana.';
  else {
    const dia = peorHoy >= peorMan ? 'hoy' : 'man', nombres = lista(dia, peor), motivo = ls.find(x => x[dia].nivel === peor)[dia].titulo;
    const donde = nombres.slice(0, 3).join(', ') + (nombres.length > 3 ? ` y ${nombres.length - 3} lugares más` : '');
    texto = `${dia === 'hoy' ? 'Hoy' : 'Mañana'}: ${motivo.charAt(0).toLowerCase() + motivo.slice(1)} en ${donde}.`;
  }
  return { nivel: peor, texto, n: ls.length };
}

function pintar(regiones) {
  const activas = regiones.flatMap(r => r.zonas.map(z => ({ ...z, region: r.nombre })));
  $('#zonas').innerHTML = activas.map(z => {
    const e = estadoZona(z.z);
    return `<a class="zona" href="${esc(z.url)}">
      <span class="arriba"><span><span class="nombre">${esc(z.nombre)}</span><br><span class="region">Región ${esc(z.region)}${e ? ` · ${e.n} localidades` : ''}</span></span>
        ${e ? `<span class="estado e${e.nivel}">${NOMBRE[e.nivel]}</span>` : ''}</span>
      <p>${e ? esc(e.texto) : ''}</p>
      <span class="detalle">${esc(z.detalle)}</span>
      <span class="ir">Ver la zona →</span></a>`;
  }).join('');
  $('#regiones').innerHTML = regiones.map(r => r.zonas.length
    ? `<a class="region-tarjeta activa" href="${esc(r.zonas[0].url)}"><span class="etiqueta">Con datos: ${r.zonas.map(z => esc(z.nombre)).join(', ')}</span><b>${esc(r.nombre)}</b><small>${esc(r.provincias)}</small><small>${esc(r.que)}</small></a>`
    : `<div class="region-tarjeta"><span class="etiqueta">Próximamente</span><b>${esc(r.nombre)}</b><small>${esc(r.provincias)}</small><small>${esc(r.que)}</small></div>`).join('');
}

function buscar() {
  const q = sinTildes($('#buscar').value.trim()), lista = $('#resultados');
  if (q.length < 2) { lista.innerHTML = ''; return; }
  const rango = x => { const n = sinTildes(x.n); return n.startsWith(q) ? 0 : (' ' + n).includes(' ' + q) ? 1 : 2; };
  const r = LUGARES.filter(x => sinTildes(x.n).includes(q)).sort((a, b) => rango(a) - rango(b) || a.n.localeCompare(b.n)).slice(0, 8);
  lista.innerHTML = r.length
    ? r.map(x => `<li><a href="app/?l=${encodeURIComponent(x.n)}&z=${x.z}"><span><b>${esc(x.n)}</b><br><small>${esc(ZONA_DE[x.z] || '')}</small></span><span class="estado e${Math.max(x.hoy.nivel, x.man.nivel)}">${NOMBRE[Math.max(x.hoy.nivel, x.man.nivel)]}</span></a></li>`).join('')
    : '<li><a href="#regiones"><span>No encontramos ese lugar todavía. Mirá qué regiones tenemos.</span></a></li>';
}

(async () => {
  const [reg, app] = await Promise.all([leer('regiones.json'), leer('app.json')]);
  LUGARES = (app && app.lugares) || [];
  const regiones = (reg && reg.regiones) || [];
  regiones.forEach(r => r.zonas.forEach(z => { ZONA_DE[z.z] = z.nombre; }));
  pintar(regiones);
  $('#buscar').addEventListener('input', buscar);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#resultados').innerHTML = ''; });
})();
