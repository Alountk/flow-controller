/** «Control de aMule» — S5 actions block (amule-control): server list with
 *  per-row estado, add server, connect/remove per row, and the ed2k/magnet
 *  queue form.
 *
 * Not part of the settings form: these write aMule's live state on their own
 *  buttons (the SharedDirsSection/IndexadoresSection precedent), never through
 *  «Guardar cambios». Every verdict renders inline and STAYS (`{ok, detail}`
 *  contract): an action without a visible outcome is a lie by omission. Row
 *  fields are present-or-absent — an absent `failed` is reported as unknown,
 *  never guessed. */

import { useEffect, useState } from 'react'
import {
  addAmuleLink,
  addAmuleServer,
  connectAmuleServer,
  getAmuleServers,
  removeAmuleServer,
  type AmuleActionResult,
  type AmuleServerRow,
} from '../../shared/api/services.ts'
import { Field } from '../../shared/ui/Field.tsx'
import './Settings.css'

/** A thrown fetch carries no verdict body — reuse the settings/probe failure
 *  sentence instead of inventing a second phrasing for the same failure. */
const FETCH_FAILURE = 'No se pudo probar la conexión con el backend.'

interface Verdict {
  text: string
  ok: boolean
}

/** `failed` is present-or-absent in the payload: truthy = the server reports a
 *  failure; absent = the payload says nothing, so the estado admits it. */
function estadoDe(row: AmuleServerRow): { label: string; failed: boolean } {
  if (row.failed) return { label: 'Con fallo', failed: true }
  return { label: 'failed' in row ? 'Sin fallos' : 'Desconocido', failed: false }
}

export function AmuleServerActions() {
  /** null = no list to show (never fetched / fetch threw); [] = an empty list. */
  const [rows, setRows] = useState<AmuleServerRow[] | null>(null)
  const [listVerdict, setListVerdict] = useState<Verdict | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [link, setLink] = useState('')

  /** One honest snapshot per call; never throws, claims nothing it did not read. */
  async function load() {
    try {
      const res = await getAmuleServers()
      setRows(Array.isArray(res.servers) ? res.servers : [])
      setListVerdict(res.ok ? null : { text: res.detail ?? '', ok: false })
    } catch {
      setRows(null)
      setListVerdict({ text: FETCH_FAILURE, ok: false })
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /** Actions run singly (buttons disabled in flight) and refresh the list on
   *  success; the verdict is surfaced whether or not the action succeeded. */
  async function run(kind: string, action: () => Promise<AmuleActionResult>, refresh: boolean) {
    setPending(kind)
    setVerdict(null)
    try {
      const result = await action()
      setVerdict({ text: result.detail, ok: result.ok })
      if (result.ok && refresh) await load()
    } catch {
      setVerdict({ text: FETCH_FAILURE, ok: false })
    } finally {
      setPending(null)
    }
  }

  function submitAdd() {
    void run('add', () => addAmuleServer(address.trim(), name.trim() || undefined), true)
  }

  function submitLink() {
    void run('link', () => addAmuleLink(link.trim()), false)
  }

  const idle = pending !== null

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">Control de aMule</h3>

      {verdict?.text ? (
        <div
          className={`amule-actions-notice${verdict.ok ? '' : ' amule-actions-notice-error'}`}
          role={verdict.ok ? 'status' : 'alert'}
        >
          {verdict.text}
        </div>
      ) : null}

      <div className="settings-group">
        {listVerdict?.text ? (
          <div className="amule-actions-notice amule-actions-notice-error" role="alert">
            {listVerdict.text}
          </div>
        ) : null}
        {rows === null ? null : rows.length > 0 ? (
          <ul className="amule-actions-list">
            {rows.map((row) => {
              const estado = estadoDe(row)
              return (
                <li key={row.address} className="amule-actions-row">
                  <div className="amule-actions-row-main">
                    <span className="amule-actions-row-name">{row.name}</span>
                    <code className="amule-actions-row-address">{row.address}</code>
                    <span
                      className={`amule-actions-estado${
                        estado.failed ? ' amule-actions-estado-failed' : ''
                      }`}
                    >
                      {estado.label}
                    </span>
                  </div>
                  <div className="amule-actions-row-actions">
                    <button
                      type="button"
                      className="settings-btn settings-btn-secondary"
                      disabled={idle}
                      onClick={
                        idle
                          ? undefined
                          : () => void run(`connect:${row.address}`, () => connectAmuleServer(row.address), true)
                      }
                    >
                      Conectar
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn-secondary"
                      disabled={idle}
                      onClick={
                        idle
                          ? undefined
                          : () => void run(`remove:${row.address}`, () => removeAmuleServer(row.address), true)
                      }
                    >
                      Quitar
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : listVerdict === null ? (
          <div className="amule-actions-empty">Sin servidores en la lista</div>
        ) : null}
      </div>

      <div className="settings-group">
        <Field label="Dirección" value={address} onChange={setAddress} placeholder="ip:puerto" />
        <Field label="Nombre (opcional)" value={name} onChange={setName} />
        <div className="settings-group-actions">
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            disabled={idle}
            onClick={idle ? undefined : submitAdd}
          >
            Añadir servidor
          </button>
        </div>
      </div>

      <div className="settings-group">
        <Field label="Enlace ed2k o magnet" value={link} onChange={setLink} />
        <div className="settings-group-actions">
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            disabled={idle}
            onClick={idle ? undefined : submitLink}
          >
            Añadir a la cola
          </button>
        </div>
      </div>
    </section>
  )
}
