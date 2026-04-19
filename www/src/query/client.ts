import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,              // Treat data fresh for 1 min; GBFS polls ~every minute anyway.
      gcTime: 10 * 60_000,            // Keep evicted entries 10 min so back-nav is instant.
      refetchOnWindowFocus: false,    // Smart-polling hook already handles visibility-aware refresh.
      retry: 1,
    },
  },
})
