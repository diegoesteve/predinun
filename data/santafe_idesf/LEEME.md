# Capas de la IDESF (Infraestructura de Datos Espaciales de Santa Fe)

Bajadas a mano desde el servicio WMS público de la Provincia (`https://aswe.santafe.gov.ar/idesf/publico-wms`), que no
responde desde fuera de Argentina. Cada imagen está recortada igual que la simulación de la escala `<id>`
(ver `docs/data/simulacion.json`, `limites`), 1512 × 1296 píxeles, EPSG:4326.

- `defensas_<id>.png`: capa `saguas_defensas` (Trazas de defensas, Secretaría de Aguas). La simulación las usa como
  paredes que el agua no cruza.
- `agua_19980119_<id>.png`: capa `scit_cobertura_agua_190198` (Cobertura agua 19/01/1998, SCIT). Verde = agua,
  azul = sin agua, blanco = fuera de la imagen. Se usa para comprobar la simulación con un dato independiente.

Para sumar otra escala, pedir el GetMap con el `bbox` de sus `limites` (oeste,sur,este,norte), `width=1512&height=1296`,
`format=image/png` (y `transparent=true` para las defensas).
