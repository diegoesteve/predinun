"""Simulación de crecida del Paraná: hasta dónde llegaría el agua con cada altura del río.

Para cada escala del Paraná en Santa Fe con «cero» conocido (la altura del cero de la escala sobre el nivel del mar,
del Instituto Nacional del Agua):

  1. Se bajan de Earth Engine, para un cuadrado de unos 40 km alrededor de la escala:
     - el relieve FABDEM (Copernicus 30 m sin edificios ni árboles; si no está, Copernicus GLO-30);
     - el agua permanente (JRC Global Surface Water: lugares con agua más de la mitad del tiempo);
     - la última pasada del radar Sentinel-1 de los últimos 14 días (el agua se ve oscura en el radar).
  2. Con una altura h del río, el agua llega a la cota «cero + h». Quedan bajo el agua los lugares más bajos que esa
     cota Y conectados al río (una laguna aislada detrás de un albardón no se llena). Se repite para alturas cada
     25 cm, desde 2 m hasta un poco más que el récord de la escala.
  3. Ajuste: el relieve satelital y el cero de la escala no usan exactamente la misma referencia, y el relieve tiene
     error. Se prueba correr toda la simulación entre -2 y +2 m y se elige el corrimiento con el que el agua simulada
     para la altura del día de la pasada del radar se parece más al agua que vio el radar.

No ve defensas, terraplenes, bombeos ni desagües, y supone el río horizontal en los 20 km alrededor de la escala.
Es una orientación, no un mapa oficial.

Escribe docs/data/simulacion.json y, por escala, docs/data/simulacion/<id>.png (cada píxel: 0 seco, 1..N la primera
altura de la lista con la que se moja, 255 agua permanente) y <id>_satelite.png (1 = agua vista por el radar).
Corre en el workflow del boletín cuando se pide (opción «simulacion») o si falta el resultado.
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402
from alerta.boletin import iniciar_ee   # noqa: E402

INA = 'https://alerta.ina.gob.ar/a5'
CAB = {'User-Agent': 'predinun (proyecto sin fines comerciales)'}
ESCALAS = [24, 30, 33, 34, 35]          # Reconquista, Santa Fe, San Lorenzo, Rosario, Villa Constitución
RES = 1 / 3600                          # 1 segundo de arco (~30 m)
MEDIO_LAT, MEDIO_LON = 0.18, 0.21       # medio lado del cuadrado: ~20 km
PASO = 0.25
SEMILLA_KM = 3                          # el río «de la escala»: el agua permanente a menos de 3 km
UMBRAL_VV_DB = -16                      # agua en Sentinel-1 (VV): más oscuro que esto
SALIDA = os.path.join(cfg.DOCS_DATA, 'simulacion')


def get(url, **params):
    for k in range(3):
        try:
            r = requests.get(url, params={'format': 'json', **params}, headers=CAB, timeout=180)
            r.raise_for_status()
            return json.loads(r.content.decode('utf-8'))
        except Exception:
            if k == 2:
                raise
            time.sleep(10)


def bajar(ee, img, banda, oeste, norte, ancho, alto):
    pedido = {'expression': img, 'fileFormat': 'NUMPY_NDARRAY',
              'grid': {'dimensions': {'width': ancho, 'height': alto}, 'crsCode': 'EPSG:4326',
                       'affineTransform': {'scaleX': RES, 'shearX': 0, 'translateX': oeste,
                                           'shearY': 0, 'scaleY': -RES, 'translateY': norte}}}
    for intento in range(4):
        try:
            a = ee.data.computePixels(pedido)
            return np.array(a[banda] if a.dtype.names else a, dtype=np.float32)
        except Exception as e:
            if intento == 3:
                raise
            print('  reintento:', str(e)[:120])
            time.sleep(20)


def inundado(dem, permanente, semillas, cota):
    """Lo que queda bajo el agua con el río en «cota»: más bajo que la cota (o agua permanente) y conectado al río."""
    from scipy import ndimage
    candidato = (dem <= cota) | permanente
    etiquetas, _ = ndimage.label(candidato)
    tocan = np.unique(etiquetas[semillas & candidato])
    tocan = tocan[tocan > 0]
    return np.isin(etiquetas, tocan)


def guardar_png(ruta, matriz):
    from PIL import Image
    Image.fromarray(matriz.astype(np.uint8), mode='L').save(ruta, optimize=True)


def historia(est_id):
    """Toda la serie de alturas: récord y altura de cada día."""
    j = get(f'{INA}/obs/puntual/series/{est_id}', timestart='1900-01-01', timeend=(datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d'))
    obs = [(o['timestart'][:10], o['valor']) for o in (j.get('observaciones') or []) if o.get('valor') is not None]
    return j['estacion'], obs


def main():
    ee = iniciar_ee()
    if ee is None:
        print('Sin Earth Engine: no se simula.')
        return
    os.makedirs(SALIDA, exist_ok=True)
    ahora = datetime.now(timezone.utc)
    resultado = []
    for est_id in ESCALAS:
        t0 = time.time()
        try:
            est, obs = historia(est_id)
        except Exception as e:
            print(f'{est_id}: sin datos del INA ({str(e)[:80]})')
            continue
        cero = est.get('cero_ign')
        if cero is None or not obs:
            print(f"{est['nombre']}: sin cero de escala, no se simula")
            continue
        lat, lon = est['geom']['coordinates'][1], est['geom']['coordinates'][0]
        por_dia = dict(obs)
        rec_fecha, rec_altura = max(obs, key=lambda o: o[1])
        oeste, norte = lon - MEDIO_LON, lat + MEDIO_LAT
        ancho, alto = int(2 * MEDIO_LON / RES), int(2 * MEDIO_LAT / RES)
        caja = ee.Geometry.Rectangle([oeste, lat - MEDIO_LAT, lon + MEDIO_LON, norte])
        print(f"{est['nombre']}: cero {cero} m, récord {rec_altura} m ({rec_fecha}), {ancho}x{alto} píxeles")

        # relieve
        fuente_dem = 'FABDEM'
        try:
            dem = bajar(ee, ee.ImageCollection('projects/sat-io/open-datasets/FABDEM').filterBounds(caja).mosaic().select([0], ['b']).toFloat(), 'b', oeste, norte, ancho, alto)
            if not np.isfinite(dem).any() or np.nanmax(dem) <= 0:
                raise ValueError('vacío')
        except Exception as e:
            print('  FABDEM no disponible, uso Copernicus GLO-30:', str(e)[:80])
            fuente_dem = 'Copernicus GLO-30'
            dem = bajar(ee, ee.ImageCollection('COPERNICUS/DEM/GLO30').filterBounds(caja).mosaic().select(['DEM'], ['b']).toFloat(), 'b', oeste, norte, ancho, alto)
        dem[~np.isfinite(dem)] = 9999
        ocurrencia = bajar(ee, ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select(['occurrence'], ['b']).unmask(0).toFloat(), 'b', oeste, norte, ancho, alto)
        permanente = ocurrencia >= 50
        # semillas: el agua permanente conectada a la que está a menos de SEMILLA_KM de la escala
        from scipy import ndimage
        filas, cols = np.indices(dem.shape)
        plat, plon = norte - (filas + .5) * RES, oeste + (cols + .5) * RES
        cerca = np.hypot((plat - lat) * 111.3, (plon - lon) * 111.3 * np.cos(np.radians(lat))) <= SEMILLA_KM
        et, _ = ndimage.label(permanente)
        ids = np.unique(et[permanente & cerca])
        semillas = np.isin(et, ids[ids > 0])
        if not semillas.any():
            print('  no encontré el río cerca de la escala, no se simula')
            continue

        # radar Sentinel-1: la última pasada de los últimos 14 días
        ajuste, iou, s1_fecha, s1_altura, agua_s1 = 0.0, None, None, None, None
        try:
            col = (ee.ImageCollection('COPERNICUS/S1_GRD').filterBounds(caja)
                   .filterDate((ahora - timedelta(days=14)).strftime('%Y-%m-%d'), (ahora + timedelta(days=1)).strftime('%Y-%m-%d'))
                   .filter(ee.Filter.eq('instrumentMode', 'IW')).filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
                   .sort('system:time_start', False))
            ultima = col.first()
            s1_fecha = ee.Date(ultima.get('system:time_start')).format('YYYY-MM-dd').getInfo()
            del_dia = col.filterDate(s1_fecha, ee.Date(s1_fecha).advance(1, 'day')).mosaic().select(['VV'], ['b'])
            vv = bajar(ee, del_dia.focalMedian(45, 'circle', 'meters').unmask(0).toFloat(), 'b', oeste, norte, ancho, alto)
            agua_s1 = (vv < UMBRAL_VV_DB) & (vv != 0)
            s1_altura = por_dia.get(s1_fecha) or por_dia.get((datetime.fromisoformat(s1_fecha) - timedelta(days=1)).strftime('%Y-%m-%d'))
            hay = vv != 0
            if s1_altura is not None and hay.mean() > .5:
                mejor = (-1, 0.0)
                for k in np.arange(-2.0, 2.01, 0.1):
                    sim = inundado(dem, permanente, semillas, cero + s1_altura + k)
                    inter = (sim & agua_s1 & hay).sum()
                    union = ((sim | agua_s1) & hay).sum()
                    v = inter / union if union else 0
                    if v > mejor[0]:
                        mejor = (v, round(float(k), 1))
                iou, ajuste = round(float(mejor[0]), 3), mejor[1]
                print(f'  radar del {s1_fecha} con el río en {s1_altura} m: ajuste {ajuste:+.1f} m, coincidencia {iou:.0%}')
            else:
                print(f'  radar del {s1_fecha}: sin altura del río ese día o pasada incompleta, sin ajuste')
        except Exception as e:
            print('  sin radar Sentinel-1:', str(e)[:120])

        # alturas a simular
        alerta, evac = est.get('nivel_alerta'), est.get('nivel_evacuacion')
        tope = max(rec_altura, (evac or 0) + 1.0) + PASO
        niveles = [round(h, 2) for h in np.arange(2.0, tope + 1e-6, PASO)][:250]
        indice = np.zeros(dem.shape, dtype=np.uint8)
        for k in range(len(niveles), 0, -1):          # de la más alta a la más baja: queda la primera que moja
            indice[inundado(dem, permanente, semillas, cero + ajuste + niveles[k - 1])] = k
        indice[permanente] = 255
        guardar_png(os.path.join(SALIDA, f'{est_id}.png'), indice)
        if agua_s1 is not None:
            guardar_png(os.path.join(SALIDA, f'{est_id}_satelite.png'), agua_s1.astype(np.uint8))
        km2 = (RES * 111.3) ** 2 * np.cos(np.radians(lat))
        area = {str(h): round(float(((indice > 0) & (indice <= k) & (indice != 255)).sum() * km2), 1) for k, h in enumerate(niveles, 1)}
        ult_fecha, ult_altura = obs[-1]
        resultado.append({
            'id': est_id, 'nombre': est['nombre'], 'lat': round(lat, 4), 'lon': round(lon, 4),
            'cero_m': cero, 'ajuste_m': ajuste, 'coincidencia_radar': iou, 'relieve': fuente_dem,
            'limites': [[round(norte - alto * RES, 5), round(oeste, 5)], [round(norte, 5), round(oeste + ancho * RES, 5)]],
            'niveles': niveles, 'area_km2': area, 'alerta_m': alerta, 'evacuacion_m': evac,
            'record': {'altura_m': rec_altura, 'fecha': rec_fecha}, 'actual': {'altura_m': ult_altura, 'fecha': ult_fecha},
            'satelite': ({'fecha': s1_fecha, 'altura_m': s1_altura} if agua_s1 is not None else None),
        })
        print(f'  listo en {time.time() - t0:.0f} s')
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'simulacion.json'), {
        'generado': datetime.now(timezone(timedelta(hours=-3))).strftime('%Y-%m-%d %H:%M'),
        'fuentes': 'Relieve FABDEM (Hawker y otros, 2022; CC BY-NC-SA 4.0) o Copernicus GLO-30; agua permanente JRC Global Surface Water; '
                   'radar Sentinel-1 (Copernicus); alturas y cero de las escalas: INA / Prefectura Naval',
        'escalas': resultado})
    print(f'simulacion.json: {len(resultado)} escalas')


if __name__ == '__main__':
    main()
