import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api/auth'
import type { ServiceKey } from '../types'

interface ServiceInfo {
  key: ServiceKey
  kind: string
  url: string
  configured: boolean
}

interface ServicesResponse {
  services: ServiceInfo[]
  configured: ServiceKey[]
}

/**
 * Which services are actually usable.
 *
 * Used to hide the parts of the UI that depend on a service the user has not
 * set up. Deliberately distinct from "configured but down": that one is shown,
 * with an error, because the user expects it to work and needs to know it does
 * not.
 */
export function useConfiguredServices() {
  const query = useQuery({
    queryKey: ['services'],
    queryFn: async (): Promise<ServicesResponse> => {
      const res = await apiFetch('/api/services')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as ServicesResponse
    },
    staleTime: 60_000,
  })

  const configured = query.data?.configured ?? []

  return {
    /** False until the answer is known, so nothing flashes into view. */
    ready: query.isSuccess,
    configured,
    isConfigured: (key: ServiceKey) => configured.includes(key),
    /** Movies need Radarr, episodes need Sonarr. */
    hasAnyArr: configured.includes('radarr') || configured.includes('sonarr'),
  }
}
