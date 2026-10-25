interface PlanNote { kind: string; body: string; planRevision: string }

/** One repair budget shared by direct and delegated writes. The coordinator
 * supplies persisted counters; the last valid revision is never overwritten. */
export function guardPlanWrites(deps: {
 failures: () => number;
 remember: (count: number) => void;
 write: (input: PlanNote) => Promise<void>;
 block: (reason: string) => Promise<void>;
}) {
 return async (input: PlanNote): Promise<void> => {
  if (input.kind === 'looks' && deps.failures() >= 3)
   throw new Error('LOOKS_REPAIR_LIMIT: stop retrying. Explain that the looks could not be prepared; the saved plan and last valid options are retained.');
  try {
   await deps.write(input);
   if (input.kind === 'looks') deps.remember(0);
  } catch (error) {
   if (input.kind === 'looks' && error instanceof Error && error.message.includes('LOOKS_INVALID')) {
    const failures = deps.failures() + 1;
    deps.remember(failures);
    if (failures === 3) await deps.block('Caddie could not prepare valid look options after three attempts. Your saved plan and earlier options are retained. You can ask Caddie to try again.');
   }
   throw error;
  }
 };
}
