"""Campings y balnearios junto a ríos serranos, y cuán bajos están respecto del cauce.

1. Baja de OpenStreetMap (Overpass) los campings (tourism=camp_site), balnearios (leisure=bathing_place)
   y playas (natural=beach) de las sierras de Córdoba.
2. Con MERIT Hydro en Earth Engine mide, en un radio de 150 m alrededor de cada uno, la menor altura sobre el
   cauce (HAND) y el área de cuenca del río más grande que pasa cerca.
3. Escribe data/campings.json. armar_riesgo.py lo suma al mapa y a la tabla por localidad.

Es población temporaria: en verano puede haber más gente acampando junto a un río que viviendo en el pueblo.
Corre dentro del workflow del boletín (que es el único autorizado a usar Earth Engine) y solo rehace los datos
si tienen más de 30 días, o con FORZAR=1.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

REGION = {'oeste': -65.50, 'este': -64.05, 'sur': -33.30, 'norte': -29.85}
BLOQUE = 0.5
SERVIDORES = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
              'https://overpass.kumi.systems/api/interpreter']
CABECERA = {'User-Agent': 'predinun/1.0 (proyecto personal sin fines comerciales; github.com/diegoesteve/predinun)'}
CONSULTA = ('[out:json][timeout:90];(nwr["tourism"="camp_site"]({b});nwr["leisure"="bathing_place"]({b});'
            'nwr["natural"="beach"]({b}););out center tags;')
SALIDA = os.path.join(cfg.DATA, 'campings.json')
DIAS_VIGENCIA = 30
TIEMPO_MAX = 10 * 60
# Bajo junto a un río: a menos de 5 m de altura sobre un cauce, con un río o arroyo de más de 20 km² de cuenca a menos de 150 m
HAND_BAJO_M, UPA_RIO_KM2 = 5, 20


def vigente():
    d = cfg.leer_json('campings.json')
    if not d or os.environ.get('FORZAR') == '1' or d.get('bloques_sin_bajar'):
        return False   # si quedaron bloques sin bajar, se reintenta en la próxima corrida
    edad = datetime.now(timezone.utc) - datetime.fromisoformat(d['generado'])
    return edad.days < DIAS_VIGENCIA


def pedir_bloque(sur, oeste, norte, este, limite):
    q = CONSULTA.format(b=f'{sur:.3f},{oeste:.3f},{norte:.3f},{este:.3f}')
    for url in SERVIDORES:
        if time.time() > limite:
            return None
        try:
            r = requests.post(url, data={'data': q}, headers=CABECERA, timeout=90)
            if r.ok:
                return r.json()['elements']
            print(f'  {url.split("/")[2]}: HTTP {r.status_code}')
        except Exception as e:
            print(f'  {url.split("/")[2]}: {str(e)[:60]}')
    return None


def bajar_osm():
    limite = time.time() + TIEMPO_MAX
    lugares, faltan = {}, 0
    la = REGION['sur']
    while la < REGION['norte']:
        lo = REGION['oeste']
        while lo < REGION['este']:
            el = pedir_bloque(la, lo, min(la + BLOQUE, REGION['norte']), min(lo + BLOQUE, REGION['este']), limite)
            if el is None:
                faltan += 1
            else:
                for e in el:
                    c = e.get('center') or ({'lat': e['lat'], 'lon': e['lon']} if 'lat' in e else None)
                    if not c:
                        continue
                    t = e.get('tags', {})
                    tipo = ('camping' if t.get('tourism') == 'camp_site' else
                            'balneario' if t.get('leisure') == 'bathing_place' else 'playa')
                    lugares[f"{e['type']}/{e['id']}"] = {'osm': f"{e['type']}/{e['id']}", 'tipo': tipo,
                                                         'nombre': t.get('name', ''), 'lat': round(c['lat'], 5),
                                                         'lon': round(c['lon'], 5)}
            lo += BLOQUE
            time.sleep(1)
        la += BLOQUE
    return list(lugares.values()), faltan


def medir(lugares, ee):
    merit = ee.Image('MERIT/Hydro/v1_0_1').select(['hnd', 'upa'])
    out = []
    for i in range(0, len(lugares), 400):
        tanda = lugares[i:i + 400]
        fc = ee.FeatureCollection([ee.Feature(ee.Geometry.Point([p['lon'], p['lat']]).buffer(150), {'k': j})
                                   for j, p in enumerate(tanda)])
        res = merit.reduceRegions(collection=fc, reducer=ee.Reducer.minMax(), scale=90).getInfo()
        medidas = {f['properties']['k']: f['properties'] for f in res['features']}
        for j, p in enumerate(tanda):
            m = medidas.get(j, {})
            hnd, upa = m.get('hnd_min'), m.get('upa_max')
            out.append({**p, 'altura_sobre_cauce_m': None if hnd is None else round(hnd, 1),
                        'cuenca_rio_cercano_km2': None if upa is None else round(upa, 1),
                        'bajo_junto_a_rio': bool(hnd is not None and upa is not None
                                                 and hnd <= HAND_BAJO_M and upa >= UPA_RIO_KM2)})
    return out


def main():
    if vigente():
        print('campings.json tiene menos de 30 días: no se rehace (FORZAR=1 para rehacerlo).')
        return
    from alerta.boletin import iniciar_ee
    ee = iniciar_ee()
    if ee is None:
        print('Sin Earth Engine: no se puede medir la altura de los campings.')
        return
    lugares, faltan = bajar_osm()
    print(f'OpenStreetMap: {len(lugares)} campings, balnearios y playas ({faltan} bloques sin bajar)')
    if not lugares:
        return
    medidos = medir(lugares, ee)
    bajos = sum(p['bajo_junto_a_rio'] for p in medidos)
    cfg.escribir_json(SALIDA, {'generado': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                               'criterio': f'a menos de {HAND_BAJO_M} m sobre un cauce, con un río de más de '
                                           f'{UPA_RIO_KM2} km² de cuenca a menos de 150 m (MERIT Hydro, 90 m)',
                               'bloques_sin_bajar': faltan, 'lugares': medidos})
    print(f'campings.json: {len(medidos)} lugares, {bajos} bajos junto a un río')


if __name__ == '__main__':
    main()
