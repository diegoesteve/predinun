"""Barrios de las ciudades de Córdoba y Santa Fe (OpenStreetMap), para buscar por barrio en la app.

Pide a Overpass los lugares marcados como barrio (place = suburb, neighbourhood o quarter) en las dos provincias y
asigna cada uno a su municipio según GeoRef (si ese municipio está en la app, docs/data/app.json); si GeoRef no
responde, a la localidad más cercana a menos de BARRIO_KM. Al elegir un
barrio, la app usa el pronóstico de su ciudad, el punto del barrio para la distancia al arroyo, y lo que los vecinos
contaron de ese barrio (scripts/eventos_barrios.py).

Escribe docs/data/barrios.json: [[barrio, localidad, zona, lat, lon], …]. Corre una vez por mes (importar_aprhi.yml)
o a mano; con un archivo de Overpass ya bajado: python scripts/barrios.py archivo.json
Datos de OpenStreetMap © colaboradores de OpenStreetMap, licencia ODbL.
"""
import json
import math
import os
import sys

import time
import unicodedata

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

OVERPASS = 'https://overpass-api.de/api/interpreter'
CONSULTA = ('[out:json][timeout:120];(area["name"="Córdoba"]["admin_level"="4"];area["name"="Santa Fe"]["admin_level"="4"];)->.p;'
            '(node["place"~"^(suburb|neighbourhood|quarter)$"](area.p);way["place"~"^(suburb|neighbourhood|quarter)$"](area.p);'
            'relation["place"~"^(suburb|neighbourhood|quarter)$"](area.p););out center tags;')
BARRIO_KM = 10


GEOREF = 'https://apis.datos.gob.ar/georef/api/ubicacion'


def normal(t):
    return ''.join(c for c in unicodedata.normalize('NFD', t or '') if not unicodedata.combining(c)).lower().strip()


def municipios(puntos):
    """Municipio de cada punto según GeoRef (de a 1000 por pedido)."""
    salida = []
    for i in range(0, len(puntos), 1000):
        pedido = {'ubicaciones': [{'lat': la, 'lon': lo, 'aplanar': True, 'campos': 'municipio.nombre,provincia.nombre'} for la, lo in puntos[i:i + 1000]]}
        for k in range(3):
            try:
                r = requests.post(GEOREF, json=pedido, timeout=120)
                r.raise_for_status()
                salida += [(x.get('ubicacion') or {}).get('municipio_nombre') for x in r.json()['resultados']]
                break
            except Exception:
                if k == 2:
                    raise
                time.sleep(10)
    return salida


def km(a, b, c, d):
    return math.hypot((a - c) * 111.3, (b - d) * 111.3 * math.cos(math.radians(a)))


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding='utf-8') as f:
            osm = json.load(f)
    else:
        r = requests.post(OVERPASS, data={'data': CONSULTA}, headers={'User-Agent': 'predinun (sin fines comerciales)'}, timeout=300)
        r.raise_for_status()
        osm = r.json()
    with open(os.path.join(cfg.DOCS_DATA, 'app.json'), encoding='utf-8') as f:
        lugares = json.load(f)['lugares']
    elementos = []
    for e in osm['elements']:
        nombre = (e.get('tags') or {}).get('name', '').strip()
        c = e.get('center') or ({'lat': e['lat'], 'lon': e['lon']} if 'lat' in e else None)
        if nombre and c:
            elementos.append((nombre, c['lat'], c['lon']))
    # municipio de cada barrio (GeoRef); si no responde, la localidad más cercana
    try:
        munis = municipios([(la, lo) for _, la, lo in elementos])
    except Exception as e:
        print('GeoRef no respondió, uso la localidad más cercana:', str(e)[:100])
        munis = [None] * len(elementos)
    por_nombre = {}
    for x in lugares:
        por_nombre.setdefault(normal(x['n']), []).append(x)
    vistos, salida = set(), []
    for (nombre, la, lo), muni in zip(elementos, munis):
        candidatos = por_nombre.get(normal(muni), []) if muni else []
        if candidatos:
            x = min(candidatos, key=lambda y: km(la, lo, y['la'], y['lo']))
        elif muni is None:
            d, x = min(((km(la, lo, y['la'], y['lo']), y) for y in lugares), key=lambda t: t[0])
            if d > BARRIO_KM:
                continue
        else:
            continue          # el municipio no está en la app (por ahora)
        if normal(nombre) == normal(x['n']):
            continue
        clave = (normal(nombre), x['n'], x['z'])
        if clave in vistos:
            continue
        vistos.add(clave)
        salida.append([nombre, x['n'], x['z'], round(la, 5), round(lo, 5)])
    salida.sort(key=lambda b: (b[1], b[0]))
    with open(os.path.join(cfg.DOCS_DATA, 'barrios.json'), 'w', encoding='utf-8') as f:
        json.dump({'fuente': 'OpenStreetMap © colaboradores de OpenStreetMap (ODbL)', 'barrios': salida}, f, ensure_ascii=False, separators=(',', ':'))
    from collections import Counter
    print(f'barrios.json: {len(salida)} barrios;', Counter(b[1] for b in salida).most_common(8))


if __name__ == '__main__':
    main()
