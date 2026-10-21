# Predicción de crecidas · Sierras de Córdoba

Monitor experimental y personal de lluvias y crecidas en **Sierras Chicas** y **Punilla** (Córdoba, Argentina), sin fines comerciales.

> **Solo con fines informativos.** Estos datos son experimentales y no reemplazan ni anticipan los avisos oficiales. No los uses para decidir si evacuar o volver a tu casa. Los canales oficiales son **Defensa Civil de la Provincia de Córdoba**, el **Servicio Meteorológico Nacional** y tu municipio. Ante una emergencia llamá al **103 (Defensa Civil)** o al **911**.

## Qué hace

| Parte | Cada cuánto | Qué produce |
|---|---|---|
| **Monitor de estaciones** (`scripts/correr_monitor.py`) | 15 min | Lee la red pública de estaciones de la Provincia (lluvia y nivel de ríos), clasifica cada zona y avisa por Telegram solo cuando una zona sube de nivel o vuelve a normal. Guarda una historia propia, porque la Provincia publica solo las últimas horas. |
| **Boletín** (`scripts/correr_boletin.py`) | 6 h | Pronóstico a 48 h por cuenca (GFS, ICON, ECMWF y sus ensambles, vía Open-Meteo), humedad del suelo (NASA SMAP más el cambio que da el modelo desde la fecha de SMAP) y perspectiva a 10 días. |
| **Página** (`docs/`) | estática | Pestañas *Ahora*, *Pronóstico*, *Mapa de riesgo* (con tabla por localidad), *Antes de ir al río* (guía para campistas y bañistas) y *Aportá* (formulario de relatos). Se publica con GitHub Pages. |
| **Campings junto al río** (`scripts/armar_campings.py`) | 1 vez por mes | Campings, balnearios y playas de OpenStreetMap a menos de 5 m sobre un río (MERIT Hydro). Es la población temporaria del verano. |
| **Mapa de riesgo** (`scripts/armar_riesgo.py`) | a mano | Daños verificados con imágenes (2014–2016), tramos de río inestables y microcuencas prioritarias. |

El análisis que da origen a los umbrales y al mapa está en las notebooks de Colab (pasos 1 a 8): umbrales de lluvia, susceptibilidad por microcuenca, inventario satelital de daños, crecida del Paraná y monitor de estaciones.

### Reglas (provisorias)

- **Estaciones**: amarillo, naranja o rojo con 8/15/25 mm en 20 min, 15/30/50 mm en 1 h o 25/50/80 mm en 3 h, o con una subida del río de 0,25/0,5/1 m en 1 h. Una estación sin datos hace más de 2 h queda como "sin datos".
- **Pronóstico 48 h**: amarillo si un modelo supera el umbral de 3 h de la cuenca o un ensamble da ≥ 30 %; naranja si lo superan dos modelos o un ensamble da ≥ 60 %.
- **Suelo**: si el suelo está por encima del percentil 80 y algún modelo pronostica al menos la mitad del umbral, se sube un nivel.
- **Estado combinado**: por cuenca manda el peor entre estaciones y pronóstico.

## Estructura

```
alerta/
  config.py              cuencas, umbrales, modelos y rutas
  monitor_estaciones.py  lectura de la red de la Provincia (mismo código que el paso 8)
  boletin.py             pronóstico, suelo y perspectiva (mismo cálculo que el paso 4)
scripts/                 lo que corren los workflows
data/                    insumos copiados de Drive, inventario y historia del monitor
docs/                    la página (GitHub Pages) y docs/data/*.json que actualizan los workflows
.github/workflows/       monitor.yml (cada 15 min) y boletin.yml (cada 6 h)
```

## Puesta en marcha

### 1. Copiar los insumos desde Drive

Desde `inundaciones_cba/` en Drive, copiá a `data/` los que tengas (todo es opcional; si falta algo se usa un valor por defecto):

| Archivo | Lo genera | Si falta |
|---|---|---|
| `puntos_cuencas.json` | paso 4 | se pronostica solo en el punto de salida de cada cuenca |
| `umbrales_modelo.json` | paso 4 | se usan los umbrales de IMERG del paso 3 (sin calibrar por modelo) |
| `modelos_open_meteo.json` | paso 4 | GFS, ICON y ECMWF por defecto |
| `cuencas.geojson` | paso 4 | el suelo se promedia en un círculo de 10 km en la salida |
| `smap_normal_mesMM.json` | paso 4 | se calcula la primera vez (tarda unos minutos) |
| `susceptibilidad/tramos_rios.csv`, `susceptibilidad/microcuencas.csv` | paso 5 | el mapa muestra solo los daños confirmados |

Después de copiar los archivos del paso 5, corré `python scripts/armar_riesgo.py` y subí `docs/data/riesgo.geojson`.

### 2. Secretos del repositorio

En **Settings → Secrets and variables → Actions → New repository secret**:

| Secreto | Para qué | Cómo se consigue |
|---|---|---|
| `TELEGRAM_TOKEN` | avisos | hablale a @BotFather en Telegram, `/newbot`, y copiá el token |
| `TELEGRAM_CHAT_ID` | avisos | mandale un mensaje a tu bot y abrí `https://api.telegram.org/bot<TOKEN>/getUpdates`: el número de `chat.id` |
| `GCP_WIF_PROVIDER` | humedad del suelo (SMAP) | lo imprime `scripts/configurar_google.sh` (ver abajo) |
| `GCP_SERVICE_ACCOUNT` | idem | idem |
| `EE_PROJECT` | idem | |

Sin los secretos de Telegram los avisos solo se imprimen en el registro del workflow. Sin los de Google el boletín sale sin el dato de suelo.

**Acceso a Earth Engine sin clave.** GitHub Actions se autentica en Google con *Workload Identity Federation*: no hay ninguna clave guardada, y solo los workflows de este repositorio pueden usar la cuenta de servicio. Para configurarlo, abrí Google Cloud Shell (en console.cloud.google.com, el ícono `>_`), subí `scripts/configurar_google.sh` y corré `bash configurar_google.sh`. Al final imprime los valores de los tres secretos. Si la organización permitiera claves, también funciona pegar la clave JSON en `EE_SERVICE_ACCOUNT_JSON`.


### 3. Activar la página y los workflows

- **Settings → Pages**: *Deploy from a branch*, rama `main`, carpeta `/docs`. La página queda en `https://diegoesteve.github.io/predinun/`.
- **Settings → Actions → General → Workflow permissions**: *Read and write permissions* (los workflows guardan los JSON en el repo).
- En la pestaña **Actions**, corré cada workflow una vez con *Run workflow* para tener datos enseguida.

GitHub puede atrasar las corridas programadas varios minutos cuando hay mucha demanda, así que el monitor no es en tiempo real estricto. Si el repositorio pasa 60 días sin actividad, GitHub pausa los workflows programados y hay que reactivarlos desde Actions.

## Aportes de vecinos y visitantes

La pestaña **Aportá** recibe relatos de crecidas con hasta 3 fotos. El flujo es este:

1. La persona completa el formulario. Las fotos se achican en su teléfono y pierden los datos ocultos (GPS, modelo del teléfono). Un control antispam de Cloudflare (Turnstile) frena los envíos automáticos.
2. Un **Worker de Cloudflare** (`aportes/worker.js`) guarda el aporte en un depósito privado (R2) y avisa por Telegram.
3. En la **página de revisión**, que pide usuario y contraseña, se puede corregir el texto, elegir qué fotos publicar y aprobar o rechazar el aporte.
4. Al aprobar, el Worker publica `data/aportes/<id>.json` en este repositorio, y el boletín lo suma al mapa y a la ficha de la localidad. Al rechazar, se borran las fotos y el contacto.

**Privacidad:**
- El contacto (mail o teléfono, opcional) nunca se publica y queda solo en el depósito privado.
- Nada se ve en la página ni en el repositorio antes de aprobarse.
- Los relatos y fotos aprobados se publican con licencia CC BY-NC 4.0 (sin uso comercial), que la persona acepta al enviar.

### Puesta en marcha (una sola vez)

1. **Cuenta de Cloudflare:** creá una cuenta gratuita en dash.cloudflare.com.
   - En *Workers & Pages* elegí un subdominio `*.workers.dev` y copiá el **Account ID** que aparece a la derecha.
2. **R2:** activalo en el panel, en *R2 Object Storage*. Cloudflare pide un medio de pago para activarlo, aunque el uso de este proyecto queda dentro del plan gratuito (10 GB).
3. **Token de API:** en *My Profile → API Tokens → Create Token*, usá la plantilla **Edit Cloudflare Workers** y agregale el permiso *Account → Workers R2 Storage → Edit*.
4. **Turnstile:** en *Turnstile → Add widget*, poné el dominio `diegoesteve.github.io` en modo *Managed*. Te da una **Site Key** (pública) y una **Secret Key**.
5. **Token de GitHub para publicar los aportes aprobados:** en GitHub, *Settings → Developer settings → Fine-grained tokens → Generate new token*.
   - Repositorio: solo `diegoesteve/predinun`.
   - Permiso: *Contents → Read and write*.
   - Anotá en qué fecha vence, para renovarlo.
6. **Secretos del repositorio:** en *Settings → Secrets and variables → Actions*, cargá estos:

   | Secreto | Valor |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | el token del paso 3 |
   | `CLOUDFLARE_ACCOUNT_ID` | el Account ID del paso 1 |
   | `TURNSTILE_SECRET` | la Secret Key del paso 4 |
   | `GH_TOKEN_APORTES` | el token del paso 5 |
   | `REVISION_USUARIO` | el usuario para la página de revisión |
   | `REVISION_CLAVE` | una contraseña larga para la página de revisión |

   Los avisos de aportes nuevos usan `TELEGRAM_TOKEN` y `TELEGRAM_CHAT_ID`, los mismos del monitor.
7. **Desplegar:** en *Actions*, corré **Desplegar el receptor de aportes**. El registro muestra la dirección del Worker, por ejemplo `https://predinun-aportes.TU-SUBDOMINIO.workers.dev`.
8. **Activar el formulario:** en `docs/config.js`, completá `aportesUrl` con esa dirección y `turnstileSitekey` con la Site Key. Hasta que estén esos dos datos, el formulario se ve pero está desactivado.
9. **Revisar:** los aportes se revisan en `https://predinun-aportes.TU-SUBDOMINIO.workers.dev/revisar`.

## Correr en tu computadora

```bash
pip install -r requirements.txt
python scripts/correr_boletin.py      # docs/data/boletin.json
python scripts/correr_monitor.py      # docs/data/ahora.json y estaciones.json
python -m http.server -d docs         # abrir http://localhost:8000
```

`AVISAR=0` evita los mensajes de Telegram mientras probás.

## Fuentes de datos

- Red de estaciones hidrometeorológicas de la Provincia de Córdoba (servicios ArcGIS públicos).
- [Open-Meteo](https://open-meteo.com): pronósticos, ensambles y humedad del suelo de los modelos (CC BY 4.0).
- NASA SMAP L4 (`NASA/SMAP/SPL4SMGP`) vía Google Earth Engine.
- Inventario de daños: Sentinel-2, Landsat, Sentinel-1 y revisión con imágenes históricas de Google Earth.
- Límites urbanos, ríos y arroyos con nombre y puentes de las localidades serranas (`data/geoportal/`): GeoPortal de la Provincia de Córdoba (2008–2010), vía [OpenDataCordoba/mapas-de-cordoba](https://github.com/OpenDataCordoba/mapas-de-cordoba) (dominio público). Se extraen con `scripts/importar_geoportal.py`.
- Mapa base © colaboradores de OpenStreetMap.

## Licencia

Proyecto sin fines comerciales. El código tiene licencia [PolyForm Noncommercial 1.0.0](LICENSE) y los datos y textos
propios, [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.es): se pueden usar, modificar y compartir
para cualquier fin no comercial, pero no vender ni usar en productos o servicios pagos. Los datos de terceros
(OpenStreetMap, Open-Meteo, NASA, Copernicus, la Provincia) conservan su licencia. Detalle en [LICENCIAS.md](LICENCIAS.md).

## Pendiente

- Imágenes SAOCOM (CONAE), si se consiguen.
- Calibrar los umbrales de las estaciones con la historia que va juntando el monitor.
- Capa de población temporaria (campings, balnearios, eventos), que quedó expuesta en la crecida de Cosquín del 17/10/2026.
