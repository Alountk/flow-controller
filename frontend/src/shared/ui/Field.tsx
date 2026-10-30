import { useId } from 'react'
import { slug } from '../utils/slug.ts'
import './Field.css'

// S2 pairing: the id must stay unique across mounted panels («URL» ×5), so it
// comes from useId; only the form name derives from the label text.

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  restart = false,
  placeholder,
  ariaLabel,
  disabled = false,
}: {
  label: string
  value: string | number | boolean
  onChange: (v: string) => void
  type?: string
  restart?: boolean
  placeholder?: string
  /** Accessible name when the visible label is shorter (e.g. "URL" on the Radarr step). */
  ariaLabel?: string
  disabled?: boolean
}) {
  const uid = useId()
  // The label IS the row; the input keeps its aria-label because the restart
  // badge would otherwise leak into the accessible name.
  return (
    <label className="settings-field" htmlFor={uid}>
      <span className="settings-label">
        {label}
        {restart && <span className="settings-restart-badge">Requiere reinicio</span>}
      </span>
      {type === 'toggle' ? (
        <button
          className={`settings-toggle ${value ? 'on' : 'off'}`}
          id={uid}
          name={slug(label)}
          onClick={() => onChange(value ? 'false' : 'true')}
        >
          {value ? 'Sí' : 'No'}
        </button>
      ) : (
        <input
          className="settings-input"
          type={type}
          id={uid}
          name={slug(label)}
          value={String(value)}
          placeholder={placeholder}
          aria-label={ariaLabel ?? label}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  )
}
