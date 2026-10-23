/**
 * Re-export of the pieces a TEST HARNESS needs to wrap app components that use
 * react-query. The app itself imports '@tanstack/react-query' directly; this
 * module exists so a harness entry (tests/fixtures/*) resolves react-query
 * through apps/app/node_modules — the SAME copy the app components resolve —
 * instead of a second copy reachable from the repo root. Two copies share a
 * QueryClientContext symbol in the bundle but not the same provider instance,
 * which surfaces as "No QueryClient set" despite a provider being mounted.
 */
export { QueryClient, QueryClientProvider } from '@tanstack/react-query';
