// Recibe los aportes de vecinos y visitantes (relato + fotos), los guarda en R2 hasta que se revisan,
// y publica en el repositorio solo los aprobados. Cloudflare Worker sin dependencias.
//
// Rutas:
//   POST /aportes                 formulario público (con Turnstile)
//   GET  /fotos/<id>/<n>.jpg      fotos de aportes aprobados (públicas)
//   GET  /revisar                 página privada de revisión (usuario y contraseña)
//   GET  /revisar/foto/<clave>    fotos pendientes (privadas)
//   POST /revisar/aprobar|rechazar
//
// Variables (wrangler.toml): ORIGEN, REPO, RAMA. Secretos: TURNSTILE_SECRET, GH_TOKEN, REVISION_USUARIO,
// REVISION_CLAVE y, opcionales, TELEGRAM_TOKEN y TELEGRAM_CHAT_ID.

const MAX_FOTOS = 3;
const MAX_BYTES_FOTO = 5 * 1024 * 1024;
const TIPOS_FOTO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const LARGOS = { tipo: 40, fecha_evento: 80, localidad: 80, relato: 4000, altura_agua: 300, contacto: 120 };
// Límites contra abusos: aportes aceptados por conexión (IP) y aportes sin revisar en total
const MAX_POR_HORA = 3;
const MAX_POR_DIA = 10;
const MAX_PENDIENTES = 200;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
      if (url.pathname === '/aportes' && req.method === 'POST') return cors(env, await recibir(req, env, url));
      if (url.pathname.startsWith('/fotos/') && req.method === 'GET') return await fotoPublica(url, env);
      if (url.pathname === '/revisar' || url.pathname.startsWith('/revisar/')) {
        if (!autorizado(req, env)) {
          return new Response('Se necesita usuario y contraseña.', {
            status: 401, headers: { 'WWW-Authenticate': 'Basic realm="predinun", charset="UTF-8"' } });
        }
        if (req.method === 'POST' && req.headers.get('Origin') !== url.origin) return texto('Origen no permitido', 403);
        if (url.pathname === '/revisar' && req.method === 'GET') return await paginaRevision(env, url);
        if (url.pathname.startsWith('/revisar/foto/')) return await fotoPrivada(url, env);
        if (url.pathname === '/revisar/aprobar' && req.method === 'POST') return await aprobar(req, env, url);
        if (url.pathname === '/revisar/rechazar' && req.method === 'POST') return await rechazar(req, env, url);
      }
      return texto('No encontrado', 404);
    } catch (e) {
      console.log('error', e && e.stack || e);
      const r = json({ ok: false, error: 'Error interno. Probá de nuevo más tarde.' }, 500);
      return url.pathname === '/aportes' ? cors(env, r) : r;
    }
  },

  // Despertador: GitHub no respeta los horarios de las tareas programadas en cuentas gratuitas (el monitor «cada
  // 15 minutos» corría cada 3 a 5 horas). Cloudflare sí: en cada disparo le pide a GitHub que corra los workflows.
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(despertar(env, evento.cron));
  },
};

// Qué correr con cada horario de wrangler.toml: «repo:workflow» separados por coma
const DESPERTAR = {
  '*/15 * * * *': 'diegoesteve/predinun:monitor.yml,diegoesteve/predgra:radar.yml',
  '20 */6 * * *': 'diegoesteve/predinun:boletin.yml',
  '35 */6 * * *': 'diegoesteve/predgra:pronostico.yml',
};

async function despertar(env, cron) {
  const lista = (DESPERTAR[cron] || '').split(',').filter(Boolean);
  for (const item of lista) {
    const [repo, workflow] = item.split(':');
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
                   'User-Agent': 'predinun-despertador', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ ref: 'main' }) });
      if (r.status !== 204) console.log('despertar', item, r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.log('despertar', item, e); }
  }
}

// ------------------------------------------------------------------ utilidades
const texto = (t, status = 200) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const html = (h, status = 200) => new Response(h, { status, headers: {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'" } });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function cors(env, r) {
  const h = new Headers(r.headers);
  h.set('Access-Control-Allow-Origin', env.ORIGEN || '*');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return new Response(r.body, { status: r.status, headers: h });
}

function igualSeguro(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function autorizado(req, env) {
  if (!env.REVISION_USUARIO || !env.REVISION_CLAVE) return false;
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let dec = '';
  try { dec = new TextDecoder().decode(Uint8Array.from(atob(h.slice(6)), c => c.charCodeAt(0))); } catch (e) { return false; }
  const i = dec.indexOf(':');
  return i > 0 && igualSeguro(dec.slice(0, i), env.REVISION_USUARIO) && igualSeguro(dec.slice(i + 1), env.REVISION_CLAVE);
}

function aBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function esImagen(bytes, tipo) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (tipo === 'image/jpeg') return b[0] === 0xFF && b[1] === 0xD8;
  if (tipo === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  if (tipo === 'image/webp') return b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45;
  return false;
}

async function avisar(env, mensaje) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: mensaje }) });
  } catch (e) { console.log('telegram', e); }
}

async function leerJSON(env, clave) {
  const o = await env.APORTES.get(clave);
  return o ? JSON.parse(await o.text()) : null;
}

// ------------------------------------------------------------------ límites
// La IP no se guarda: se guarda un resumen (hash) con sal secreta, que no permite recuperarla.
async function claveIP(req, env) {
  const ip = req.headers.get('CF-Connecting-IP');
  if (!ip) return null;
  const datos = new TextEncoder().encode(`${env.TURNSTILE_SECRET || ''}|${ip}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', datos));
  return 'limites/' + [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('') + '.json';
}

async function enviosRecientes(env, clave) {
  if (!clave) return [];
  const d = await leerJSON(env, clave).catch(() => null);
  const desde = Date.now() - 24 * 3600e3;
  return (d && Array.isArray(d.t) ? d.t : []).filter(t => t > desde);
}

async function contarPendientes(env) {
  let n = 0, cursor;
  do {
    const r = await env.APORTES.list({ prefix: 'pendientes/', cursor, limit: 1000 });
    n += r.objects.filter(o => o.key.endsWith('/aporte.json')).length;
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor && n < MAX_PENDIENTES);
  return n;
}

// ------------------------------------------------------------------ recibir un aporte
async function recibir(req, env, url) {
  const largo = Number(req.headers.get('Content-Length') || 0);
  if (largo > (MAX_FOTOS * MAX_BYTES_FOTO + 200000)) return json({ ok: false, error: 'El envío es demasiado grande.' }, 413);

  // Límites (antes de todo lo demás, para no gastar recursos en envíos de más)
  const claveLimite = await claveIP(req, env);
  const recientes = await enviosRecientes(env, claveLimite);
  if (recientes.filter(t => t > Date.now() - 3600e3).length >= MAX_POR_HORA || recientes.length >= MAX_POR_DIA) {
    return json({ ok: false, error: 'Recibimos varios aportes desde tu conexión en poco tiempo. Probá de nuevo en unas horas. ¡Gracias!' }, 429);
  }
  const pendientes = await contarPendientes(env);
  if (pendientes >= MAX_PENDIENTES) {
    return json({ ok: false, error: 'Tenemos muchos aportes sin revisar. Volvé en unos días, por favor. ¡Gracias!' }, 503);
  }
  let form;
  try { form = await req.formData(); } catch (e) { return json({ ok: false, error: 'Formulario inválido.' }, 400); }

  // Antispam
  const token = form.get('cf-turnstile-response');
  if (!token) return json({ ok: false, error: 'Falta la verificación antispam.' }, 400);
  const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET || '', response: token,
                                                remoteip: req.headers.get('CF-Connecting-IP') || '' }) });
  const vj = await v.json().catch(() => ({}));
  if (!vj.success) return json({ ok: false, error: 'No pasó la verificación antispam. Recargá la página y probá de nuevo.' }, 400);

  const campo = k => String(form.get(k) || '').trim().slice(0, LARGOS[k] || 200);
  const relato = campo('relato');
  if (relato.length < 20) return json({ ok: false, error: 'Contanos un poco más: el relato es muy corto.' }, 400);
  if (!campo('localidad')) return json({ ok: false, error: 'Falta la localidad.' }, 400);
  if (form.get('acepto') !== 'si') return json({ ok: false, error: 'Falta aceptar las condiciones de publicación.' }, 400);
  let lat = parseFloat(form.get('lat')), lon = parseFloat(form.get('lon'));
  const enCordoba = lat > -35.5 && lat < -29 && lon > -66 && lon < -61;
  if (!enCordoba) { lat = null; lon = null; }

  const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomUUID().slice(0, 8);
  // Primero se validan todas las fotos y recién después se guardan, para no dejar archivos sueltos
  const validas = [];
  for (const f of form.getAll('fotos').slice(0, MAX_FOTOS)) {
    if (!f || typeof f === 'string' || !f.size) continue;
    if (f.size > MAX_BYTES_FOTO) return json({ ok: false, error: 'Una de las fotos supera los 5 MB.' }, 400);
    const ext = TIPOS_FOTO[f.type];
    const bytes = await f.arrayBuffer();
    if (!ext || !esImagen(bytes, f.type)) return json({ ok: false, error: 'Solo se aceptan fotos JPG, PNG o WebP.' }, 400);
    validas.push({ bytes, ext, tipo: f.type });
  }
  const fotos = [];
  for (const v of validas) {
    const clave = `pendientes/${id}/foto-${fotos.length + 1}.${v.ext}`;
    await env.APORTES.put(clave, v.bytes, { httpMetadata: { contentType: v.tipo } });
    fotos.push(clave);
  }

  const aporte = {
    id, recibido: new Date().toISOString(), tipo: campo('tipo'), fecha_evento: campo('fecha_evento'),
    localidad: campo('localidad'), lat: lat == null ? null : Math.round(lat * 1e4) / 1e4,
    lon: lon == null ? null : Math.round(lon * 1e4) / 1e4, relato, altura_agua: campo('altura_agua'),
    fotos, estado: 'pendiente',
  };
  await env.APORTES.put(`pendientes/${id}/aporte.json`, JSON.stringify(aporte));
  const contacto = campo('contacto');
  if (contacto) await env.APORTES.put(`pendientes/${id}/contacto.json`, JSON.stringify({ contacto }));
  if (claveLimite) await env.APORTES.put(claveLimite, JSON.stringify({ t: [...recientes, Date.now()] }));
  const lleno = pendientes + 1 >= MAX_PENDIENTES ? `\nSe llenó la bandeja (${MAX_PENDIENTES}): el formulario no acepta más hasta que se revise.` : '';
  await avisar(env, `Nuevo aporte para revisar: ${aporte.localidad} (${aporte.fecha_evento || 'sin fecha'}), ` +
                    `${fotos.length} foto(s).\n${url.origin}/revisar${lleno}`);
  return json({ ok: true, id });
}

// ------------------------------------------------------------------ fotos
async function fotoPublica(url, env) {
  const partes = url.pathname.split('/').filter(Boolean);       // fotos/<id>/<archivo>
  if (partes.length !== 3 || !/^[\w-]+$/.test(partes[1]) || !/^foto-\d\.(jpg|png|webp)$/.test(partes[2])) return texto('No encontrado', 404);
  const o = await env.APORTES.get(`publicos/${partes[1]}/${partes[2]}`);
  if (!o) return texto('No encontrado', 404);
  return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'image/jpeg',
                                           'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
}

async function fotoPrivada(url, env) {
  const clave = decodeURIComponent(url.pathname.slice('/revisar/foto/'.length));
  if (!/^pendientes\/[\w-]+\/foto-\d\.(jpg|png|webp)$/.test(clave)) return texto('No encontrado', 404);
  const o = await env.APORTES.get(clave);
  if (!o) return texto('No encontrado', 404);
  return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'no-store' } });
}

// ------------------------------------------------------------------ revisión
async function pendientes(env) {
  const out = [];
  let cursor;
  do {
    const l = await env.APORTES.list({ prefix: 'pendientes/', cursor });
    for (const o of l.objects) if (o.key.endsWith('/aporte.json')) out.push(o.key);
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  const aportes = [];
  for (const k of out.sort()) {
    const a = await leerJSON(env, k);
    if (a) aportes.push({ ...a, contacto: (await leerJSON(env, `pendientes/${a.id}/contacto.json`))?.contacto || '' });
  }
  return aportes;
}

async function paginaRevision(env, url) {
  const lista = await pendientes(env);
  const msg = url.searchParams.get('ok');
  const tarjetas = lista.map(a => `
    <form method="post" class="ap">
      <input type="hidden" name="id" value="${esc(a.id)}">
      <h2>${esc(a.localidad)} <small>${esc(a.fecha_evento || 'sin fecha')} · ${esc(a.tipo)}</small></h2>
      <p class="meta">Recibido ${esc(a.recibido.slice(0, 16).replace('T', ' '))} UTC · ${a.lat != null ? `<a href="https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lon}" target="_blank" rel="noopener">${a.lat}, ${a.lon}</a>` : 'sin punto en el mapa'}
      ${a.contacto ? ` · contacto (privado): <b>${esc(a.contacto)}</b>` : ''}</p>
      <label>Relato (podés corregirlo o sacar datos personales antes de aprobar)
        <textarea name="relato" rows="6">${esc(a.relato)}</textarea></label>
      <label>Hasta dónde llegó el agua <input name="altura_agua" value="${esc(a.altura_agua)}"></label>
      <label>Fecha del evento <input name="fecha_evento" value="${esc(a.fecha_evento)}"></label>
      <label>Localidad <input name="localidad" value="${esc(a.localidad)}"></label>
      <div class="fotos">${a.fotos.map((f, i) => `<label class="foto"><img src="/revisar/foto/${encodeURIComponent(f)}" alt="">
        <span><input type="checkbox" name="foto" value="${i}" checked> publicar</span></label>`).join('') || '<p>Sin fotos.</p>'}</div>
      <div class="botones">
        <button formaction="/revisar/aprobar" class="si">Aprobar y publicar</button>
        <button formaction="/revisar/rechazar" class="no">Rechazar (borra fotos y contacto)</button>
      </div>
    </form>`).join('');
  return html(`<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisar aportes</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#F3F5F4;color:#16201C}main{max-width:900px;margin:0 auto;padding:16px}
.ap{background:#fff;border:1px solid #D6DDDA;border-radius:12px;padding:14px 16px;margin:14px 0;display:grid;gap:10px}
h1{font-size:20px}h2{margin:0;font-size:18px}small{color:#5B6863;font-weight:400}.meta{margin:0;color:#5B6863;font-size:14px}
label{display:grid;gap:4px;font-size:14px}textarea,input:not([type=checkbox]){font:inherit;padding:8px;border:1px solid #D6DDDA;border-radius:8px}
.fotos{display:flex;flex-wrap:wrap;gap:10px}.foto img{width:220px;max-width:100%;border-radius:8px;display:block}
.botones{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;padding:8px 14px;border-radius:8px;border:0;cursor:pointer}
.si{background:#1F7A4D;color:#fff}.no{background:#C0362C;color:#fff}.ok{background:#E8F3EC;border:1px solid #1F7A4D;padding:8px 12px;border-radius:8px}
</style></head><body><main><h1>Aportes para revisar (${lista.length})</h1>
${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
<p class="meta">Al aprobar, el relato y las fotos marcadas se publican en el repositorio y aparecen en el mapa en la próxima corrida del boletín. El contacto nunca se publica.</p>
${tarjetas || '<p>No hay aportes pendientes.</p>'}</main></body></html>`);
}

async function moverFoto(env, desde, hasta) {
  const o = await env.APORTES.get(desde);
  if (!o) return false;
  await env.APORTES.put(hasta, await o.arrayBuffer(), { httpMetadata: o.httpMetadata });
  await env.APORTES.delete(desde);
  return true;
}

async function aprobar(req, env, url) {
  const form = await req.formData();
  const id = String(form.get('id') || '');
  if (!/^[\w-]+$/.test(id)) return texto('id inválido', 400);
  const a = await leerJSON(env, `pendientes/${id}/aporte.json`);
  if (!a) return Response.redirect(`${url.origin}/revisar?ok=${encodeURIComponent('Ese aporte ya no está pendiente.')}`, 303);
  const elegidas = new Set(form.getAll('foto').map(Number));
  const publicas = [];
  for (const [i, clave] of a.fotos.entries()) {
    if (elegidas.has(i)) {
      const nombre = `foto-${publicas.length + 1}.${clave.split('.').pop()}`;
      if (await moverFoto(env, clave, `publicos/${id}/${nombre}`)) publicas.push(`${url.origin}/fotos/${id}/${nombre}`);
    } else {
      await env.APORTES.delete(clave);
    }
  }
  const publico = {
    id, recibido: a.recibido, tipo: a.tipo,
    fecha_evento: String(form.get('fecha_evento') || a.fecha_evento).slice(0, LARGOS.fecha_evento),
    localidad: String(form.get('localidad') || a.localidad).slice(0, LARGOS.localidad),
    lat: a.lat, lon: a.lon,
    relato: String(form.get('relato') || a.relato).slice(0, LARGOS.relato),
    altura_agua: String(form.get('altura_agua') ?? a.altura_agua).slice(0, LARGOS.altura_agua),
    fotos: publicas, licencia: 'CC BY-NC 4.0', aprobado: new Date().toISOString(),
  };
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/contents/data/aportes/${id}.json`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
               'User-Agent': 'predinun-aportes', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ message: `Aporte aprobado: ${publico.localidad} (${id})`, branch: env.RAMA || 'main',
                           content: aBase64(JSON.stringify(publico, null, 1) + '\n') }),
  });
  if (!r.ok && r.status !== 422) {
    const detalle = await r.text();
    console.log('github', r.status, detalle);
    let mensaje = '';
    try { mensaje = JSON.parse(detalle).message || ''; } catch (e) { mensaje = detalle.slice(0, 300); }
    return texto(`No se pudo publicar en GitHub (HTTP ${r.status}). El aporte sigue pendiente.\n\n` +
                 `GitHub dice: ${mensaje}\n\n` +
                 'Revisá el token GH_TOKEN_APORTES: tiene que ser un fine-grained token con acceso solo a ' +
                 `${env.REPO} y el permiso Contents en "Read and write". Después de cambiarlo, volvé a correr ` +
                 'el workflow "Desplegar el receptor de aportes" y aprobá de nuevo.', 502);
  }
  await env.APORTES.put(`revisados/${id}/aporte.json`, JSON.stringify({ ...publico, estado: 'aprobado' }));
  const c = await env.APORTES.get(`pendientes/${id}/contacto.json`);
  if (c) { await env.APORTES.put(`revisados/${id}/contacto.json`, await c.text()); await env.APORTES.delete(`pendientes/${id}/contacto.json`); }
  await env.APORTES.delete(`pendientes/${id}/aporte.json`);
  return Response.redirect(`${url.origin}/revisar?ok=${encodeURIComponent(`Publicado: ${publico.localidad}.`)}`, 303);
}

async function rechazar(req, env, url) {
  const form = await req.formData();
  const id = String(form.get('id') || '');
  if (!/^[\w-]+$/.test(id)) return texto('id inválido', 400);
  const a = await leerJSON(env, `pendientes/${id}/aporte.json`);
  if (a) {
    for (const clave of a.fotos) await env.APORTES.delete(clave);
    await env.APORTES.put(`rechazados/${id}/aporte.json`, JSON.stringify({ ...a, fotos: [], estado: 'rechazado' }));
    await env.APORTES.delete(`pendientes/${id}/contacto.json`);
    await env.APORTES.delete(`pendientes/${id}/aporte.json`);
  }
  return Response.redirect(`${url.origin}/revisar?ok=${encodeURIComponent('Rechazado y borrado.')}`, 303);
}
