import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  BRIDGE_KIND,
  FETCH_KIND,
  FETCH_RESULT_KIND,
  FLUTTER_PREVIEW_LIMIT,
  MAX_IN_FLIGHT,
  MAX_RELAY_BODY,
  PREVIEW_LIMIT,
  STORAGE_LIMIT,
  previewDocument,
  previewSeed,
} from "../../shared/preview-frame.ts";

// The frame document is composed in one place (shared/preview-frame.ts) so the
// server and the client cannot drift; it is re-exported here because the
// browser specs pin it.
export { FLUTTER_CSP, previewDocument } from "../../shared/preview-frame.ts";

function storageKey(actorId: string, projectId: string): string {
  return `caddie:preview:${encodeURIComponent(actorId)}:${encodeURIComponent(projectId)}`;
}

/**
 * The app's cookies while the preview is open (the frame has no cookie store
 * of its own). Name -> value only; an expired or Max-Age=0 cookie is removed.
 */
export { updateCookieJar, cookieHeader } from '../../shared/preview-cookies.ts';
import { updateCookieJar, cookieHeader } from '../../shared/preview-cookies.ts';

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
  /** "flutter": an Android app's browser preview (Track 3), in a phone-sized frame. */
  kind?: "web" | "flutter";
  standalone?: boolean;
  /**
   * The Brief ready card's live mini view: only the running app's frame, with
   * no toolbar, notes or reset. The card scales it down and makes it inert.
   */
  peek?: boolean;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const nativeReset = useRef(false);
  const windowRef = useRef<HTMLDialogElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [device, setDevice] = useState<'phone' | 'desktop'>('desktop');
  function toggleExpanded() {
    const dialog = windowRef.current;
    if (!dialog) return;
    dialog.close();
    if (expanded) { dialog.show(); setExpanded(false); expandRef.current?.focus(); }
    else { dialog.showModal(); setExpanded(true); }
  }
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    scope: string;
    /** The composed frame document, for a frame that cannot be loaded by URL. */
    document?: string;
    /** The frame's own URL: the document is served over https. */
    url?: string;
    nativeStorage?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const kind = props.kind ?? "web";
  const contentUrl =
    props.contentUrl ??
    `/api/projects/${encodeURIComponent(props.projectId)}/artifact-revisions/${encodeURIComponent(props.artifactId)}/content`;
  const scope = `${props.actorId}\n${props.projectId}\n${props.artifactId}\n${contentUrl}\n${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    const nonce = crypto.randomUUID();
    const key = storageKey(props.actorId, props.projectId);
    let active = true;
    let frameOrigin = 'null';
    setLoaded(null);
    setError(null);
    setStorageWarning(false);
    const appRequestUrl = props.appRequestUrl;
    const jar = new Map<string, string>();
    let inFlight = 0;
    const answer = (id: unknown, payload: { response?: unknown; error?: string }) =>
      frame.current?.contentWindow?.postMessage({ kind: FETCH_RESULT_KIND, nonce, id, ...payload }, frameOrigin === 'null' ? '*' : frameOrigin);
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
        event.origin !== frameOrigin
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
        storageMigrated?: unknown;
      };
      if (envelope.nonce !== nonce) return;
      if(frameOrigin!=='null'&&envelope.kind===BRIDGE_KIND&&envelope.storageMigrated===true) {
        try{window.localStorage.removeItem(key);}catch{setStorageWarning(true);}
        return;
      }
      if (envelope.kind === FETCH_KIND) {
        void relay(envelope.id, envelope.request);
        return;
      }
      if (envelope.kind !== BRIDGE_KIND) return;
      const storage = previewSeed(envelope.storage);
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
        // The app's own saved data (its localStorage in the preview).
        let seed: Record<string, string> = Object.create(null);
        try {
          seed =
            previewSeed(
              JSON.parse(window.localStorage.getItem(key) ?? "{}"),
            ) ?? seed;
        } catch {
          setStorageWarning(true);
        }
        const limit = kind === "flutter" ? FLUTTER_PREVIEW_LIMIT : PREVIEW_LIMIT;
        const tooLarge = () => new Error("This preview is too large to open here. Download it instead.");
        const accessError = (status: number) =>
          status === 401
            ? "Sign in again to open this preview."
            : status === 403
              ? "You do not have access to this preview."
              : null;

        if (kind !== "flutter") {
          const documentBase = contentUrl.replace(/\/content$/, "");
          if (documentBase.includes('/workflow/preview/')) {
            const response = await fetch(`${documentBase}/launch`, {
              method: 'POST', credentials: 'same-origin',
              headers: {'content-type':'application/json'}, body: JSON.stringify({nonce,storage:nativeReset.current?{}:seed}), signal:controller.signal,
            });
            if (!response.ok) throw new Error(accessError(response.status) ?? 'The isolated app preview could not be opened.');
            const launch = await response.json() as {url:string;origin:string;resetUrl:string};
            const url = new URL(nativeReset.current ? launch.resetUrl : launch.url);
            if (url.origin !== launch.origin || url.origin === window.location.origin || !['http:','https:'].includes(url.protocol))
              throw new Error('A separate preview origin is required.');
            frameOrigin = launch.origin;
            nativeReset.current = false;
            if (active) setLoaded({scope,url:url.href,nativeStorage:true});
            return;
          }
          // The frame is loaded from Caddie's own https URL, not from a `srcdoc`
          // attribute: a srcdoc frame reports the protocol `about:`, and an app
          // that checks its own origin before it fetches then believes it is
          // offline and never calls its server (HerdVoice, 2026-10-22). The
          // frame stays sandboxed without `allow-same-origin`, so its origin is
          // still opaque. The frame document lives beside the content:
          // .../workflow/preview/<id> for a built app, .../artifact-revisions/<rev>
          // for an imported one.
          const seeded = await fetch(`${documentBase}/seed`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ storage: seed }),
            signal: controller.signal,
          });
          if (!seeded.ok) throw new Error(accessError(seeded.status) ?? "The preview's saved data could not be prepared.");
          const { seedRef } = (await seeded.json()) as { seedRef?: string };
          if (!seedRef) throw new Error("The preview's saved data could not be prepared.");
          const frameUrl = `${documentBase}/document?nonce=${encodeURIComponent(nonce)}&seed=${encodeURIComponent(seedRef)}`;
          const frame = await fetch(frameUrl, { credentials: "same-origin", signal: controller.signal });
          if (!frame.ok) throw new Error(accessError(frame.status) ?? "The preview could not be loaded.");
          if (!frame.headers.get("content-type")?.toLowerCase().startsWith("text/html"))
            throw new Error("This artifact is not an interactive app preview.");
          if (Number(frame.headers.get("content-length")) > limit) throw tooLarge();
          await frame.text();
          if (!active) return;
          setLoaded({ scope, url: frameUrl });
          return;
        }

        // Flutter's preview page is composed here (its assets and its engine
        // are not Caddie's to serve), so it stays a `srcdoc` frame.
        const response = await fetch(contentUrl, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(accessError(response.status) ?? "The preview could not be loaded.");
        if (
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/html")
        )
          throw new Error("This artifact is not an interactive app preview.");
        if (Number(response.headers.get("content-length")) > limit) throw tooLarge();
        const html = await response.text();
        if (new TextEncoder().encode(html).byteLength > limit) throw tooLarge();
        if (!active) return;
        setLoaded({ scope, document: previewDocument(html, nonce, seed, Boolean(appRequestUrl), kind) });
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
  }, [scope, props.actorId, props.projectId, props.artifactId, contentUrl, props.appRequestUrl, kind]);

  if (props.peek) {
    // The ready card's live mini view: the same frame, bridge and sandbox as
    // the full preview, with nothing around it. Out of the tab order: the
    // card's "Try the app" button is how a person opens it.
    return loaded?.scope === scope ? (
      <iframe
        ref={frame}
        title="A live view of your app"
        name="caddie-preview-peek"
        sandbox={loaded.nativeStorage ? 'allow-scripts allow-forms allow-same-origin' : 'allow-scripts allow-forms'}
        referrerPolicy="no-referrer"
        src={loaded.url}
        srcDoc={loaded.document}
        data-kind={kind}
        data-testid="peek-frame"
        tabIndex={-1}
        style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
      />
    ) : (
      <p role="status" className="compact-card-peek-wait">
        {error ? "The live view isn’t available right now." : "Opening a live view…"}
      </p>
    );
  }

  return (
    <dialog open ref={windowRef} className={expanded ? "app-preview-window expanded" : "app-preview-window"} aria-label="App preview window" onCancel={event => { event.preventDefault(); toggleExpanded(); }}>
    <section
      className="artifact-panel"
      style={{ display: "grid", gap: 12 }}
      data-testid="interactive-preview"
      aria-label="App preview"
    >
      <div className="preview-window-toolbar">
        <span className="kicker">Try your app</span>
        <div className="row-actions"><div className="preview-device-switch" role="group" aria-label="Preview size"><button type="button" aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}>Phone</button><button type="button" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>Desktop</button></div><button ref={expandRef} type="button" className="btn-ghost" onClick={toggleExpanded} data-testid="preview-expand">{expanded ? 'Close full screen' : 'Full screen'}</button>
        {!props.standalone ? <a className="btn-key" data-testid="preview-open-page" href={`${window.location.pathname.startsWith('/app') ? '/app' : ''}/preview?${new URLSearchParams({ project: props.projectId, preview: props.artifactId, source: props.contentUrl?.includes('/workflow/preview/') ? 'workflow' : 'artifact' })}`}>Open app preview</a> : null}</div>
      </div>
      {/* The stage already stands at the app's own height while the app
          opens: the loading line is 17px and the frame it becomes is not, so
          without this everything under the window jumped by ~400px the moment
          the app arrived (owner 2026-10-27 on the Preview tab). */}
      <div className={props.standalone ? "preview-stage preview-stage-standalone" : "preview-stage"}>
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
          sandbox={loaded.nativeStorage ? 'allow-scripts allow-forms allow-same-origin' : 'allow-scripts allow-forms'}
          allow="geolocation"
          referrerPolicy="no-referrer"
          src={loaded.url}
          srcDoc={loaded.document}
          data-kind={kind}
          data-device={device}
          style={
            kind === "flutter" || device === 'phone'
              ? { width: "min(100%, 390px)", height: props.standalone ? "max(650px, calc(100dvh - 210px))" : 650, justifySelf: "center", border: 0, borderRadius: 20, background: "#fff" }
              : { width: "100%", minHeight: props.standalone ? "max(520px, calc(100dvh - 210px))" : 440, border: 0, borderRadius: 16, background: "#fff" }
          }
        />
      ) : (
        <p role="status">Opening your app preview…</p>
      )}
      </div>
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
                .then(() => { nativeReset.current = loaded?.nativeStorage === true; setAttempt((value) => value + 1); })
                .catch(() => setError("The test data could not be reset. Try again."))
                .finally(() => setResetting(false));
            }}
          >
            {resetting ? "Resetting…" : "Reset test data"}
          </button>
        ) : null}
      </div>
    </section>
    </dialog>
  );
}
