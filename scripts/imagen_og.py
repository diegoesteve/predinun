"""Imagen de vista previa (1200x630) que muestran WhatsApp y las redes al compartir el sitio. Se corre a mano."""
import os
from PIL import Image, ImageDraw, ImageFont

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F = '/usr/share/fonts/truetype/dejavu/'
negrita = lambda t: ImageFont.truetype(F + 'DejaVuSans-Bold.ttf', t)   # noqa: E731
normal = lambda t: ImageFont.truetype(F + 'DejaVuSans.ttf', t)         # noqa: E731

im = Image.new('RGB', (1200, 630), '#F3F5F4')
d = ImageDraw.Draw(im)
d.rectangle([0, 0, 1200, 14], fill='#0E5E5A')
# sierras estilizadas al pie
d.polygon([(0, 630), (0, 520), (180, 450), (330, 505), (520, 420), (700, 490), (880, 430), (1050, 480), (1200, 440), (1200, 630)], fill='#DCE5E1')
d.polygon([(0, 630), (0, 570), (240, 520), (460, 565), (640, 515), (860, 560), (1060, 525), (1200, 555), (1200, 630)], fill='#C4D3CD')
d.line([(0, 600), (200, 590), (420, 606), (650, 592), (880, 604), (1200, 590)], fill='#4FB3AC', width=6)

d.text((70, 70), 'CRECIDAS · SIERRAS DE CÓRDOBA', font=negrita(28), fill='#0E5E5A')
d.text((70, 125), '¿Hay riesgo de crecida', font=negrita(66), fill='#16201C')
d.text((70, 205), 'esta semana?', font=negrita(66), fill='#16201C')
d.text((70, 300), 'Semáforo por localidad, ríos en vivo y pronóstico.', font=normal(32), fill='#16201C')
d.text((70, 345), 'Datos de la Provincia de Córdoba, NASA y Open-Meteo.', font=normal(32), fill='#5B6863')
# semáforo
for i, c in enumerate(['#C0362C', '#F2C230', '#1F7A4D']):
    d.ellipse([1010, 80 + i * 92, 1090, 160 + i * 92], fill=c)
d.rounded_rectangle([70, 410, 556, 462], radius=26, fill='#FFF6DB', outline='#C99A06', width=2)
d.text((92, 421), 'Monitor experimental, no oficial', font=negrita(24), fill='#16201C')
im.save(os.path.join(RAIZ, 'docs', 'og.png'), optimize=True)
print('docs/og.png')
