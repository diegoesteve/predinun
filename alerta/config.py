"""Configuración común: cuencas, umbrales, rutas y modelos."""
import json
import os

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(RAIZ, 'data')            # insumos (copiados de Drive) e historia del monitor
DOCS_DATA = os.path.join(RAIZ, 'docs', 'data')  # lo que lee la página
TZ = 'America/Argentina/Cordoba'

# Punto de salida de cada cuenca (lat, lon). Las cuencas completas vienen de data/cuencas.geojson (paso 4).
SALIDAS = {
    'SierrasChicas':   (-31.305, -64.310),
    'Cosquin':         (-31.245, -64.465),
    'SanAntonio_CPaz': (-31.430, -64.495),
    'Capital':         (-31.420, -64.190),
}
NOMBRES = {'SierrasChicas': 'Sierras Chicas', 'Cosquin': 'Cosquín',
           'SanAntonio_CPaz': 'San Antonio / Carlos Paz', 'Capital': 'Capital (experimental)'}
# Zona del monitor de estaciones que corresponde a cada cuenca
CUENCA_A_ZONA = {'SierrasChicas': 'Sierras Chicas', 'Cosquin': 'Punilla norte',
                 'SanAntonio_CPaz': 'Punilla sur / San Antonio', 'Capital': 'Córdoba / La Calera'}

# Umbrales del paso 3: lluvia máxima en 3 h, promedio de cuenca, IMERG (mm). Se usan si falta umbrales_modelo.json
UMBRAL_IMERG_3H = {'SierrasChicas': 22.0, 'Cosquin': 24.0, 'SanAntonio_CPaz': 23.0, 'Capital': 20.0}

# Reglas del boletín
HORAS_ALERTA = 48
PROB_POSIBLE, PROB_PROBABLE = 0.30, 0.60
PCTL_HUMEDO = 80          # suelo saturado desde este percentil
FRACCION_LLUVIA = 0.5     # con suelo saturado, cuenta esta fracción del umbral
DIAS_PERSPECTIVA = 10

# Modelos de Open-Meteo (el paso 4 guarda los que funcionaron en modelos_open_meteo.json)
MODELOS_DEF = {'GFS': 'gfs_seamless', 'ICON': 'icon_seamless', 'ECMWF': 'ecmwf_ifs025'}
ENSAMBLES_DEF = {'ECMWF ENS': 'ecmwf_ifs025', 'GFS ENS': 'gfs025', 'ICON EPS': 'icon_seamless'}
ENSAMBLE_A_MODELO = {'ECMWF ENS': 'ECMWF', 'GFS ENS': 'GFS', 'ICON EPS': 'ICON'}


def leer_json(nombre, defecto=None):
    ruta = os.path.join(DATA, nombre)
    if os.path.exists(ruta):
        with open(ruta, encoding='utf-8') as f:
            return json.load(f)
    return defecto


def escribir_json(ruta, obj):
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    with open(ruta, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, default=str)


def modelos():
    m = leer_json('modelos_open_meteo.json') or {}
    return m.get('actuales') or MODELOS_DEF, m.get('ensamble') or ENSAMBLES_DEF


def puntos():
    # Puntos de pronóstico por cuenca (paso 4). Si falta el archivo, se usa solo el punto de salida.
    p = leer_json('puntos_cuencas.json')
    if p:
        return {c: [tuple(x) for x in v] for c, v in p.items()}
    return {c: [s] for c, s in SALIDAS.items()}


def umbral(cuenca, modelo):
    u = (leer_json('umbrales_modelo.json') or {}).get(cuenca, {}).get(modelo)
    return (u['umbral_mm'], u.get('fuente', 'paso 4')) if u else (UMBRAL_IMERG_3H[cuenca], 'IMERG (sin calibrar)')
