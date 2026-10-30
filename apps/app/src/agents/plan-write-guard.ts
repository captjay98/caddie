interface PlanNote { kind: string; body: string; planRevision: string; authorRouteId?: string; signal?: AbortSignal }

/**
 * Refused looks saves allowed per turn. Each refusal names every fix at once,
 * and a designer pass costs about half a US cent, so five lets a real
 * correction land (EggOps Nigeria, 2026-10-30: three rounds fixed three
 * different things and the step stopped one fix short).
 */
export const LOOKS_REPAIR_ATTEMPTS = 5;

/** One repair budget shared by direct and delegated writes. The coordinator
 * supplies persisted counters; the last valid revision is never overwritten. */
export function guardPlanWrites(deps: {
 failures: () => number;
 remember: (count: number) => void;
 write: (input: PlanNote) => Promise<void>;
 block: (reason: string) => Promise<void>;
}) {
 return async (input: PlanNote): Promise<void> => {
  if (input.kind === 'looks' && deps.failures() >= LOOKS_REPAIR_ATTEMPTS)
   throw new Error('LOOKS_REPAIR_LIMIT: stop retrying. Explain that the looks could not be prepared; the saved plan and last valid options are retained.');
  try {
   await deps.write(input);
   if (input.kind === 'looks') deps.remember(0);
  } catch (error) {
   if (input.kind === 'looks' && error instanceof Error && error.message.includes('LOOKS_INVALID')) {
    const failures = deps.failures() + 1;
    deps.remember(failures);
    if (failures === LOOKS_REPAIR_ATTEMPTS) await deps.block('Caddie couldn’t finish the look options this time. Your plan is safe — tap Try again.');
   }
   throw error;
  }
 };
}
