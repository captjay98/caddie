import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { AppTheme, DesignMock } from "@caddie/contracts";
import { themeToCssVars } from "@caddie/contracts";
import { Icon } from "../icons.tsx";

/**
 * Design-mock preview — renders the designer's static `html-mock` screens from
 * a design brief so the user APPROVES SOMETHING THEY CAN SEE, not only read.
 *
 * One mock per screen or state (the key screen, its empty and error states),
 * switched with a segmented picker; a Phone / Desktop toggle lays the mock out
 * at a real 390px or 1280px width, scaled down to fit; the inline frame drags
 * taller, and "View full size" opens it in a full-window dialog where the
 * desktop layout is readable at (or near) 1:1. All of that lives OUT here in
 * the parent: the frame itself stays script-free.
 *
 * Safety: a mock is untrusted static markup, never a running app, so the frame
 * is locked down harder than the post-build app preview — `sandbox=""` (no
 * scripts, opaque origin) plus a CSP that forbids scripts and every network
 * fetch. The only thing injected is the parent's active theme tokens, so the
 * mock paints with the real palette instead of an invented one.
 */

const MOCK_LIMIT = 512 * 1024; // per screen
const MAX_SCREENS = 32;
const VIEWPORT = { phone: 390, desktop: 1280 } as const;
type Device = keyof typeof VIEWPORT;

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
  "script-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; " +
  "worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * The active theme's custom properties, inlined into the frame. Names come from
 * the app's own `:root…` rules (drift-free) plus whatever the browser lists in
 * computed style; values are read resolved for the CURRENT theme + palette.
 */
function readThemeTokens(): string {
  if (typeof document === "undefined") return "";
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet is unreadable — and never carries our tokens
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || !rule.selectorText.trim().startsWith(":root")) continue;
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style.item(i);
        if (prop.startsWith("--")) names.add(prop);
      }
    }
  }
  const style = getComputedStyle(document.documentElement);
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    if (prop.startsWith("--")) names.add(prop);
  }
  const lines: string[] = [];
  for (const prop of names) {
    const value = style.getPropertyValue(prop).trim();
    if (value && !/[<>{}]/.test(value)) lines.push(`${prop}:${value};`);
  }
  return lines.join("");
}

/**
 * The frame document. Token roles match the app: --color-ink is the PAGE
 * BACKGROUND and --color-bright the text on it (the literal fallbacks only
 * apply if a token is missing).
 */
export function mockDocument(html: string, tokens: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>:root{${tokens}}*,*::before,*::after{box-sizing:border-box}html,body{margin:0}` +
    `body{background:var(--color-ink,#090b10);color:var(--color-bright,#e6e9ef);` +
    `font-family:var(--font-ui,system-ui,sans-serif);font-size:14px;line-height:1.45}</style>` +
    `</head><body>${html}</body></html>`
  );
}

/**
 * One mock frame: lays the mock out at its real viewport width and scales it
 * down only when the available width is narrower than that.
 */
function MockStage(props: { doc: string; viewport: number; title: string; frameClass: string; testId: string }): ReactElement {
  const stage = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    if (el.clientWidth > 0) setStageWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setStageWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = stageWidth > 0 ? Math.min(1, stageWidth / props.viewport) : 1;
  return (
    <div className="design-mock__stage" ref={stage}>
      <div className={props.frameClass} data-testid={props.testId} style={{ width: Math.round(props.viewport * scale) }}>
        <iframe
          title={`Design mockup: ${props.title}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={props.doc}
          style={{
            width: props.viewport,
            height: `${100 / scale}%`,
            transform: scale < 1 ? `scale(${scale})` : undefined,
          }}
        />
      </div>
    </div>
  );
}

export function DesignMockPreview(props: { mocks: DesignMock[]; theme?: AppTheme | null; fullRequest?: number; onFullChange?: (full: boolean) => void; dialogOnly?: boolean }): ReactElement | null {
  const screens = props.mocks.slice(0, MAX_SCREENS);
  const [active, setActive] = useState(0);
  const [device, setDevice] = useState<Device>("phone");
  const [full, setFull] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  // Requests are caller epochs: a mount WITH fullRequest>0 means "open now",
  // so the marker starts at 0 and every new value opens once.
  const lastRequest = useRef(0);  const index = Math.min(active, Math.max(screens.length - 1, 0));
  const current = screens[index] ?? null;

  // A caller (e.g. a look card's preview overlay) can pop the dialog open:
  // each NEW request value opens; closing reports back so the caller resets.
  const request = props.fullRequest ?? 0;
  useEffect(() => {
    if (request > lastRequest.current) {
      lastRequest.current = request;
      setFull(true);
    }
  }, [request]);
  useEffect(() => {
    props.onFullChange?.(full);
  }, [full, props.onFullChange]);

  const html = current?.html ?? "";
  const theme = props.theme ?? null;
  const { doc, tooLarge } = useMemo(() => {
    if (new TextEncoder().encode(html).byteLength > MOCK_LIMIT) return { doc: "", tooLarge: true };
    // When the brief carries a validated app theme, paint the mock in the
    // APP's own theme (plain names + the --color-* aliases) instead of copying
    // Caddie's live dashboard tokens, so every app's design looks like itself.
    // A brief with no theme keeps today's behaviour.
    const tokens = theme ? themeToCssVars(theme) : readThemeTokens();
    return { doc: mockDocument(html, tokens), tooLarge: false };
  }, [html, theme]);

  // The native dialog gives focus trapping, Esc-to-close and a backdrop for free.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (full && !el.open) el.showModal?.();
    if (!full && el.open) el.close();
  }, [full]);

  if (!current) return null;

  const controls = (prefix: string) => (
    <>
      <label className="design-mock__screen-picker"><span>Screen</span><select aria-label={`${prefix === 'design-mock-full' ? 'Full size ' : ''}Screen`} value={index} onChange={event => setActive(Number(event.target.value))}>{screens.map((screen,i) => <option key={i} value={i}>{screen.title}</option>)}</select></label>
      {screens.length > 1 ? (
        <span className="disc-seg design-mock__screens" role="group" aria-label="Screen" data-testid={`${prefix}-screens`}>
          {screens.map((screen, i) => (
            <button
              key={`${i}-${screen.title}`}
              type="button"
              aria-pressed={i === index}
              data-testid={`${prefix}-screen-${i}`}
              onClick={() => setActive(i)}
            >
              {screen.title}
            </button>
          ))}
        </span>
      ) : (
        <span className="design-mock__title" data-testid={`${prefix}-title`}>
          {current.title}
        </span>
      )}
      <span className="disc-seg" role="group" aria-label="Layout width" data-testid={`${prefix}-device`}>
        <button type="button" aria-pressed={device === "phone"} data-testid={`${prefix}-phone`} onClick={() => setDevice("phone")}>
          Phone
        </button>
        <button type="button" aria-pressed={device === "desktop"} data-testid={`${prefix}-desktop`} onClick={() => setDevice("desktop")}>
          Desktop
        </button>
      </span>
    </>
  );

  const tooLargeNote = (
    <p className="state-detail" role="status" data-testid="design-mock-too-large">
      This screen&rsquo;s mockup is too large to show here — the written brief below still describes it in full.
    </p>
  );

  return (
    <figure className={props.dialogOnly ? "design-mock design-mock--dialog-only" : "design-mock"} data-testid={props.dialogOnly ? undefined : "design-mock-preview"} data-device={device}>
      {props.dialogOnly ? null : (
        <>
          <figcaption className="sr-only">Screen mockups</figcaption>
          <div className="design-mock__bar">
            {controls("design-mock")}
            <button type="button" className="btn-ghost design-mock__expand" data-testid="design-mock-full" onClick={() => setFull(true)}>
              <Icon name="expand" title="" /> View full size
            </button>
          </div>
          {tooLarge ? tooLargeNote : (
            <MockStage doc={doc} viewport={VIEWPORT[device]} title={current.title} frameClass="design-mock__frame" testId="design-mock-frame" />
          )}
        </>
      )}
      <dialog
        ref={dialog}
        className="design-mock__dialog"
        aria-label={`Design mockup: ${current.title}`}
        data-device={device}
        data-testid="design-mock-dialog"
        onClose={() => setFull(false)}
      >
        {full ? (
          <div className="design-mock__dialog-body">
            <div className="design-mock__bar">
              {controls("design-mock-full")}
              {/* Owner 2026-10-24: one compact control row — the x sits right of
                  the device toggle; no caption, no separate Close button. */}
              <button type="button" className="btn-ghost design-mock__close" data-testid="design-mock-close" aria-label="Close preview" onClick={() => setFull(false)}>
                <Icon name="x" title="" />
              </button>
            </div>
            {tooLarge ? (
              tooLargeNote
            ) : (
              <MockStage
                doc={doc}
                viewport={VIEWPORT[device]}
                title={current.title}
                frameClass="design-mock__frame design-mock__frame--full"
                testId="design-mock-full-frame"
              />
            )}
          </div>
        ) : null}
      </dialog>
    </figure>
  );
}
