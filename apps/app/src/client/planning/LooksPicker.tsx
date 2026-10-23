import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Look, LooksSet } from "@caddie/contracts";
import { themeToCssVars } from "@caddie/contracts";
import { Icon } from "../icons.tsx";
import { mockDocument } from "../artifacts/DesignMockPreview.tsx";

/**
 * Look-and-feel picker — the step between the approved plan and the design.
 * Caddie proposes 2-3 looks; the owner picks ONE and the designer draws every
 * screen in it.
 *
 * The approved mock (docs/reviews/2026-10-23-look-and-feel-picker):
 *  - desktop: the looks side by side; phone: a scroll-snap strip with name
 *    tabs, one look at a time with the next peeking in;
 *  - the look IN VIEW is the choice — the tab's aria-pressed, the radio and the
 *    "Use <name>" button all follow it;
 *  - "Designed for <audience>" with a Change link (sends `more` with the note
 *    "Designed for: …"), an optional note box, and "Show other looks".
 *
 * Each look's preview is the SAME shared key screen (the set's one html-mock)
 * painted in that look's theme, so the owner compares like for like. The frame
 * is the same locked-down, script-free sandbox DesignMockPreview uses — the
 * only thing injected is the look's theme tokens.
 */

const PREVIEW_LIMIT = 512 * 1024;

/** The five dots + "Aa": the colours and heading font that make a look itself. */
function Swatches({ look }: { look: Look }): ReactElement {
  const c = look.colors;
  const dots = [c.bg, c.primary, c.ok ?? c.primary, c.surface].filter(Boolean);
  return (
    <p className="look-swatches" aria-hidden="true">
      {dots.map((hex, i) => (
        <i key={`${i}-${hex}`} style={{ background: hex }} />
      ))}
      <span style={{ fontFamily: look.fonts.heading }}>Aa</span>
    </p>
  );
}

function LookPreview({ look, screenHtml }: { look: Look; screenHtml: string }): ReactElement {
  const doc = useMemo(() => {
    if (new TextEncoder().encode(screenHtml).byteLength > PREVIEW_LIMIT) return "";
    return mockDocument(screenHtml, themeToCssVars(look));
  }, [look, screenHtml]);
  if (!doc)
    return (
      <div className="look-app look-app--empty" aria-hidden="true">
        This screen is too large to preview here.
      </div>
    );
  return (
    <iframe
      className="look-app"
      title={`Preview: ${look.name}`}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={doc}
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}

export function LooksPicker(props: {
  set: LooksSet;
  busy: boolean;
  /** Choose this look; note is the optional "Anything to change?" text. */
  onChoose: (lookId: string, note: string) => void;
  /** Ask Caddie for different looks; note carries the request (e.g. audience change). */
  onMore: (note: string) => void;
}): ReactElement {
  const { set } = props;
  const looks = set.looks;
  const recommendedIndex = Math.max(
    looks.findIndex((l) => l.id === set.recommended),
    0,
  );
  const [active, setActive] = useState(recommendedIndex);
  const [note, setNote] = useState("");
  const track = useRef<HTMLDivElement>(null);
  const index = Math.min(active, looks.length - 1);
  const chosen = looks[index]!;
  const prefersReduced =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const screenHtml = set.screen.html;

  // A tab click (phone) slides the strip to that look; the scroll handler keeps
  // `active` in sync when the owner swipes instead. On desktop the strip is a
  // grid, so clicking a card's radio is what selects it.
  function goTo(i: number) {
    setActive(i);
    const strip = track.current;
    if (!strip || getComputedStyle(strip).display !== "flex") return;
    const card = strip.children[i] as HTMLElement | undefined;
    if (card) strip.scrollTo({ left: card.offsetLeft - 16, behavior: prefersReduced ? "auto" : "smooth" });
  }

  useEffect(() => {
    const strip = track.current;
    if (!strip) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (getComputedStyle(strip).display !== "flex") return;
        const edge = strip.getBoundingClientRect().left + 16;
        let best = 0;
        let bestGap = Infinity;
        for (let i = 0; i < strip.children.length; i++) {
          const gap = Math.abs((strip.children[i] as HTMLElement).getBoundingClientRect().left - edge);
          if (gap < bestGap) {
            bestGap = gap;
            best = i;
          }
        }
        setActive(best);
      });
    };
    strip.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      strip.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div className="look-picker" data-testid="looks-picker">
      <p className="look-for">
        <span>Designed for</span> <b>{set.audience}</b>{" "}
        <button
          type="button"
          className="r-link look-for-change"
          data-testid="looks-change-audience"
          disabled={props.busy}
          onClick={() => props.onMore(`Designed for: ${set.audience} — change this to: `)}
        >
          Change
        </button>
      </p>

      {/* Phone-only name tabs; the look in view is the choice. */}
      <div className="look-switch" role="tablist" aria-label="Looks" data-testid="looks-tabs">
        {looks.map((look, i) => (
          <button
            key={look.id}
            type="button"
            role="tab"
            aria-pressed={i === index}
            data-testid={`looks-tab-${look.id}`}
            onClick={() => goTo(i)}
          >
            {look.name}
          </button>
        ))}
      </div>

      <fieldset className="look-options">
        <legend className="visually-hidden">Choose a look</legend>
        <div className="look-track" ref={track} style={{ ["--look-count" as string]: String(looks.length) }}>
          {looks.map((look, i) => (
            <label className="look-option" key={look.id} data-testid={`looks-option-${look.id}`}>
              <input
                type="radio"
                name="look"
                value={look.id}
                checked={i === index}
                onChange={() => setActive(i)}
              />
              <span className="look-selected">
                <Icon name="check" title="" /> Selected
              </span>
              <LookPreview look={look} screenHtml={screenHtml} />
              <div className="look-text">
                <p className="look-name">
                  {look.name}
                  {look.id === set.recommended ? (
                    <span className="look-tag">
                      <Icon name="sparkle" title="" /> Caddie&rsquo;s pick
                    </span>
                  ) : null}
                </p>
                <p className="look-why">{look.why}</p>
                <Swatches look={look} />
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="look-next">
        <label htmlFor="look-note">
          Anything to change?{" "}
          <span>Optional. For example: &ldquo;the first one, but warmer&rdquo;, or &ldquo;use the green from our logo&rdquo;.</span>
          <textarea
            id="look-note"
            data-testid="looks-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
          />
        </label>
        <p className="state-detail">Next, Caddie designs every screen in this look for you to review.</p>
        <div className="row-actions">
          <button
            type="button"
            className="btn-key"
            data-testid="looks-use"
            disabled={props.busy}
            onClick={() => props.onChoose(chosen.id, note.trim())}
          >
            {props.busy ? "Saving…" : `Use ${chosen.name}`}
          </button>
          <button
            type="button"
            className="btn-ghost"
            data-testid="looks-more"
            disabled={props.busy}
            onClick={() => props.onMore(note.trim())}
          >
            Show other looks
          </button>
        </div>
      </div>
    </div>
  );
}
