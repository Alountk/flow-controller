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
