/** Explicit split-document marker, not a claim of semantic completeness. */
export function designCompletenessIssue(body: string): string | null {
  const heading = body.split(/\r?\n/).find(line => /^#{1,2}\s/.test(line)) ?? '';
  return /\bpart\s+\d+\b/i.test(heading)
    ? 'This design was saved in separate parts. Caddie needs to combine them into one complete design before you approve.'
    : null;
}
