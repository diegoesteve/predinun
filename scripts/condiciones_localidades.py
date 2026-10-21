"""Condiciones de los próximos días para cada localidad del mapa de riesgo.

Para cada localidad de docs/data/localidades.json:
  - lluvia pronosticada: la mayor lluvia en 3 horas de las próximas 72 h (Open-Meteo, mejor modelo disponible);
  - lluvia de los últimos 7 días (Open-Meteo, observado/analizado);
  - humedad del suelo: percentil SMAP de la cuenca del boletín si la localidad está dentro de una de ellas
    (data/cuencas.geojson); si no, se considera suelo húmedo cuando llovió 40 mm o más en los últimos 7 días.

Con eso arma una condición: 'lluvia fuerte' (se espera lluvia que en el pasado alcanzó para una crecida),
'atención' (la mitad de esa lluvia) o 'normal'. Con el suelo húmedo cuenta la mitad de la lluvia, como en el boletín.
La página lo cruza con la exposición de cada localidad (historial y terreno) para el semáforo «Ahora».

Escribe docs/data/condiciones_localidades.json. Corre en el workflow del boletín, cada 6 horas.
"""
import os
import sys
import time

import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

URL = 'https://api.open-meteo.com/v1/forecast'
HORAS = 72
UMBRAL_3H_MM = 20.0          # lluvia en 3 h que en el pasado alcanzó para crecidas (paso 3: 20 a 24 mm según la cuenca)
LLUVIA_7D_HUMEDO_MM = 40.0   # sin dato de SMAP: suelo húmedo si llovió esto en la última semana
TANDA = 80


def dentro(lon, lat, anillo):
    """Punto en polígono (ray casting) sobre el anillo exterior."""
    adentro = False
    for (x1, y1), (x2, y2) in zip(anillo, anillo[1:] + anillo[:1]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            adentro = not adentro
    return adentro


def cuenca_de(lat, lon, cuencas):
    for nombre, anillos in cuencas.items():
        if any(dentro(lon, lat, a) for a in anillos):
            return nombre
    return None


def leer_cuencas():
    g = cfg.leer_json('cuencas.geojson') or {}
    salida = {}
    for f in g.get('features', []):
        geom = f['geometry']
        polis = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
        salida[f['properties']['nombre']] = [p[0] for p in polis]
    return salida


def pedir(params, reintentos=4):
    for k in range(reintentos):
        r = requests.get(URL, params=params, timeout=120)
        if r.status_code == 429:
            time.sleep(20 * (k + 1))
            continue
        r.raise_for_status()
        j = r.json()
        return j if isinstance(j, list) else [j]
    r.raise_for_status()


def semaforo(condicion, maximo, umbral, exposicion):
    """Semáforo «Ahora» de la página (la misma regla que muestra la leyenda):
    alerta   = lluvia fuerte en un lugar muy expuesto, o lluvia de al menos 1,5 veces el umbral en uno expuesto;
    atención = lluvia fuerte en cualquier otro lugar, o al menos el 75 % del umbral en uno muy expuesto;
    normal   = el resto."""
    muy, expuesta = exposicion == 'muy expuesta', exposicion == 'expuesta'
    if condicion == 'lluvia fuerte':
        return 'alerta' if muy or (expuesta and umbral and maximo >= 1.5 * umbral) else 'atención'
    if muy and umbral and maximo >= 0.75 * umbral:
        return 'atención'
    return 'normal'


def main():
    locs = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'localidades.json')) or {}).get('localidades', [])
    if not locs:
        print('No hay localidades.json todavía.')
        return
    boletin = cfg.leer_json(os.path.join('..', 'docs', 'data', 'boletin.json')) or {}
    suelo_cuenca = {f['cuenca']: f['suelo'] for f in boletin.get('cuencas', []) if f.get('suelo')}
    cuencas = leer_cuencas()

    ahora = pd.Timestamp.now(tz=cfg.TZ).tz_localize(None).floor('h')
    fin = ahora + pd.Timedelta(hours=HORAS)
    salida = {}
    for i in range(0, len(locs), TANDA):
        tanda = locs[i:i + TANDA]
        params = {'latitude': ','.join(f"{f['lat']:.4f}" for f in tanda),
                  'longitude': ','.join(f"{f['lon']:.4f}" for f in tanda),
                  'hourly': 'precipitation', 'past_days': 7, 'forecast_days': 4, 'timezone': cfg.TZ}
        try:
            respuestas = pedir(params)
        except Exception as e:
            print(f'Tanda {i}: sin pronóstico ({str(e)[:80]})')
            continue
        for f, j in zip(tanda, respuestas):
            s = pd.Series(j['hourly']['precipitation'], index=pd.to_datetime(j['hourly']['time']), dtype=float).fillna(0)
            r3 = s.rolling(3, min_periods=1).sum().loc[ahora:fin]
            lluvia_7d = float(s.loc[ahora - pd.Timedelta(days=7):ahora].sum())
            # cuenca del boletín que contiene a la localidad, si hay una
            cuenca = cuenca_de(f['lat'], f['lon'], cuencas)
            sm = suelo_cuenca.get(cuenca) if cuenca else None
            if sm:
                humedo = sm.get('percentil', 0) >= cfg.PCTL_HUMEDO
                suelo = f"{'muy húmedo' if humedo else 'normal'} (percentil {sm['percentil']} de humedad, cuenca {cfg.NOMBRES.get(cuenca, cuenca)})"
            else:
                humedo = lluvia_7d >= LLUVIA_7D_HUMEDO_MM
                suelo = f"{'húmedo' if humedo else 'normal'} ({round(lluvia_7d)} mm en los últimos 7 días)"
            # Umbral fijo para lluvia puntual: los umbrales del boletín están calibrados para la lluvia
            # promedio de cada cuenca según cada modelo, y usarlos en un punto daría falsas alarmas.
            efectivo = UMBRAL_3H_MM * (cfg.FRACCION_LLUVIA if humedo else 1)
            maximo = float(r3.max()) if len(r3) else 0.0
            condicion = 'lluvia fuerte' if maximo >= efectivo else 'atención' if maximo >= efectivo / 2 else 'normal'
            salida[f['localidad']] = {
                'condicion': condicion, 'ahora': semaforo(condicion, maximo, efectivo, f.get('exposicion')), 'max_3h_mm': round(maximo, 1),
                'cuando': r3.idxmax().strftime('%Y-%m-%d %H:00') if maximo > 0 else None,
                'umbral_mm': round(efectivo, 1), 'suelo_humedo': bool(humedo), 'suelo': suelo,
                'lluvia_7d_mm': round(lluvia_7d, 1),
            }
        time.sleep(1)
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'condiciones_localidades.json'),
                      {'generado': ahora.strftime('%Y-%m-%d %H:%M'), 'horas': HORAS, 'localidades': salida})
    from collections import Counter
    print(f'condiciones_localidades.json: {len(salida)} localidades', dict(Counter(v['ahora'] for v in salida.values())))


if __name__ == '__main__':
    main()
