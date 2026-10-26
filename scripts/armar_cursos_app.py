"""Arroyos y ríos de las sierras de Córdoba en cuadrados de 0,1° para la app: con la ubicación del celular, la app
baja solo el cuadrado donde está la persona y los vecinos (pocos KB) y calcula a cuántos metros vive del arroyo más
cercano. En la crecida del 15/02/2015 en Sierras Chicas el agua llegó hasta 300 m de la orilla (informe de la UNC).

Fuente: cursos de agua de la APRHI (data/aprhi/cursos_agua.geojson, de scripts/importar_aprhi.py).
Escribe docs/data/cursos/<x>_<y>.json con x = piso(lon·10), y = piso(lat·10).
"""
import json
import math
import os
import shutil
import sys

from shapely.geometry import box, shape
from shapely.ops import transform

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

TOLERANCIA = 0.0001          # ~10 m
SALIDA = os.path.join(cfg.DOCS_DATA, 'cursos')


def main():
    g = cfg.leer_json(os.path.join('aprhi', 'cursos_agua.geojson'))
    if not g:
        print('Falta data/aprhi/cursos_agua.geojson')
        return
    celdas = {}
    for f in g['features']:
        geo = shape(f['geometry']).simplify(TOLERANCIA)
        nombre = (f['properties'].get('NOMBRE_COMPLETO') or '').strip()
        if nombre.lower() in ('', 'sin nombre', 's/n'):
            nombre = ''
        for corto, largo in (('A. ', 'arroyo '), ('Ao. ', 'arroyo '), ('R. ', 'río '), ('Rio ', 'río '), ('Río ', 'río '), ('Arroyo ', 'arroyo '), ('Cda. ', 'cañada ')):
            if nombre.startswith(corto):
                nombre = largo + nombre[len(corto):]
                break
        x0, y0, x1, y1 = geo.bounds
        for x in range(math.floor(x0 * 10), math.floor(x1 * 10) + 1):
            for y in range(math.floor(y0 * 10), math.floor(y1 * 10) + 1):
                parte = geo.intersection(box(x / 10, y / 10, (x + 1) / 10, (y + 1) / 10))
                if parte.is_empty:
                    continue
                lineas = list(getattr(parte, 'geoms', [parte]))
                for l in lineas:
                    if l.geom_type != 'LineString' or len(l.coords) < 2:
                        continue
                    celdas.setdefault((x, y), []).append([nombre, [[round(a, 5), round(b, 5)] for a, b in l.coords]])
    shutil.rmtree(SALIDA, ignore_errors=True)
    os.makedirs(SALIDA)
    total = 0
    for (x, y), ls in celdas.items():
        nombres = sorted({n for n, _ in ls})
        idx = {n: i for i, n in enumerate(nombres)}
        datos = {'nombres': nombres, 'lineas': [[idx[n], c] for n, c in ls]}
        texto = json.dumps(datos, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(SALIDA, f'{x}_{y}.json'), 'w', encoding='utf-8') as fh:
            fh.write(texto)
        total += len(texto)
    print(f'cursos: {len(celdas)} cuadrados, {total / 1e6:.1f} MB en total, {total / max(len(celdas), 1) / 1e3:.0f} KB por cuadrado en promedio')


if __name__ == '__main__':
    main()
