import './Field.css'

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
  return (
    <div className="settings-field">
      <label className="settings-label">
        {label}
        {restart && <span className="settings-restart-badge">Requiere reinicio</span>}
      </label>
      {type === 'toggle' ? (
        <button
          className={`settings-toggle ${value ? 'on' : 'off'}`}
          onClick={() => onChange(value ? 'false' : 'true')}
        >
          {value ? 'Sí' : 'No'}
        </button>
      ) : (
        <input
          className="settings-input"
          type={type}
          value={String(value)}
          placeholder={placeholder}
          aria-label={ariaLabel ?? label}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}
