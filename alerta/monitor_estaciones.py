"""
Monitor de estaciones de lluvia y nivel de ríos — Sierras Chicas y Punilla (Córdoba).

Una ejecución = una consulta. Programarlo cada 15 minutos:
  - Windows: Programador de tareas -> python monitor_estaciones.py
  - Linux:   */15 * * * * python3 /ruta/monitor_estaciones.py
Variables de entorno:
  MONITOR_RUTA       carpeta donde guardar la historia y el estado (por defecto ./monitor)
  TELEGRAM_TOKEN     opcional, token del bot de Telegram
  TELEGRAM_CHAT_ID   opcional, chat o grupo que recibe los avisos
Requiere: pip install requests pandas numpy

Umbrales provisorios. No reemplaza los avisos de Defensa Civil ni del SMN.
"""

import os, json, time
import requests
import pandas as pd
import numpy as np

# ---------------------------------------------------------------------------------------------
# Fuentes: servicios públicos de la Secretaría de Recursos Hídricos de Córdoba (APRHI / SIHM)
# ---------------------------------------------------------------------------------------------
BASE_ARCGIS = 'https://services1.arcgis.com/atxllciEI8CHWvwW/arcgis/rest/services'
SERV_ESTACIONES = f'{BASE_ARCGIS}/Estaciones_ultimamedicion_Publico/FeatureServer/0/query'
SERV_LLUVIA_10 = f'{BASE_ARCGIS}/lluvia_10_min_ultimas_2_hs/FeatureServer/0/query'
SERV_NIVEL_10 = f'{BASE_ARCGIS}/nivel10min_ultimas24hs_tab/FeatureServer/0/query'
ZONA_HORARIA = 'America/Argentina/Cordoba'

# Sierras Chicas y Punilla (con margen), sin el resto de la provincia
REGION = {'oeste': -64.85, 'este': -64.05, 'sur': -31.65, 'norte': -30.85}

# ---------------------------------------------------------------------------------------------
# Umbrales PROVISORIOS por pluviómetro. Los del paso 3 (22–24 mm en 3 h) son promedios de cuenca
# medidos por satélite; un pluviómetro mide en un punto y marca más. Hay que recalibrarlos con la
# historia de las estaciones, que este mismo monitor va guardando en cada consulta.
# Referencias: 29/01/2021 Mendiolaza, 90 mm en 15 min; 15/01/2021 La Falda, 100 mm en 70 min.
# ---------------------------------------------------------------------------------------------
NIVELES_LLUVIA = [   # de mayor a menor
    ('rojo',     {'Lluvia_mm_20min': 25, 'Lluvia_mm_1hs': 50, 'Lluvia_mm_3hs': 80}),
    ('naranja',  {'Lluvia_mm_20min': 15, 'Lluvia_mm_1hs': 30, 'Lluvia_mm_3hs': 50}),
    ('amarillo', {'Lluvia_mm_20min': 8,  'Lluvia_mm_1hs': 15, 'Lluvia_mm_3hs': 25}),
]
# Subida del río en la última hora (m). El 17/10/2026 el Cosquín creció ~1,5 m y hubo evacuados en la costa
NIVELES_RIO = [('rojo', 1.0), ('naranja', 0.5), ('amarillo', 0.25)]
HORAS_SIN_DATOS = 2           # una estación sin datos hace más de esto se marca "sin datos"
# Lecturas de nivel que no se usan para el semáforo:
#  - canales y diques: el nivel de un embalse o de un canal de riego no es una crecida (y algunos se miden contra otra
#    referencia: «Canal Los Molinos» marca ~140 m);
#  - picos aislados: una lectura que se aparta más de SALTO_MAX_M de la mediana de sus vecinas es un error del sensor
#    (el 22/10/2026 «El Diquecito» pasó de 0,5 a 56 m). Una crecida real sigue alta en las lecturas siguientes.
REFERENCIA = ('canal', 'dique', 'embalse')
SALTO_MAX_M = 1.0
RANGO_RIO_M = (-2.0, 15.0)

ORDEN = {'normal': 0, 'amarillo': 1, 'naranja': 2, 'rojo': 3}
ULTIMAS_ESTACIONES = None   # la última tabla leída por ciclo(), para el mapa
ICONO = {'normal': '🟢', 'amarillo': '🟡', 'naranja': '🟠', 'rojo': '🔴', 'sin datos': '⚪', 'dato dudoso': '⚪', 'referencia': '⚪'}


def zona_de(lat, lon):
    if lon > -64.42:
        return 'Sierras Chicas' if lat > -31.33 else 'Córdoba / La Calera'
    return 'Punilla norte' if lat > -31.28 else 'Punilla sur / San Antonio'


def consultar(url, where='1=1', campos='*', orden=None):
    # Consulta paginada a un servicio ArcGIS (POST, para que las condiciones largas no corten la URL)
    filas, offset = [], 0
    while True:
        params = {'where': where, 'outFields': campos, 'returnGeometry': 'false', 'f': 'json',
                  'resultOffset': offset, 'resultRecordCount': 2000}
        if orden:
            params['orderByFields'] = orden
        r = requests.post(url, data=params, timeout=60)
        r.raise_for_status()
        j = r.json()
        if 'error' in j:
            raise RuntimeError(f"El servicio respondió con error: {j['error']}")
        feats = j.get('features', [])
        filas += [f['attributes'] for f in feats]
        if not feats or not j.get('exceededTransferLimit'):
            break
        offset += len(feats)
    return pd.DataFrame(filas)


def a_hora_local(serie_ms):
    return pd.to_datetime(serie_ms, unit='ms', utc=True).dt.tz_convert(ZONA_HORARIA)


def dentro(lat_col, lon_col):
    return (f"{lat_col} >= {REGION['sur']} AND {lat_col} <= {REGION['norte']} AND "
            f"{lon_col} >= {REGION['oeste']} AND {lon_col} <= {REGION['este']}")


def leer_estaciones():
    campos = ('Codigo,NombreEstacion,Ciudad,Subcuenca,PropietarioEstacion,Latitud,Longitud,UltimaActualizacion,'
              'HorasSinRegistro,EstadoEquipo,Precipitacion,Lluvia_mm_20min,Lluvia_mm_1hs,Lluvia_mm_3hs,'
              'Lluvia_mm_6hs,Lluvia_mm_24hs,Nivel_m,Caudal_ls')
    e = consultar(SERV_ESTACIONES, dentro('Latitud', 'Longitud'), campos)
    if e.empty:
        return e
    e['UltimaActualizacion'] = a_hora_local(e['UltimaActualizacion'])
    e['zona'] = [zona_de(la, lo) for la, lo in zip(e['Latitud'], e['Longitud'])]
    return e


def leer_niveles_10min():
    n = consultar(SERV_NIVEL_10, dentro('latitud', 'longitud'), 'codigo,nombre_estacion,latitud,longitud,fecha,nivel_m,caudal')
    if n.empty:
        return n
    n['fecha'] = a_hora_local(n['fecha'])
    return n.dropna(subset=['nivel_m'])


def leer_lluvia_10min():
    l = consultar(SERV_LLUVIA_10, dentro('latitud', 'longitud'),
                  'codigo_estacion,nombre_estacion,latitud,longitud,fecha_medicion,medicion_lluvia_mm')
    if l.empty:
        return l
    l['fecha_medicion'] = a_hora_local(l['fecha_medicion'])
    return l


def nivel_lluvia(fila):
    for nombre, umbrales in NIVELES_LLUVIA:
        for campo, valor in umbrales.items():
            v = fila.get(campo)
            if v is not None and not pd.isna(v) and v >= valor:
                return nombre, f'{campo.replace("Lluvia_mm_", "lluvia ")}: {v:.1f} mm (umbral {valor})'
    return 'normal', ''


def es_referencia(nombre):
    n = str(nombre).lower()
    return any(p in n for p in REFERENCIA)


def sin_picos(g):
    """Saca lecturas fuera de rango y picos aislados (se apartan de la mediana de las vecinas). La última lectura se
    compara con las dos anteriores: si sube de golpe y la siguiente lo confirma, deja de ser un pico."""
    v = g['nivel_m']
    med = v.rolling(5, center=True, min_periods=3).median()
    ultimas = v.rolling(3, min_periods=3).median()          # para las últimas lecturas, que no tienen vecinas después
    ref = med.where(med.notna(), ultimas)
    bueno = v.between(*RANGO_RIO_M) & ((v - ref).abs() <= SALTO_MAX_M) | ref.isna()
    return g[bueno & v.between(*RANGO_RIO_M)], int((~bueno).sum())


def subida_rios(niveles, ahora):
    # Subida en la última hora y respecto del mínimo de las últimas 24 h, por estación de nivel
    filas = []
    for cod, g in niveles.groupby('codigo'):
        g = g.sort_values('fecha')
        nombre = g['nombre_estacion'].iloc[-1]
        if es_referencia(nombre):
            ult = g.iloc[-1]
            filas.append({'codigo': cod, 'estacion': nombre, 'lat': ult['latitud'], 'lon': ult['longitud'],
                          'zona': zona_de(ult['latitud'], ult['longitud']), 'hora': ult['fecha'].strftime('%d/%m %H:%M'),
                          'nivel_m': round(ult['nivel_m'], 2), 'subida_1h_m': None, 'sobre_minimo_24h_m': None,
                          'estado': 'referencia', 'nota': 'canal o dique: no se usa para el semáforo'})
            continue
        crudo_ult = g.iloc[-1]
        g, descartadas = sin_picos(g)
        # Si la que se descartó es la última y es una subida, puede ser el comienzo de una crecida: no se esconde
        a_confirmar = (not g.empty and crudo_ult['fecha'] > g['fecha'].iloc[-1]
                       and RANGO_RIO_M[0] <= crudo_ult['nivel_m'] <= RANGO_RIO_M[1]
                       and crudo_ult['nivel_m'] - g['nivel_m'].iloc[-1] > SALTO_MAX_M)
        if g.empty:
            filas.append({'codigo': cod, 'estacion': nombre, 'lat': crudo_ult['latitud'], 'lon': crudo_ult['longitud'],
                          'zona': zona_de(crudo_ult['latitud'], crudo_ult['longitud']),
                          'hora': crudo_ult['fecha'].strftime('%d/%m %H:%M'), 'nivel_m': None, 'subida_1h_m': None,
                          'sobre_minimo_24h_m': None, 'estado': 'dato dudoso', 'nota': 'todas las lecturas fuera de rango'})
            continue
        ult = g.iloc[-1]
        hace_1h = g[g['fecha'] <= ult['fecha'] - pd.Timedelta(minutes=60)]
        sube_1h = ult['nivel_m'] - hace_1h.iloc[-1]['nivel_m'] if not hace_1h.empty else np.nan
        nivel = 'normal'
        for nombre, umbral in NIVELES_RIO:
            if not pd.isna(sube_1h) and sube_1h >= umbral:
                nivel = nombre
                break
        atraso_h = (ahora - ult['fecha']).total_seconds() / 3600
        filas.append({'codigo': cod, 'estacion': ult['nombre_estacion'], 'lat': ult['latitud'], 'lon': ult['longitud'],
                      'zona': zona_de(ult['latitud'], ult['longitud']), 'hora': ult['fecha'].strftime('%d/%m %H:%M'),
                      'nivel_m': round(ult['nivel_m'], 2), 'subida_1h_m': None if pd.isna(sube_1h) else round(sube_1h, 2),
                      'sobre_minimo_24h_m': round(ult['nivel_m'] - g['nivel_m'].min(), 2),
                      'estado': 'sin datos' if atraso_h > HORAS_SIN_DATOS else (max(nivel, 'amarillo', key=lambda x: ORDEN[x]) if a_confirmar else nivel),
                      **({'nota': f"subida brusca de {crudo_ult['nivel_m'] - ult['nivel_m']:.1f} m en la última lectura, a confirmar"} if a_confirmar else
                         {'nota': f'{descartadas} lectura{"s" if descartadas > 1 else ""} descartada{"s" if descartadas > 1 else ""} por error del sensor'}
                         if descartadas else {})})
    return pd.DataFrame(filas)


def guardar_historia(df, archivo, claves):
    # Agrega las lecturas nuevas al archivo propio (la Provincia no publica la historia)
    if df.empty:
        return
    df = df.copy()
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].astype(str)
    if os.path.exists(archivo):
        df = pd.concat([pd.read_csv(archivo, dtype=str), df.astype(str)], ignore_index=True)
    df.astype(str).drop_duplicates(subset=claves, keep='last').to_csv(archivo, index=False)


def enviar(mensaje):
    print(mensaje)
    token, chat = os.environ.get('TELEGRAM_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID')
    if token and chat:
        try:
            requests.post(f'https://api.telegram.org/bot{token}/sendMessage',
                          data={'chat_id': chat, 'text': mensaje}, timeout=20)
        except Exception as e:
            print('No se pudo enviar a Telegram:', e)


def ciclo(ruta, avisar=True):
    # Una consulta completa: lee, clasifica, guarda la historia y avisa si alguna zona sube de nivel
    os.makedirs(ruta, exist_ok=True)
    ahora = pd.Timestamp.now(tz=ZONA_HORARIA)
    global ULTIMAS_ESTACIONES
    est = leer_estaciones()
    ULTIMAS_ESTACIONES = est
    niv = leer_niveles_10min()
    try:
        llu = leer_lluvia_10min()
    except Exception as e:
        print('Lluvia cada 10 min no disponible:', e)
        llu = pd.DataFrame()

    # Lluvia por estación
    lluvia = est[est['Precipitacion'].astype(str).str.upper() == 'SI'].copy() if not est.empty else est
    if not lluvia.empty:
        clasif = [nivel_lluvia(f) for f in lluvia.to_dict('records')]
        lluvia['estado'] = [c[0] for c in clasif]
        lluvia['motivo'] = [c[1] for c in clasif]
        atraso_h = (ahora - lluvia['UltimaActualizacion']).dt.total_seconds() / 3600
        lluvia.loc[atraso_h.isna() | (atraso_h > HORAS_SIN_DATOS), 'estado'] = 'sin datos'
    rios = subida_rios(niv, ahora) if not niv.empty else pd.DataFrame()

    # Historia propia
    guardar_historia(est, f'{ruta}/historia_estaciones.csv', ['Codigo', 'UltimaActualizacion'])
    guardar_historia(niv, f'{ruta}/historia_niveles_10min.csv', ['codigo', 'fecha'])
    if not llu.empty:
        guardar_historia(llu, f'{ruta}/historia_lluvia_10min.csv', ['codigo_estacion', 'fecha_medicion'])

    # Estado por zona: el peor de sus estaciones (lluvia o río)
    estados = {}
    for df in (lluvia, rios):
        if df is None or df.empty:
            continue
        for zona, g in df.groupby('zona'):
            validos = g[g['estado'].isin(list(ORDEN))]['estado']   # sin «sin datos», «dato dudoso» ni «referencia»
            peor = max(validos, key=lambda s: ORDEN[s]) if not validos.empty else 'normal'
            if ORDEN[peor] > ORDEN.get(estados.get(zona, 'normal'), 0):
                estados[zona] = peor
            else:
                estados.setdefault(zona, 'normal')

    # Avisos: solo cuando una zona SUBE de nivel o vuelve a normal (para no repetir cada 15 minutos)
    archivo_estado = f'{ruta}/estado_zonas.json'
    previo = json.load(open(archivo_estado)) if os.path.exists(archivo_estado) else {}
    for zona, estado in estados.items():
        antes = previo.get(zona, 'normal')
        if avisar and ORDEN[estado] > ORDEN[antes]:
            detalle = []
            if not lluvia.empty:
                for _, f in lluvia[(lluvia['zona'] == zona) & (lluvia['estado'].map(ORDEN.get).fillna(0) >= ORDEN[estado])].iterrows():
                    detalle.append(f"  · {f['NombreEstacion']}: {f['motivo']}")
            if not rios.empty:
                for _, f in rios[(rios['zona'] == zona) & (rios['estado'].map(ORDEN.get).fillna(0) >= ORDEN[estado])].iterrows():
                    detalle.append(f"  · {f['estacion']}: el río subió {f['subida_1h_m']} m en 1 h")
            enviar(f"{ICONO[estado]} {zona}: nivel {estado.upper()} ({ahora:%d/%m %H:%M})\n" + '\n'.join(detalle) +
                   '\nUmbrales provisorios. Para decidir, seguir a Defensa Civil y al SMN.')
        elif avisar and estado == 'normal' and antes != 'normal':
            enviar(f"🟢 {zona}: volvió a normal ({ahora:%d/%m %H:%M})")
    json.dump(estados, open(archivo_estado, 'w'), ensure_ascii=False)
    return ahora, lluvia, rios, estados


if __name__ == '__main__':
    ahora, lluvia, rios, estados = ciclo(os.environ.get('MONITOR_RUTA', 'monitor'))
    print(f'{ahora:%d/%m/%Y %H:%M}', ' | '.join(f'{ICONO[e]} {z}' for z, e in sorted(estados.items())))
