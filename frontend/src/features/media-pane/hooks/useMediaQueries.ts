import { useInfiniteQuery } from '@tanstack/react-query'
import type { WantedMovie, WantedEpisode, AllMovie, AllSeries } from '../../../shared/types.ts'
import {
  fetchWantedMovies,
  fetchWantedEpisodes,
  fetchAllMovies,
  fetchAllSeries,
} from '../../../shared/api/wanted.ts'
import type { MediaKind, MediaFilter } from '../types.ts'

const PAGE_SIZE = 50

/**
 * The pane's query wiring: four infinite queries (two lists × two filters),
 * the one active for the current kind/filter, and everything derived from
 * it — flattened items, the tab totals, the error the backend explained,
 * and the paging controls the sentinel observer drives. Exactly one query
 * is enabled at a time; the other three idle with their own cache.
 */
export function useMediaQueries({
  kind,
  filter,
  debouncedQuery,
}: {
  kind: MediaKind
  filter: MediaFilter
  debouncedQuery: string
}) {
  const isMovies = kind === 'movies'

  // 1. Wanted Movies Infinite Query
  const wantedMoviesQuery = useInfiniteQuery({
    queryKey: ['wanted-movies-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchWantedMovies(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'movies' && filter === 'missing',
  })

  // 2. All Movies Infinite Query
  const allMoviesQuery = useInfiniteQuery({
    queryKey: ['all-movies-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchAllMovies(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'movies' && filter === 'all',
  })

  // 3. Wanted Episodes Infinite Query
  const wantedEpisodesQuery = useInfiniteQuery({
    queryKey: ['wanted-episodes-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchWantedEpisodes(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'episodes' && filter === 'missing',
  })

  // 4. All Series Infinite Query
  const allSeriesQuery = useInfiniteQuery({
    queryKey: ['all-series-infinite', debouncedQuery],
    queryFn: ({ pageParam = 1 }) => fetchAllSeries(pageParam, PAGE_SIZE, debouncedQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const currentFetched = (lastPage.page ?? 1) * PAGE_SIZE
      return currentFetched < lastPage.total ? (lastPage.page ?? 1) + 1 : undefined
    },
    enabled: kind === 'episodes' && filter === 'all',
  })

  // Active query based on current view
  const activeQuery =
    isMovies
      ? (filter === 'missing' ? wantedMoviesQuery : allMoviesQuery)
      : (filter === 'missing' ? wantedEpisodesQuery : allSeriesQuery)

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isPending } = activeQuery

  const wantedTotal =
    (isMovies ? wantedMoviesQuery : wantedEpisodesQuery).data?.pages[0]?.total ?? 0
  const allTotal =
    (isMovies ? allMoviesQuery : allSeriesQuery).data?.pages[0]?.total ?? 0

  // A failed fetch must never read as "nothing missing": the backend now says
  // WHY it is empty, and that reason has to reach the screen.
  const activeError =
    activeQuery.data?.pages.find((p) => p.error)?.error ?? null

  return {
    wantedMovies: wantedMoviesQuery.data?.pages.flatMap((p) => p.items) ?? ([] as WantedMovie[]),
    catalogMovies: allMoviesQuery.data?.pages.flatMap((p) => p.items) ?? ([] as AllMovie[]),
    wantedEpisodes: wantedEpisodesQuery.data?.pages.flatMap((p) => p.items) ?? ([] as WantedEpisode[]),
    catalogSeries: allSeriesQuery.data?.pages.flatMap((p) => p.items) ?? ([] as AllSeries[]),
    wantedTotal,
    allTotal,
    activeError,
    serviceName: isMovies ? 'Radarr' : 'Sonarr',
    isPending,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  }
}
