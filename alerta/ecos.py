"""Filtro de ecos que no son tormentas.

Cerca de las sierras el radar a veces devuelve un eco fijo del terreno: aparece siempre en el mismo lugar, con unos
55 dBZ y un «tope» de apenas 1 a 5 km (el 22 y 23/10/2026, entre el San Roque y La Calera, generó decenas de falsas
alarmas). Una tormenta capaz de dar granizo o una crecida llega mucho más alto y se mueve. Dos reglas:

  1. tope bajo: si se conoce la altura del tope y es menor que TOPE_MIN_KM, no se usa para alarmas;
  2. eco fijo conocido: en los lugares de la lista ECOS_FIJOS (anotados a mano después de revisarlos) se descarta
     cualquier núcleo que no sea muy fuerte (DBZ_FUERTE con tope alto).

Se probó detectar ecos fijos solos (núcleos de tope bajo repetidos en el mismo lugar), pero en un día de lluvia
generalizada marcaba decenas de lugares: por eso la lista es manual. El mismo archivo está en los dos proyectos.
"""
import math

TOPE_MIN_KM = 6.0
RADIO_KM = 3.0
DBZ_FUERTE = 60          # un núcleo de 60 dBZ o más con tope alto no se descarta aunque caiga sobre un eco fijo
ECOS_FIJOS = [
    {'lat': -31.33, 'lon': -64.42, 'nota': 'entre el San Roque y La Calera: 55 dBZ, tope 0,6 a 4,8 km, toda la noche del 22 al 23/10/2026'},
]


def km(a, b, c, d):
    return math.hypot((a - c) * 111.3, (b - d) * 111.3 * math.cos(math.radians(a)))


def filtrar(nucleos, ahora=None):
    """Marca en cada núcleo 'descartado' (motivo) si no debe usarse para alarmas. Devuelve los que sí sirven."""
    utiles = []
    for n in nucleos:
        tope = n.get('tope_km')
        bajo = tope is not None and tope < TOPE_MIN_KM
        fijo = any(km(n['lat'], n['lon'], x['lat'], x['lon']) <= RADIO_KM for x in ECOS_FIJOS)
        if bajo:
            n['descartado'] = f'tope bajo ({tope} km)'
        elif fijo and (n.get('max_dbz') or 0) < DBZ_FUERTE:
            n['descartado'] = 'eco fijo del terreno'
        else:
            utiles.append(n)
    return utiles
