import { useEffect, useState } from 'react'
import { renameApply, renamePreview, type RenameProposal } from '../../shared/api/files.ts'
import './LibraryRenameDialog.css'

interface Props {
  /** Absolute path of the video the user picked in the explorer. */
  path: string
  onClose: () => void
  /** Called with the backend's own words after a rename that moved something. */
  onRenamed: (detail: string) => void
}

/**
 * The dialog for renaming a 4K/3D copy the way Radarr would.
 *
 * Everything it shows is a suggestion from the backend, and both fields are
 * editable because the proposal is only as good as the movie it identified: a
 * pattern that could not be reproduced arrives as a warning, not as a name.
 */
export function LibraryRenameDialog({ path, onClose, onRenamed }: Props) {
  const [proposal, setProposal] = useState<RenameProposal | null>(null)
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      const got = await renameApply({ remote_path: path, folder, name })
      if (got.ok) {
        onRenamed(got.detail)
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
        <p className="fm-rename-subject" title={path}>
          {movie?.title ? `${movie.title}${movie.year ? ` (${movie.year})` : ''}` : 'Película sin identificar'}
        </p>

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
