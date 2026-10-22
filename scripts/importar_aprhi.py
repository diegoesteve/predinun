"""Capas públicas de la Administración Provincial de Recursos Hídricos (APRHI), del Portal de Información Hídrica
de Córdoba (https://portal-aprhi.opendata.arcgis.com). Se bajan de sus servicios ArcGIS y se guardan en data/aprhi/.

- subcuencas_embalses.geojson: 71 subcuencas de los ríos serranos que llegan a los embalses (la vista que usa el
  radar). Sirven para saber si una tormenta está sobre la cuenca de un pueblo.
- cursos_agua.geojson: ríos y arroyos con su nombre oficial (relevamiento 2021), solo en la zona de las sierras.
- lineas_ribera.geojson: líneas de ribera aprobadas (límite legal del cauce).
- puntos_niveles.geojson: red de medición de niveles.

Corre una vez por mes (workflow importar_aprhi.yml) o a mano.
"""
import json
import os
import sys

import requests
from shapely.geometry import mapping, shape

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

BASE = 'https://services1.arcgis.com/atxllciEI8CHWvwW/arcgis/rest/services'
CAPAS = {
    'subcuencas_embalses': ('Subcuencas_Embalses_Vista_Radar', ['EMBALSE', 'RIO_PRINCI', 'UGH', 'CUENCA', 'Nombre_nuevo', 'codigo'], 0.0003),
    'cursos_agua': ('Cursos_2021_Vista_Publica', ['NOMBRE_COMPLETO', 'DEPARTAMENTO', 'CUENCA', 'SUBCUENCA'], 0.0001),
    'lineas_ribera': ('L%C3%ADneas_de_ribera_Vista_Publica', ['Name', 'CURSO_DE_AGUA', 'CAUDAL_DE_CALCULO', 'Estado', 'RESOLUCION'], 0.00005),
    'puntos_niveles': ('Punto_de_medici%C3%B3n_de_niveles_(vista)', ['Nombre', 'Rio', 'Observaciones'], 0),
}
SIERRAS = '-65.9,-33.8,-63.6,-29.6'   # oeste, sur, este, norte
CABECERA = {'User-Agent': 'predinun (proyecto sin fines comerciales; github.com/diegoesteve/predinun)'}


def redondear(c):
    return round(c, 5) if isinstance(c, float) else [redondear(x) for x in c]


def bajar(servicio, campos, solo_sierras):
    feats, desde = [], 0
    while True:
        params = {'where': '1=1', 'outFields': ','.join(campos), 'f': 'geojson', 'outSR': 4326,
                  'resultOffset': desde, 'resultRecordCount': 1000, 'geometryPrecision': 5}
        if solo_sierras:
            params.update({'geometry': SIERRAS, 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326,
                           'spatialRel': 'esriSpatialRelIntersects'})
        r = requests.get(f'{BASE}/{servicio}/FeatureServer/0/query', params=params, headers=CABECERA, timeout=120)
        r.raise_for_status()
        j = r.json()
        lote = j.get('features', [])
        feats += lote
        if not lote or not (j.get('exceededTransferLimit') or j.get('properties', {}).get('exceededTransferLimit')):
            break
        desde += len(lote)
    return feats


def main():
    destino = os.path.join(cfg.DATA, 'aprhi')
    os.makedirs(destino, exist_ok=True)
    for nombre, (servicio, campos, tolerancia) in CAPAS.items():
        try:
            feats = bajar(servicio, campos, solo_sierras=nombre == 'cursos_agua')
        except Exception as e:
            print(f'{nombre}: no se pudo bajar ({str(e)[:100]})')
            continue
        salida = []
        for f in feats:
            if not f.get('geometry'):
                continue
            g = shape(f['geometry'])
            if tolerancia:
                g = g.simplify(tolerancia, preserve_topology=True)
            props = {k: (v.strip() if isinstance(v, str) else v) for k, v in (f.get('properties') or {}).items() if k in campos}
            salida.append({'type': 'Feature', 'properties': props, 'geometry': {'type': g.geom_type, 'coordinates': redondear(json.loads(json.dumps(mapping(g)))['coordinates'])}})
        with open(os.path.join(destino, f'{nombre}.geojson'), 'w', encoding='utf-8') as fh:
            json.dump({'type': 'FeatureCollection', 'fuente': 'APRHI, Portal de Información Hídrica de Córdoba',
                       'features': salida}, fh, ensure_ascii=False, separators=(',', ':'))
        print(f'{nombre}: {len(salida)} elementos')


if __name__ == '__main__':
    main()
