"""Cuenca de aporte de cada arroyo que entra a cada localidad, calculada con las direcciones de flujo de MERIT Hydro.

Para cada punto donde un arroyo entra a un pueblo (docs/data/localidades.json, que sale del paso 9) se toma la celda
de MERIT Hydro (90 m) con más área de aporte a menos de ~300 m, y se marcan todas las celdas cuyo camino del agua
pasa por ahí. El resultado es el contorno de la cuenca de ese arroyo: si una tormenta cae adentro, el agua llega al
pueblo. Lo usa scripts/radar_ohmc.py.

Cómo: se bajan de Earth Engine las bandas «dir» (dirección de flujo D8) y «upa» (área de aporte) para la zona de las
sierras, en la grilla original de MERIT. Cada celda apunta a la de abajo; con saltos de puntero (en cada vuelta cada
celda mira el doble de lejos) se encuentra para cada celda el primer punto de salida aguas abajo. Eso da la cuenca
propia de cada salida, y la cuenca completa es la suya más las de las salidas que tiene aguas arriba.

Escribe data/cuencas_arroyos.geojson. Corre a mano (workflow del boletín con «cuencas» tildado) o si falta el archivo.
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402
from alerta.boletin import iniciar_ee   # noqa: E402

RES = 1 / 1200                     # MERIT Hydro: 3 segundos de arco
OESTE, ESTE, SUR, NORTE = -65.9, -63.4, -33.8, -29.6
SNAP_CELDAS = 3                    # buscar la salida a ±3 celdas (~270 m)
AREA_MAX_KM2 = 6000                # más grande que esto es un río troncal: no sirve para avisar a un pueblo
# D8 de MERIT: 1=E 2=SE 4=S 8=SO 16=O 32=NO 64=N 128=NE
D8 = {1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1), 64: (-1, 0), 128: (-1, 1)}


def bajar_todo(ee, banda, tipo, lado=1500):
    """Baja una banda de MERIT en la grilla original, por bloques, con computePixels (no necesita permiso para crear
    enlaces de descarga, que la cuenta de servicio del proyecto no tiene)."""
    import rasterio
    col0 = int(np.floor((OESTE + 180) / RES))
    fila0 = int(np.floor((90 - NORTE) / RES))
    ancho = int(np.ceil((ESTE - OESTE) / RES))
    alto = int(np.ceil((NORTE - SUR) / RES))
    x0, y0 = -180 + col0 * RES, 90 - fila0 * RES
    img = ee.Image('MERIT/Hydro/v1_0_1').select(banda)
    img = img.unmask(0).toUint8() if tipo == 'uint8' else img.unmask(0).min(65000).max(0).toUint16()
    salida = np.zeros((alto, ancho), dtype=np.uint8 if tipo == 'uint8' else np.uint16)
    for f in range(0, alto, lado):
        for c in range(0, ancho, lado):
            h, w = min(lado, alto - f), min(lado, ancho - c)
            pedido = {'expression': img, 'fileFormat': 'NUMPY_NDARRAY',
                      'grid': {'dimensions': {'width': w, 'height': h}, 'crsCode': 'EPSG:4326',
                               'affineTransform': {'scaleX': RES, 'shearX': 0, 'translateX': x0 + c * RES,
                                                   'shearY': 0, 'scaleY': -RES, 'translateY': y0 - f * RES}}}
            for intento in range(4):
                try:
                    bloque = ee.data.computePixels(pedido)
                    break
                except Exception:
                    if intento == 3:
                        raise
                    time.sleep(15)
            salida[f:f + h, c:c + w] = bloque[banda] if bloque.dtype.names else bloque
    return salida, rasterio.Affine(RES, 0, x0, 0, -RES, y0)


def primera_salida(dirs, salidas):
    """Para cada celda, el índice de la primera salida que encuentra el agua aguas abajo (-1 si ninguna)."""
    alto, ancho = dirs.shape
    n = alto * ancho
    filas, cols = np.divmod(np.arange(n, dtype=np.int64), ancho)
    abajo = np.full(n, -1, dtype=np.int64)
    d = dirs.ravel()
    for codigo, (df, dc) in D8.items():
        sel = d == codigo
        f2, c2 = filas[sel] + df, cols[sel] + dc
        ok = (f2 >= 0) & (f2 < alto) & (c2 >= 0) & (c2 < ancho)
        destino = np.full(sel.sum(), -1, dtype=np.int64)
        destino[ok] = f2[ok] * ancho + c2[ok]
        abajo[sel] = destino
    objetivo = np.full(n, -1, dtype=np.int32)
    for k, celda in enumerate(salidas):
        objetivo[celda] = k
    siguiente = abajo.copy()
    pendiente = (objetivo < 0) & (siguiente >= 0)
    for _ in range(40):                       # 2^40 celdas: sobra
        idx = np.nonzero(pendiente)[0]
        if not len(idx):
            break
        sig = siguiente[idx]
        encontrado = objetivo[sig] >= 0
        objetivo[idx[encontrado]] = objetivo[sig[encontrado]]
        resto = idx[~encontrado]
        siguiente[resto] = siguiente[siguiente[resto]] if len(resto) else siguiente[resto]
        sin_salida = siguiente[resto] < 0
        pendiente[idx[encontrado]] = False
        pendiente[resto[sin_salida]] = False
    return objetivo.reshape(alto, ancho), abajo


def main():
    import rasterio.features
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union

    ee = iniciar_ee()
    if ee is None:
        print('Sin Earth Engine: no se calculan las cuencas.')
        return
    t0 = time.time()
    dirs, transf = bajar_todo(ee, 'dir', 'uint8')
    upa, _ = bajar_todo(ee, 'upa', 'uint16')
    upa = upa[:dirs.shape[0], :dirs.shape[1]]
    print(f'MERIT: {dirs.shape} celdas, {time.time() - t0:.0f} s')
    inv = ~transf
    locs = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'localidades.json')) or {}).get('localidades', [])

    # Salidas: una por celda (varios arroyos pueden caer en la misma)
    salidas, por_celda, pedidos = [], {}, []
    for f in locs:
        for i, a in enumerate(f.get('arroyos', [])):
            c, r = inv * (a['lon'], a['lat'])
            r, c = int(r), int(c)
            if not (SNAP_CELDAS <= r < dirs.shape[0] - SNAP_CELDAS and SNAP_CELDAS <= c < dirs.shape[1] - SNAP_CELDAS):
                continue
            ventana = upa[r - SNAP_CELDAS:r + SNAP_CELDAS + 1, c - SNAP_CELDAS:c + SNAP_CELDAS + 1]
            dr, dc = np.unravel_index(np.argmax(ventana), ventana.shape)
            celda = (r - SNAP_CELDAS + dr) * dirs.shape[1] + (c - SNAP_CELDAS + dc)
            if int(upa.flat[celda]) > AREA_MAX_KM2:
                continue
            if celda not in por_celda:
                por_celda[celda] = len(salidas)
                salidas.append(celda)
            pedidos.append((f['localidad'], i, a.get('arroyo', ''), por_celda[celda]))
    print(f'{len(salidas)} salidas para {len(pedidos)} arroyos')

    etiqueta, abajo = primera_salida(dirs, np.array(salidas, dtype=np.int64))
    # Árbol de salidas: para cada salida, la primera salida aguas abajo
    padre = np.full(len(salidas), -1)
    for k, celda in enumerate(salidas):
        sig = abajo[celda]
        padre[k] = etiqueta.flat[sig] if sig >= 0 else -1
    hijos = {}
    for k, p in enumerate(padre):
        if p >= 0:
            hijos.setdefault(int(p), []).append(k)

    def arriba(k):
        pila, todos = [k], []
        while pila:
            x = pila.pop()
            todos.append(x)
            pila.extend(hijos.get(x, []))
        return todos

    # Rectángulo que ocupa la cuenca propia de cada salida (para no recorrer toda la grilla en cada una)
    plano = etiqueta.ravel()
    con = np.nonzero(plano >= 0)[0]
    lab = plano[con]
    orden = np.argsort(lab, kind='stable')
    con, lab = con[orden], lab[orden]
    cortes = np.searchsorted(lab, np.arange(len(salidas) + 1))
    caja = {}
    for k in range(len(salidas)):
        celdas = con[cortes[k]:cortes[k + 1]]
        if len(celdas):
            f, c = np.divmod(celdas, dirs.shape[1])
            caja[k] = (f.min(), f.max() + 1, c.min(), c.max() + 1)
    del plano, con, lab, orden

    poligonos = {}
    for k in range(len(salidas)):
        ids = [x for x in arriba(k) if x in caja]
        if not ids:
            continue
        f0, f1 = min(caja[x][0] for x in ids), max(caja[x][1] for x in ids)
        c0, c1 = min(caja[x][2] for x in ids), max(caja[x][3] for x in ids)
        sub = np.isin(etiqueta[f0:f1, c0:c1], ids).astype(np.uint8)
        t = transf * rasterio.Affine.translation(c0, f0)
        formas = [shape(g) for g, v in rasterio.features.shapes(sub, mask=sub.astype(bool), transform=t) if v == 1]
        g = unary_union(formas).simplify(RES * 1.2, preserve_topology=True)
        recortada = bool(f0 == 0 or c0 == 0 or f1 == dirs.shape[0] or c1 == dirs.shape[1])
        poligonos[k] = (g, int(sub.sum()), recortada)

    feats = []
    for localidad, i, nombre, k in pedidos:
        if k not in poligonos:
            continue
        g, celdas, recortada = poligonos[k]
        area = round(celdas * (RES * 111.32) ** 2 * np.cos(np.radians(g.centroid.y)), 1)
        geom = json.loads(json.dumps(mapping(g)))
        redondear = lambda c: round(c, 4) if isinstance(c, float) else [redondear(x) for x in c]   # noqa: E731
        feats.append({'type': 'Feature', 'geometry': {'type': geom['type'], 'coordinates': redondear(geom['coordinates'])},
                      'properties': {'localidad': localidad, 'arroyo_n': i, 'arroyo': nombre, 'area_km2': float(area),
                                     'recortada': recortada}})
    with open(os.path.join(cfg.DATA, 'cuencas_arroyos.geojson'), 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'fuente': 'MERIT Hydro v1.0.1 (Yamazaki y otros, 2019)', 'features': feats},
                  fh, ensure_ascii=False, separators=(',', ':'))
    print(f'cuencas_arroyos.geojson: {len(feats)} cuencas, {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
