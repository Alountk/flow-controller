import { useState, type ReactNode } from 'react'
import type { RowWiring } from '../types.ts'

/* ── Section rows (PR 5 of F-08) ───────────────────────────────────────────
 * The chosen prototypes (peliculas-02 / series-04) draw a dense row: a
 * CSS-drawn mini-poster, title + year, a status pill, a quality chip and the
 * path. These build exactly that — and only claims the row's own data can
 * back: a status the listing does not carry is never invented ("Descargando"
 * and "Colocado" appear only when some field says so, and none does; a grab
 * keeps its own honest mark instead).
 */

export type PillTone = 'ok' | 'warn' | 'bad'

/** Initials for the mini-poster: first letter of the first two words (one
 *  word → its first two letters). The row's fallback: drawn when the data
 *  carries no poster (or the poster URL fails to load). */
function posterInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}

/** A stable hue per title, so two rows never share a gradient by accident. */
function posterHue(title: string): number {
  let hue = 0
  for (let i = 0; i < title.length; i++) hue = (hue * 31 + title.charCodeAt(i)) % 360
  return hue
}

/** A row of the missing queue: it is missing, whatever a grab has done. */
export function faltaStatus(): { label: string; tone: PillTone } {
  return { label: 'Falta', tone: 'warn' }
}

/** A row of the catalogue, from the same two facts the panel reports. */
export function catalogRowStatus(
  hasFile: boolean,
  pathExists: boolean,
  hasUnimportedFile = false,
): { label: string; tone: PillTone } {
  if (hasFile && pathExists) return { label: 'En biblioteca', tone: 'ok' }
  if (!hasFile) {
    // Same two claims as `catalogState`: only the unimported label is backed
    // by a folder listing that SAW a video. Files on disk are not a failure —
    // `warn`, the stylesheet's own third tone, never `bad`.
    if (hasUnimportedFile) return { label: 'Carpetas con vídeo · sin importar', tone: 'warn' }
    return { label: 'Sin archivo', tone: 'bad' }
  }
  return { label: 'Ruta no encontrada', tone: 'bad' }
}

interface SectionRowProps {
  /** The row's own classes: wanted-card|wanted-row + is-selectable. The
   *  wanted-* class is what every existing query and style keys on. */
  className: string
  /** Selection wiring from `rowProps` — `{}` when nothing selects. */
  wiring: RowWiring
  title: string
  year?: number | null
  status: { label: string; tone: PillTone }
  /** The row's real poster, when the data carries one. Empty/absent keeps
   *  the initials gradient; a URL that fails to load falls back to it too. */
  poster?: string
  /** The quality/class chip, when the row's data carries one (the Calidad
   *  view keeps its own class badge on top of this). */
  chip?: string
  path?: string
  grabbed?: string | null
  grabbedDestination?: string | null
  /** The rest of the second line: episode code + title + date, counts… */
  extra?: ReactNode
  /** Every action the row had — the same buttons, nothing dropped. */
  children: ReactNode
}

/** One prototype-shaped row. Scoped to the sections by construction: this
 *  component only renders when the caller asked for the 'section' variant, so
 *  the Faltantes page's DOM is untouched. */
export function SectionRow({
  className,
  wiring,
  title,
  year,
  status,
  poster,
  chip,
  path,
  grabbed,
  grabbedDestination,
  extra,
  children,
}: SectionRowProps) {
  const hue = posterHue(title)
  // A poster URL that fails to load drops the image for good on this row:
  // the initials underneath were always there, so the box never goes blank.
  const [posterFailed, setPosterFailed] = useState(false)
  return (
    <div className={`sec-row ${className}`} {...wiring}>
      <span
        className="sec-row-poster"
        aria-hidden="true"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 46% 54%), hsl(${hue} 52% 14%))` }}
      >
        {posterInitials(title)}
        {poster && !posterFailed && (
          <img
            className="sec-row-poster-img"
            src={poster}
            // The title sits right beside the box: the image adds nothing a
            // screen reader should hear twice.
            alt=""
            loading="lazy"
            onError={() => setPosterFailed(true)}
          />
        )}
      </span>
      <span className="sec-row-body">
        <span className="sec-row-top">
          <span className="sec-row-name">{title}</span>
          {year != null && <span className="sec-row-year">{year}</span>}
          <span className="sec-row-state">
            <span className={`sec-pill sec-pill-${status.tone}`}>{status.label}</span>
          </span>
        </span>
        <span className="sec-row-bottom">
          {chip && <span className="sec-q-tag">{chip}</span>}
          {path && <span className="sec-row-path" title={path}>{path}</span>}
          {extra}
          {/* Null means never requested: show nothing, not a dash. */}
          {grabbed && (
            <span className="wanted-grabbed" title={grabbedDestination ?? undefined}>
              {grabbed}
            </span>
          )}
        </span>
      </span>
      <span className="sec-row-actions">{children}</span>
    </div>
  )
}
