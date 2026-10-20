"""Extrae del repositorio OpenDataCordoba/mapas-de-cordoba (GeoPortal de la Provincia, 2008-2010, dominio público)
lo que sirve para el análisis de crecidas en las sierras:

  data/geoportal/localidades_limites.geojson   límite urbano (envolvente) de cada localidad
  data/geoportal/rios_urbanos.geojson          ríos y arroyos dentro de cada localidad, con nombre
  data/geoportal/puentes.geojson               puentes cargados en esas capas (solo algunas localidades)

Uso: python scripts/importar_geoportal.py /ruta/a/mapas-de-cordoba
"""
import glob
import json
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, 'data', 'geoportal')
REGION = {'oeste': -65.50, 'este': -64.05, 'sur': -33.30, 'norte': -29.85}   # sierras (igual que el paso 9)
NO_CURSO = re.compile(r'FFCC|F\.C\.|^FC|FERROCARRIL|\bVIA\b|VIAS|RUTA|CALLE|LIM|SENDERO|CAMINO', re.I)
PUENTE = re.compile(r'^(PTE|PUENTE)\b', re.I)


def cargar(ruta):
    crudo = open(ruta, 'rb').read()
    try:
        return json.loads(crudo.decode('utf-8'))
    except UnicodeDecodeError:
        return json.loads(crudo.decode('latin-1'))


def redondear(c):
    return [redondear(x) for x in c] if isinstance(c[0], list) else [round(c[0], 5), round(c[1], 5)]


def centro(geom):
    pts = []

    def juntar(c):
        if isinstance(c[0], (int, float)):
            pts.append(c)
        else:
            for x in c:
                juntar(x)
    juntar(geom['coordinates'])
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def dentro(geom):
    lon, lat = centro(geom)
    return REGION['oeste'] <= lon <= REGION['este'] and REGION['sur'] <= lat <= REGION['norte']


def archivos(carpeta, capa):
    # Por localidad, la capa de 2010; si no está, la de 2008
    por_loc = {}
    for anio in ('2008', '2010'):
        for f in glob.glob(os.path.join(carpeta, f'*_{capa}_{anio}.geojson')):
            por_loc[os.path.basename(f).split('_')[0]] = (f, anio)
    return por_loc


def main(repo):
    carpeta = os.path.join(repo, 'hackathONG-2015', 'procesamiento_zip', 'geojson')
    os.makedirs(SALIDA, exist_ok=True)

    limites, en_region = [], set()
    for loc, (f, anio) in sorted(archivos(carpeta, 'envolvente').items()):
        for ft in cargar(f)['features']:
            if not ft.get('geometry') or not dentro(ft['geometry']):
                continue
            p = ft['properties']
            en_region.add(loc)
            limites.append({'type': 'Feature', 'geometry': {'type': ft['geometry']['type'],
                                                            'coordinates': redondear(ft['geometry']['coordinates'])},
                            'properties': {'localidad': (p.get('NOMLOC') or loc).title(), 'archivo': loc,
                                           'municipio': (p.get('NOMMUNI') or '').title(), 'depto': p.get('DEPTO'),
                                           'codloc': p.get('CODLOC'), 'anio': int(anio)}})

    rios, puentes = [], []
    capas_rios = {}
    for capa in ('rios', 'rios-y-ffcc', 'ffcc-y-rios', 'rios-y-embalses', 'rios-y-diques'):
        capas_rios.update(archivos(carpeta, capa))
    for loc, (f, anio) in sorted(capas_rios.items()):
        if loc not in en_region:
            continue
        for ft in cargar(f)['features']:
            g = ft.get('geometry')
            if not g:
                continue
            nombre = str(ft['properties'].get('NOMBRE') or '').strip()
            base = {'type': 'Feature', 'geometry': {'type': g['type'], 'coordinates': redondear(g['coordinates'])}}
            if PUENTE.match(nombre):
                puentes.append({**base, 'properties': {'nombre': nombre.title(), 'archivo': loc, 'anio': int(anio)}})
            elif nombre and not NO_CURSO.search(nombre):
                rios.append({**base, 'properties': {'nombre': nombre.title(), 'archivo': loc, 'anio': int(anio)}})

    for nombre, feats in (('localidades_limites', limites), ('rios_urbanos', rios), ('puentes', puentes)):
        json.dump({'type': 'FeatureCollection', 'features': feats},
                  open(os.path.join(SALIDA, f'{nombre}.geojson'), 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'{nombre}: {len(feats)} elementos')
    print('Localidades en la región:', len(en_region))


if __name__ == '__main__':
    main(sys.argv[1])
