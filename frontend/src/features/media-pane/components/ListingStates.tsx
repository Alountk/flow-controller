/**
 * The three non-list states every listing branch can show instead of its
 * rows: the first-load spinner line, the backend-explained error banner and
 * the empty message. Stateless, so all four listings share one definition
 * of each instead of repeating the markup.
 */

export function ListingLoading({ message }: { message: string }) {
  return <div className="wanted-loading">{message}</div>
}

export function ListingError({ serviceName, error }: { serviceName: string; error: string }) {
  return (
    <div className="wanted-error" role="alert">
      <strong>No se pudo consultar {serviceName}</strong>
      <span>{error}</span>
    </div>
  )
}

export function ListingEmpty({ message }: { message: string }) {
  return <div className="wanted-empty">{message}</div>
}
