"""Simulación de crecida del Paraná: hasta dónde llegaría el agua con cada altura del río.

Para cada escala del Paraná en Santa Fe con «cero» conocido (la altura del cero de la escala sobre el nivel del mar,
del Instituto Nacional del Agua):

  1. Se bajan de Earth Engine, para un cuadrado de unos 40 km alrededor de la escala:
     - el relieve FABDEM (Copernicus 30 m sin edificios ni árboles; si no está, Copernicus GLO-30);
     - el agua permanente (JRC Global Surface Water: lugares con agua más de la mitad del tiempo);
     - la última pasada del radar Sentinel-1 de los últimos 14 días (el agua se ve oscura en el radar).
  2. Con una altura h del río, el agua llega a la cota «cero + h». Quedan bajo el agua los lugares más bajos que esa
     cota Y conectados al río (una laguna aislada detrás de un albardón no se llena). Se repite para alturas cada
     10 cm, desde 2 m hasta un poco más que el récord de la escala.
  3. Ajuste: el relieve satelital y el cero de la escala no usan exactamente la misma referencia, y el relieve tiene
     error. En los meses de agua más alta (1984-2021) se compara la simulación con el agua que vio Landsat ese mes
     (JRC Monthly Water History), probando corrimientos entre -3 y +3 m; se usa la mediana de esas crecidas.

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
PASO = 0.10
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

        # radar Sentinel-1. Para MOSTRAR: la pasada más nueva de los últimos 21 días. Para AJUSTAR: pasadas en los días
        # de agua más alta desde 2015 (con el río bajo casi no hay agua fuera del cauce y la comparación no dice nada).
        ajuste, iou, s1_fecha, s1_altura, agua_s1, calibracion = 0.0, None, None, None, None, []
        rec_zona = dem <= cero + rec_altura + 1.5        # solo donde el agua puede llegar (no los campos altos)
        def altura_cerca(fecha, dias=2):
            f0 = datetime.fromisoformat(fecha)
            for dd in sorted(range(-dias, dias + 1), key=abs):
                v = por_dia.get((f0 + timedelta(days=dd)).strftime('%Y-%m-%d'))
                if v is not None:
                    return v
            return None
        s1 = (ee.ImageCollection('COPERNICUS/S1_GRD').filterBounds(caja).filter(ee.Filter.eq('instrumentMode', 'IW'))
              .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV')))
        def pasadas(desde, hasta):
            col = s1.filterDate(desde, hasta)
            return sorted(set(col.aggregate_array('system:time_start').map(lambda t: ee.Date(t).format('YYYY-MM-dd')).getInfo()))
        def radar(fecha):
            del_dia = s1.filterDate(fecha, ee.Date(fecha).advance(1, 'day')).mosaic().select(['VV'], ['b'])
            vv = bajar(ee, del_dia.focalMedian(45, 'circle', 'meters').unmask(0).toFloat(), 'b', oeste, norte, ancho, alto)
            return (vv < UMBRAL_VV_DB) & (vv != 0), vv != 0
        try:
            recientes = pasadas((ahora - timedelta(days=21)).strftime('%Y-%m-%d'), (ahora + timedelta(days=1)).strftime('%Y-%m-%d'))
            if recientes:
                s1_fecha = recientes[-1]
                agua_s1, _ = radar(s1_fecha)
                s1_altura = altura_cerca(s1_fecha)
        except Exception as e:
            print('  sin pasada reciente de Sentinel-1:', str(e)[:120])
        try:
            # Ajuste con el agua que vio Landsat mes a mes (JRC Monthly Water History, 1984-2021): en los meses de la
            # escala con el río más alto (uno por crecida), el agua del mes contra la simulación con la altura máxima
            # de ese mes. Landsat ve bien el agua abierta y cubre las grandes crecidas (1992, 1998, 2016...).
            max_mes = {}
            for f, v in obs:
                if '1984-03' <= f[:7] <= '2021-12':
                    max_mes[f[:7]] = max(max_mes.get(f[:7], -99), v)
            altos = []
            for mes, v in sorted(max_mes.items(), key=lambda x: -x[1]):
                if all(abs((int(mes[:4]) * 12 + int(mes[5:])) - (int(g[:4]) * 12 + int(g[5:]))) > 3 for g, _ in altos):
                    altos.append((mes, v))
                if len(altos) == 5:
                    break
            mensual = ee.ImageCollection('JRC/GSW1_4/MonthlyHistory')
            for mes, h_mes in altos:
                img = mensual.filter(ee.Filter.eq('system:index', mes.replace('-', '_'))).first()
                w = bajar(ee, ee.Image(img).select(['water'], ['b']).unmask(0).toFloat(), 'b', oeste, norte, ancho, alto)
                agua, hay = w == 2, w > 0
                zona = hay & rec_zona & ~permanente
                if zona.sum() < 0.2 * rec_zona.sum():       # mes muy nublado: no sirve
                    print(f'  Landsat {mes}: muy nublado')
                    continue
                mejor = (-1, 0.0)
                for k in np.arange(-3.0, 3.01, 0.1):
                    sim = inundado(dem, permanente, semillas, cero + h_mes + k)
                    union = ((sim | agua) & zona).sum()
                    v = (sim & agua & zona).sum() / union if union else 0
                    if v > mejor[0]:
                        mejor = (v, round(float(k), 1))
                calibracion.append({'mes': mes, 'altura_max_m': h_mes, 'ajuste_m': mejor[1], 'coincidencia': round(float(mejor[0]), 3)})
                print(f'  ajuste con Landsat {mes} (río hasta {h_mes} m): {mejor[1]:+.1f} m, coincidencia {mejor[0]:.0%}')
            buenas = [c for c in calibracion if c['coincidencia'] >= 0.4] or calibracion
            if buenas:
                ajuste = round(float(np.median([c['ajuste_m'] for c in buenas])), 1)
                iou = round(float(np.mean([c['coincidencia'] for c in buenas])), 3)
                print(f'  ajuste final {ajuste:+.1f} m (coincidencia media {iou:.0%}, {len(buenas)} crecidas)')
            else:
                print('  sin meses de crecida con Landsat: sin ajuste')
        except Exception as e:
            print('  sin ajuste con Landsat:', str(e)[:150])

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
            'satelite': ({'fecha': s1_fecha, 'altura_m': s1_altura} if agua_s1 is not None else None), 'calibracion': calibracion,
        })
        print(f'  listo en {time.time() - t0:.0f} s')
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'simulacion.json'), {
        'generado': datetime.now(timezone(timedelta(hours=-3))).strftime('%Y-%m-%d %H:%M'),
        'fuentes': 'Relieve FABDEM (Hawker y otros, 2022; CC BY-NC-SA 4.0) o Copernicus GLO-30; agua permanente JRC Global Surface Water; '
                   'radar Sentinel-1 (Copernicus); ajuste con JRC Monthly Water History (Landsat); alturas y cero de las escalas: INA / Prefectura Naval',
        'escalas': resultado})
    print(f'simulacion.json: {len(resultado)} escalas')


if __name__ == '__main__':
    main()
