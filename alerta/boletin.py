"""Boletín de pronóstico por cuenca: 48 h, perspectiva a 10 días y suelo (SMAP + modelo).

Es el mismo cálculo que la notebook del paso 4, preparado para correr solo (GitHub Actions o cron).
"""
import json
import os
import time

import numpy as np
import pandas as pd
import requests

from . import config as cfg

URL_PRONOSTICO = 'https://api.open-meteo.com/v1/forecast'
URL_ENSAMBLE = 'https://ensemble-api.open-meteo.com/v1/ensemble'


def pedir(url, params, reintentos=4):
    for k in range(reintentos):
        r = requests.get(url, params=params, timeout=120)
        if r.status_code == 429:
            time.sleep(20 * (k + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def como_lista(js):
    return js if isinstance(js, list) else [js]


def serie_puntos(url, pts, variables, **extra):
    """DataFrame horario con las columnas que empiezan por cada variable, promediado sobre los puntos."""
    params = {'latitude': ','.join(f'{p[0]:.4f}' for p in pts), 'longitude': ','.join(f'{p[1]:.4f}' for p in pts),
              'hourly': variables, 'timezone': cfg.TZ, **extra}
    partes = []
    for j in como_lista(pedir(url, params)):
        h = j['hourly']
        cols = {k: v for k, v in h.items() if k != 'time'}
        partes.append(pd.DataFrame(cols, index=pd.to_datetime(h['time']), dtype=float))
    return pd.concat(partes).groupby(level=0).mean()


def max_3h(s):
    return s.fillna(0).rolling(3, min_periods=1).sum()


# ---------------------------------------------------------------------------------------------
# 48 horas
# ---------------------------------------------------------------------------------------------
def boletin_48h(ahora, PUNTOS, MODELOS, ENSAMBLES):
    fin = ahora + pd.Timedelta(hours=cfg.HORAS_ALERTA)
    filas = []
    for c, pts in PUNTOS.items():
        fila = {'cuenca': c, 'nombre': cfg.NOMBRES.get(c, c), 'modelos': {}, 'ensambles': {}}
        superan, prob_max = 0, 0.0
        for modelo, mid in MODELOS.items():
            try:
                s = serie_puntos(URL_PRONOSTICO, pts, 'precipitation', models=mid, forecast_days=3)['precipitation']
            except Exception as e:
                print(f'{c} {modelo}: sin datos ({str(e)[:80]})')
                continue
            r3 = max_3h(s).loc[ahora:fin]
            u, fuente = cfg.umbral(c, modelo)
            fila['modelos'][modelo] = {'max_3h_mm': round(float(r3.max()), 1), 'umbral_mm': u, 'fuente_umbral': fuente,
                                       'cuando': r3.idxmax().strftime('%Y-%m-%d %H:00') if r3.max() > 0 else None}
            if r3.max() >= u:
                superan += 1
        for ens, mid in ENSAMBLES.items():
            try:
                m = serie_puntos(URL_ENSAMBLE, pts, 'precipitation', models=mid, forecast_days=3)
            except Exception as e:
                print(f'{c} {ens}: sin datos ({str(e)[:80]})')
                continue
            maximos = m.fillna(0).rolling(3, min_periods=1).sum().loc[ahora:fin].max()
            u, _ = cfg.umbral(c, cfg.ENSAMBLE_A_MODELO.get(ens, ens))
            p = float((maximos >= u).mean())
            fila['ensambles'][ens] = round(p, 2)
            prob_max = max(prob_max, p)
        if superan >= 2 or prob_max >= cfg.PROB_PROBABLE:
            fila['nivel'] = 'naranja'
        elif superan >= 1 or prob_max >= cfg.PROB_POSIBLE:
            fila['nivel'] = 'amarillo'
        else:
            fila['nivel'] = 'verde'
        fila['nivel_por_lluvia'] = fila['nivel']
        filas.append(fila)
    return filas


# ---------------------------------------------------------------------------------------------
# Suelo: SMAP (Earth Engine) + cambio según el modelo desde la fecha de SMAP
# ---------------------------------------------------------------------------------------------
CAPAS_SUELO = {'soil_moisture_0_to_1cm': 1, 'soil_moisture_1_to_3cm': 2, 'soil_moisture_3_to_9cm': 6,
               'soil_moisture_9_to_27cm': 18, 'soil_moisture_27_to_81cm': 54}


def iniciar_ee():
    """Earth Engine con una cuenta de servicio (secreto EE_SERVICE_ACCOUNT_JSON). Devuelve el módulo o None."""
    clave = os.environ.get('EE_SERVICE_ACCOUNT_JSON')
    if not clave:
        print('Sin EE_SERVICE_ACCOUNT_JSON: el boletín sale sin el dato de suelo de SMAP.')
        return None
    import ee
    info = json.loads(clave)
    cred = ee.ServiceAccountCredentials(info['client_email'], key_data=clave)
    ee.Initialize(cred, project=os.environ.get('EE_PROJECT') or info.get('project_id'))
    return ee


def geometrias(ee):
    geo = cfg.leer_json('cuencas.geojson')
    out = {}
    if geo:
        for f in geo['features']:
            out[f['properties']['nombre']] = ee.Geometry(f['geometry'])
    for c, (lat, lon) in cfg.SALIDAS.items():
        out.setdefault(c, ee.Geometry.Point([lon, lat]).buffer(10000))
    return out


def suelo(PUNTOS):
    ee = iniciar_ee()
    if ee is None:
        return {}, None
    smap = None
    for _id in ['NASA/SMAP/SPL4SMGP/008', 'NASA/SMAP/SPL4SMGP/007']:
        try:
            col = ee.ImageCollection(_id)
            if col.limit(1).size().getInfo():
                smap = col.select('sm_rootzone')
                break
        except Exception:
            pass
    if smap is None:
        return {}, None
    fecha = pd.Timestamp(smap.sort('system:time_start', False).first().get('system:time_start').getInfo(), unit='ms')

    def serie(geom, ini, fin):
        def valor(img):
            return ee.Feature(None, {'t': img.get('system:time_start'),
                                     'v': img.reduceRegion(ee.Reducer.mean(), geom, 9000).get('sm_rootzone')})
        fc = smap.filterDate(ini, fin).map(valor).filter(ee.Filter.notNull(['v']))
        t, v = ee.List([fc.aggregate_array('t'), fc.aggregate_array('v')]).getInfo()
        return pd.Series(v, index=pd.to_datetime(t, unit='ms')).resample('D').mean().dropna() if t else pd.Series(dtype=float)

    archivo = os.path.join(cfg.DATA, f'smap_normal_mes{fecha.month:02d}.json')
    normal = json.load(open(archivo)) if os.path.exists(archivo) else {}
    geoms = geometrias(ee)
    out = {}
    ahora_utc = pd.Timestamp.now(tz='UTC').tz_localize(None).floor('h')
    atraso = (ahora_utc - fecha).total_seconds() / 86400
    for c in PUNTOS:
        g = geoms[c]
        if c not in normal:
            vals = []
            for anio in range(2015, fecha.year):
                ini = pd.Timestamp(anio, fecha.month, 1)
                vals += serie(g, ini.strftime('%Y-%m-%d'), (ini + pd.offsets.MonthBegin(1)).strftime('%Y-%m-%d')).round(4).tolist()
            normal[c] = vals
            cfg.escribir_json(archivo, normal)
        rec = serie(g, (fecha - pd.Timedelta(days=7)).strftime('%Y-%m-%d'), (fecha + pd.Timedelta(days=1)).strftime('%Y-%m-%d'))
        if rec.empty or not normal[c]:
            continue
        actual = float(rec.iloc[-1])
        d = {'smap_m3m3': round(actual, 3), 'smap_percentil': int(round(100 * (np.array(normal[c]) < actual).mean())),
             'smap_fecha': fecha.strftime('%Y-%m-%d %H:%M UTC')}
        try:   # estimado para hoy con el cambio del modelo
            pts = PUNTOS[c]
            params = {'latitude': ','.join(f'{p[0]:.4f}' for p in pts), 'longitude': ','.join(f'{p[1]:.4f}' for p in pts),
                      'hourly': ','.join(CAPAS_SUELO), 'timezone': 'UTC',
                      'past_days': min(92, max(7, int(atraso) + 2)), 'forecast_days': 2}
            partes = []
            for j in como_lista(pedir(URL_PRONOSTICO, params)):
                h = j['hourly']
                df = pd.DataFrame({k: h[k] for k in CAPAS_SUELO if k in h}, index=pd.to_datetime(h['time']), dtype=float)
                pesos = pd.Series({k: CAPAS_SUELO[k] for k in df.columns}, dtype=float)
                partes.append((df * pesos).sum(axis=1, min_count=1) / pesos.sum())
            m = pd.concat(partes, axis=1).mean(axis=1).dropna().sort_index()
            m_smap = float(m.iloc[m.index.get_indexer([fecha], method='nearest')[0]])
            m_hoy = float(m.loc[:ahora_utc].iloc[-1])
            est = actual + (m_hoy - m_smap)
            d.update({'estimado_hoy_m3m3': round(est, 3),
                      'estimado_hoy_percentil': int(round(100 * (np.array(normal[c]) < est).mean()))})
        except Exception as e:
            print(f'{c}: sin humedad de modelo ({str(e)[:80]})')
        usar_estimado = atraso > 3 and 'estimado_hoy_percentil' in d
        d['percentil'] = d['estimado_hoy_percentil'] if usar_estimado else d['smap_percentil']
        d['es_estimado'] = usar_estimado
        d['estado'] = 'saturado' if d['percentil'] >= cfg.PCTL_HUMEDO else 'normal' if d['percentil'] >= 30 else 'seco'
        out[c] = d
    return out, round(atraso, 1)


def ajustar_por_suelo(filas, SUELO):
    subir = {'verde': 'amarillo', 'amarillo': 'naranja'}
    for f in filas:
        s = SUELO.get(f['cuenca'])
        f['suelo'] = s
        if not s or s['percentil'] < cfg.PCTL_HUMEDO:
            continue
        relevante = any(m['max_3h_mm'] >= cfg.FRACCION_LLUVIA * m['umbral_mm'] for m in f['modelos'].values())
        if relevante and f['nivel'] in subir:
            f['nivel'] = subir[f['nivel']]
            f['agravado_por_suelo'] = True
    return filas


# ---------------------------------------------------------------------------------------------
# Perspectiva a 10 días
# ---------------------------------------------------------------------------------------------
def perspectiva(PUNTOS, ENSAMBLES, SUELO):
    hoy = pd.Timestamp.now(tz=cfg.TZ).tz_localize(None).normalize()
    dias = pd.date_range(hoy, periods=cfg.DIAS_PERSPECTIVA, freq='D')
    out = {'dias': [d.strftime('%Y-%m-%d') for d in dias], 'cuencas': {}}
    for c, pts in PUNTOS.items():
        pu, pm, ll = [], [], []
        for ens, mid in ENSAMBLES.items():
            try:
                m = serie_puntos(URL_ENSAMBLE, pts, 'precipitation', models=mid, forecast_days=cfg.DIAS_PERSPECTIVA).fillna(0)
            except Exception as e:
                print(f'{c} {ens}: sin datos ({str(e)[:80]})')
                continue
            u, _ = cfg.umbral(c, cfg.ENSAMBLE_A_MODELO.get(ens, ens))
            horas = m.groupby(m.index.normalize()).size()
            completos = [d for d in dias if horas.get(d, 0) >= 20]
            max3 = m.rolling(3, min_periods=1).sum().resample('D').max().reindex(completos)
            total = m.resample('D').sum().reindex(completos)
            pu.append((max3 >= u).mean(axis=1).reindex(dias))
            pm.append((max3 >= u * cfg.FRACCION_LLUVIA).mean(axis=1).reindex(dias))
            ll.append(total.median(axis=1).reindex(dias))
        if not pu:
            continue
        saturado = (SUELO.get(c) or {}).get('percentil', 0) >= cfg.PCTL_HUMEDO
        p_u = pd.concat(pu, axis=1).mean(axis=1)
        p_m = pd.concat(pm, axis=1).mean(axis=1)
        p = np.fmax(p_u, p_m) if saturado else p_u
        mm = pd.concat(ll, axis=1).mean(axis=1)
        out['cuencas'][c] = {'nombre': cfg.NOMBRES.get(c, c), 'suelo_saturado': bool(saturado),
                             'prob': [None if pd.isna(x) else round(float(x), 2) for x in p],
                             'mm': [None if pd.isna(x) else round(float(x), 1) for x in mm]}
    return out


def generar():
    PUNTOS = cfg.puntos()
    MODELOS, ENSAMBLES = cfg.modelos()
    ahora = pd.Timestamp.now(tz=cfg.TZ).tz_localize(None).floor('h')
    filas = boletin_48h(ahora, PUNTOS, MODELOS, ENSAMBLES)
    try:
        SUELO, atraso = suelo(PUNTOS)
    except Exception as e:
        print('Suelo no disponible:', e)
        SUELO, atraso = {}, None
    filas = ajustar_por_suelo(filas, SUELO)
    persp = perspectiva(PUNTOS, ENSAMBLES, SUELO)
    return {'generado': ahora.strftime('%Y-%m-%d %H:%M'), 'horas': cfg.HORAS_ALERTA, 'smap_atraso_dias': atraso,
            'cuencas': filas, 'perspectiva': persp}
