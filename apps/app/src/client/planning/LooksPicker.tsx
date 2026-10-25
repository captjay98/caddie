import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Look, LooksSet } from "@caddie/contracts";
import { themeToCssVars } from "@caddie/contracts";
import { Icon } from "../icons.tsx";
import { DesignMockPreview, mockDocument } from "../artifacts/DesignMockPreview.tsx";

/**
 * Look-and-feel picker — the step between the approved plan and the design.
 * Caddie proposes 2-3 looks; the owner picks ONE and the designer draws every
 * screen in it.
 *
 *  - desktop: the looks side by side; phone: the name tabs choose, and the
 *    chosen look fills the available width (owner 2026-10-24: the tabs already
 *    say there is more than one — no peeking carousel strip);
 *  - the chosen look is the choice — the tab's aria-pressed, the radio and the
 *    "Use <name>" button all follow it;
 *  - "Designed for <audience>" with a Change link (sends `more` with the note
 *    "Designed for: …"), one quiet caption row ("appearance only" + Inspect),
 *    and a collapsed "Anything to change?" note so the default path is one
 *    decision: Use.
 *
 * Each look can provide its own composition for the same user task. Older
 * proposals fall back to the shared key screen painted in each theme. The frame
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

function LookPreview({ look, screenHtml, onOpen }: { look: Look; screenHtml: string; onOpen: () => void }): ReactElement {
  const doc = useMemo(() => {
    if (new TextEncoder().encode(screenHtml).byteLength > PREVIEW_LIMIT) return "";
    return mockDocument(screenHtml, themeToCssVars(look));
  }, [look, screenHtml]);
  return (
    <span className="look-app-wrap">
      {doc ? (
        <iframe
          className="look-app"
          title={`Preview: ${look.name}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={doc}
          aria-hidden="true"
          tabIndex={-1}
        />
      ) : (
        <span className="look-app look-app--empty" aria-hidden="true">
          This screen is too large to preview here.
        </span>
      )}
      {/* Owner 2026-10-24: clicking the preview opens it full-size — no
          scrolling below to the Inspect panel first. */}
      <button type="button" className="look-open-full" onClick={onOpen} aria-label={`Open ${look.name} full size`}>
        <Icon name="expand" title="" />
      </button>
    </span>
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
  const [noteOpen, setNoteOpen] = useState(false);
  const [fullRequest, setFullRequest] = useState(0);
  const pickerId = useId();
  const track = useRef<HTMLDivElement>(null);
  const index = Math.min(active, looks.length - 1);
  const chosen = looks[index]!;
  const prefersReduced =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const chosenScreen = chosen.screen ?? set.screen;
  // A typed note never hides behind the collapsed toggle.
  const noteVisible = noteOpen || note.trim().length > 0;

  // The track shows one full-width card at a time at every size (owner
  // 2026-10-24): a tab click scrolls to that look, and scrolling the track
  // keeps `active` in sync when the owner swipes instead. A programmatic
  // goTo suppresses that sync while its smooth scroll flies — mid-flight
  // edge sampling would re-latch the wrong card over the tab's own choice.
  const programmaticScroll = useRef(false);
  function goTo(i: number) {
    setActive(i);
    const strip = track.current;
    if (!strip) return;
    const card = strip.children[i] as HTMLElement | undefined;
    if (!card) return;
    programmaticScroll.current = true;
    strip.scrollTo({ left: card.offsetLeft, behavior: prefersReduced ? "auto" : "smooth" });
    setTimeout(() => { programmaticScroll.current = false; }, prefersReduced ? 50 : 450);
  }

  useEffect(() => {
    const strip = track.current;
    if (!strip) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (programmaticScroll.current) return;
        const edge = strip.getBoundingClientRect().left;
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
      <div className="look-for">
        <span className="look-for-head">
          <span className="look-for-label">Designed for</span>
          <button
            type="button"
            className="look-for-change"
            data-testid="looks-change-audience"
            disabled={props.busy}
            onClick={() => props.onMore(`Designed for: ${set.audience} — change this to: `)}
          >
            Change
          </button>
        </span>
        <b>{set.audience}</b>
      </div>

      {/* Name tabs choose at every width; the track below shows one
          full-width card at a time and scrolls between them. */}
      <div className="look-switch" role="group" aria-label="Choose a look" data-testid="looks-tabs">
        {looks.map((look, i) => (
          <button
            key={look.id}
            type="button"
            aria-pressed={i === index}
            disabled={props.busy}
            tabIndex={i === index ? 0 : -1}
            data-testid={`looks-tab-${look.id}`}
            onKeyDown={(event) => {
              const next = event.key === "Home" ? 0 : event.key === "End" ? looks.length - 1 :
                event.key === "ArrowRight" ? (index + 1) % looks.length :
                event.key === "ArrowLeft" ? (index - 1 + looks.length) % looks.length : null;
              if (next === null) return;
              event.preventDefault();
              setActive(next);
              (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }}
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
                name={`${pickerId}-look`}
                disabled={props.busy}
                value={look.id}
                aria-label={`Choose ${look.name}`}
                checked={i === index}
                onChange={() => setActive(i)}
              />
              <span className="look-selected">
                <Icon name="check" title="" /> Selected
              </span>
              <LookPreview
                look={look}
                screenHtml={(look.screen ?? set.screen).html}
                onOpen={() => {
                  setActive(i);
                  setFullRequest((epoch) => epoch + 1);
                }}
              />
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

      {/* Owner 2026-10-24: clicking a preview opens it full-size — that is the
          only expanded preview (no second panel below the options). The
          request counter only grows: every click is a fresh open. */}
      <DesignMockPreview
        key={chosen.id}
        mocks={[chosenScreen]}
        theme={chosen}
        dialogOnly
        fullRequest={fullRequest}
      />

      <div className="look-next">
        {noteVisible ? (
          <label htmlFor={`${pickerId}-note`} data-testid="looks-note-field">
            Anything to change?{" "}
            <span>Optional. For example: &ldquo;the first one, but warmer&rdquo;, or &ldquo;use the green from our logo&rdquo;.</span>
            <textarea
              id={`${pickerId}-note`}
              data-testid="looks-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              rows={2}
            />
          </label>
        ) : null}
        <button
          type="button"
          className="btn-key look-use"
          data-testid="looks-use"
          disabled={props.busy}
          onClick={() => props.onChoose(chosen.id, note.trim())}
        >
          {props.busy ? "Saving…" : `Use ${chosen.name}`}
        </button>
        <div className="row-actions look-quiet">
          <button
            type="button"
            className="btn-ghost"
            data-testid="looks-note-toggle"
            aria-expanded={noteVisible}
            disabled={props.busy}
            onClick={() => setNoteOpen(!noteVisible)}
          >
            {noteVisible ? "Hide change note" : "Anything to change?"}
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
