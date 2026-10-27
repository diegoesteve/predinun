"""Hoy y mañana para cada localidad, en palabras simples: lo que muestra la app (docs/app/) y lo que mandan los avisos.

Junta lo que ya calculan los otros scripts, sin pedir nada nuevo a nadie:
  Córdoba (sierras): radar del OHMC (docs/data/radar.json), alertas del SMN (smn.json), lluvia de hoy y mañana con el
    umbral de cada localidad (condiciones_localidades.json) y lo expuesta que está por su historia (localidades.json).
  Santa Fe (llanura): el río más cercano y su pronóstico (santafe.json, del INA), la lluvia de hoy y mañana con los
    umbrales de anegamiento, y las alertas del SMN.

Niveles: 0 tranquilo · 1 atención · 2 alerta · 3 peligro. Para cada día, el nivel más alto y por qué (título y texto
cortos, sin números técnicos).

Escribe docs/data/app.json. Corre en el monitor (cada 15 minutos) y en el boletín.
"""
import json
import math
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

DD = cfg.DOCS_DATA
SMN_NIVEL = {'amarillo': 1, 'naranja': 2, 'rojo': 3}
COLOR_SMN = {'amarillo': 'amarilla', 'naranja': 'naranja', 'rojo': 'roja'}
RIO_KM = 20            # una localidad «tiene río» si la escala está a menos de esto (Salado)

# Costa santafesina del Paraná (y del San Javier, su brazo): borde oeste del valle, de norte a sur, por los pueblos de la
# costa. Las localidades a menos de COSTA_KM de esta línea toman el Paraná aunque la escala quede lejos o del otro lado
# (Las Toscas, Villa Ocampo y Tacuarendí no tienen escala propia: la más cercana es Bella Vista, en Corrientes).
COSTA_PARANA = [(-28.04, -59.22), (-28.23, -59.26), (-28.35, -59.25), (-28.49, -59.28), (-29.07, -59.53), (-29.24, -59.60),
                (-29.50, -59.74), (-29.91, -59.82), (-30.58, -59.93), (-30.88, -60.03), (-31.10, -60.09), (-31.20, -60.16),
                (-31.42, -60.33), (-31.55, -60.52), (-31.64, -60.70), (-31.97, -60.92), (-32.43, -60.82), (-32.72, -60.73),
                (-32.95, -60.64), (-33.24, -60.33)]
COSTA_KM = 10
# Escalas del Paraná para la costa santafesina, de norte a sur: para un pueblo entre dos escalas se interpola por
# latitud cuánto le falta (o le sobra) al río para la alerta y la evacuación. Quedan afuera las del otro lado del valle
# que tienen otra referencia (Goya, Paraná, Victoria).
CADENA_PARANA = [21, 22, 24, 25, 26, 30, 31, 33, 34, 35]
# Ciudades con defensas contra el Paraná: el nivel de evacuación de la escala es para la costa, las islas y los barrios
# fuera de las defensas, no para toda la ciudad.
CON_DEFENSAS = {'Santa Fe', 'Reconquista'}
DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']


def leer(nombre):
    ruta = os.path.join(DD, nombre)
    if not os.path.exists(ruta):
        return {}
    with open(ruta, encoding='utf-8') as f:
        return json.load(f)


def km(a, b, c, d):
    return math.hypot((a - c) * 111.3, (b - d) * 111.3 * math.cos(math.radians(a)))


def minutos_desde(texto, ahora):
    try:
        return (ahora - datetime.strptime(texto, '%Y-%m-%d %H:%M')).total_seconds() / 60
    except (TypeError, ValueError):
        return None


def nombres_oficiales():
    """Nombre oficial (con tildes) de las localidades de Córdoba según GeoRef: el inventario tiene varios sin tildes
    («Cordoba», «Saldan»). Se baja una vez y queda en data/nombres_georef.json."""
    import unicodedata
    normal = lambda t: ''.join(c for c in unicodedata.normalize('NFD', t or '') if not unicodedata.combining(c)).lower().strip()   # noqa: E731
    ruta = os.path.join(cfg.DATA, 'nombres_georef.json')
    nombres = cfg.leer_json('nombres_georef.json')
    if not nombres:
        try:
            import requests
            nombres = []
            for recurso in ('municipios', 'localidades'):
                r = requests.get(f'https://apis.datos.gob.ar/georef/api/{recurso}', params={'provincia': 'Córdoba', 'max': 5000, 'campos': 'nombre'}, timeout=60)
                r.raise_for_status()
                nombres += [x['nombre'] for x in r.json()[recurso]]
            cfg.escribir_json(ruta, sorted(set(nombres)))
        except Exception as e:
            print('GeoRef sin respuesta: nombres como están', str(e)[:80])
            nombres = []
    return {normal(n): n for n in nombres}


def nombre_curso(t):
    """«A. Cabana» → «Arroyo Cabana», «Rio Ceballos» → «Río Ceballos»."""
    t = (t or '').strip()
    for corto, largo in (('A. ', 'Arroyo '), ('Ao. ', 'Arroyo '), ('R. ', 'Río '), ('Rio ', 'Río '), ('Cda. ', 'Cañada ')):
        if t.startswith(corto):
            return largo + t[len(corto):]
    return t


def motivo(nivel, titulo, texto):
    return {'nivel': nivel, 'titulo': titulo, 'texto': texto}


def resumen(motivos, tranquilo):
    """El motivo de nivel más alto manda; si hay otro distinto, va como segunda línea."""
    motivos = sorted([m for m in motivos if m and m['nivel'] > 0], key=lambda m: -m['nivel'])
    if not motivos:
        return {'nivel': 0, 'titulo': 'Tranquilo', 'texto': tranquilo}
    p = dict(motivos[0])
    otros = [m['titulo'] for m in motivos[1:] if m['titulo'] != p['titulo']]
    if otros:
        p['tambien'] = otros[0]
    return p


def alertas_smn(smn, clave, nombre, dia):
    """Alertas del SMN que tocan a la localidad y están vigentes ese día."""
    ids = (smn.get(clave) or {}).get(nombre) or []
    salida = []
    for a in smn.get('alertas', []):
        if a['id'] not in ids:
            continue
        desde, hasta = (a.get('desde') or '')[:10], (a.get('hasta') or '')[:10]
        if (not desde or desde <= dia) and (not hasta or dia <= hasta):
            n = SMN_NIVEL.get(a.get('nivel'), 1)
            corto = a.get('tipo') == 'aviso a corto plazo'
            salida.append(motivo(n, f"{'Aviso' if corto else 'Alerta'} {COLOR_SMN.get(a.get('nivel'), '')} del SMN",
                                 f"{a.get('evento') or 'Tormentas'}{', hasta las ' + a['hasta_local'][-5:] + ' h' if a.get('hasta_local') else ''}. "
                                 'Es un aviso oficial: seguí las indicaciones de Defensa Civil.'))
    return salida


# ---------------------------------------------------------------- Córdoba
def cordoba(ahora, hoy, manana):
    locs = leer('localidades.json').get('localidades', [])
    cond = leer('condiciones_localidades.json').get('localidades', {})
    radar = leer('radar.json')
    smn = leer('smn.json')
    edad = minutos_desde(radar.get('consultado'), ahora)
    tormentas = (radar.get('localidades') or {}) if edad is not None and edad <= 60 else {}
    salida = []
    for f in locs:
        nombre, expo = f['localidad'], f.get('exposicion')
        c = cond.get(nombre) or {}
        umbral = c.get('umbral_mm') or 20
        muy = expo == 'muy expuesta'

        def lluvia(dia, cuando):
            m3 = ((c.get('dias') or {}).get(dia) or [0, 0])[0]
            if m3 >= umbral:
                n = 2 if muy or (expo == 'expuesta' and m3 >= 1.5 * umbral) else 1
                return motivo(n, 'Tormentas fuertes' if n == 2 else 'Puede llover fuerte',
                              f'Se espera mucha lluvia en poco tiempo {cuando}. Con tormenta, el arroyo puede crecer en pocos minutos, aunque acá no llueva.')
            if muy and m3 >= 0.75 * umbral:
                return motivo(1, 'Puede llover fuerte', f'Puede llover fuerte {cuando}. Si llueve mucho, el arroyo crece rápido.')
            return None

        hoy_m = [lluvia(hoy, 'hoy'), *alertas_smn(smn, 'localidades', nombre, hoy)]
        t = tormentas.get(nombre)
        if t:
            n = 3 if muy or (expo == 'expuesta' and t.get('nivel') == 'muy intensa') else 2
            hoy_m.append(motivo(n, 'Tormenta fuerte sobre el río, ahora',
                                f"El radar ve una tormenta fuerte sobre la cuenca del {nombre_curso(t.get('cuenca_de')) or 'arroyo'}. "
                                'El agua puede bajar en minutos: alejate de la orilla y no cruces vados.'))
        man_m = [lluvia(manana, 'mañana'), *alertas_smn(smn, 'localidades', nombre, manana)]
        arroyos = [nombre_curso(a.get('arroyo')) for a in f.get('arroyos', []) if a.get('arroyo')]
        dias = c.get('dias') or {}
        salida.append({'n': nombre, 'z': 'cba', 'la': f['lat'], 'lo': f['lon'], 'tipo': 'sierras',
                       'mm': [(dias.get(hoy) or [0, 0])[1], (dias.get(manana) or [0, 0])[1]],
                       'rio': arroyos[0] if arroyos else None, 'expo': expo,
                       'hoy': resumen(hoy_m, 'No se esperan lluvias fuertes ni tormentas.'),
                       'man': resumen(man_m, 'No se esperan lluvias fuertes ni tormentas.')})
    return salida


# ---------------------------------------------------------------- Santa Fe
def altura_manana(r, manana):
    """Altura estimada del río para mañana: entre la última lectura y el pronóstico del INA (o con la tendencia)."""
    if r.get('altura_m') is None or not r.get('fecha'):
        return None
    t0 = datetime.fromisoformat(r['fecha'])
    t1 = datetime.fromisoformat(manana)
    pts = [(datetime.fromisoformat(p[0]), p[2]) for p in ((r.get('pronostico') or {}).get('puntos') or []) if p[2] is not None]
    pts = [p for p in pts if p[0] > t0]
    if pts:
        tp, hp = pts[0]
        if t1 >= tp:
            return hp
        return r['altura_m'] + (hp - r['altura_m']) * (t1 - t0).days / max((tp - t0).days, 1)
    if r.get('tendencia_m_dia') is not None:
        return r['altura_m'] + r['tendencia_m_dia'] * (t1 - t0).days
    return r['altura_m']


def nivel_rio(h, r, subiendo):
    a, e = r.get('alerta_m'), r.get('evacuacion_m')
    if h is None or a is None:
        return 0
    if e is not None and h >= e:
        return 3
    if h >= a:
        return 2
    if h >= a - 0.3 and subiendo:
        return 1
    return 0


def km_a_costa(la, lo):
    def seg(p, a, b):
        # distancia de p al segmento a-b, en un plano local (km)
        c = math.cos(math.radians(p[0]))
        ax, ay, bx, by, px, py = a[1] * c * 111.3, a[0] * 111.3, b[1] * c * 111.3, b[0] * 111.3, p[1] * c * 111.3, p[0] * 111.3
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
        return math.hypot(px - ax - t * dx, py - ay - t * dy)
    return min(seg((la, lo), COSTA_PARANA[i], COSTA_PARANA[i + 1]) for i in range(len(COSTA_PARANA) - 1))


def parana_en(la, rios, manana):
    """Escala «virtual» del Paraná frente a un pueblo de la costa: interpola por latitud entre la escala de arriba y la de
    abajo cuánto está el río sobre (o bajo) la alerta y la evacuación, hoy y mañana. Alerta = 0 m."""
    por_id = {r['id']: r for r in rios}
    cadena = [por_id[i] for i in CADENA_PARANA if i in por_id and por_id[i].get('altura_m') is not None and por_id[i].get('alerta_m') is not None]
    if not cadena:
        return None
    cadena.sort(key=lambda r: -r['lat'])

    def datos(r):
        a = r['alerta_m']
        e = r['evacuacion_m'] if r.get('evacuacion_m') is not None else a + 0.4
        hm = altura_manana(r, manana)
        return (r['altura_m'] - a, e - a, (hm - a) if hm is not None else None, r.get('tendencia_m_dia') or 0)
    if la >= cadena[0]['lat']:
        a = b = cadena[0]
    elif la <= cadena[-1]['lat']:
        a = b = cadena[-1]
    else:
        k = next(i for i in range(len(cadena) - 1) if cadena[i]['lat'] >= la >= cadena[i + 1]['lat'])
        a, b = cadena[k], cadena[k + 1]
    t = 0 if a is b else (a['lat'] - la) / (a['lat'] - b['lat'])
    da, db = datos(a), datos(b)
    mezcla = lambda i: None if da[i] is None or db[i] is None else da[i] + (db[i] - da[i]) * t
    nombre = a['nombre'] if a is b or t < .15 else b['nombre'] if t > .85 else f"{a['nombre']} y {b['nombre']}"
    return {'id': None, 'rio': 'Paraná', 'nombre': nombre, 'entre': a is not b and .15 <= t <= .85,
            'altura_m': mezcla(0), 'alerta_m': 0.0, 'evacuacion_m': mezcla(1), 'manana_m': mezcla(2), 'tendencia_m_dia': mezcla(3)}


def santa_fe(hoy, manana):
    d = leer('santafe.json')
    smn = leer('smn.json')
    u = d.get('umbrales_lluvia') or {}
    rios = [r for r in d.get('rios', []) if r.get('nivel') != 'sin dato reciente']
    salida = []
    for f in d.get('localidades', []):
        nombre = f['localidad']
        if km_a_costa(f['lat'], f['lon']) <= COSTA_KM:
            r = parana_en(f['lat'], [x for x in rios if x['rio'] == 'Paraná'], manana)
        else:
            cerca = sorted(((km(f['lat'], f['lon'], x['lat'], x['lon']), x) for x in rios if x['rio'] != 'Paraná'), key=lambda x: x[0])
            r = cerca[0][1] if cerca and cerca[0][0] <= RIO_KM else None
        defensas = nombre in CON_DEFENSAS

        def lluvia(dia, cuando):
            m3, total = ((f.get('dias') or {}).get(dia) or [0, 0])
            k = u.get('fraccion_humedo', .75) if f.get('suelo_humedo') else 1
            if total >= u.get('fuerte_24h', 80) * k or m3 >= u.get('fuerte_3h', 50) * k:
                return motivo(2, 'Lluvia muy fuerte', f'Se espera mucha lluvia {cuando}. Las calles y zonas bajas se pueden anegar.')
            if total >= u.get('atencion_24h', 50) * k or m3 >= u.get('atencion_3h', 30) * k:
                return motivo(1, 'Puede llover mucho', f'Puede llover mucho {cuando}. Si tu calle se anega seguido, prevenite.')
            return None

        hoy_m, man_m = [lluvia(hoy, 'hoy')], [lluvia(manana, 'mañana')]
        hoy_m += alertas_smn(smn, 'localidades_santafe', nombre, hoy)
        man_m += alertas_smn(smn, 'localidades_santafe', nombre, manana)
        if r:
            subiendo = (r.get('tendencia_m_dia') or 0) > 0.005
            rio = f"el río {r['rio']}"
            Rio = f"El río {r['rio']}"
            n_hoy = nivel_rio(r['altura_m'], r, subiendo)
            sube = 'sigue subiendo' if subiendo else 'no baja'
            textos = {3: ('Costa e islas: el río pasó el nivel de evacuación',
                          f'{Rio} está muy alto y {sube}. Si vivís en la costa, en las islas o en un barrio bajo, '
                          'prepará lo importante y seguí las indicaciones de Protección Civil.'),
                      2: ('El río está alto', f'{Rio} pasó el nivel de alerta{" y sigue subiendo" if subiendo else ""}. Las zonas bajas cerca de la costa pueden tener agua.'),
                      1: ('El río está subiendo', f'{Rio} sube y se acerca al nivel de alerta. Estate atento a las zonas bajas cerca de la costa.')}
            if defensas:
                # Con defensas, la evacuación es para lo que queda afuera: la ciudad no está toda en peligro.
                textos[3] = ('Costa e islas: el río pasó el nivel de evacuación',
                             f'{Rio} está muy alto y {sube}. La ciudad tiene defensas: el peligro es para quienes viven '
                             'fuera de ellas, en la costa, las islas y los barrios bajos. Si es tu caso, seguí las indicaciones de Protección Civil.')
            # Con defensas, la evacuación de la escala es para lo que queda afuera: el pueblo no está todo en peligro (nivel 2).
            tope = 2 if defensas else 3
            hm = r['manana_m'] if 'manana_m' in r else altura_manana(r, manana)
            real_hoy, real_man = n_hoy, nivel_rio(hm, r, subiendo)
            if real_hoy:
                hoy_m.append(motivo(min(real_hoy, tope), *textos[real_hoy]))
            if real_man:
                t = textos[real_man]
                if real_man > real_hoy:
                    t = {3: ('El río puede llegar al nivel de evacuación',
                             f'Mañana {rio} puede llegar al nivel de evacuación. ' + ('La ciudad tiene defensas: si vivís fuera de ellas, en la costa, las islas o un barrio bajo, prepará lo importante hoy.'
                                                                                     if defensas else 'Si vivís en la costa, en las islas o en un barrio bajo, prepará lo importante hoy.')),
                         2: ('Puede entrar agua en las zonas bajas', f'{Rio} sigue subiendo: mañana puede pasar el nivel de alerta y llegar a las calles más bajas cerca de la costa.'),
                         1: t}[real_man]
                man_m.append(motivo(min(real_man, tope), *t))
        dias = f.get('dias') or {}
        salida.append({'n': nombre, 'z': 'sf', 'la': f['lat'], 'lo': f['lon'], 'tipo': 'llanura',
                       'mm': [(dias.get(hoy) or [0, 0])[1], (dias.get(manana) or [0, 0])[1]],
                       'rio': (f"{r['rio']} entre {r['nombre']}" if r.get('entre') else f"{r['rio']} en {r['nombre']}") if r else None,
                       'hoy': resumen(hoy_m, 'No se esperan lluvias fuertes' + (' y el río está normal.' if r else '.')),
                       'man': resumen(man_m, 'No se esperan lluvias fuertes' + (' ni que el río pase la alerta.' if r else '.'))})
    return salida


def main():
    from zoneinfo import ZoneInfo
    ahora = datetime.now(ZoneInfo(cfg.TZ)).replace(tzinfo=None)
    hoy = ahora.strftime('%Y-%m-%d')
    manana = (ahora + timedelta(days=1)).strftime('%Y-%m-%d')
    lugares = cordoba(ahora, hoy, manana) + santa_fe(hoy, manana)
    import unicodedata
    oficial = nombres_oficiales()
    for x in lugares:
        clave = ''.join(c for c in unicodedata.normalize('NFD', x['n']) if not unicodedata.combining(c)).lower().strip()
        nom = oficial.get(clave) if x['z'] == 'cba' else None
        if nom and nom != x['n']:
            x['nom'] = nom          # para mostrar; «n» sigue siendo la clave que usan los demás archivos
    cfg.escribir_json(os.path.join(DD, 'app.json'), {
        'generado': ahora.strftime('%Y-%m-%d %H:%M'), 'hoy': hoy, 'manana': manana,
        'dia_manana': DIAS[(ahora + timedelta(days=1)).weekday()],
        'lugares': lugares})
    from collections import Counter
    print(f"app.json: {len(lugares)} lugares · hoy {dict(Counter(x['hoy']['nivel'] for x in lugares))} · mañana {dict(Counter(x['man']['nivel'] for x in lugares))}")


if __name__ == '__main__':
    main()
