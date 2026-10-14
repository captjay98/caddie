import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

const STORAGE_LIMIT = 100 * 1024;
const PREVIEW_LIMIT = 5 * 1024 * 1024;
const BRIDGE_KIND = "caddie-preview-storage";
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function storageKey(actorId: string, projectId: string): string {
  return `caddie:preview:${encodeURIComponent(actorId)}:${encodeURIComponent(projectId)}`;
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

function previewDocument(
  html: string,
  nonce: string,
  seed: Record<string, string>,
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
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><script>${shim}</script></head><body>${html}</body></html>`;
}

/** Generated code stays in an opaque iframe; only its own bounded storage is shared. */
export function InteractivePreview(props: {
  projectId: string;
  artifactId: string;
  actorId: string;
  contentUrl?: string;
  downloadUrl?: string;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    scope: string;
    document: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
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
      };
      if (envelope.kind !== BRIDGE_KIND || envelope.nonce !== nonce) return;
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
        setLoaded({ scope, document: previewDocument(html, nonce, seed) });
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
  }, [scope, props.actorId, props.projectId, props.artifactId, contentUrl]);

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
    </section>
  );
}
