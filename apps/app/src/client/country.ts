/**
 * Country code → human display. The Discover eligibility chip and onboarding
 * both resolve a stored ISO alpha-2 code (e.g. "NG") to a readable name
 * ("Nigeria") and a flag emoji, so the UI never shows the raw code as if it
 * were debug output. Pure, no I/O.
 */

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** The display name for an ISO alpha-2 code, or the code itself if unknown. */
export function countryName(code: string | null | undefined): string | null {
	if (!code) return null;
	const upper = code.trim().toUpperCase();
	if (upper.length !== 2) return code;
	try {
		return regionNames.of(upper) ?? code;
	} catch {
		return code;
	}
}

/** The flag emoji for an ISO alpha-2 code (regional-indicator letters). */
export function countryFlag(code: string | null | undefined): string {
	if (!code) return '';
	const upper = code.trim().toUpperCase();
	if (upper.length !== 2 || !/^[A-Z]{2}$/.test(upper)) return '';
	const base = 0x1f1e6; // regional indicator 'A'
	return String.fromCodePoint(
		base + (upper.charCodeAt(0) - 65),
		base + (upper.charCodeAt(1) - 65),
	);
}

const COUNTRY_CODES = 'AF AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW'.split(' ');

/** Every country as { code, name }, sorted by name — for a searchable country field. */
export const COUNTRY_OPTIONS: readonly { readonly code: string; readonly name: string }[] = COUNTRY_CODES
	.map((code) => ({ code, name: countryName(code) ?? code }))
	.sort((a, b) => a.name.localeCompare(b.name));

/** The ISO code for a typed country name (case-insensitive, exact name), or null. */
export function countryCodeForName(typed: string): string | null {
	const wanted = typed.trim().toLowerCase();
	if (!wanted) return null;
	return COUNTRY_OPTIONS.find((c) => c.name.toLowerCase() === wanted)?.code ?? null;
}
