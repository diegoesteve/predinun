"""Núcleos de tormenta del radar de Córdoba (RMA1), según el Observatorio Hidro-Meteorológico de Córdoba (OHMC).

Lee la API pública del visor WebMet (https://webmet.ohmc.ar): la última detección de «topes y núcleos» del radar,
cada ~10 minutos. Cada núcleo es un punto con su intensidad en dBZ; alrededor hay un polígono («blob») con la
intensidad máxima. Este script marca qué localidades tienen un núcleo intenso sobre la cuenca de sus arroyos
(data/cuencas_arroyos.geojson) en este momento.

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
    # Localidades. Una tormenta cuenta para un pueblo si cae:
    #  1) dentro de la cuenca de aporte de alguno de sus arroyos (data/cuencas_arroyos.geojson, calculada con MERIT);
    #  2) para arroyos sin cuenca calculada: en la misma subcuenca oficial de la APRHI, o a menos del largo aproximado
    #     de su cuenca;
    #  3) a menos de 5 km del centro del pueblo.
    subcuencas = []
    for sc in (cfg.leer_json(os.path.join('aprhi', 'subcuencas_embalses.geojson')) or {}).get('features', []):
        g = sc['geometry']
        anillos = [g['coordinates'][0]] if g['type'] == 'Polygon' else [p[0] for p in g['coordinates']]
        subcuencas.append((sc['properties'].get('Nombre_nuevo') or sc['properties'].get('RIO_PRINCI') or 'subcuenca', anillos))
    en_subcuenca = lambda lo, la: [n for n, anillos in subcuencas if any(dentro(lo, la, a) for a in anillos)]   # noqa: E731
    for n in intensos:
        n['subcuencas'] = en_subcuenca(n['lon'], n['lat'])
    propias_cuencas = {}
    for c in (cfg.leer_json('cuencas_arroyos.geojson') or {}).get('features', []):
        g = c['geometry']
        anillos = [g['coordinates'][0]] if g['type'] == 'Polygon' else [p[0] for p in g['coordinates']]
        q = c['properties']
        propias_cuencas.setdefault(q['localidad'], {})[q['arroyo_n']] = anillos
    locs = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'localidades.json')) or {}).get('localidades', [])
    for f in locs:
        cuencas_loc = propias_cuencas.get(f['localidad'], {})
        mejor = None

        def considerar(n, d, **extra):
            nonlocal mejor
            if mejor is None or n['max_dbz'] > mejor['max_dbz'] or (n['max_dbz'] == mejor['max_dbz'] and d < mejor['km']):
                mejor = {'km': round(d, 1), 'max_dbz': n['max_dbz'], 'tope_km': n['tope_km'], **extra}

        for n in intensos:
            d_centro = km(f['lat'], f['lon'], n['lat'], n['lon'])
            if d_centro <= 5:
                considerar(n, d_centro)
            for i, a in enumerate(f.get('arroyos', [])):
                d = km(a['lat'], a['lon'], n['lat'], n['lon'])
                if i in cuencas_loc:
                    if any(dentro(n['lon'], n['lat'], an) for an in cuencas_loc[i]):
                        considerar(n, d, cuenca_de=a.get('arroyo') or 'un arroyo')
                    continue
                comun = set(en_subcuenca(a['lon'], a['lat'])).intersection(n['subcuencas'])
                if comun:
                    considerar(n, d, subcuenca=sorted(comun)[0])
                elif d <= radio_km(a.get('area_km2')):
                    considerar(n, d)
        if mejor:
            mejor['nivel'] = 'muy intensa' if mejor['max_dbz'] >= DBZ_MUY_INTENSA else 'intensa'
            salida['localidades'][f['localidad']] = mejor
    for n in salida['nucleos']:
        n.pop('subcuencas', None)
    with open(os.path.join(cfg.DOCS_DATA, 'radar.json'), 'w', encoding='utf-8') as fh:
        json.dump(salida, fh, ensure_ascii=False, indent=1)
    print(f"radar.json: {salida['radar']} {salida['observacion']}, {len(salida['nucleos'])} núcleos en las sierras, "
          f"{len(intensos)} intensos, {len(salida['localidades'])} localidades con tormenta intensa cerca")
    avisar_alertas(salida, locs, ahora)


SITIO = os.environ.get('SITIO_URL', 'https://diegoesteve.github.io/predinun/')
REAVISO_H = 3          # no repetir el aviso de una misma localidad antes de 3 horas
VIGENCIA_AVISO_MIN = 30


def slug(nombre):
    import re
    import unicodedata
    s = ''.join(c for c in unicodedata.normalize('NFD', nombre) if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def avisar_alertas(salida, locs, ahora):
    """Telegram: localidades que pasan a alerta por una tormenta sobre su cuenca (misma regla que el semáforo de la
    página: tormenta intensa en un lugar muy expuesto, o muy intensa en uno expuesto). Una vez por localidad cada 3 h."""
    token, chat = os.environ.get('TELEGRAM_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID')
    if salida.get('minutos') is None or salida['minutos'] > VIGENCIA_AVISO_MIN:
        return
    expo = {f['localidad']: f.get('exposicion') for f in locs}
    alerta = {n: v for n, v in salida['localidades'].items()
              if expo.get(n) == 'muy expuesta' or (expo.get(n) == 'expuesta' and v['nivel'] == 'muy intensa')}
    ruta = os.path.join(cfg.DATA, 'monitor', 'radar_avisados.json')
    avisados = cfg.leer_json(os.path.join('monitor', 'radar_avisados.json')) or {}
    limite = (ahora - timedelta(hours=REAVISO_H)).isoformat()
    avisados = {k: t for k, t in avisados.items() if t > limite}
    nuevas = {n: v for n, v in alerta.items() if n not in avisados}
    if nuevas:
        lineas = []
        for n, v in sorted(nuevas.items(), key=lambda x: (-x[1]['max_dbz'], x[1]['km'])):
            donde = f"sobre la cuenca del {v['cuenca_de']}" if v.get('cuenca_de') else (f"sobre la {v['subcuenca']}" if v.get('subcuenca') else f"a {v['km']} km")
            lineas.append(f"• {n}: tormenta {v['nivel']} {donde} ({v['max_dbz']} dBZ). {SITIO}l/{slug(n)}/")
        texto = (f"🔴 Alerta por tormenta (radar de Córdoba, {salida['observacion'][11:]} h)\n" + '\n'.join(lineas) +
                 '\n\nUna tormenta sobre la cuenca puede hacer crecer el arroyo en minutos. Monitor experimental, no oficial.')
        print(texto)
        if token and chat:
            try:
                requests.post(f'https://api.telegram.org/bot{token}/sendMessage',
                              data={'chat_id': chat, 'text': texto, 'disable_web_page_preview': 'true'}, timeout=20)
            except Exception as e:
                print('No se pudo enviar a Telegram:', e)
        from alerta.historial import registrar
        registrar('crecidas', 'radar OHMC', [(n, 'alerta', f"tormenta {v['nivel']}, {v['max_dbz']} dBZ, a {v['km']} km"
                                            + (f", tope {v['tope_km']} km" if v.get('tope_km') else '')
                                            + (f", cuenca del {v['cuenca_de']}" if v.get('cuenca_de') else ''))
                                           for n, v in nuevas.items()], True)
        for n in nuevas:
            avisados[n] = ahora.isoformat()
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    with open(ruta, 'w', encoding='utf-8') as fh:
        json.dump(avisados, fh, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
