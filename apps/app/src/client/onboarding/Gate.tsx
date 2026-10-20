import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useAuthStatus, useSessionActor } from '../queries.ts';
import { fetchJson } from '../api.ts';
import { StatePanel } from '../states.tsx';

export type OnboardingStatus = { completedAt: string | null };
export const onboardingKey = (actor: string | null) => ['onboarding', actor] as const;
export const returnKey = (actor: string) => `caddie:onboarding-return:${actor}`;
export function useOnboarding() {
 const auth = useAuthStatus();
 const actor = useSessionActor(Boolean(auth.data?.authenticated));
 const status = useQuery({
  queryKey: onboardingKey(actor.data ?? null),
  queryFn: () => fetchJson<OnboardingStatus>('/api/onboarding'),
  enabled: Boolean(auth.data?.authenticated && actor.data),
  staleTime: 60_000,
 });
 return { auth, actor, status };
}

export function OnboardingGate({ children }: { children: ReactNode }) {
 const { auth, actor, status } = useOnboarding();
 const location = useLocation();
 const navigate = useNavigate();
 const atWelcome = /\/onboarding\/?$/.test(location.pathname);
 const needsWelcome = Boolean(auth.data?.authenticated && status.data && !status.data.completedAt && !atWelcome);
 useEffect(() => {
  if (!needsWelcome || !actor.data) return;
  try {
   const path = window.location.pathname + window.location.search + window.location.hash;
   // Save only the destination being visited, never a user-supplied external URL.
   sessionStorage.setItem(returnKey(actor.data), path);
  } catch { /* Storage may be unavailable; onboarding still works. */ }
  void navigate({ to: '/onboarding', search: {}, replace: true });
 }, [needsWelcome, actor.data, navigate]);
 if (auth.data?.authenticated && (actor.error || status.error || (actor.isSuccess && !actor.data))) {
  return (
   <WorkspaceReady>
    <StatePanel
     kind="error"
     title="We couldn’t check your welcome progress"
     onRetry={() => { void actor.refetch(); void status.refetch(); }}
     retryLabel="Try again"
     askCaddie={false}
    />
   </WorkspaceReady>
  );
 }
 if (auth.isPending || (auth.data?.authenticated && (actor.isPending || status.isPending)) || needsWelcome) {
  return (
   <WorkspaceReady>
    <StatePanel kind="loading" title="Getting your workspace ready…" />
   </WorkspaceReady>
  );
 }
 return <>{children}</>;
}

/**
 * The page before the workspace opens (plan 5.1). The chrome is not mounted
 * yet, so this screen paints its own themed canvas (as the route error page
 * does) and centres the same state panel every page uses.
 */
function WorkspaceReady({ children }: { children: ReactNode }) {
 return (
  <main id="main" className="gate-view" data-testid="workspace-ready" aria-live="polite">
   {children}
  </main>
 );
}
