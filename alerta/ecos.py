"""Filtro de ecos que no son tormentas.

Cerca de las sierras el radar a veces devuelve un eco fijo del terreno: aparece siempre en el mismo lugar, con unos
55 dBZ y un «tope» de apenas 1 a 5 km (el 22 y 23/10/2026, entre el San Roque y La Calera, generó decenas de falsas
alarmas). Una tormenta capaz de dar granizo o una crecida llega mucho más alto y se mueve. Dos reglas:

  1. tope bajo: si se conoce la altura del tope y es menor que TOPE_MIN_KM, no se usa para alarmas;
  2. eco fijo conocido: en los lugares de la lista ECOS_FIJOS (anotados a mano después de revisarlos) se descarta
     cualquier núcleo que no supere lo que ese eco da siempre (más dBZ o un tope más alto que los de la lista).

El segundo eco fijo está sobre la Pampa de Achala (las Sierras Grandes al oeste de Cuesta Blanca): del 20 al 26/10/2026
apareció en casi todas las corridas, siempre en la misma franja, con 41 a 52 dBZ y tope de 5 a 7 km (las sierras ya
tienen 2 km), y avisaba por Cuesta Blanca, Tala Huasi y Mayu Sumaj. Ahí una tormenta de verdad sí importa (es la
cabecera del San Antonio), así que solo se descarta lo que se parece al eco: menos de 55 dBZ y tope de menos de 9 km.

Se probó detectar ecos fijos solos (núcleos de tope bajo repetidos en el mismo lugar), pero en un día de lluvia
generalizada marcaba decenas de lugares: por eso la lista es manual. El mismo archivo está en los dos proyectos.
"""
import math

TOPE_MIN_KM = 6.0
# Cada eco fijo: centro, radio y desde cuántos dBZ o qué tope un núcleo ahí se toma como tormenta de verdad.
ECOS_FIJOS = [
    {'lat': -31.33, 'lon': -64.42, 'radio_km': 3.0, 'dbz_real': 60, 'tope_real_km': 99,
     'nota': 'entre el San Roque y La Calera: 55 dBZ, tope 0,6 a 4,8 km, toda la noche del 22 al 23/10/2026'},
    {'lat': -31.485, 'lon': -64.78, 'radio_km': 7.0, 'dbz_real': 55, 'tope_real_km': 9.0,
     'nota': 'Pampa de Achala, al oeste de Cuesta Blanca: 41 a 52 dBZ, tope 5 a 7 km, casi todas las corridas del 20 al 26/10/2026'},
]


def km(a, b, c, d):
    return math.hypot((a - c) * 111.3, (b - d) * 111.3 * math.cos(math.radians(a)))


def filtrar(nucleos, ahora=None):
    """Marca en cada núcleo 'descartado' (motivo) si no debe usarse para alarmas. Devuelve los que sí sirven."""
    utiles = []
    for n in nucleos:
        tope = n.get('tope_km')
        bajo = tope is not None and tope < TOPE_MIN_KM
        dbz = n.get('max_dbz') or n.get('dbz') or 0
        fijo = any(km(n['lat'], n['lon'], x['lat'], x['lon']) <= x['radio_km'] and dbz < x['dbz_real'] and (tope or 0) < x['tope_real_km']
                   for x in ECOS_FIJOS)
        if bajo:
            n['descartado'] = f'tope bajo ({tope} km)'
        elif fijo:
            n['descartado'] = 'eco fijo del terreno'
        else:
            utiles.append(n)
    return utiles
