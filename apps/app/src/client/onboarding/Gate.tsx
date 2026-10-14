import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useAuthStatus, useSessionActor } from '../queries.ts';
import { fetchJson } from '../api.ts';

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
  return <main role="alert"><p>We couldn’t check your welcome progress.</p><button onClick={() => { void actor.refetch(); void status.refetch(); }}>Try again</button></main>;
 }
 if (auth.isPending || (auth.data?.authenticated && (actor.isPending || status.isPending)) || needsWelcome) {
  return <main aria-live="polite"><p>Getting your workspace ready…</p></main>;
 }
 return <>{children}</>;
}
