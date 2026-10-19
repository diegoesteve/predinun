"""Arma docs/data/riesgo.geojson para el mapa de riesgo.

Capas (cada una se agrega solo si está su archivo en data/):
  - sitios_confirmados.csv   daños verificados con imágenes (paso 6)
  - tramos_rios.csv          tramos de río con su índice de corredor (paso 5, sección 4b)
  - microcuencas.csv         prioridad por microcuenca (paso 5), como puntos en el centroide
Se corre a mano cuando cambian esos archivos; no hace falta en cada pasada.
"""
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
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'riesgo.geojson'), {'type': 'FeatureCollection', 'features': feats})
    print(f'riesgo.geojson: {len(feats)} elementos')


if __name__ == '__main__':
    main()
