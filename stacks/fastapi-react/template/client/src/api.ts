/** The client's single API surface: configured base + endpoint path. */
export function apiUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, "")}${path}`;
}
