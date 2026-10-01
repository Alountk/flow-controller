# Renombrar al llegar (F-01, etapa 6) — carpetas 4K/3D

## Objetivo

Que un fichero que aterriza en `paths.path_4k` / `paths.path_3d` lleve **el nombre que Radarr
habría puesto**, en lugar del nombre que hoy construimos a mano.

## Alcance (decidido por el usuario)

**Solo las carpetas 4K/3D.** NO se toca el rename de biblioteca (`RenameMovie` cuando
`renamed_needed`) — Radarr ya renombra lo que es suyo.

## El hecho que lo condiciona todo

**Radarr solo renombra ficheros que posee.** `GET /api/v3/rename`, `RenameMovie` y
`RenameFiles` operan sobre la biblioteca. Un fichero en `path_4k` **está fuera de sus raíces**:
Radarr no lo ve, no da `newPath`, no lo renombra. Y **no expone** un endpoint *"dime cómo se
llamaría este fichero"*.

Lo único que entrega es su **plantilla**: `GET /api/v3/config/naming` →
`standardMovieFormat` + `movieFolderFormat`. → **Tenemos que evaluarla nosotros.**

## Qué sí nos da Radarr sin evaluar nada

| Dato | Endpoint | Nota |
|---|---|---|
| **Carpeta** | `movie.folderName` en `GET /api/v3/movie/{id}` | Ya viene **evaluada** por Radarr. Cero riesgo. |
| **Plantilla de fichero** | `GET /api/v3/config/naming` | Hay que evaluarla. |
| **Referencia para validar** | `GET /api/v3/moviefile?movieId=` → `relativePath` | Lo que Radarr calculó **él mismo** para el fichero que ya existe. |

## La decisión de seguridad: **autocomprobación**

Evaluar un patrón ajeno es donde se puede escribir un nombre **equivocado con toda la
confianza**. Así que la regla es:

1. Evaluar `standardMovieFormat` para el fichero **que ya existe** (su calidad) → `computed`.
2. Comparar con `relativePath` que Radarr calculó **él mismo**.
3. **Iguales** → nuestro evaluador reproduce a Radarr *en este despliegue* → evaluar otra vez
   con la calidad **nueva** y usarlo.
4. **Distintos / sin referencia / token desconocido** → **no renombrar**, nombre de hoy, y
   decir por qué en el detalle de la tarea.

Un patrón con `{MEDIAINFO VIDEOCODEC}` o `{Release Group}` que no sepamos evaluar **no va a
coincidir**, y ahí fallamos cerrados en vez de escribir algo que Radarr no habría escrito.

### Tokens a soportar (acotado, a propósito)

`{Movie Title}` `{Movie CleanTitle}` `{Title}` `{Title The}` `{Original Title}`
`{Release Year}` `{Movie Year}` `{Quality Full}` `{Quality}` `{Quality-Short}`
`{Quality Title}` `{Edition Tags}` · grupos opcionales `{[...]}` → se omiten si algo dentro
es desconocido. **Todo lo demás → fallar cerrado.**

## El hueco de datos: la calidad no está en ningún sitio

Verificado con grep: **ni en `traces.py`, ni en `history.py` (`own_grabs`), ni en el payload
de copia.** Y `CalendarGrabRequest.quality` **ya llega** al backend — solo que lo tiramos
tras usarlo para enrutar.

→ Guardarlo: columna `own_grabs.quality` (migración) + pasarlo al payload en `_dispatch`.

## Reparto

| PR | Contenido | Por qué va solo |
|----|-----------|-----------------|
| **1** | **Plumbing de calidad**: migración v7→v8 (`own_grabs.quality`), se guarda en `record_own_grab`, viaja al payload de copia | Independientemente útil (qué calidad se descargó en cada grab) y es prerequisito. Sin él, PR 2 no puede evaluar `{Quality Full}` |
| **2** | **Evaluador**: `clients.arr_naming_config` + `arr_movie_files`, módulo `naming.py` (evaluar + autocomprobar), integración en la rama ajena de `copy_engine` | Es toda la lógica; depende de 1 |

## Aceptación

- [ ] Patrón **por defecto** de Radarr + fichero existente de referencia → el 4K aterriza como
      `path_4k/<carpeta de Radarr>/<fichero con la calidad nueva>`.
- [ ] Patrón con token desconocido → **nombre de hoy** y el detalle explica por qué.
- [ ] Sin fichero de referencia (no está en la biblioteca) → **nombre de hoy**.
- [ ] La autocomprobación **no coincide** → **nombre de hoy**, nunca un nombre inventado.
- [ ] Sin `dest_root` (biblioteca) → **cero cambios**: Radarr importa y renombra él.

## Checks

```
cd backend && python -m pytest -q
cd backend && python -m pytest tests_static.py -q
```

## Riesgos

- 🟠 **Escribir un nombre equivocado con confianza** es exactamente lo que la
  autocomprobación existe para evitar. No la toques para "que funcione más seguido".
- 🟠 Migración de `own_grabs`: el repo ya tiene migraciones v6→v7 y v7→v8 con tests — sigue
  ese patrón, no inventes otro.
- ⬜ Si el patrón del usuario es TRaSH completo, **fallará cerrado casi siempre**. Es
  correcto (no podemos evaluar MediaInfo), pero hay que decirlo claro, no venderlo como
  "funciona siempre".
