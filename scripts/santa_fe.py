"""Santa Fe y región: crecidas de ríos y anegamientos por lluvia.

Ríos — Alerta Hidrológico de la Cuenca del Plata del Instituto Nacional del Agua (INA), alerta.ina.gob.ar/a5:
  - altura diaria de los puertos del Paraná (escalas de Prefectura) y de las estaciones del Salado santafesino
    (Red Hidrológica Nacional), con los niveles de alerta y de evacuación que fija cada lugar;
  - el pronóstico oficial del INA para el Paraná (sale martes y viernes, con un rango inferior–medio–superior).
  Nivel de cada estación:
    rojo      = en o por encima del nivel de evacuación;
    naranja   = en o por encima del nivel de alerta;
    amarillo  = el pronóstico (valor medio) llega al nivel de alerta, o está a menos de 30 cm y subiendo;
    normal    = el resto;  «sin dato reciente» si la última lectura tiene más de 5 días.

Lluvia — para cada municipio y comuna de Santa Fe (GeoRef, datos.gob.ar) la lluvia de las próximas 72 h (Open-Meteo):
  la llanura no crece como un arroyo serrano, se anega cuando llueve mucho en pocas horas o muchos días seguidos.
    lluvia fuerte = 80 mm o más en 24 h, o 50 mm o más en 3 h;
    atención      = 50 mm o más en 24 h, o 30 mm o más en 3 h;
  con el suelo húmedo (60 mm o más en los últimos 7 días) los umbrales bajan a 3/4.
  Son umbrales aproximados, de referencia: la ciudad de Santa Fe tuvo anegamientos graves con 100 mm en 6 horas.

Escribe docs/data/santafe.json y avisa por Telegram cuando un río pasa el nivel de alerta o de evacuación.
Corre en el workflow del boletín, cada 6 horas.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

INA = 'https://alerta.ina.gob.ar/a5'
CAB = {'User-Agent': 'predinun (proyecto sin fines comerciales)'}
ARG = timezone(timedelta(hours=-3))
SITIO = 'https://diegoesteve.github.io/predinun/mapa.html#santafe'

# Estaciones del INA (id de estación = id de la serie observada de altura). De norte a sur.
PARANA = [23, 24, 25, 26, 30, 29, 31, 32, 33, 34, 35]   # Goya, Reconquista, Esquina, La Paz, Santa Fe, Paraná, Diamante, Victoria, San Lorenzo, Rosario, Villa Constitución
SALADO = {105: 105, 175: 175, 103: 103, 1679: 3044}       # estación: serie (Tostado, Emilia, Recreo, Santo Tomé)
CALIBRADO_PARANA = 289                                    # «tabprono_central»: pronóstico oficial del Paraná medio
DIAS_VIEJO = 5
MARGEN_M = 0.30

# lluvia (mm)
A24, A3, F24, F3 = 50, 30, 80, 50
HUMEDO_7D, FRACCION_HUMEDO = 60, 0.75
TANDA = 80


def get(url, **params):
    for k in range(3):
        try:
            r = requests.get(url, params={'format': 'json', **params}, headers=CAB, timeout=90)
            r.raise_for_status()
            return json.loads(r.content.decode('utf-8'))   # el INA responde text/plain sin charset: forzar UTF-8
        except Exception:
            if k == 2:
                raise
            time.sleep(10)


def hoy():
    return datetime.now(ARG)


# ---------------------------------------------------------------- ríos
def serie(sid, dias=30):
    fin = hoy() + timedelta(days=1)
    j = get(f'{INA}/obs/puntual/series/{sid}', timestart=(fin - timedelta(days=dias)).strftime('%Y-%m-%d'), timeend=fin.strftime('%Y-%m-%d'))
    obs = sorted((o['timestart'], o['valor']) for o in (j.get('observaciones') or []) if o.get('valor') is not None)
    return j['estacion'], obs


def pronosticos():
    """{estacion_id: {'fecha': emisión, 'puntos': [(fecha, inferior, medio, superior)]}} del último pronóstico del Paraná."""
    try:
        series = get(f'{INA}/obs/puntual/series', var_id=2, proc_id=4)
        series = series.get('rows', series) if isinstance(series, dict) else series
        estacion_de = {s['id']: s['estacion']['id'] for s in series}
        c = get(f'{INA}/sim/calibrados/{CALIBRADO_PARANA}/corridas/last', includeProno='true')
    except Exception as e:
        print('INA: sin pronóstico', str(e)[:100])
        return {}
    salida = {}
    for s in c.get('series', []):
        est = estacion_de.get(s['series_id'])
        if not est:
            continue
        por_fecha = {}
        for p in s.get('pronosticos', []):
            por_fecha.setdefault(p['timestart'][:10], {})[p.get('qualifier') or 'medio'] = p['valor']
        puntos = [(f, v.get('inferior'), v.get('medio'), v.get('superior')) for f, v in sorted(por_fecha.items())]
        salida[est] = {'emitido': c['forecast_date'][:10], 'puntos': puntos}
    return salida


def fecha_local(t):
    return pd.Timestamp(t).tz_convert('America/Argentina/Buenos_Aires').strftime('%Y-%m-%d')


def nivel_rio(altura, alerta, evac, tendencia, pron_max, viejo):
    if altura is None or viejo:
        return 'sin dato reciente'
    if evac and altura >= evac:
        return 'rojo'
    if alerta and altura >= alerta:
        return 'naranja'
    if alerta and ((pron_max is not None and pron_max >= alerta) or (altura >= alerta - MARGEN_M and (tendencia or 0) > 0)):
        return 'amarillo'
    return 'normal'


def rios():
    prono = pronosticos()
    salida = []
    for grupo, ids in (('Paraná', {i: i for i in PARANA}), ('Salado', SALADO)):
        for est_id, sid in ids.items():
            try:
                est, obs = serie(sid, 60 if grupo == 'Salado' else 30)
            except Exception as e:
                print('INA: sin datos de', est_id, str(e)[:80])
                continue
            altura = obs[-1][1] if obs else None
            ultima = fecha_local(obs[-1][0]) if obs else None
            viejo = not obs or (hoy() - pd.Timestamp(obs[-1][0]).to_pydatetime()).days > DIAS_VIEJO
            # cambio en los últimos 7 días (m/día), con la lectura más cercana a 7 días antes
            tendencia = None
            if len(obs) >= 2:
                t1 = pd.Timestamp(obs[-1][0])
                previas = [(t, v) for t, v in obs if (t1 - pd.Timestamp(t)).days >= 6]
                t0, v0 = previas[-1] if previas else obs[0]
                dias = max((t1 - pd.Timestamp(t0)).total_seconds() / 86400, 1)
                tendencia = round((altura - v0) / dias, 3)
            p = prono.get(est_id)
            futuros = [x for x in (p['puntos'] if p else []) if x[0] > (ultima or '')]
            pron_max = max((x[2] for x in futuros if x[2] is not None), default=None)
            nivel = nivel_rio(altura, est.get('nivel_alerta'), est.get('nivel_evacuacion'), tendencia, pron_max, viejo)
            salida.append({
                'id': est_id, 'nombre': re.sub(r'\s*-\s*Ruta Provincial nº\s*(\d+)', r' (RP \1)', est['nombre']),
                'rio': grupo, 'lat': round(est['geom']['coordinates'][1], 4), 'lon': round(est['geom']['coordinates'][0], 4),
                'provincia': (est.get('provincia') or '').title().replace('Santafe', 'Santa Fe').replace('Entrerios', 'Entre Ríos'),
                'altura_m': altura, 'fecha': ultima, 'alerta_m': est.get('nivel_alerta'), 'evacuacion_m': est.get('nivel_evacuacion'),
                'aguas_bajas_m': est.get('nivel_aguas_bajas'), 'tendencia_m_dia': tendencia, 'nivel': nivel,
                'historia': [[fecha_local(t), v] for t, v in obs[-30:]],
                'pronostico': ({'emitido': p['emitido'], 'puntos': [list(x) for x in futuros]} if p and futuros else None),
            })
            time.sleep(0.5)
    return salida


# ---------------------------------------------------------------- localidades y lluvia
def localidades():
    """Municipios y comunas de Santa Fe (GeoRef). Se guardan en data/santafe_localidades.json: no cambian."""
    ruta = os.path.join(cfg.DATA, 'santafe_localidades.json')
    guardadas = cfg.leer_json('santafe_localidades.json')
    if guardadas:
        return guardadas
    r = requests.get('https://apis.datos.gob.ar/georef/api/municipios', params={'provincia': 'Santa Fe', 'max': 1000, 'campos': 'nombre,centroide'},
                     headers=CAB, timeout=90)
    r.raise_for_status()
    locs = sorted(({'localidad': m['nombre'], 'lat': round(m['centroide']['lat'], 4), 'lon': round(m['centroide']['lon'], 4)}
                   for m in r.json()['municipios']), key=lambda f: f['localidad'])
    cfg.escribir_json(ruta, locs)
    return locs


ERRORES = []


def lluvia(locs):
    # Corre justo después de las localidades de Córdoba: se espera un minuto para no pasar el límite por minuto de Open-Meteo
    time.sleep(60)
    ahora = pd.Timestamp.now(tz=cfg.TZ).tz_localize(None).floor('h')
    fin = ahora + pd.Timedelta(hours=72)
    salida = {}
    for i in range(0, len(locs), TANDA):
        tanda = locs[i:i + TANDA]
        params = {'latitude': ','.join(f"{f['lat']:.4f}" for f in tanda), 'longitude': ','.join(f"{f['lon']:.4f}" for f in tanda),
                  'hourly': 'precipitation', 'past_days': 7, 'forecast_days': 4, 'timezone': cfg.TZ}
        j, error = None, ''
        for k in range(5):
            try:
                r = requests.get('https://api.open-meteo.com/v1/forecast', params=params, timeout=120)
                if r.status_code == 200:
                    j = r.json()
                    break
                error = f'HTTP {r.status_code}: {r.text[:150]}'
            except Exception as e:
                error = str(e)[:150]
            time.sleep(30 * (k + 1))
        if j is None:
            print('Open-Meteo: sin pronóstico para la tanda', i, error)
            ERRORES.append(f'lluvia, tanda {i}: {error}')
            continue
        for f, d in zip(tanda, j if isinstance(j, list) else [j]):
            s = pd.Series(d['hourly']['precipitation'], index=pd.to_datetime(d['hourly']['time']), dtype=float).fillna(0)
            r3 = s.rolling(3, min_periods=1).sum().loc[ahora:fin]
            r24 = s.rolling(24, min_periods=1).sum().loc[ahora:fin]
            l7 = float(s.loc[ahora - pd.Timedelta(days=7):ahora].sum())
            humedo = l7 >= HUMEDO_7D
            k = FRACCION_HUMEDO if humedo else 1
            m3, m24 = float(r3.max() or 0), float(r24.max() or 0)
            r3d = s.rolling(3, min_periods=1).sum()
            por_dia = {}
            for kd in range(3):
                d0 = max(ahora.normalize() + pd.Timedelta(days=kd), ahora)
                d1 = ahora.normalize() + pd.Timedelta(days=kd + 1) - pd.Timedelta(hours=1)
                if d1 >= d0:
                    por_dia[d0.strftime('%Y-%m-%d')] = [round(float(r3d.loc[d0:d1].max() or 0), 1), round(float(s.loc[d0:d1].sum()), 1)]
            cond = ('lluvia fuerte' if m24 >= F24 * k or m3 >= F3 * k else 'atención' if m24 >= A24 * k or m3 >= A3 * k else 'normal')
            salida[f['localidad']] = {'condicion': cond, 'max_3h_mm': round(m3, 1), 'max_24h_mm': round(m24, 1),
                                      'cuando': (r24.idxmax() if m24 >= m3 * 2 else r3.idxmax()).strftime('%Y-%m-%d %H:00') if m24 > 0 else None,
                                      'lluvia_7d_mm': round(l7, 1), 'suelo_humedo': humedo, 'dias': por_dia}
        time.sleep(1)
    return salida


# ---------------------------------------------------------------- avisos
ORDEN = {'normal': 0, 'sin dato reciente': 0, 'amarillo': 1, 'naranja': 2, 'rojo': 3}


def avisar(lista):
    ruta = os.path.join(cfg.DATA, 'santafe_avisados.json')
    antes = cfg.leer_json('santafe_avisados.json') or {}
    ahora = {}
    filas, mensajes = [], []
    for r in lista:
        n = r['nivel']
        ahora[str(r['id'])] = n
        if ORDEN.get(n, 0) > ORDEN.get(antes.get(str(r['id']), 'normal'), 0):
            detalle = f"{r['altura_m']} m el {r['fecha']} (alerta {r['alerta_m']} m, evacuación {r['evacuacion_m'] or '–'} m)"
            filas.append((f"Río {r['rio']} en {r['nombre']}", n, detalle))
            if n in ('naranja', 'rojo'):
                icono = '🔴' if n == 'rojo' else '🟠'
                que = 'pasó el nivel de evacuación' if n == 'rojo' else 'pasó el nivel de alerta'
                mensajes.append(f"{icono} El río {r['rio']} en {r['nombre']} {que}: {detalle}. Dato del INA / Prefectura.")
    try:
        from alerta.historial import registrar
        registrar('crecidas santa fe', 'INA ríos', filas, bool(mensajes))
    except Exception as e:
        print('historial:', e)
    token, chat = os.environ.get('TELEGRAM_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID')
    for m in mensajes:
        print(m)
        if token and chat:
            try:
                requests.post(f'https://api.telegram.org/bot{token}/sendMessage',
                              data={'chat_id': chat, 'text': m + '\n' + SITIO, 'disable_web_page_preview': 'true'}, timeout=20)
            except Exception as e:
                print('Telegram:', e)
    cfg.escribir_json(ruta, ahora)


def main():
    lista = rios()
    try:
        locs = localidades()
        llu = lluvia(locs)
    except Exception as e:
        print('Localidades/lluvia de Santa Fe:', str(e)[:120])
        ERRORES.append(f'localidades/lluvia: {str(e)[:150]}')
        locs, llu = cfg.leer_json('santafe_localidades.json') or [], {}
    salida = {'generado': hoy().strftime('%Y-%m-%d %H:%M'),
              'fuentes': {'rios': 'Instituto Nacional del Agua (INA), Alerta Hidrológico de la Cuenca del Plata; alturas de Prefectura Naval y Red Hidrológica Nacional',
                          'lluvia': 'Open-Meteo (modelos de pronóstico)', 'localidades': 'GeoRef, datos.gob.ar'},
              'umbrales_lluvia': {'atencion_24h': A24, 'atencion_3h': A3, 'fuerte_24h': F24, 'fuerte_3h': F3,
                                  'humedo_7d': HUMEDO_7D, 'fraccion_humedo': FRACCION_HUMEDO},
              'rios': lista,
              'errores': ERRORES,
              'localidades': [{**f, **llu.get(f['localidad'], {})} for f in locs]}
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'santafe.json'), salida)
    print(f"santafe.json: {len(lista)} estaciones de ríos ({sum(r['nivel'] in ('naranja', 'rojo') for r in lista)} en alerta o más), "
          f"{len(locs)} localidades, {sum(v['condicion'] != 'normal' for v in llu.values())} con lluvia para mirar")
    if lista:
        avisar(lista)


if __name__ == '__main__':
    main()
