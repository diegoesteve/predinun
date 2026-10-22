"""Arma docs/data/riesgo.geojson para el mapa de riesgo.

Capas (cada una se agrega solo si está su archivo en data/):
  - sitios_confirmados.csv   daños verificados con imágenes (paso 6)
  - tramos_rios.csv          tramos de río con su índice de corredor (paso 5, sección 4b)
  - microcuencas.csv         prioridad por microcuenca (paso 5), como puntos en el centroide
  - comunidades_analogas.csv arroyos serranos que entran a pueblos, parecidos a San Carlos Minas (paso 9)
Además arma docs/data/localidades.json, la tabla por localidad del mapa de riesgo (paso 9 + inventario de eventos
+ límites urbanos del GeoPortal + daños confirmados).
Lo corre el workflow del boletín, así que alcanza con subir los archivos a data/.
"""
import json
import math
import re
import unicodedata
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402


def num(v):
    if pd.isna(v):
        return None
    return v.item() if hasattr(v, 'item') else v


def puntos(df, capa, lat='lat', lon='lon', campos=None):
    feats = []
    for f in df.to_dict('records'):
        if pd.isna(f.get(lat)) or pd.isna(f.get(lon)):
            continue
        props = {k: num(v) for k, v in f.items() if (campos is None or k in campos) and k not in (lat, lon)}
        feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(float(f[lon]), 5), round(float(f[lat]), 5)]},
                      'properties': {'capa': capa, **props}})
    return feats


ORDEN_ICONOS = ['⛰️', '🚪', '↪️', '🌉', '🏠', '🟫']
ALIAS = {'cordoba capital': 'cordoba', 'cordoba sur': 'cordoba', 'sistema rio ceballos saldan': 'rio ceballos'}
RAZONES = {
    '⛰️': 'el arroyo baja de una cuenca serrana grande o muy empinada',
    '🚪': 'el pueblo está en la salida de la sierra, donde el agua se abre y desborda',
    '↪️': 'hay una curva cerrada o un angostamiento del cauce río arriba',
    '🌉': 'hay puentes que se pueden tapar con ramas y troncos',
    '🏠': 'hay casas bajas junto al cauce',
    '🟫': 'el pueblo está en un llano apenas más alto que el arroyo',
}
MARGEN_MIN_AVISO = 30   # minutos: una estación en el mismo pueblo no da tiempo de avisar


def clave(n):
    n = re.sub(r'\(.*', '', str(n)).replace('-', ' ').lower()
    n = ''.join(ch for ch in unicodedata.normalize('NFD', n) if unicodedata.category(ch) != 'Mn')
    n = ' '.join(n.split())
    return ALIAS.get(n, n)


def bonito(n):
    n = ' '.join(str(n).replace('-', ' ').split()).title()
    for a, b in ((' De ', ' de '), (' Del ', ' del '), (' La ', ' la '), (' Las ', ' las '), (' Los ', ' los '), (' El ', ' el ')):
        n = n.replace(a, b)
    return n


def recortar(t, n=240):
    t = str(t)
    return t if len(t) <= n else t[:n].rsplit(' ', 1)[0].rstrip(';,') + '…'


def leer_aportes():
    import glob
    out = []
    for ruta in sorted(glob.glob(os.path.join(cfg.DATA, 'aportes', '*.json'))):
        try:
            a = json.load(open(ruta, encoding='utf-8'))
        except Exception as e:
            print('aporte ilegible', ruta, e)
            continue
        a['fotos'] = [u for u in a.get('fotos', []) if str(u).startswith('https://')]
        out.append(a)
    return out


def razones_de(iconos):
    return [t for i, t in RAZONES.items() if i in str(iconos or '')]


def exposicion(max_banderas, personas, n_eventos=0, graves=0.0):
    """Exposición permanente (historial y terreno), para saber dónde mirar. No es un nivel de riesgo oficial
    ni dice nada del momento: eso lo da el semáforo «Ahora» de la página, con el pronóstico.

    graves: crecidas graves registradas; las anteriores a 1950 cuentan la mitad (registros más inciertos
    y pueblos que cambiaron mucho desde entonces)."""
    if (graves >= 2 or (graves >= 1 and max_banderas >= 3)
            or (max_banderas >= 5 and personas >= 300) or (max_banderas >= 4 and personas >= 1000)):
        return 'muy expuesta'
    if graves or n_eventos or max_banderas >= 3 or personas >= 200:
        return 'expuesta'
    if max_banderas >= 1 or personas > 0:
        return 'poco expuesta'
    return None


def peso_grave(evento):
    if str(evento.get('severidad', '')).lower() not in ('grave', 'catastrófica', 'catastrofica'):
        return 0.0
    m = re.match(r'\d{4}', str(evento.get('fecha', '')))
    return 0.5 if m and int(m.group()) < 1950 else 1.0


def km(lat1, lon1, lat2, lon2):
    return math.hypot((lat1 - lat2) * 111.3, (lon1 - lon2) * 111.3 * math.cos(math.radians(lat1)))


GENERICOS = {'', 'sin nombre', 'rio', 'río', 'arroyo', 'canal', 'cañada', 'canada'}


def limpiar_curso(n):
    """«A. Cachirla*» -> «Arroyo Cachirla» (el asterisco de la APRHI marca nombres asignados)."""
    n = n.replace('*', '').strip()
    for corto, largo in (('A. ', 'Arroyo '), ('R. ', 'Río '), ('C. ', 'Cañada '), ('Ao. ', 'Arroyo ')):
        if n.startswith(corto):
            n = largo + n[len(corto):]
    return n


def cursos_con_nombre():
    """Tramos de los cursos de agua de la APRHI que tienen nombre: lista de (nombre, [(lat, lon), ...], bbox)."""
    d = cfg.leer_json(os.path.join('aprhi', 'cursos_agua.geojson')) or {}
    out = []
    for f in d.get('features', []):
        nombre = (f['properties'].get('NOMBRE_COMPLETO') or '').strip()
        if not nombre:
            continue
        g = f['geometry']
        lineas = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        for ln in lineas:
            pts = [(c[1], c[0]) for c in ln]
            la, lo = [p[0] for p in pts], [p[1] for p in pts]
            out.append((limpiar_curso(nombre), pts, (min(la), max(la), min(lo), max(lo))))
    return out


def nombre_oficial(lat, lon, cursos, max_m=300):
    """Nombre del curso de agua de la APRHI más cercano al punto, si está a menos de max_m metros."""
    margen = max_m / 111000 * 1.5
    mejor, dmin = None, max_m / 1000
    kx = math.cos(math.radians(lat))
    for nombre, pts, (la0, la1, lo0, lo1) in cursos:
        if not (la0 - margen <= lat <= la1 + margen and lo0 - margen <= lon <= lo1 + margen):
            continue
        for (ya, xa), (yb, xb) in zip(pts, pts[1:]):
            ax, ay, bx, by = (xa - lon) * kx * 111.3, (ya - lat) * 111.3, (xb - lon) * kx * 111.3, (yb - lat) * 111.3
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
            d = math.hypot(ax + t * dx, ay + t * dy)
            if d < dmin:
                mejor, dmin = nombre, d
    return mejor


def localidades():
    """Una fila por localidad, para elegir dónde enfocarse en el mapa."""
    filas = {}
    ruta = os.path.join(cfg.DATA, 'geoportal', 'localidades_limites.geojson')
    if os.path.exists(ruta):
        for ft in json.load(open(ruta, encoding='utf-8'))['features']:
            g = ft['geometry']
            anillo = (g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0])
            lon = sum(c[0] for c in anillo) / len(anillo)
            lat = sum(c[1] for c in anillo) / len(anillo)
            k = clave(ft['properties']['localidad'])
            filas.setdefault(k, {'localidad': bonito(ft['properties']['localidad']), 'lat': round(lat, 5), 'lon': round(lon, 5)})
    ruta = os.path.join(cfg.DATA, 'comunidades_analogas.csv')
    if os.path.exists(ruta):
        a = pd.read_csv(ruta)
        a = a[a['localidad'] != 'zona rural'].sort_values(['n_banderas', 'personas_expuestas'], ascending=False)
        for loc, g in a.groupby('localidad', sort=False):
            k = clave(loc)
            f = filas.setdefault(k, {'localidad': loc, 'lat': round(float(g['lat'].iat[0]), 5), 'lon': round(float(g['lon'].iat[0]), 5)})
            f['localidad'] = bonito(loc)
            presentes = ''.join(g['banderas'].fillna(''))
            iconos = ''.join(i for i in ORDEN_ICONOS if i in presentes)
            con_margen = (g['margen_aprox_min'].fillna(0) >= MARGEN_MIN_AVISO)
            f.update({
                'banderas': iconos, 'max_banderas': int(g['n_banderas'].max()),
                'personas_expuestas': int(g['personas_expuestas'].sum()),
                'personas_llano': int(g['personas_llano'].sum()) if 'personas_llano' in g else None,
                'tipos': sorted(set(g['tipo_peligro'].dropna())),
                'aviso': 'sí' if con_margen.all() else ('parcial' if con_margen.any() else 'no'),
                'margen_max_min': None if g['margen_aprox_min'].isna().all() else int(g['margen_aprox_min'].max()),
                'parecido_scm': None if g['parecido_scm'].isna().all() else round(float(g['parecido_scm'].min()), 2),
                'arroyos': [{'arroyo': (r.arroyo if isinstance(r.arroyo, str) else 'sin nombre'), 'banderas': r.banderas if isinstance(r.banderas, str) else '',
                             'razones': razones_de(r.banderas),
                             'exposicion': exposicion(int(r.n_banderas), int(r.personas_expuestas)),
                             'area_km2': r.area_km2, 'personas': int(r.personas_expuestas),
                             'margen_min': None if pd.isna(r.margen_aprox_min) else int(r.margen_aprox_min),
                             'lat': r.lat, 'lon': r.lon} for r in g.itertuples()][:8],
            })
    # Nombres oficiales de los arroyos (APRHI) donde el análisis no tenía nombre o tenía uno genérico
    cursos = cursos_con_nombre()
    if cursos:
        n = 0
        for f in filas.values():
            for a in f.get('arroyos', []):
                if a['arroyo'].strip().lower() in GENERICOS:
                    oficial = nombre_oficial(a['lat'], a['lon'], cursos)
                    if oficial:
                        a['arroyo'], n = oficial, n + 1
        print(f'arroyos con nombre oficial de la APRHI: {n}')
    ruta = os.path.join(cfg.DATA, 'inventario_inundaciones_cordoba.csv')
    if os.path.exists(ruta):
        inv = pd.read_csv(ruta, dtype=str).fillna('')
        for ev in inv.itertuples():
            for nombre in ev.localidades.split(';'):
                k = clave(nombre)
                if k in filas:
                    filas[k].setdefault('eventos', []).append(
                        {'fecha': ev.fecha, 'impacto': recortar(ev.impacto), 'severidad': ev.severidad, 'url': ev.url})
    ruta = os.path.join(cfg.DATA, 'sitios_confirmados.csv')
    if os.path.exists(ruta):
        s = pd.read_csv(ruta)
        s = s.dropna(subset=['lat', 'lon'])   # confirmados con imágenes y reportados con testimonio o prensa
        for f in filas.values():
            f['danos_registrados'] = int(sum(km(f['lat'], f['lon'], la, lo) <= 4 for la, lo in zip(s['lat'], s['lon'])))
    for a in leer_aportes():
        k = clave(a.get('localidad', ''))
        if k not in filas and a.get('lat') is not None:
            cerca = min(filas.values(), key=lambda f: km(f['lat'], f['lon'], a['lat'], a['lon']), default=None)
            if cerca and km(cerca['lat'], cerca['lon'], a['lat'], a['lon']) <= 5:
                k = clave(cerca['localidad'])
        if k in filas:
            filas[k].setdefault('relatos', []).append({
                'id': a['id'], 'fecha_evento': a.get('fecha_evento', ''), 'relato': recortar(a.get('relato', ''), 600),
                'altura_agua': a.get('altura_agua', ''), 'fotos': a['fotos']})
    camp = cfg.leer_json('campings.json')
    if camp:
        bajos = [c for c in camp['lugares'] if c['bajo_junto_a_rio']]
        for f in filas.values():
            cerca = [c for c in bajos if km(f['lat'], f['lon'], c['lat'], c['lon']) <= 5]
            if cerca:
                f['campings_bajos'] = [{'tipo': c['tipo'], 'nombre': c['nombre'] or f"{c['tipo']} sin nombre",
                                        'altura_m': c['altura_sobre_cauce_m'], 'lat': c['lat'], 'lon': c['lon']}
                                       for c in cerca][:12]
    out = []
    for f in filas.values():
        f.setdefault('banderas', ''); f.setdefault('max_banderas', 0); f.setdefault('personas_expuestas', 0)
        f.setdefault('aviso', None); f.setdefault('eventos', [])
        f['n_eventos'] = len({e['fecha'] for e in f['eventos']})
        graves = sum(1 for e in f['eventos'] if peso_grave(e))
        f['exposicion'] = exposicion(f['max_banderas'], f['personas_expuestas'], f['n_eventos'], sum(peso_grave(e) for e in f['eventos']))
        f['razones'] = razones_de(f['banderas'])
        if graves:
            f['razones'].insert(0, f'tuvo {graves} crecida{"s" if graves > 1 else ""} grave{"s" if graves > 1 else ""} registrada{"s" if graves > 1 else ""}')
        elif f['n_eventos']:
            f['razones'].insert(0, f'tuvo {f["n_eventos"]} crecida{"s" if f["n_eventos"] > 1 else ""} registrada{"s" if f["n_eventos"] > 1 else ""}')
        out.append(f)
    orden = {'muy expuesta': 0, 'expuesta': 1, 'poco expuesta': 2, None: 3}
    out.sort(key=lambda f: (orden[f['exposicion']], -f['n_eventos'], -f['max_banderas'], -f['personas_expuestas']))
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'localidades.json'), {'localidades': out})
    print(f'localidades.json: {len(out)} localidades, {sum(1 for f in out if f["n_eventos"])} con eventos registrados')


def main():
    feats = []
    ruta = os.path.join(cfg.DATA, 'sitios_confirmados.csv')
    if os.path.exists(ruta):
        s = pd.read_csv(ruta)
        s = s[s['estado'].astype(str).str.startswith('confirmado')]
        feats += puntos(s, 'daño confirmado', campos=['id', 'rio', 'zona', 'evento', 'ubicacion', 'tipo_dano', 'notas'])
    ruta = os.path.join(cfg.DATA, 'tramos_rios.csv')
    if os.path.exists(ruta):
        t = pd.read_csv(ruta)
        la = 'lat' if 'lat' in t else next(c for c in t.columns if c.lower().startswith('lat'))
        lo = 'lon' if 'lon' in t else next(c for c in t.columns if c.lower().startswith('lon'))
        if 'inestable' in t and 'expuesto_ha' in t:
            t = t[t['inestable'].astype(str).str.lower().isin(['true', '1']) | (t['expuesto_ha'] > 0)]
        feats += puntos(t, 'tramo de río', la, lo, ['localidad_cercana', 'area_km2', 'ancho_llanura_m', 'pendiente_cauce_%',
                                                    'cand_eventos', 'confirmados', 'expuesto_ha', 'inestable'])
    ruta = os.path.join(cfg.DATA, 'microcuencas.csv')
    if os.path.exists(ruta):
        m = pd.read_csv(ruta)
        la = next((c for c in m.columns if c.lower().startswith('lat')), None)
        lo = next((c for c in m.columns if c.lower().startswith('lon')), None)
        if la and lo:
            if 'expuesto_ha' in m:
                m = m[m['expuesto_ha'] > 0]
            feats += puntos(m, 'microcuenca', la, lo, ['localidad_cercana', 'tipo', 'expuesto_ha', 'banderas', 'n_banderas'])
    ruta = os.path.join(cfg.DATA, 'comunidades_analogas.csv')
    if os.path.exists(ruta):
        a = pd.read_csv(ruta)
        a = a[(a['localidad'] != 'zona rural') & (a['n_banderas'] >= 3)].copy()
        a['exposicion'] = [exposicion(int(n), int(p)) for n, p in zip(a['n_banderas'], a['personas_expuestas'])]
        a['razones'] = ['; '.join(razones_de(b)) for b in a['banderas']]
        feats += puntos(a, 'comunidad análoga', campos=['exposicion', 'razones', 'localidad', 'arroyo', 'banderas', 'tipo_peligro', 'area_km2',
                                                         'desnivel_m', 'puentes', 'personas_expuestas', 'personas_llano', 'personas_bajo',
                                                         'estaciones_arriba', 'margen_aprox_min', 'parecido_scm'])
    for a in leer_aportes():
        if a.get('lat') is None or a.get('lon') is None:
            continue
        feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [a['lon'], a['lat']]},
                      'properties': {'capa': 'aporte', 'localidad': a.get('localidad', ''),
                                     'fecha_evento': a.get('fecha_evento', ''), 'relato': recortar(a.get('relato', ''), 500),
                                     'altura_agua': a.get('altura_agua', ''), 'fotos': a['fotos']}})
    camp = cfg.leer_json('campings.json')
    if camp:
        bajos = pd.DataFrame([c for c in camp['lugares'] if c['bajo_junto_a_rio']])
        if not bajos.empty:
            feats += puntos(bajos, 'camping o balneario bajo', campos=['tipo', 'nombre', 'altura_sobre_cauce_m',
                                                                        'cuenca_rio_cercano_km2'])
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'riesgo.geojson'), {'type': 'FeatureCollection', 'features': feats})
    print(f'riesgo.geojson: {len(feats)} elementos')
    localidades()


if __name__ == '__main__':
    main()
