import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatSize, useBrowse } from '../hooks/useFilesNavigator.ts'
import { apiFetch } from '../api/auth.ts'
import { errorMessage } from '../utils/text.ts'
import { classifyFile, type FileSectionId, type RoutingFolders } from '../utils/fileSections.ts'
import { probeFile, probeCached, probeHeight, type ProbeFile, type ProbeFileResult } from '../api/probe.ts'
import { probeSpec } from '../utils/probePreview.ts'
import type { BrowseResponse, FileItem } from '../types.ts'

/** What the Archivos tab reads of each page's RowFacts — pages pass theirs. */
export type PanelFilesFacts =
  | { state: 'empty' }
  | { state: 'missing' }
  | { state: 'ready'; path: string | null }

// Also rendered by the Historial and Episodios panels — the one copy.
export const ROW_MISSING = 'No se pudo leer la fila seleccionada.'

/** The Archivos tab: the selected row's folder, read-only by construction —
 *  rename/delete/copy live in the Archivos PAGE (retired later, not here).
 *  Pages that pass `routing` get T3's four sections (1080/4K/3D/Otros); the
 *  flat listing is the default so Series' tab stays byte-identical. */
export function PanelFiles({
  facts,
  folders,
}: {
  facts: PanelFilesFacts
  folders?: RoutingFolders
}) {
  if (facts.state === 'empty') return null
  if (facts.state === 'missing') return <p className="sec-tab-note">{ROW_MISSING}</p>
  if (!facts.path) return <p className="sec-tab-note">Esta entrada no tiene ruta</p>
  return folders ? (
    <FilesSections basePath={facts.path} folders={folders} />
  ) : (
    <FilesList path={facts.path} />
  )
}

function FilesList({ path }: { path: string }) {
  const query = useBrowse(path, true)
  if (query.isPending) return <p className="sec-tab-note">Cargando ruta…</p>
  if (query.isError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la ruta</strong>
        <span>{errorMessage(query.error)}</span>
      </div>
    )
  }
  // browsePath answers failures on the body ("No es un directorio", FastAPI's
  // `detail`) — neither may render as an empty listing.
  const data = query.data as BrowseResponse & { detail?: string }
  const failure = data.error ?? data.detail
  if (!data.ok) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la ruta</strong>
        <span>{failure ?? 'respuesta inesperada del servidor'}</span>
      </div>
    )
  }
  if (data.items.length === 0) return <p className="sec-tab-note">Esta carpeta está vacía</p>
  return <FilesTable items={data.items} />
}

/** The listing table the navigator family renders — one copy for the flat
 *  tab and for every section. Sections pass `actions` (T4's «Analizar»); the
 *  flat tab passes nothing and gains no column. */
function FilesTable({ items, actions, chips }: { items: FileItem[]; actions?: (item: FileItem) => ReactNode; chips?: (item: FileItem) => ReactNode }) {
  return (
    <table className="sec-table sec-files-table">
      <thead>
        <tr>
          <th scope="col">Nombre</th>
          <th scope="col">Tamaño</th>
          <th scope="col">Modificado</th>
          {actions && <th scope="col">Analizar</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.path}>
            <td className="sec-file-name" title={item.path}>
              {item.name}
              {chips?.(item)}
            </td>
            <td>{item.is_dir ? '—' : formatSize(item.size)}</td>
            <td>{new Date(item.modified * 1000).toLocaleDateString('es-ES')}</td>
            {actions && <td>{actions(item)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const SECTIONS: Array<{ id: FileSectionId; label: string; specClass: string }> = [
  { id: '1080', label: '1080', specClass: '1080p' },
  { id: '4k', label: '4K', specClass: '4K' },
  { id: '3d', label: '3D', specClass: '3D' },
  { id: 'otros', label: 'Otros', specClass: 'Otros' },
]

/** The movie's folder name: its copies keep it at the FRONT of theirs (the
 *  same prefix rule ReleaseSearchModal's holdsCopy uses). No name, no proof. */
function copyPrefixOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

async function browseFolder(folder: string): Promise<FileItem[]> {
  // Same read as ReleaseSearchModal's feature-local fetchRoutingListing: a
  // failure throws so the UI shows an error, never "the folder is empty".
  const res = await apiFetch(`/api/files/browse?path=${encodeURIComponent(folder)}`, {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as BrowseResponse
  if (!body.ok || !Array.isArray(body.items)) throw new Error(body.error || `HTTP ${res.status}`)
  return body.items
}

/** The movie's copies in ONE routing folder: top-level prefix matches plus
 *  the files inside a matched copy directory (the nested layout
 *  `path_4k/<folder>/<file>`) — ONE level down, never a recursive crawl. */
async function fetchRoutingCopies(folder: string, prefix: string): Promise<FileItem[]> {
  const top = await browseFolder(folder)
  if (prefix === '') return []
  const copies: FileItem[] = []
  for (const entry of top.filter((item) => item.name.startsWith(prefix))) {
    if (entry.is_dir) copies.push(...(await browseFolder(entry.path)))
    else copies.push(entry)
  }
  return copies
}

/** T3 (S1/S4): the three locations as ONE list, split into four sections. */
function FilesSections({ basePath, folders }: { basePath: string; folders: RoutingFolders }) {
  const base = useBrowse(basePath, true)
  const prefix = copyPrefixOf(basePath)
  const staleTime = 0 // A listing must mirror the disk — see useBrowse.
  const r4k = useQuery({
    queryKey: ['routing-copies', folders.path4k, prefix],
    queryFn: () => fetchRoutingCopies(folders.path4k, prefix),
    enabled: !!folders.path4k,
    staleTime,
  })
  const r3d = useQuery({
    queryKey: ['routing-copies', folders.path3d, prefix],
    queryFn: () => fetchRoutingCopies(folders.path3d, prefix),
    enabled: !!folders.path3d,
    staleTime,
  })

  if (base.isLoading || r4k.isLoading || r3d.isLoading) {
    return <p className="sec-tab-note">Cargando ruta…</p>
  }
  if (base.isError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la ruta</strong>
        <span>{errorMessage(base.error)}</span>
      </div>
    )
  }
  const data = base.data as BrowseResponse & { detail?: string }
  if (!data.ok) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la ruta</strong>
        <span>{data.error ?? data.detail ?? 'respuesta inesperada del servidor'}</span>
      </div>
    )
  }

  // A FAILED routing read may never show as an empty section: the alert says
  // which source could not answer, and no note claims "there are no copies".
  const routingFailed = r4k.isError || r3d.isError
  const entries = [...data.items, ...(r4k.data ?? []), ...(r3d.data ?? [])]

  return (
    <>
      {r4k.isError && (
        <div className="wanted-error" role="alert">
          <strong>No se pudo leer la ruta</strong>
          <span>
            {folders.path4k}: {errorMessage(r4k.error)}
          </span>
        </div>
      )}
      {r3d.isError && (
        <div className="wanted-error" role="alert">
          <strong>No se pudo leer la ruta</strong>
          <span>
            {folders.path3d}: {errorMessage(r3d.error)}
          </span>
        </div>
      )}
      {SECTIONS.map((section) => {
        const items = entries.filter((entry) => classifyFile(entry, folders, basePath) === section.id)
        return (
          <FilesSection
            key={section.id}
            section={section}
            items={items}
            routingFailed={routingFailed}
          />
        )
      })}
    </>
  )
}

/** ffprobe can only read actual videos — dirs and sidecars prove nothing (T4). */
const isAnalyzable = (item: FileItem) => !item.is_dir && item.is_video !== false

/** S2: the honest low-quality marker, shown only after a real measurement. */
const QUALITY_CHIP = 'Baja calidad'

/** One section with its own on-demand probe state (S2: nothing runs alone;
 *  T4: no global state, no cache — a re-click re-probes). */
function FilesSection({
  section,
  items,
  routingFailed,
}: {
  section: { label: string; specClass: string }
  items: FileItem[]
  routingFailed: boolean
}) {
  const [probes, setProbes] = useState<Record<string, ProbeFileResult>>({})
  const [runningFiles, setRunningFiles] = useState<Set<string>>(() => new Set())
  const [sectionRunning, setSectionRunning] = useState(false)

  const store = (path: string, result: ProbeFileResult) =>
    setProbes((prev) => ({ ...prev, [path]: result }))

  const analyzeFile = (item: FileItem) => {
    // S4: a fresh persisted probe answers instantly — a click never re-probes
    // what the cache already knows.
    if (probes[item.path]?.ok) return
    setRunningFiles((prev) => new Set(prev).add(item.path))
    // probeFile never rejects — no try/catch needed to leave the button state.
    probeFile(item.path).then((result) => {
      store(item.path, result)
      setRunningFiles((prev) => {
        const next = new Set(prev)
        next.delete(item.path)
        return next
      })
    })
  }

  const analyzeSection = () => {
    setSectionRunning(true)
    Promise.all(
      items.filter(isAnalyzable).map((item) => probeFile(item.path).then((r) => store(item.path, r))),
    ).then(() => setSectionRunning(false))
  }

  const analyzable = items.filter(isAnalyzable)

  // T4 (S2): chips read the PERSISTED probes, so rendering never runs ffprobe
  // — one cache read per section, and only for files nobody analyzed here.
  const sectionPaths = items.map((item) => item.path).join('|')
  useEffect(() => {
    const paths = items.filter(isAnalyzable).map((item) => item.path).filter(Boolean)
    if (paths.length === 0) return
    let live = true
    probeCached(paths).then((cached) => {
      if (!live) return
      setProbes((prev) => {
        const next = { ...prev }
        for (const [path, probe] of Object.entries(cached)) {
          if (probe && !next[path]) next[path] = { ok: true, probe }
        }
        return next
      })
    })
    return () => {
      live = false
    }
    // `sectionPaths` is the identity that matters: `items` is a fresh array.
  }, [sectionPaths])

  /** S2: only a MEASURED height below 1080 earns the chip — never a guess. */
  const qualityChip = (item: FileItem) => {
    const result = probes[item.path]
    if (!result?.ok) return null
    const height = probeHeight(result.probe)
    if (!height || height >= 1080) return null
    return <span className="sec-quality-chip">{QUALITY_CHIP}</span>
  }

  return (
    <section className="sec-files-section">
      <h4>{section.label}</h4>
      {analyzable.length > 0 && (
        <p className="sec-analyze-row">
          <button
            type="button"
            className="sec-analyze"
            aria-label={`Analizar sección ${section.label}`}
            disabled={sectionRunning}
            onClick={analyzeSection}
          >
            Analizar
          </button>
          {sectionRunning && <span className="sec-analyze-running">Ejecutando ffprobe…</span>}
        </p>
      )}
      {items.length === 0 ? (
        routingFailed ? null : <p className="sec-tab-note">Sin archivos en esta sección</p>
      ) : (
        <FilesTable
          items={items}
          chips={qualityChip}
          actions={(item) =>
            isAnalyzable(item) ? (
              <>
                <button
                  type="button"
                  className="sec-analyze"
                  aria-label={`Analizar ${item.name}`}
                  disabled={sectionRunning || runningFiles.has(item.path)}
                  onClick={() => analyzeFile(item)}
                >
                  Analizar
                </button>
                {runningFiles.has(item.path) && (
                  <span className="sec-analyze-running">Ejecutando ffprobe…</span>
                )}
              </>
            ) : null
          }
        />
      )}
      {analyzable.map((item) => {
        const result = probes[item.path]
        if (!result) return null
        return result.ok ? (
          <SpecBlock key={item.path} probe={result.probe} specClass={section.specClass} />
        ) : (
          <div key={item.path} className="wanted-error" role="alert">
            <strong>No se pudo analizar</strong>
            <span>
              {item.name}: {result.detail}
            </span>
          </div>
        )
      })}
    </section>
  )
}

/** The S3 spec block, verbatim — lines from probePreview, header local. */
function SpecBlock({ probe, specClass }: { probe: ProbeFile; specClass: string }) {
  const spec = probeSpec(probe)
  return (
    <div className="sec-probe-spec">
      <p>
        <strong>{specClass}</strong> · <code>{probe.filename}</code>
      </p>
      <p>{spec.specs}</p>
      {spec.audio.map((line, i) => (
        <p key={probe.audio_tracks[i].index}>{line}</p>
      ))}
      {spec.subtitles && <p>{spec.subtitles}</p>}
      <p>{spec.footer}</p>
    </div>
  )
}
