"""Una pasada del monitor de estaciones (cada 15 min en GitHub Actions).

Escribe:
  docs/data/ahora.json        estado por zona y por cuenca (estaciones + boletín) para la página
  docs/data/estaciones.json   estaciones con su última lectura, para el mapa
  data/monitor/estado_zonas.json   estado anterior, para avisar solo cuando algo cambia
  data/historia/AAAA-MM-DD_<tipo>.csv.gz   historia propia, un archivo por día ya cerrado
"""
import glob
import gzip
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg               # noqa: E402
from alerta import monitor_estaciones as mon   # noqa: E402

RUTA = os.path.join(cfg.DATA, 'monitor')
HISTORIA = os.path.join(cfg.DATA, 'historia')
FECHAS = {'historia_estaciones.csv': 'UltimaActualizacion', 'historia_niveles_10min.csv': 'fecha',
          'historia_lluvia_10min.csv': 'fecha_medicion'}
ORDEN_PRON = {'verde': 0, 'amarillo': 1, 'naranja': 2, 'rojo': 3}
A_PRON = {'normal': 'verde', 'amarillo': 'amarillo', 'naranja': 'naranja', 'rojo': 'rojo'}


def cerrar_dias(hoy):
    """Pasa las filas de días anteriores a un archivo comprimido por día y deja solo las de hoy."""
    os.makedirs(HISTORIA, exist_ok=True)
    for nombre, col in FECHAS.items():
        ruta = os.path.join(RUTA, nombre)
        if not os.path.exists(ruta):
            continue
        df = pd.read_csv(ruta, dtype=str)
        dia = df[col].str[:10]
        for d, g in df[dia < hoy].groupby(dia[dia < hoy]):
            destino = os.path.join(HISTORIA, f"{d}_{nombre.replace('historia_', '').replace('.csv', '')}.csv.gz")
            if os.path.exists(destino):
                g = pd.concat([pd.read_csv(destino, dtype=str), g]).drop_duplicates()
            with gzip.open(destino, 'wt', encoding='utf-8') as f:
                g.to_csv(f, index=False)
        df[dia >= hoy].to_csv(ruta, index=False)


def limpio(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if hasattr(v, 'item'):
        v = v.item()
    return round(v, 2) if isinstance(v, float) else v


def puntos_estaciones(est, rios):
    out = []
    if est is not None and not est.empty:
        for f in est.to_dict('records'):
            estado, motivo = mon.nivel_lluvia(f) if str(f.get('Precipitacion')).upper() == 'SI' else ('normal', '')
            atraso = f.get('HorasSinRegistro')
            if atraso is not None and not pd.isna(atraso) and float(atraso) > mon.HORAS_SIN_DATOS:
                estado = 'sin datos'
            out.append({'tipo': 'lluvia' if str(f.get('Precipitacion')).upper() == 'SI' else 'otra',
                        'codigo': limpio(f.get('Codigo')), 'nombre': f.get('NombreEstacion'), 'zona': f.get('zona'),
                        'lat': limpio(f.get('Latitud')), 'lon': limpio(f.get('Longitud')),
                        'hora': f['UltimaActualizacion'].strftime('%d/%m %H:%M') if pd.notna(f.get('UltimaActualizacion')) else None,
                        'lluvia_1h': limpio(f.get('Lluvia_mm_1hs')), 'lluvia_3h': limpio(f.get('Lluvia_mm_3hs')),
                        'lluvia_24h': limpio(f.get('Lluvia_mm_24hs')), 'estado': estado, 'motivo': motivo})
    if rios is not None and not rios.empty:
        for f in rios.to_dict('records'):
            out.append({'tipo': 'rio', 'nombre': f.get('estacion'), **{k: limpio(v) for k, v in f.items()}})
    return out


def combinar(estados, boletin):
    """Por cuenca: lo que dicen las estaciones ahora y lo que dice el pronóstico; manda el peor."""
    pron = {f['cuenca']: f for f in (boletin or {}).get('cuencas', [])}
    out = []
    for c, nombre in cfg.NOMBRES.items():
        zona = cfg.CUENCA_A_ZONA[c]
        est = A_PRON[estados.get(zona, 'normal')]
        p = pron.get(c, {}).get('nivel', 'verde')
        nivel = max(est, p, key=ORDEN_PRON.get)
        motivo = []
        if est != 'verde':
            motivo.append(f'estaciones: {est}')
        if p != 'verde':
            motivo.append(f'pronóstico 48 h: {p}')
        out.append({'cuenca': c, 'nombre': nombre, 'zona_estaciones': zona, 'nivel': nivel,
                    'estaciones': est, 'pronostico': p, 'motivo': '; '.join(motivo) or 'sin lluvias fuertes ni crecidas',
                    'suelo': (pron.get(c, {}).get('suelo') or {}).get('estado')})
    return out


def main():
    ahora, lluvia, rios, estados = mon.ciclo(RUTA, avisar=os.environ.get('AVISAR', '1') == '1')
    cerrar_dias(ahora.strftime('%Y-%m-%d'))
    est = mon.ULTIMAS_ESTACIONES
    boletin = cfg.leer_json(os.path.join('..', 'docs', 'data', 'boletin.json'))
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'ahora.json'), {
        'actualizado': ahora.strftime('%Y-%m-%d %H:%M'),
        'boletin_generado': (boletin or {}).get('generado'),
        'zonas': [{'zona': z, 'estado': estados.get(z, 'normal')} for z in sorted(set(cfg.CUENCA_A_ZONA.values()))],
        'cuencas': combinar(estados, boletin),
        'umbrales': {'lluvia': mon.NIVELES_LLUVIA, 'rio_subida_1h_m': mon.NIVELES_RIO, 'provisorios': True},
    })
    cfg.escribir_json(os.path.join(cfg.DOCS_DATA, 'estaciones.json'),
                      {'actualizado': ahora.strftime('%Y-%m-%d %H:%M'), 'estaciones': puntos_estaciones(est, rios)})
    print(f'{ahora:%d/%m/%Y %H:%M}', ' | '.join(f'{mon.ICONO[e]} {z}' for z, e in sorted(estados.items())))


if __name__ == '__main__':
    main()
