"""Lugar alto de referencia para cada barrio y pueblo: a dónde ir si el agua sube.

1. Lugares públicos y conocidos de OpenStreetMap en Córdoba y Santa Fe (escuelas, hospitales, centros de salud,
   centros vecinales, municipalidades, comisarías, bomberos, iglesias).
2. Para esos lugares y para cada barrio y pueblo, la «altura sobre el desagüe más cercano» (HAND, MERIT Hydro, 90 m):
   cuántos metros más arriba está cada punto que el arroyo, río o canal hacia el que corre el agua.
3. Para cada barrio y pueblo, el lugar más cercano (a menos de RADIO_KM) que esté al menos ALTO_M metros por encima
   de su desagüe y por encima del barrio. En el Paraná, además, que no se moje ni con la crecida récord según la
   simulación (docs/data/simulacion/<id>.png), si el lugar cae en un recorte simulado.

Es una referencia por el relieve, NO un centro de evacuación oficial: la app lo dice siempre. El relieve satelital
tiene errores de algunos metros y no ve defensas, terraplenes ni el estado de las calles para llegar.

Escribe docs/data/altos/<zona>/<localidad>.json (uno por localidad, para que la app baje solo el suyo): {"<barrio o vacío>": {"h": metros del barrio sobre su
desagüe, "d": {"n": nombre, "t": tipo, "m": distancia, "r": rumbo, "h": metros sobre su desagüe, "la", "lo"}}}.
Corre en el boletín cuando se pide (opción «lugares_altos») o si falta el archivo.
"""
import json
import math
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402
from alerta.boletin import iniciar_ee   # noqa: E402

RADIO_KM = 3.0
ALTO_M = {'cba': 8.0, 'sf': 4.0}     # sierras: arroyos encajonados; llanura: el agua sube menos pero cubre más
TIPOS = {'school': 'escuela', 'college': 'instituto', 'university': 'facultad', 'hospital': 'hospital',
         'clinic': 'centro de salud', 'community_centre': 'centro vecinal', 'townhall': 'municipalidad',
         'police': 'comisaría', 'fire_station': 'bomberos', 'place_of_worship': 'iglesia o templo'}
FILTRO = 'nwr["amenity"~"^(' + '|'.join(TIPOS) + ')$"]["name"]'
CAJA = (-35.0, -66.0, -22.0, -58.5)    # Córdoba y Santa Fe; se pide de a cuadrados de PASO grados para no saturar Overpass
PASO = 1.5
SERVIDORES = ('https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
              'https://overpass.private.coffee/api/interpreter')
RUMBOS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste']


def km(a, b, c, d):
    return math.hypot((a - c) * 111.3, (b - d) * 111.3 * math.cos(math.radians(a)))


def rumbo(la0, lo0, la1, lo1):
    ang = math.degrees(math.atan2((lo1 - lo0) * math.cos(math.radians(la0)), la1 - la0)) % 360
    return RUMBOS[int((ang + 22.5) // 45) % 8]


def overpass():
    s0, w0, n0, e0 = CAJA
    vistos, salida = set(), []
    la = s0
    while la < n0:
        lo = w0
        while lo < e0:
            q = f'[out:json][timeout:90];{FILTRO}({la},{lo},{min(la + PASO, n0)},{min(lo + PASO, e0)});out center tags;'
            for intento in range(6):
                url = SERVIDORES[intento % len(SERVIDORES)]
                try:
                    r = requests.get(url, params={'data': q}, headers={'User-Agent': 'predinun/1.0 (sin fines comerciales)'}, timeout=120)
                    r.raise_for_status()
                    for el in r.json()['elements']:
                        if (el['type'], el['id']) not in vistos:
                            vistos.add((el['type'], el['id']))
                            salida.append(el)
                    break
                except Exception as e:
                    print('Overpass:', url, la, lo, str(e)[:100])
                    time.sleep(15)
            else:
                raise RuntimeError(f'Overpass no respondió para el cuadrado {la},{lo}')
            time.sleep(2)
            lo += PASO
        la += PASO
    return salida


def hand(ee, puntos):
    """Metros sobre el desagüe más cercano (MERIT Hydro «hnd») para cada (lat, lon), de a 2500."""
    img = ee.Image('MERIT/Hydro/v1_0_1').select('hnd')
    salida = []
    for i in range(0, len(puntos), 2500):
        fc = ee.FeatureCollection([ee.Feature(ee.Geometry.Point([lo, la]), {'i': k}) for k, (la, lo) in enumerate(puntos[i:i + 2500])])
        for intento in range(3):
            try:
                res = img.reduceRegions(collection=fc, reducer=ee.Reducer.first(), scale=90).getInfo()
                break
            except Exception as e:
                if intento == 2:
                    raise
                print('  reintento EE:', str(e)[:100])
                time.sleep(20)
        valores = {f['properties']['i']: f['properties'].get('first') for f in res['features']}
        salida += [valores.get(k) for k in range(len(puntos[i:i + 2500]))]
    return salida


def secos_por_simulacion():
    """Función (lat, lon) → False si ese punto se moja con la mayor altura simulada del Paraná; None si no hay simulación."""
    sim = cfg.leer_json(os.path.join('..', 'docs', 'data', 'simulacion.json')) or {}
    cajas = []
    try:
        import numpy as np
        from PIL import Image
        for e in sim.get('escalas', []):
            ruta = os.path.join(cfg.DOCS_DATA, 'simulacion', f"{e['id']}.png")
            if os.path.exists(ruta):
                cajas.append((e['limites'], np.array(Image.open(ruta))))
    except Exception as e:
        print('sin simulación:', str(e)[:80])

    def seco(la, lo):
        for (lim, idx) in cajas:
            (s, w), (n, e_) = lim
            if s <= la <= n and w <= lo <= e_:
                fila = int((n - la) / (n - s) * idx.shape[0])
                col = int((lo - w) / (e_ - w) * idx.shape[1])
                fila, col = min(max(fila, 0), idx.shape[0] - 1), min(max(col, 0), idx.shape[1] - 1)
                return idx[fila, col] == 0
        return None
    return seco


def slug(t):
    import re
    import unicodedata
    t = ''.join(c for c in unicodedata.normalize('NFD', t or '') if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')


def escribir(salida):
    """Un archivo chico por localidad (con sus barrios), para que la app baje solo el suyo:
    docs/data/altos/<zona>/<localidad>.json → {"": {...pueblo...}, "<barrio>": {...}}"""
    import shutil
    base = os.path.join(cfg.DOCS_DATA, 'altos')
    shutil.rmtree(base, ignore_errors=True)
    por_loc = {}
    for clave, v in salida.items():
        z, loc, barrio = clave.split(':', 2)
        por_loc.setdefault((z, loc), {})[barrio] = v
    for (z, loc), v in por_loc.items():
        os.makedirs(os.path.join(base, z), exist_ok=True)
        with open(os.path.join(base, z, slug(loc) + '.json'), 'w', encoding='utf-8') as f:
            json.dump(v, f, ensure_ascii=False, separators=(',', ':'))


def main():
    ee = iniciar_ee()
    if ee is None:
        print('Sin Earth Engine: no se calculan los lugares altos.')
        return
    app = cfg.leer_json(os.path.join('..', 'docs', 'data', 'app.json')) or {}
    barrios = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'barrios.json')) or {}).get('barrios', [])
    destinos = []
    for e in overpass():
        t = e.get('tags') or {}
        c = e.get('center') or ({'lat': e['lat'], 'lon': e['lon']} if 'lat' in e else None)
        if c and t.get('name') and t.get('amenity') in TIPOS:
            destinos.append({'n': t['name'].strip()[:80], 't': TIPOS[t['amenity']], 'la': round(c['lat'], 5), 'lo': round(c['lon'], 5)})
    objetivos = [(f"{x['z']}:{x['n']}:", x['z'], x['la'], x['lo']) for x in app.get('lugares', [])]
    objetivos += [(f"{b[2]}:{b[1]}:{b[0]}", b[2], b[3], b[4]) for b in barrios]
    print(f'{len(destinos)} lugares públicos, {len(objetivos)} barrios y pueblos')
    h = hand(ee, [(d['la'], d['lo']) for d in destinos] + [(o[2], o[3]) for o in objetivos])
    for d, v in zip(destinos, h[:len(destinos)]):
        d['h'] = v
    seco = secos_por_simulacion()
    destinos = [d for d in destinos if d['h'] is not None]
    # índice por cuadrados de 0,05° para buscar rápido
    grilla = {}
    for d in destinos:
        grilla.setdefault((int(d['la'] * 20), int(d['lo'] * 20)), []).append(d)
    salida = {}
    for (clave, z, la, lo), ho in zip(objetivos, h[len(destinos):]):
        minimo = max(ALTO_M[z], (ho or 0) + 2)
        cerca = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                cerca += grilla.get((int(la * 20) + dy, int(lo * 20) + dx), [])
        mejores = sorted(((km(la, lo, d['la'], d['lo']), d) for d in cerca if d['h'] >= minimo), key=lambda t: t[0])
        elegido = None
        for dist, d in mejores:
            if dist > RADIO_KM:
                break
            if z == 'sf' and seco(d['la'], d['lo']) is False:
                continue          # en la simulación del Paraná se moja con la crecida récord
            elegido = (dist, d)
            break
        salida[clave] = {'h': round(ho, 1) if ho is not None else None}
        if elegido:
            dist, d = elegido
            salida[clave]['d'] = {'n': d['n'], 't': d['t'], 'm': int(round(dist * 1000, -1)), 'r': rumbo(la, lo, d['la'], d['lo']),
                                  'h': round(d['h'], 1), 'la': d['la'], 'lo': d['lo']}
    escribir(salida)
    con = sum('d' in v for v in salida.values())
    print(f'lugares_altos.json: {len(salida)} barrios y pueblos, {con} con un lugar alto a menos de {RADIO_KM} km')


if __name__ == '__main__':
    main()
