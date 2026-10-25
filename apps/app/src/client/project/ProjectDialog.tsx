import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../icons.tsx";

/** Native modal supplies focus containment, Escape and focus restoration. */
export function ProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      className={`project-dialog${props.wide ? " project-dialog--wide" : ""}`}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          event.currentTarget.close();
      }}
    >
      <div className="project-dialog-head">
        <h2 id={titleId}>{props.title}</h2>
        <button
          type="button"
          className="project-dialog-close"
          aria-label={`Close ${props.title.toLowerCase()}`}
          onClick={() => ref.current?.close()}
          autoFocus
        >
          <Icon name="x" title="" />
        </button>
      </div>
      {props.open ? <div className="project-dialog-body">{props.children}</div> : null}
    </dialog>
  );
}
