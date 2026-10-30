/** Owner-facing evidence vocabulary. Raw claim keys remain in developer details. */
export function evidenceTopic(type: string): string {
	if (type === 'eligibility.min_age') return 'Minimum age';
 if (type === 'deadline' || type === 'requirement.submission_deadline') return 'Submission deadline';
 if (type === 'eligibility.restricted_countries') return 'Countries excluded from entry';
 if (type.startsWith('eligibility.')) return 'Entry rules';
 if (type.startsWith('requirement.')) return 'Submission requirements';
 return 'Project information';
}

export function evidenceConflictCopy(type: string): { headline: string; summary: string } {
 if (type === 'deadline' || type === 'requirement.submission_deadline') return {
  headline: 'The submission deadline needs checking',
  summary: 'Caddie found different closing times in the source material. Check the quoted details before relying on a deadline.',
 };
 if (type.startsWith('eligibility.')) return {
  headline: 'The entry rules need checking',
  summary: 'Caddie found different entry restrictions in the source material. Check the quoted rules before relying on an entry verdict.',
 };
 return {
  headline: 'Some project information needs checking',
  summary: 'Caddie found different answers in the source material. Both readings are saved so you can compare them.',
 };
}

export function evidenceValue(type: string, value: string): string {
 if (type !== 'eligibility.restricted_countries') return value;
 const codes = value.split(',').map(code => code.trim().toUpperCase());
 // Only translate a list of country codes; preserve prose and unknown formats.
 if (!codes.length || codes.some(code => !/^[A-Z]{2}$/.test(code))) return value;
 const names = new Intl.DisplayNames(['en'], { type: 'region' });
 return codes.map(code => names.of(code) ?? code).join(', ');
}
