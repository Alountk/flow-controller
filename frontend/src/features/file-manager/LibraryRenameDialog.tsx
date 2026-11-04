import { useEffect, useState } from 'react'
import {
  renameApply,
  renameMovies,
  renamePreview,
  type RenameMovie,
  type RenameProposal,
} from '../../shared/api/files.ts'
import './LibraryRenameDialog.css'

interface Props {
  /** Absolute path of the video the user picked in the explorer. */
  path: string
  onClose: () => void
  /** Called with the backend's own words after a rename that moved something. */
  onRenamed: (detail: string) => void
  /** Who asked: the batch page, or one file the operator picked by hand. */
  origin?: 'lote' | 'a mano'
}

/**
 * The dialog for renaming a copy the way Radarr would — a 4K/3D one, or any file
 * the operator picked in the explorer whose movie the backend can identify.
 *
 * Everything it shows is a suggestion from the backend, and both fields are
 * editable because the proposal is only as good as the movie it identified: a
 * pattern that could not be reproduced arrives as a warning, not as a name.
 */
export function LibraryRenameDialog({ path, onClose, onRenamed, origin = 'lote' }: Props) {
  const [proposal, setProposal] = useState<RenameProposal | null>(null)
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<RenameMovie[]>([])

  useEffect(() => {
    let live = true
    renamePreview(path)
      .then((got) => {
        if (!live) return
        setProposal(got)
        setFolder(got.folder ?? '')
        setName(got.name ?? '')
        if (!got.ok) setError(got.detail || 'No se pudo preparar el renombrado')
      })
      .catch(() => {
        if (live) setError('No se pudo preparar el renombrado')
      })
    return () => {
      live = false
    }
  }, [path])

  // The catalog is searched only once the person opens the picker: most copies
  // are identified, and a Radarr round trip on every dialog would be waste.
  useEffect(() => {
    if (!picking || query.trim().length < 2) {
      setFound([])
      return
    }
    let live = true
    const timer = window.setTimeout(() => {
      renameMovies(query)
        .then((got) => {
          if (live) setFound(got.items ?? [])
        })
        .catch(() => {
          if (live) setFound([])
        })
    }, 250)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [picking, query])

  async function pick(movie: RenameMovie) {
    setPicking(false)
    setQuery('')
    setError(null)
    try {
      // Re-derive the plan for the film the person chose: the folder comes from
      // Radarr's own path and the name from its template, not from the guess.
      const got = await renamePreview(path, movie.id)
      setProposal(got)
      setFolder(got.folder ?? '')
      setName(got.name ?? '')
      if (!got.ok) setError(got.detail || 'No se pudo preparar el renombrado')
    } catch {
      setError('No se pudo preparar el renombrado')
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const got = await renameApply({
        remote_path: path,
        folder,
        name,
        origin,
        movie_id: proposal?.movie?.id ?? 0,
      })
      if (got.ok) {
        // Radarr knows the file by its path: a rename it never heard about
        // leaves the movie "missing" and the file orphaned, so the failure
        // travels WITH the success instead of being swallowed.
        const late =
          got.rescan && !got.rescan.ok
            ? `Renombrado, pero Radarr no confirmó el rescan: ${got.rescan.detail}`
            : ''
        onRenamed(late || got.detail || 'Renombrado')
        onClose()
        return
      }
      setError(got.detail || 'No se pudo renombrar')
    } catch {
      setError('No se pudo renombrar')
    } finally {
      setBusy(false)
    }
  }

  const loose = proposal?.loose === true
  const sidecars = proposal?.sidecars ?? []
  const warnings = proposal?.warnings ?? []
  const extension = proposal?.extension ?? ''
  const movie = proposal?.movie

  return (
    <div className="fm-rename-backdrop" onClick={onClose}>
      <div
        className="fm-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Renombrar como Radarr"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="fm-rename-title">Renombrar como Radarr</h3>
        <div className="fm-rename-movie">
          <span className="fm-rename-subject" title={path}>
            {movie?.title
              ? `${movie.title}${movie.year ? ` (${movie.year})` : ''}`
              : 'Película sin identificar'}
          </span>
          <button
            type="button"
            className="fm-btn"
            onClick={() => {
              setPicking((open) => !open)
              setQuery('')
            }}
            disabled={busy}
          >
            {picking ? 'Cancelar búsqueda' : 'Elegir película'}
          </button>
        </div>

        {picking && (
          <div className="fm-rename-picker">
            <label className="fm-rename-field">
              <span>Buscar en Radarr</span>
              <input
                aria-label="Buscar película"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={busy}
                placeholder="Título o título y año"
                autoFocus
              />
            </label>
            {query.trim().length >= 2 && found.length === 0 && (
              <p className="fm-rename-hint">Ninguna película del catálogo coincide</p>
            )}
            {found.length > 0 && (
              <ul className="fm-rename-results">
                {found.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      className="fm-rename-result"
                      onClick={() => pick(option)}
                      disabled={busy}
                    >
                      <span>{option.title}</span>
                      <span className="fm-rename-result-year">{option.year ?? ''}</span>
                      <span className="fm-rename-result-folder">{option.folder}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {loose && (
          <label className="fm-rename-field">
            <span>Carpeta</span>
            <input
              aria-label="Carpeta"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={busy}
              placeholder="Título (Año)"
            />
          </label>
        )}

        <label className="fm-rename-field">
          <span>Nombre</span>
          <input
            aria-label="Nombre del archivo"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <p className="fm-rename-hint">
          {folder ? `${folder}/` : ''}
          {name}
          {extension}
        </p>

        {sidecars.length > 0 && (
          <p className="fm-rename-sidecars">
            También se renombran: {sidecars.map((s) => s.from).join(', ')}
          </p>
        )}

        {warnings.length > 0 && (
          <ul className="fm-rename-warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        {error && <p className="fm-rename-error" role="alert">{error}</p>}

        <div className="fm-rename-actions">
          <button className="fm-btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="fm-btn accent" onClick={apply} disabled={busy || !proposal?.ok || !name}>
            {busy ? 'Renombrando…' : 'Aplicar'}
          </button>
        </div>
      </div>
    </div>
  )
}
