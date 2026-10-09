import { useEffect, useRef } from 'react'

/**
 * The infinite-scroll sentinel: a ref for the loading-more div at the end of
 * the listing, plus the IntersectionObserver that fetches the next page when
 * that div comes within 300px of the viewport. The effect re-arms only when
 * the paging state changes and disconnects on cleanup.
 */
export function useLoadMoreObserver({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}) {
  // Sentinel ref for infinite scroll intersection observer
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  // IntersectionObserver for auto-loading next page on scroll
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !hasNextPage || isFetchingNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchNextPage()
        }
      },
      { rootMargin: '300px' },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return loadMoreRef
}
