"""Genera el boletín (48 h + suelo + perspectiva a 10 días) en docs/data/boletin.json.

Si el nivel de alguna cuenca sube respecto del boletín anterior, avisa por Telegram (si hay secretos).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg                 # noqa: E402
from alerta import boletin                       # noqa: E402
from alerta.monitor_estaciones import enviar     # noqa: E402

ORDEN = {'verde': 0, 'amarillo': 1, 'naranja': 2, 'rojo': 3}
ICONO = {'verde': '🟢', 'amarillo': '🟡', 'naranja': '🟠', 'rojo': '🔴'}
SALIDA = os.path.join(cfg.DOCS_DATA, 'boletin.json')


def main():
    anterior = cfg.leer_json(os.path.join('..', 'docs', 'data', 'boletin.json')) or {}
    antes = {f['cuenca']: f['nivel'] for f in anterior.get('cuencas', [])}
    b = boletin.generar()
    if not b['cuencas']:
        print('No se pudo armar ningún pronóstico; se deja el boletín anterior.')
        sys.exit(1)
    cfg.escribir_json(SALIDA, b)
    for f in b['cuencas']:
        s = f.get('suelo') or {}
        print(f"{ICONO[f['nivel']]} {f['nombre']}: {f['nivel']}"
              f"{' (agravado por suelo)' if f.get('agravado_por_suelo') else ''}"
              f" | suelo p{s.get('percentil', '?')}")
        if os.environ.get('AVISAR', '1') == '1' and ORDEN[f['nivel']] > ORDEN.get(antes.get(f['cuenca'], 'verde'), 0):
            from alerta.historial import registrar
            registrar('crecidas', 'pronóstico 48 h', [(f['nombre'], f['nivel'], ', '.join(f"{m} {v['max_3h_mm']} mm" for m, v in f['modelos'].items()))],
                      ORDEN[f['nivel']] >= ORDEN['naranja'])
        if os.environ.get('AVISAR', '1') == '1' and ORDEN[f['nivel']] > ORDEN.get(antes.get(f['cuenca'], 'verde'), 0) \
                and ORDEN[f['nivel']] >= ORDEN['naranja']:   # por Telegram solo naranja o rojo
            modelos = ', '.join(f"{m} {v['max_3h_mm']} mm" for m, v in f['modelos'].items())
            enviar(f"{ICONO[f['nivel']]} Pronóstico {f['nombre']}: {f['nivel'].upper()} en las próximas {b['horas']} h\n"
                   f"Máximo en 3 h: {modelos}\n"
                   + ('Suelo muy húmedo: se subió un nivel.\n' if f.get('agravado_por_suelo') else '')
                   + 'Pronóstico propio, no oficial. Seguir a Defensa Civil y al SMN.')


if __name__ == '__main__':
    main()
