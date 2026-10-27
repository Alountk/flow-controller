# file-navigator — F1 piloto: núcleo compartido + FileNavigator, migrando el picker «Carpeta»

Refactor read-only analysis → diseño (Stitch) → implementación por fases F1-F4.
Base de diseño: proyecto Stitch `15633374431171084630` (design system `assets/8d4b7d64e33546fe99ed5560c18fd65f`),
4 pantallas (navegador base, page Archivos, destino compacto, escaneo). Análisis completo: Engram 1482.

## Specs

S1 — Petición verbatim (análisis): «analiza los modals de archivos si podemos reutilizar los mismos, porque veo que se implementa algo diferente para cada uno, tal vez el más completo es el de media mixer.»
S2 — Petición verbatim (diseño): «Habla con Stitch y basandose en el de media mixer que proponga un diseño para todas estas partes que pueda reutilizar. Si se puede reutilizar tambien en archivos para aprovechar estaria bien. Echale un vistazo.»
S3 — Entregable del análisis (hecho): 6 superficies mapeadas; 8 duplicidades (`formatSize` 8× pese a `formatBytes` en `shared/utils/text.ts:40`, `parentDir` 3×, state machine volumen+path 3×, 5 query keys para `/api/files/browse` con staleTime inconsistente 0 vs default, filtro+empty-state 2×, Escape 3×, role-filter sólo FileManager, `apiFetch` duplicado en `ReleaseSearchModal:187`); richest modal = FilePicker del mixer (`pages/MediaMixer.tsx:197-422`), richest global = FileManager.
S4 — Alcance F1 (decisión usuario «F1 piloto»): «Núcleo (hooks + helpers) y migra SOLO el picker «Carpeta» recién creado como primer consumidor — validación con sus 8 tests existentes; luego decides F2+». F1 = módulo compartido de navegación (`useBrowse`/`useRoots` con query key único `['files-browse', path]` y política staleTime 0, `parentDir`) + componente presentacional `FileNavigator` (modo `folder` en F1) + migración del picker de `ReleaseSearchModal` a ese componente. `formatBytes` queda en el módulo aunque F1 no lo consuma (sin archivos en modo folder).
S5 — UX que F1 añade al picker (diseño Stitch, variante «Elegir carpeta de destino»): botón «⬆ Subir» (cadena de padres; en la cima de una raíz vuelve a la vista de raíces `''`), barra breadcrumb display-only (segments del path; el clic es F2), sin filtro y sin selector «Origen» en F1. Se conservan EXACTO: `.folder-picker`/`.folder-picker-backdrop`/`.folder-picker-path` (texto = path completo), raíces con nombre accesible, sólo directorios, «Elegir esta carpeta» disabled en vista raíces, «Cancelar», memoria de sesión (reabrir en la última carpeta), Escape en capas (navegador antes que diálogo), `destination` en el grab sin `library`, rechazo «Destino no permitido» visible.
S6 — Superficies PROHIBIDAS en F1 (quedan para F2+): `ScanModal.tsx`, `MediaMixer.tsx` FilePicker, `FileManager.tsx`, `Peliculas.tsx`/`Series.tsx` tabs, y el resto de `ReleaseSearchModal.tsx` fuera del bloque picker. Cero cambios de comportamiento en ellas: la suite completa (784 + los tests nuevos) debe quedar en verde, `tsc` 0, `eslint` 0.
S7 — Tests: los 8 de `folderDestination.test.tsx` quedan SIN tocar aserciones. RED nuevo mínimo: «⬆ Subir» visible en picker y navega al padre (`/mnt/storage-6tb/peliculas` → `/mnt/storage-6tb`), breadcrumb muestra segmentos (`storage-6tb` y `peliculas`), y «Subir» en la raíz vuelve a la vista de orígenes.

## Tasks

T1 — Tests RED de S7 en `folderDestination.test.tsx` (padre) — commit `6bf4b57`
T2 — Módulo `shared` (useBrowse/useRoots/parentDir/formatBytes) + componente `FileNavigator` modo folder (worker) — commit `6bf4b57`
T3 — Migración del picker de `ReleaseSearchModal` al componente (worker, mismas superficies) — commit `6bf4b57`
T4 — Gates (focused 11, full 787/0, tsc 0, eslint 0, build OK — todos ejecutados por el padre) + assess — commit `6bf4b57`; entrega pendiente de visto

## Log

L1 — «analiza los modals de archivos si podemos reutilizar los mismos, porque veo que se implementa algo diferente para cada uno, tal vez el más completo es el de media mixer. Habla con Stitch y basandose en el de media mixer que proponga un diseño para todas estas partes que pueda reutilizar. Si se puede reutilizar tambien en archivos para aprovechar estaria bien. Echale un vistazo.»
L2 — Ask producto (2026-10-27): respuesta «F1 piloto» (núcleo + sólo picker «Carpeta»; F2+ se decide después). Stitch entregó 4 pantallas en proyecto `15633374431171084630`; quirk: `list_screens` devuelve `{}` (ir por `get_screen` con id), `generate_variants` no fiable → `generate_screen_from_text` ×3.
L3 — Slice boundary: work-unit único de 585 líneas autorizadas (413/172) en commit `6bf4b57` — módulo + componente + su primer consumidor + tests es UNA unidad de comportamiento indivisible (los tests RED ya referenciaban el componente). Estrategia de entrega: single PR con divulgación del slice en el cuerpo (patrón aceptado en #243/#244).
