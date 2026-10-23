"""Historial de alarmas: una fila por alarma en data/historial_alarmas.csv, para compararlas después con lo que
informaron los medios. Las columnas «que_paso» y «fuente_medios» se completan a mano (en GitHub o en una planilla).

El mismo archivo está en los dos proyectos (crecidas y granizo).
"""
import csv
import os
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Cada workflow escribe su propio archivo (el del pronóstico aparte), para que dos corridas a la vez no se pisen
RUTA = os.path.join(RAIZ, 'data', os.environ.get('HISTORIAL_ARCHIVO', 'historial_alarmas.csv'))
CAMPOS = ['fecha', 'hora', 'proyecto', 'fuente', 'lugar', 'nivel', 'detalle', 'enviado_telegram', 'que_paso', 'fuente_medios']
ARG = timezone(timedelta(hours=-3))


def registrar(proyecto, fuente, filas, enviado):
    """filas: lista de (lugar, nivel, detalle). enviado: si salió por Telegram."""
    if not filas:
        return
    ahora = datetime.now(ARG)
    nuevo = not os.path.exists(RUTA)
    os.makedirs(os.path.dirname(RUTA), exist_ok=True)
    with open(RUTA, 'a', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=CAMPOS)
        if nuevo:
            w.writeheader()
        for lugar, nivel, detalle in filas:
            w.writerow({'fecha': ahora.strftime('%Y-%m-%d'), 'hora': ahora.strftime('%H:%M'), 'proyecto': proyecto,
                        'fuente': fuente, 'lugar': lugar, 'nivel': nivel, 'detalle': detalle,
                        'enviado_telegram': 'sí' if enviado else 'no', 'que_paso': '', 'fuente_medios': ''})
