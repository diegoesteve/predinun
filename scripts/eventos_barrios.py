"""Lo que contaron los vecinos, por barrio, y con cuánta lluvia se inundó cada uno.

Para cada aporte aprobado (data/aportes/*.json) que diga un barrio (o tenga un punto en el mapa) y una fecha:
  - se ubica el barrio (docs/data/barrios.json, de OpenStreetMap) o el más cercano al punto (a menos de 2 km);
  - se busca cuánto llovió ese día y el anterior en ese lugar (Open-Meteo, reanálisis ERA5-Land, ~9 km);
  - el «umbral» del barrio es la menor lluvia con la que se inundó, con un margen: si mañana se espera al menos eso, la
    app avisa «con lluvias así, tu barrio ya se inundó».
La lluvia del reanálisis es un promedio de la zona: en una tormenta muy localizada puede quedar corta. Por eso se usa
la menor de las lluvias registradas y un margen hacia abajo, y nunca menos de UMBRAL_MIN_MM.

Escribe docs/data/barrios_eventos.json: {"<zona>:<localidad>:<barrio>": {"eventos": [...], "umbral_mm": …}}.
Corre en el boletín (también cuando se aprueba un aporte).
"""
import glob
import json
import math
import os
import re
import sys
import time
import unicodedata

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

ARCHIVO = 'https://archive-api.open-meteo.com/v1/archive'
MARGEN = 0.8
UMBRAL_MIN_MM = 15
MESES = {m: i for i, m in enumerate(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
                                     'octubre', 'noviembre', 'diciembre'], 1)}


def normal(t):
    return ''.join(c for c in unicodedata.normalize('NFD', t or '') if not unicodedata.combining(c)).lower().strip()


def km(a, b, c, d):
    return math.hypot((a - c) * 111.3, (b - d) * 111.3 * math.cos(math.radians(a)))


def fecha_de(a):
    """La fecha exacta del formulario, o una que se pueda leer del texto («15 de febrero de 2015», «15/02/2015»)."""
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', a.get('fecha') or ''):
        return a['fecha']
    t = normal(a.get('fecha_evento'))
    m = re.search(r'(\d{1,2})[/-](\d{1,2})[/-](\d{4})', t)
    if m:
        return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    m = re.search(r'(\d{1,2}) de (' + '|'.join(MESES) + r') (?:de |del )?(\d{4})', t)
    if m:
        return f'{m.group(3)}-{MESES[m.group(2)]:02d}-{int(m.group(1)):02d}'
    return None


def lluvia(la, lo, fecha):
    """Lluvia del día y del anterior (mm): la mayor de las dos, por si la tormenta fue de noche."""
    from datetime import date, timedelta
    d = date.fromisoformat(fecha)
    for k in range(3):
        try:
            r = requests.get(ARCHIVO, params={'latitude': la, 'longitude': lo, 'start_date': (d - timedelta(days=1)).isoformat(),
                                              'end_date': d.isoformat(), 'daily': 'precipitation_sum', 'models': 'era5_land',
                                              'timezone': cfg.TZ}, timeout=60)
            r.raise_for_status()
            v = [x for x in r.json()['daily']['precipitation_sum'] if x is not None]
            return round(max(v), 1) if v else None
        except Exception:
            if k == 2:
                return None
            time.sleep(10)


def main():
    barrios = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'barrios.json')) or {}).get('barrios', [])
    lugares = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'app.json')) or {}).get('lugares', [])
    zona_de = {normal(x['n']): x['z'] for x in lugares}
    anterior = cfg.leer_json(os.path.join('..', 'docs', 'data', 'barrios_eventos.json')) or {}
    ya = {(e.get('id')): e for v in anterior.values() for e in v.get('eventos', [])}
    salida = {}
    for ruta in sorted(glob.glob(os.path.join(cfg.DATA, 'aportes', '*.json'))):
        with open(ruta, encoding='utf-8') as f:
            a = json.load(f)
        fecha = fecha_de(a)
        if not fecha:
            continue
        loc = normal(a.get('localidad'))
        b = None
        if a.get('barrio'):
            b = next((x for x in barrios if normal(x[0]) == normal(a['barrio']) and normal(x[1]) == loc), None) \
                or next((x for x in barrios if normal(x[0]) == normal(a['barrio'])), None)
        if b is None and a.get('lat') is not None:
            cerca = min(barrios, key=lambda x: km(a['lat'], a['lon'], x[3], x[4]), default=None)
            if cerca and km(a['lat'], a['lon'], cerca[3], cerca[4]) <= 2:
                b = cerca
        if b is None:
            continue
        nombre, localidad, zona, la, lo = b
        previo = ya.get(a['id'])
        mm = previo['lluvia_mm'] if previo and previo.get('fecha') == fecha else lluvia(a.get('lat') or la, a.get('lon') or lo, fecha)
        clave = f"{zona or zona_de.get(loc, '')}:{localidad}:{nombre}"
        salida.setdefault(clave, {'eventos': []})['eventos'].append({
            'id': a['id'], 'fecha': fecha, 'lluvia_mm': mm, 'que': (a.get('altura_agua') or '')[:140]})
    for v in salida.values():
        v['eventos'].sort(key=lambda e: e['fecha'], reverse=True)
        mms = [e['lluvia_mm'] for e in v['eventos'] if e.get('lluvia_mm')]
        v['umbral_mm'] = max(UMBRAL_MIN_MM, round(min(mms) * MARGEN)) if mms else None
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'barrios_eventos.json'), salida)
    print(f'barrios_eventos.json: {len(salida)} barrios con relatos, {sum(len(v["eventos"]) for v in salida.values())} eventos')


if __name__ == '__main__':
    main()
