# Renombrar con el formato de Radarr, leyendo el archivo

La plantilla de Radarr se renderiza con datos del archivo (códec, audio, HDR, grupo). Sin leerlo, el nombre propuesto sale corto y con la resolución heredada del archivo 1080p de Radarr.

## Specs

S1. El nombre propuesto reproduce la plantilla de Radarr **rellenando la familia `{MediaInfo …}` y `{Release Group}`** con datos del archivo. «no me formatea el nombre del archivo como lo hace radarr».
S2. La lista se sondea **en lote**: ffprobe en paralelo y solo donde falta el dato. «Sondear la lista en lote (unos segundos)».
S3. La **resolución la manda el disco** (ffprobe); la **fuente/calidad** sale del nombre y, si no la declara, de Radarr.
S4. Nada se inventa: un token conocido sin dato no produce nombre, y el aviso **nombra el token** que faltó.
S5. La compuerta `reproduced_radarr` sigue mandando cuando Radarr tiene el archivo de esa película.
S6. Un archivo se sondea una vez: caché por `(ruta, mtime, tamaño)`.
S7. Verificación contra el caso real: la plantilla del usuario y el nombre que Radarr escribe. «Te paso la plantilla y un ejemplo».

## Tasks

| ID | Specs | Qué | Commit |
|---|---|---|---|
| T1 | S1, S3 | `backend/domain/media_info.py`: valores estilo Radarr desde ffprobe, calidad con la resolución del disco, grupo del nombre | `4f2c1` |
| T2 | S1, S4 | `naming.py`: tokens `{MediaInfo …}` y `{Release Group}`, `missing()` con los tokens sin dato | `4f2c1` |
| T3 | S3, S4 | `proposal` recibe `probe`; `arr_client` expone el `mediaInfo` propio de Radarr para que la compuerta siga valiendo | `4f2c1` |
| T4 | S2, S6 | `candidates()` sondea en paralelo con caché; medición sobre una biblioteca sintética | pendiente |
| T5 | S5, S7 | Compuerta, gates completos, comprobación con la plantilla real, PR | pendiente |

## Log

L1 (usuario): «aunque seleccione la pelicula, no me formatea el nombre del archivo como lo hace radarr, tal vez deberiamos hacer el formateo del nosotros con ffprobe y radarr y mixeando los datos?»

L2 (usuario, decidido): «Sondear la lista en lote (unos segundos)» — la lista paga el ffprobe, en paralelo y solo donde falta el dato.

L3 (decidido): la compuerta `reproduced_radarr` se re-renderiza con el `mediaInfo` **de Radarr**, no con el de nuestra copia; mezclar los dos archivos haría fallar toda comparación y apagaría el nombrado.

L4: `probe` es inyectable para que el dominio no dependa de ffprobe ni de un proceso externo en los tests.

## Plantilla real (S7, verbatim del usuario)

```
archivo: {Movie Title} ({Release Year}) {Quality Title} - {MediaInfo Simple} - {MediaInfo AudioLanguages}
carpeta: {Movie Title} ({Release Year})
```

Lo que enseñó:

- **`{Quality Title}` no era un token conocido**, y un token desconocido no acorta el nombre: `evaluate` devuelve `None` y no hay propuesta. Con la plantilla anterior, elegir película a mano no servía de nada. Añadidos `Quality Title` y `Quality Name` (Radarr escribe lo mismo que `Quality` / `Quality Full`).
- **La resolución se estaba leyendo de la calidad declarada**, no del disco: `Remux-1080p` para un remux 2160p porque Radarr guarda el archivo 1080p de esa película. Ahora la fuente se declara (nombre o calidad) y los píxeles se miden.
- **`WEB-DL` lleva un guion**: partir la cadena por `-` para buscar la fuente escondía el token. Solo se parte cuando la cadena ya es una calidad (`Bluray-1080p`).

Render verificado con la plantilla real:

```
The Batman (2022) Remux-2160p - x265 10bit HDR DTS-HD MA 5.1 - en/es
Alien (1979) Bluary-1080p - x264 8bit AC3 5.1 - en
```

## El nombre real de la instancia (S7, cerrado)

```
(2012) Bluray-1080p - h265 AC3 - [ES+EN+RU].mkv
```

Contrastado con el **código fuente de Radarr** (`FileNameBuilder.cs` y `MediaInfoFormatter.cs`), no con una idea de cómo se ve un nombre:

| Token | Regla real | Lo que yo tenía |
|---|---|---|
| `{MediaInfo Simple}` | `"{VideoCodec} {AudioCodec}"` — nada más | códec + bit depth + HDR + canales |
| `{MediaInfo AudioLanguages}` | `[ES+EN+RU]`: mayúsculas, `+`, corchetes; **vacío si solo hay inglés** | `en/es` |
| `{MediaInfo VideoCodec}` | `hevc` → busca `HEVC`/`x265`/`h265` **en el nombre del release**, por defecto `h265` | siempre `x265` |
| `{MediaInfo AudioChannels}` | un decimal, de las posiciones de canal si existen | tabla fija 6→5.1 |
| `{MediaInfo VideoDynamicRange}` | `HDR` o **vacío** para SDR | `SDR` |
| `{MediaInfo VideoBitDepth}` | entero, `8` por defecto | vacío si no se sabía |
| `{Quality Title}` | la calidad sin banderas: `Bluray-1080p` | token desconocido → sin nombre |
| `{Release Group}` | el del archivo, o `Radarr` si falta | vacío |

Consecuencias de diseño:

- **Un token medido vacío se rinde vacío, no rompe el render.** Radarr escribe nombres que terminan en `- ` cuando el audio es solo inglés; negarse dejaba la plantilla inservible para media biblioteca. La compuerta sigue siendo la que decide: si nuestro hueco no coincide con el nombre de Radarr, no hay nombre.
- **La compuerta es lo que impide proponer un nombre con agujeros**: `proposal` se niega a renderizar una plantilla medida si no pudo sondear la copia, porque la compuerta compara el archivo de Radarr y no el nuestro y pasaría igual.
- El grupo vacío se queda vacío aunque Radarr escriba `Radarr`: escribir esa palabra sería inventar un dato.
- `media_mixer.parse_probe_data` gana `profile` en las pistas de audio (+3 líneas legacy, `MAX_LEGACY_LOC` 3463 → 3466, declarado en el PR): sin el perfil, `DTS-HD MA` se leería como `DTS`.
