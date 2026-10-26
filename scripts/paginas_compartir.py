"""Páginas para compartir cada localidad por WhatsApp, Telegram o redes.

WhatsApp y las redes no ejecutan JavaScript: para que al pegar un link aparezca una vista previa con el estado
de la localidad, cada una necesita su propia página con las etiquetas Open Graph ya escritas. Este script genera
docs/l/<localidad>/index.html con el título y la descripción del momento, y redirige a la ficha en el mapa de riesgo.

Corre en el workflow del boletín, después de condiciones_localidades.py, cada 6 horas.
"""
import html
import json
import os
import re
import shutil
import sys
import unicodedata
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alerta import config as cfg   # noqa: E402

SITIO = os.environ.get('SITIO_URL', 'https://diegoesteve.github.io/predinun/')
CARPETA = os.path.join(cfg.RAIZ, 'docs', 'l')
EMOJI = {'alerta': '🔴', 'atención': '🟡', 'normal': '🟢'}


def slug(nombre):
    """Igual que slug() en docs/app.js."""
    s = unicodedata.normalize('NFD', nombre)
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def descripcion(f, c):
    partes = []
    if c:
        if c.get('max_3h_mm'):
            partes.append(f"Próximos 3 días: hasta {c['max_3h_mm']:g} mm en 3 horas.")
        else:
            partes.append('Próximos 3 días: no se pronostica lluvia.')
    if f.get('exposicion'):
        partes.append(f"Exposición: {f['exposicion']}.")
    if f.get('n_eventos'):
        partes.append(f"{f['n_eventos']} crecida{'s' if f['n_eventos'] > 1 else ''} registrada{'s' if f['n_eventos'] > 1 else ''}.")
    partes.append('Monitor experimental, no oficial.')
    return ' '.join(partes)


def pagina(f, c, generado):
    ahora = (c or {}).get('ahora')
    titulo = f"{f['localidad']}: {EMOJI.get(ahora, '')} {ahora}".strip() if ahora else f['localidad']
    titulo += ' · Crecidas Sierras de Córdoba'
    destino = f"../../mapa.html?localidad={quote(f['localidad'])}#riesgo"   # codificado: sin caracteres especiales de HTML
    url = f"{SITIO}l/{slug(f['localidad'])}/"
    e = lambda t: html.escape(t, quote=True)   # noqa: E731
    return f"""<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(titulo)}</title>
<meta name="description" content="{e(descripcion(f, c))}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Crecidas · Sierras de Córdoba">
<meta property="og:title" content="{e(titulo)}">
<meta property="og:description" content="{e(descripcion(f, c))}">
<meta property="og:url" content="{e(url)}">
<meta property="og:image" content="{e(SITIO)}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="es_AR">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url={destino}">
<link rel="canonical" href="{e(url)}">
</head>
<body style="font-family:system-ui,sans-serif;padding:24px">
<p>Actualizado {e(generado)}. Si no te lleva solo, <a href="{destino}">abrí la ficha de {e(f['localidad'])}</a>.</p>
<script>location.replace({json.dumps(destino)});</script>
</body>
</html>
"""


def main():
    locs = (cfg.leer_json(os.path.join('..', 'docs', 'data', 'localidades.json')) or {}).get('localidades', [])
    cond = cfg.leer_json(os.path.join('..', 'docs', 'data', 'condiciones_localidades.json')) or {}
    if not locs:
        print('No hay localidades.json todavía.')
        return
    if os.path.isdir(CARPETA):
        shutil.rmtree(CARPETA)
    vistos = set()
    for f in locs:
        s = slug(f['localidad'])
        if not s or s in vistos:
            continue
        vistos.add(s)
        os.makedirs(os.path.join(CARPETA, s), exist_ok=True)
        with open(os.path.join(CARPETA, s, 'index.html'), 'w', encoding='utf-8') as fh:
            fh.write(pagina(f, cond.get('localidades', {}).get(f['localidad']), cond.get('generado', '')))
    print(f'docs/l: {len(vistos)} páginas para compartir')


if __name__ == '__main__':
    main()
