/** Shared preview cookie handling. The opaque app never sees Caddie cookies. */
export function updateCookieJar(jar: Map<string, string>, headers: Array<[string, string]>): void {
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "set-cookie") continue;
    const [pair = "", ...attributes] = value.split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const cookieName = pair.slice(0, at).trim();
    const expired = attributes.some((attribute) => {
      const [key = "", raw = ""] = attribute.split("=");
      const lower = key.trim().toLowerCase();
      if (lower === "max-age") return Number(raw.trim()) <= 0;
      if (lower === "expires") return Date.parse(raw.trim()) <= Date.now();
      return false;
    });
    if (expired) jar.delete(cookieName);
    else jar.set(cookieName, pair.slice(at + 1).trim());
  }
}

export function cookieHeader(jar: Map<string, string>): string | null {
  return jar.size === 0 ? null : [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
