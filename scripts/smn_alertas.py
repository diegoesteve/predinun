"""Alertas y avisos oficiales del Servicio Meteorológico Nacional (SMN) para nuestras localidades.

El SMN publica sus avisos en formato CAP (el estándar internacional de alertas) en https://ssl.smn.gob.ar/CAP/AR.php:
una lista con un enlace por aviso. Cada aviso trae el fenómeno, el nivel, la vigencia, la recomendación y el contorno
de la zona afectada. Hay dos tipos:
  - alertas (tormentas, lluvias, viento, etc.), para hoy y los próximos días;
  - avisos a corto plazo: tormentas severas que ya están ocurriendo, para la próxima hora.

Cada aviso se baja una sola vez (se guarda en data/smn_cache.json hasta que vence). Se marcan las localidades que
quedan dentro de alguna zona y se avisa por Telegram los avisos nuevos.

Este mismo archivo está en los dos proyectos (crecidas y granizo); cambia solo la configuración de arriba.
Escribe docs/data/smn.json.
"""
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import requests

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ---- configuración de cada proyecto
LOCALIDADES = os.path.join(RAIZ, 'docs', 'data', 'localidades.json')
SITIO = 'https://diegoesteve.github.io/predinun/'
FENOMENOS = ('TORMENT', 'LLUVI', 'GRANIZ', 'PRECIPIT')     # los que interesan a este proyecto (mayúsculas, sin tildes)
# ----
LISTA = 'https://ssl.smn.gob.ar/CAP/AR.php'
CABECERA = {'User-Agent': 'predinun/piedrazon (proyectos sin fines comerciales; github.com/diegoesteve)'}
CORDOBA = {'lat': (-35.2, -29.4), 'lon': (-65.9, -61.7)}
ARG = timezone(timedelta(hours=-3))
NIVEL_POR_SEVERIDAD = {'Minor': 'amarillo', 'Moderate': 'amarillo', 'Severe': 'naranja', 'Extreme': 'rojo'}
ORDEN = {'amarillo': 1, 'naranja': 2, 'rojo': 3}
AVISO_MINIMO = 'naranja'   # por Telegram solo naranja o rojo; los amarillos se ven en la página


def leer(ruta, defecto=None):
    if os.path.exists(ruta):
        with open(ruta, encoding='utf-8') as f:
            return json.load(f)
    return defecto


def escribir(ruta, obj):
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    with open(ruta, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def campo(xml, nombre):
    m = re.search(rf'<(?:cap:)?{nombre}>(.*?)</(?:cap:)?{nombre}>', xml, re.S)
    return html.unescape(m.group(1)).strip() if m else ''


def sin_tildes(t):
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFD', t) if not unicodedata.combining(c)).upper()


def analizar(url, xml):
    """Un aviso CAP → dict, o None si no se puede leer."""
    poligonos = []
    for p in re.findall(r'<(?:cap:)?polygon>(.*?)</(?:cap:)?polygon>', xml, re.S):
        puntos = []
        for par in p.split():
            try:
                la, lo = (float(x) for x in par.split(',')[:2])
                puntos.append([lo, la])
            except ValueError:
                pass
        if len(puntos) >= 3:
            poligonos.append(puntos)
    titulo = campo(xml, 'headline') or campo(xml, 'event')
    nivel = next((n for clave, n in (('ROJ', 'rojo'), ('NARANJ', 'naranja'), ('AMARILL', 'amarillo')) if clave in sin_tildes(titulo)), None)
    nivel = nivel or NIVEL_POR_SEVERIDAD.get(campo(xml, 'severity'), 'amarillo')
    hasta = campo(xml, 'expires')
    if not hasta:
        return None
    return {'id': re.sub(r'\W+', '_', url.rsplit('/', 1)[-1].replace('.xml', '')),
            'tipo': 'aviso a corto plazo' if 'cortoplazo' in url else 'alerta',
            'evento': campo(xml, 'event').capitalize(), 'nivel': nivel, 'titulo': titulo,
            'desde': campo(xml, 'onset') or campo(xml, 'effective') or campo(xml, 'sent'), 'hasta': hasta,
            'descripcion': campo(xml, 'description')[:600], 'instruccion': campo(xml, 'instruction')[:600],
            'zona': campo(xml, 'areaDesc'), 'url': url, 'poligonos': poligonos}


def dentro(lon, lat, anillo):
    adentro = False
    for (x1, y1), (x2, y2) in zip(anillo, anillo[1:] + anillo[:1]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            adentro = not adentro
    return adentro


def toca_cordoba(a):
    return any(CORDOBA['lat'][0] <= la <= CORDOBA['lat'][1] and CORDOBA['lon'][0] <= lo <= CORDOBA['lon'][1]
               for p in a['poligonos'] for lo, la in p)


def hora_local(t):
    try:
        return datetime.fromisoformat(t).astimezone(ARG).strftime('%d/%m %H:%M')
    except ValueError:
        return t


def main():
    ahora = datetime.now(timezone.utc)
    ruta_cache = os.path.join(RAIZ, 'data', 'smn_cache.json')
    cache = leer(ruta_cache, {})
    try:
        r = requests.get(LISTA, headers=CABECERA, timeout=60)
        r.raise_for_status()
        enlaces = list(dict.fromkeys(re.findall(r'<link>(https://ssl\.smn\.gob\.ar/feeds/CAP/[^<]+\.xml)</link>', r.text)))
    except Exception as e:
        print('SMN sin respuesta:', str(e)[:120])
        return
    nuevos = 0
    for url in enlaces:
        if url in cache:
            continue
        try:
            x = requests.get(url, headers=CABECERA, timeout=30)
            x.raise_for_status()
            cache[url] = analizar(url, x.content.decode('utf-8', errors='replace'))
            nuevos += 1
        except Exception as e:
            print('aviso no disponible:', url, str(e)[:80])
    # solo vigentes y en la lista actual
    vigentes = {}
    for url, a in cache.items():
        if a is None or url not in enlaces:
            continue
        try:
            if datetime.fromisoformat(a['hasta']) < ahora:
                continue
        except ValueError:
            continue
        vigentes[url] = a
    escribir(ruta_cache, {u: a for u, a in cache.items() if u in enlaces})

    interesan = [a for a in vigentes.values() if toca_cordoba(a) and any(f in sin_tildes(a['evento'] + ' ' + a['titulo']) for f in FENOMENOS)]
    locs = (leer(LOCALIDADES) or {}).get('localidades', [])
    por_loc = {}
    for a in interesan:
        for f in locs:
            if any(dentro(f['lon'], f['lat'], p) for p in a['poligonos']):
                por_loc.setdefault(f['localidad'], []).append(a['id'])
    alertas = []
    for a in sorted(interesan, key=lambda a: (-ORDEN[a['nivel']], a['tipo'] != 'aviso a corto plazo', a['hasta'])):
        n = sum(a['id'] in v for v in por_loc.values())
        if n:
            alertas.append({**{k: v for k, v in a.items() if k != 'poligonos'}, 'desde_local': hora_local(a['desde']),
                            'hasta_local': hora_local(a['hasta']), 'localidades': n, 'poligonos': a['poligonos']})
    for v in por_loc.values():
        v.sort(key=lambda i: -ORDEN[next(a['nivel'] for a in alertas if a['id'] == i)])
    escribir(os.path.join(RAIZ, 'docs', 'data', 'smn.json'),
             {'fuente': 'Servicio Meteorológico Nacional, ssl.smn.gob.ar/CAP', 'consultado': ahora.astimezone(ARG).strftime('%Y-%m-%d %H:%M'),
              'alertas': alertas, 'localidades': por_loc})
    print(f'smn.json: {len(enlaces)} avisos en la lista ({nuevos} nuevos), {len(vigentes)} vigentes, '
          f'{len(alertas)} para nuestras localidades, {len(por_loc)} localidades')
    avisar(alertas, por_loc)


def avisar(alertas, por_loc):
    ruta = os.path.join(RAIZ, 'data', 'smn_avisados.json')
    avisados = set(leer(ruta, []))
    token, chat = os.environ.get('TELEGRAM_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID')
    actuales = {a['id'] for a in alertas}
    # El SMN parte una misma alerta en varias zonas: se juntan por tipo, título, nivel y vencimiento, un mensaje cada una
    grupos = {}
    for a in alertas:
        if a['id'] not in avisados and ORDEN[a['nivel']] >= ORDEN[AVISO_MINIMO]:
            grupos.setdefault((a['tipo'], a['titulo'], a['nivel'], a['hasta_local']), []).append(a['id'])
    for (tipo, titulo, nivel, hasta), ids in grupos.items():
        nombres = sorted({n for n, v in por_loc.items() if set(v) & set(ids)})
        icono = {'rojo': '🔴', 'naranja': '🟠', 'amarillo': '🟡'}[nivel]
        texto = (f"{icono} {'Aviso a corto plazo' if tipo == 'aviso a corto plazo' else 'Alerta'} oficial del SMN: "
                 f"{titulo} (nivel {nivel}), hasta {hasta} h.\n"
                 f"{len(nombres)} localidad{'es' if len(nombres) > 1 else ''}: {', '.join(nombres[:15])}{'…' if len(nombres) > 15 else ''}.\n{SITIO}")
        print(texto)
        if token and chat:
            try:
                requests.post(f'https://api.telegram.org/bot{token}/sendMessage',
                              data={'chat_id': chat, 'text': texto, 'disable_web_page_preview': 'true'}, timeout=20)
            except Exception as e:
                print('No se pudo enviar a Telegram:', e)
        avisados.update(ids)
    escribir(ruta, sorted(avisados & actuales))   # los vencidos se olvidan


if __name__ == '__main__':
    sys.exit(main())
