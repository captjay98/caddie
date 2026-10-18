import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

const STORAGE_LIMIT = 100 * 1024;
const PREVIEW_LIMIT = 5 * 1024 * 1024;
const BRIDGE_KIND = "caddie-preview-storage";
const FETCH_KIND = "caddie-preview-fetch";
const FETCH_RESULT_KIND = "caddie-preview-fetch-result";
const MAX_RELAY_BODY = Math.ceil((1024 * 1024) / 3) * 4 + 4;
const MAX_IN_FLIGHT = 8;
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function storageKey(actorId: string, projectId: string): string {
  return `caddie:preview:${encodeURIComponent(actorId)}:${encodeURIComponent(projectId)}`;
}

/**
 * The app's cookies while the preview is open (the frame has no cookie store
 * of its own). Name -> value only; an expired or Max-Age=0 cookie is removed.
 */
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

interface RelayRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body: string | null;
}

function checkedRelayRequest(value: unknown): RelayRequest | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<RelayRequest>;
  if (typeof input.method !== "string" || typeof input.path !== "string" || !/^\/api(?:[/?]|$)/.test(input.path)) return null;
  if (!Array.isArray(input.headers) || input.headers.length > 64) return null;
  const headers = input.headers.filter(
    (pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" && pair[0].toLowerCase() !== "cookie",
  );
  if (input.body !== null && (typeof input.body !== "string" || input.body.length > MAX_RELAY_BODY)) return null;
  return { method: input.method, path: input.path, headers, body: input.body ?? null };
}

/** Only bounded string records cross the opaque-frame boundary. */
function checkedStorage(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 512) return null;
  let size = 0;
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of entries) {
    if (
      key.length > 1024 ||
      typeof item !== "string" ||
      item.length > STORAGE_LIMIT
    )
      return null;
    size += new TextEncoder().encode(key + item).byteLength;
    if (size > STORAGE_LIMIT) return null;
    result[key] = item;
  }
  return result;
}

function scriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Apps with a server: the frame has no network (connect-src 'none'), so its
 * fetch('/api/…') calls travel to the parent by postMessage, the parent sends
 * them to Caddie's relay, and the app's answer comes back the same way.
 * Only the app's own /api routes are reachable.
 */
function fetchBridgeShim(nonce: string): string {
  return `(function () {
		'use strict';
		var nonce = ${scriptJSON(nonce)};
		var BASE = 'https://app.preview.invalid';
		var pending = new Map();
		var seq = 0;
		function toBase64(bytes) { var text = ''; for (var i = 0; i < bytes.length; i += 32768) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(text); }
		function fromBase64(value) { var binary = atob(value); var out = new Uint8Array(binary.length); for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i); return out; }
		window.addEventListener('message', function (event) {
			if (event.source !== parent) return;
			var message = event.data;
			if (!message || message.kind !== ${scriptJSON(FETCH_RESULT_KIND)} || message.nonce !== nonce) return;
			var waiting = pending.get(message.id);
			if (!waiting) return;
			pending.delete(message.id);
			if (message.error) { waiting.reject(new TypeError(message.error)); return; }
			var answer = message.response;
			var status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
			var headers = answer.headers.filter(function (pair) { return String(pair[0]).toLowerCase() !== 'set-cookie'; });
			var empty = status === 204 || status === 205 || status === 304;
			waiting.resolve(new Response(empty ? null : fromBase64(answer.body), { status: status, headers: headers }));
		});
		window.fetch = async function (input, init) {
			var request = new Request(input instanceof Request ? input : new URL(String(input), BASE + '/'), init);
			var url = new URL(request.url);
			if (url.origin !== BASE || !/^\\/api(?:\\/|$)/.test(url.pathname)) throw new TypeError("The preview can only reach the app's own /api routes.");
			var body = null;
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				var bytes = new Uint8Array(await request.arrayBuffer());
				if (bytes.length > 0) body = toBase64(bytes);
			}
			var headers = [];
			request.headers.forEach(function (value, name) { headers.push([name, value]); });
			var id = ++seq;
			return new Promise(function (resolve, reject) {
				pending.set(id, { resolve: resolve, reject: reject });
				parent.postMessage({ kind: ${scriptJSON(FETCH_KIND)}, nonce: nonce, id: id, request: { method: request.method, path: url.pathname + url.search, headers: headers, body: body } }, '*');
			});
		};
	})();`;
}

function previewDocument(
  html: string,
  nonce: string,
  seed: Record<string, string>,
  bridgeFetch = false,
): string {
  // Keep all generated HTML parsing inside the sandbox, including resource tags.
  // The policy and synchronous storage shim precede every generated script.
  const shim = `(function () {
		'use strict';
		var data = Object.assign(Object.create(null), ${scriptJSON(seed)});
		var nonce = ${scriptJSON(nonce)};
		var encoder = new TextEncoder();
		function keys() { return Object.keys(data); }
		function commit(next) {
			var all = Object.keys(next), size = 0;
			if (all.length > 512) throw new DOMException('Preview storage is full.', 'QuotaExceededError');
			for (var key of all) {
				if (key.length > 1024) throw new DOMException('Preview storage key is too long.', 'QuotaExceededError');
				size += encoder.encode(key + next[key]).byteLength;
				if (size > ${STORAGE_LIMIT}) throw new DOMException('Preview storage is full.', 'QuotaExceededError');
			}
			data = next;
			parent.postMessage({ kind: ${scriptJSON(BRIDGE_KIND)}, nonce: nonce, storage: data }, '*');
		}
		var methods = {
			getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
			setItem: function (key, value) { var next = Object.assign(Object.create(null), data); next[String(key)] = String(value); commit(next); },
			removeItem: function (key) { var next = Object.assign(Object.create(null), data); delete next[String(key)]; commit(next); },
			clear: function () { commit(Object.create(null)); },
			key: function (index) { return keys()[Number(index) >>> 0] ?? null; }
		};
		var storage = new Proxy(Object.create(null), {
			get: function (_, key) { if (key === 'length') return keys().length; if (key === Symbol.toStringTag) return 'Storage'; if (Object.prototype.hasOwnProperty.call(methods, key)) return methods[key]; return typeof key === 'string' ? methods.getItem(key) ?? undefined : undefined; },
			set: function (_, key, value) { methods.setItem(key, value); return true; },
			deleteProperty: function (_, key) { methods.removeItem(key); return true; },
			ownKeys: function () { return keys(); },
			getOwnPropertyDescriptor: function (_, key) { return Object.prototype.hasOwnProperty.call(data, key) ? { configurable: true, enumerable: true, writable: true, value: data[key] } : undefined; },
			has: function (_, key) { return key === 'length' || Object.prototype.hasOwnProperty.call(methods, key) || Object.prototype.hasOwnProperty.call(data, key); }
		});
		Object.defineProperty(window, 'localStorage', { value: storage, configurable: false, writable: false });
	})();`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><script>${shim}</script>${bridgeFetch ? `<script>${fetchBridgeShim(nonce)}</script>` : ""}</head><body>${html}</body></html>`;
}

/** Generated code stays in an opaque iframe; only its own bounded storage is shared. */
export function InteractivePreview(props: {
  projectId: string;
  artifactId: string;
  actorId: string;
  contentUrl?: string;
  downloadUrl?: string;
  /** Apps with a server: where the frame's /api requests are relayed (Caddie's preview relay). */
  appRequestUrl?: string;
  /** Apps with a server: empties the preview's test data. */
  onResetData?: () => Promise<void>;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    scope: string;
    document: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const contentUrl =
    props.contentUrl ??
    `/api/projects/${encodeURIComponent(props.projectId)}/artifact-revisions/${encodeURIComponent(props.artifactId)}/content`;
  const scope = `${props.actorId}\n${props.projectId}\n${props.artifactId}\n${contentUrl}\n${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    const nonce = crypto.randomUUID();
    const key = storageKey(props.actorId, props.projectId);
    let active = true;
    setLoaded(null);
    setError(null);
    setStorageWarning(false);
    const appRequestUrl = props.appRequestUrl;
    const jar = new Map<string, string>();
    let inFlight = 0;
    const answer = (id: unknown, payload: { response?: unknown; error?: string }) =>
      frame.current?.contentWindow?.postMessage({ kind: FETCH_RESULT_KIND, nonce, id, ...payload }, "*");
    const relay = async (id: unknown, raw: unknown) => {
      const request = appRequestUrl ? checkedRelayRequest(raw) : null;
      if (!request) return answer(id, { error: "The preview can only reach the app's own /api routes." });
      if (inFlight >= MAX_IN_FLIGHT) return answer(id, { error: "The app is sending too many requests at once." });
      inFlight += 1;
      try {
        const cookie = cookieHeader(jar);
        const response = await fetch(appRequestUrl!, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request, headers: cookie ? [...request.headers, ["cookie", cookie]] : request.headers }),
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as
          | { status: number; headers: Array<[string, string]>; body: string }
          | { message?: string }
          | null;
        if (!response.ok || !payload || !("status" in payload)) {
          const message = payload && "message" in payload && payload.message ? payload.message : "The app's server could not be reached.";
          return answer(id, { error: message });
        }
        updateCookieJar(jar, payload.headers);
        answer(id, { response: payload });
      } catch {
        if (active) answer(id, { error: "The app's server could not be reached." });
      } finally {
        inFlight -= 1;
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (
        !active ||
        !frame.current ||
        event.source !== frame.current.contentWindow ||
        event.origin !== "null"
      )
        return;
      const message: unknown = event.data;
      if (!message || typeof message !== "object") return;
      const envelope = message as {
        kind?: unknown;
        nonce?: unknown;
        storage?: unknown;
        id?: unknown;
        request?: unknown;
      };
      if (envelope.nonce !== nonce) return;
      if (envelope.kind === FETCH_KIND) {
        void relay(envelope.id, envelope.request);
        return;
      }
      if (envelope.kind !== BRIDGE_KIND) return;
      const storage = checkedStorage(envelope.storage);
      if (!storage) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(storage));
      } catch {
        setStorageWarning(true);
      }
    };
    window.addEventListener("message", onMessage);
    void (async () => {
      try {
        const response = await fetch(contentUrl, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "Sign in again to open this preview."
              : response.status === 403
                ? "You do not have access to this preview."
                : "The preview could not be loaded.",
          );
        if (
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/html")
        )
          throw new Error("This artifact is not an interactive app preview.");
        if (Number(response.headers.get("content-length")) > PREVIEW_LIMIT)
          throw new Error(
            "This preview is too large to open here. Download it instead.",
          );
        const html = await response.text();
        if (new TextEncoder().encode(html).byteLength > PREVIEW_LIMIT)
          throw new Error(
            "This preview is too large to open here. Download it instead.",
          );
        if (!active) return;
        let seed: Record<string, string> = Object.create(null);
        try {
          seed =
            checkedStorage(
              JSON.parse(window.localStorage.getItem(key) ?? "{}"),
            ) ?? seed;
        } catch {
          setStorageWarning(true);
        }
        setLoaded({ scope, document: previewDocument(html, nonce, seed, Boolean(appRequestUrl)) });
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "The preview could not be loaded.",
          );
      }
    })();
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("message", onMessage);
    };
  }, [scope, props.actorId, props.projectId, props.artifactId, contentUrl, props.appRequestUrl]);

  return (
    <section
      className="artifact-panel"
      style={{ display: "grid", gap: 12 }}
      data-testid="interactive-preview"
      aria-label="App preview"
    >
      {error ? (
        <div role="alert" className="row-error">
          <p>{error}</p>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : loaded?.scope === scope ? (
        <iframe
          ref={frame}
          title="Your app preview"
          name="caddie-interactive-preview"
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          srcDoc={loaded.document}
          style={{
            width: "100%",
            minHeight: 440,
            border: 0,
            borderRadius: 16,
            background: "#fff",
          }}
        />
      ) : (
        <p role="status">Opening your app preview…</p>
      )}
      {storageWarning && (
        <p role="status">
          Changes work in this preview, but this browser could not save them for
          next time.
        </p>
      )}
      {props.appRequestUrl ? (
        <p className="state-detail" data-testid="preview-test-data-note">
          This app saves its data. In the preview it uses test data that only you see.
        </p>
      ) : null}
      <div className="row-actions">
        <a
          className="btn-ghost"
          href={
            props.downloadUrl ??
            (props.contentUrl
              ? `${props.contentUrl}?download=1`
              : `/api/projects/${encodeURIComponent(props.projectId)}/artifact-revisions/${encodeURIComponent(props.artifactId)}/download`)
          }
        >
          Download app
        </a>
        {props.onResetData ? (
          <button
            type="button"
            className="btn-ghost"
            data-testid="preview-reset-data"
            disabled={resetting}
            onClick={() => {
              setResetting(true);
              void props.onResetData!()
                .then(() => setAttempt((value) => value + 1))
                .catch(() => setError("The test data could not be reset. Try again."))
                .finally(() => setResetting(false));
            }}
          >
            {resetting ? "Resetting…" : "Reset test data"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
