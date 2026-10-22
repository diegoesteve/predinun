"""Núcleos de tormenta del radar de Córdoba (RMA1), según el Observatorio Hidro-Meteorológico de Córdoba (OHMC).

Lee la API pública del visor WebMet (https://webmet.ohmc.ar): la última detección de «topes y núcleos» del radar,
cada ~10 minutos. Cada núcleo es un punto con su intensidad en dBZ; alrededor hay un polígono («blob») con la
intensidad máxima. Este script marca qué localidades y cuencas tienen un núcleo intenso cerca en este momento.

Solo lectura y pocas consultas (dos cada 15 minutos, desde el workflow del monitor). No se muestran las imágenes
del radar en la página: eso cargaría el servidor del OHMC con cada visita.

Escribe docs/data/radar.json.
"""
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

API = 'https://webmet.ohmc.ar/api/v1'
RADARES = ['RMA1', 'RMA17', 'RMA16']   # Córdoba; si no responde, Alejandro Roca y Villa Reynolds
VIGENCIA_MIN = 40                       # más viejo que esto no se considera «ahora»
DBZ_INTENSA = 45                        # lluvia intensa (la escala del OHMC: 40-50 intensa, 60+ muy intensa y granizo)
DBZ_MUY_INTENSA = 55
CABECERA = {'User-Agent': 'predinun (proyecto sin fines comerciales; github.com/diegoesteve/predinun)'}
# Zona de las sierras donde tiene sentido mirar
SIERRAS = {'lat': (-33.6, -29.8), 'lon': (-65.6, -63.7)}


def km(lat1, lon1, lat2, lon2):
    return math.hypot((lat1 - lat2) * 111.3, (lon1 - lon2) * 111.3 * math.cos(math.radians(lat1)))


def dentro(lon, lat, anillo):
    adentro = False
    for (x1, y1), (x2, y2) in zip(anillo, anillo[1:] + anillo[:1]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            adentro = not adentro
    return adentro


def radio_km(area_km2):
    """Qué tan lejos de donde el arroyo entra al pueblo puede estar la tormenta para que el agua llegue:
    aproximadamente el largo de la cuenca, entre 5 y 25 km."""
    return max(5.0, min(25.0, 1.4 * math.sqrt(area_km2 or 0)))


def pedir(ruta, params=None):
    r = requests.get(f'{API}/{ruta}', params=params, headers=CABECERA, timeout=30)
    r.raise_for_status()
    return r.json()


def ultima_deteccion(ahora):
    desde = (ahora - timedelta(minutes=VIGENCIA_MIN)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    hasta = ahora.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    for radar in RADARES:
        try:
            lista = pedir('tops-cores', [('time_from', desde), ('time_to', hasta), ('radar_codes', radar)])
        except Exception as e:
            print(f'{radar}: sin respuesta ({str(e)[:80]})')
            continue
        lista = [x for x in lista if x.get('status') == 'available']
        if lista:
            return max(lista, key=lambda x: x['observation_time'])
    return None


def main():
    ahora = datetime.now(timezone.utc)
    salida = {'fuente': 'Observatorio Hidro-Meteorológico de Córdoba (OHMC), webmet.ohmc.ar',
              'consultado': ahora.astimezone(timezone(timedelta(hours=-3))).strftime('%Y-%m-%d %H:%M'),
              'radar': None, 'observacion': None, 'nucleos': [], 'cuencas': {}, 'localidades': {}}
    det = ultima_deteccion(ahora)
    if det:
        feats = pedir(f"tops-cores/{det['id']}/features").get('features', [])
        obs = datetime.fromisoformat(det['observation_time'].replace('Z', '+00:00'))
        salida['radar'] = det['radar_code']
        salida['observacion'] = obs.astimezone(timezone(timedelta(hours=-3))).strftime('%Y-%m-%d %H:%M')
        salida['minutos'] = round((ahora - obs).total_seconds() / 60)
        blobs = [f for f in feats if f['properties'].get('type') == 'blob' and f['geometry']['type'] == 'Polygon']
        topes = [f for f in feats if f['properties'].get('type') == 'top']
        for f in feats:
            p = f['properties']
            if p.get('type') != 'core':
                continue
            lon, lat = f['geometry']['coordinates'][:2]
            if not (SIERRAS['lat'][0] <= lat <= SIERRAS['lat'][1] and SIERRAS['lon'][0] <= lon <= SIERRAS['lon'][1]):
                continue
            maximo = p.get('intensity_dbz')
            for b in blobs:
                if dentro(lon, lat, b['geometry']['coordinates'][0]):
                    maximo = max(maximo or 0, b['properties'].get('max_dbz') or 0)
                    break
            tope = None
            cercanos = [t for t in topes if t['properties'].get('parent_core_dbz') == p.get('intensity_dbz')]
            if cercanos:
                t = min(cercanos, key=lambda t: km(lat, lon, t['geometry']['coordinates'][1], t['geometry']['coordinates'][0]))
                if km(lat, lon, t['geometry']['coordinates'][1], t['geometry']['coordinates'][0]) <= 15:
                    tope = round(t['properties'].get('altitude_m', 0) / 1000, 1)
            salida['nucleos'].append({'lat': round(lat, 4), 'lon': round(lon, 4), 'dbz': p.get('intensity_dbz'),
                                      'max_dbz': maximo, 'tope_km': tope})

    intensos = [n for n in salida['nucleos'] if (n['max_dbz'] or 0) >= DBZ_INTENSA]
    # Cuencas del boletín
    cuencas = (cfg.leer_json('cuencas.geojson') or {}).get('features', [])
    for c in cuencas:
        g = c['geometry']
        anillos = [g['coordinates'][0]] if g['type'] == 'Polygon' else [p[0] for p in g['coordinates']]
        dentro_c = [n for n in intensos if any(dentro(n['lon'], n['lat'], a) for a in anillos)]
        if dentro_c:
            salida['cuencas'][c['properties']['nombre']] = {'nucleos': len(dentro_c), 'max_dbz': max(n['max_dbz'] for n in dentro_c)}
    # Localidades: núcleo intenso a menos del largo aproximado de la cuenca de alguno de sus arroyos, o a 5 km del centro
    locs = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'localidades.json')) or {}).get('localidades', [])
    for f in locs:
        puntos = [(f['lat'], f['lon'], 5.0)] + [(a['lat'], a['lon'], radio_km(a.get('area_km2'))) for a in f.get('arroyos', [])]
        mejor = None
        for n in intensos:
            for la, lo, r in puntos:
                d = km(la, lo, n['lat'], n['lon'])
                if d <= r and (mejor is None or n['max_dbz'] > mejor['max_dbz'] or (n['max_dbz'] == mejor['max_dbz'] and d < mejor['km'])):
                    mejor = {'km': round(d, 1), 'max_dbz': n['max_dbz'], 'tope_km': n['tope_km']}
        if mejor:
            mejor['nivel'] = 'muy intensa' if mejor['max_dbz'] >= DBZ_MUY_INTENSA else 'intensa'
            salida['localidades'][f['localidad']] = mejor
    with open(os.path.join(cfg.DOCS_DATA, 'radar.json'), 'w', encoding='utf-8') as fh:
        json.dump(salida, fh, ensure_ascii=False, indent=1)
    print(f"radar.json: {salida['radar']} {salida['observacion']}, {len(salida['nucleos'])} núcleos en las sierras, "
          f"{len(intensos)} intensos, {len(salida['localidades'])} localidades con tormenta intensa cerca")


if __name__ == '__main__':
    main()
