import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "../api.ts";
import { Icon } from "../icons.tsx";

/**
 * Keys for outside services (Publish programme stage 8). The app's builder can
 * ask for a key it needs; the owner pastes it once. Caddie never shows a saved
 * key again: the server only ever returns names, descriptions and status.
 */

export interface AppKeyView {
  name: string;
  status: "requested" | "set";
  description: string | null;
  helpUrl: string | null;
  requested: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AppKeysResponse {
  configured: boolean;
  keys: AppKeyView[];
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

/** "weather api key" -> "WEATHER_API_KEY" while typing. */
function toKeyName(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 64);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function keysPath(projectId: string, name?: string): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/keys`;
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function AppKeys(props: { actorId: string; projectId: string; hasServer: boolean }): ReactElement | null {
  const keys = useQuery({
    queryKey: ["app-keys", props.actorId, props.projectId],
    queryFn: () => fetchJson<AppKeysResponse>(keysPath(props.projectId)),
  });
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ name: string; message: string } | null>(null);

  const list = keys.data?.keys ?? [];
  if (!props.hasServer && list.length === 0) return null;
  const configured = keys.data?.configured ?? true;
  const needed = list.filter((key) => key.status === "requested").length;

  async function act(name: string, run: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(name);
    setError(null);
    try {
      await run();
      await keys.refetch();
      // Publishing reads which keys are still missing.
      void queryClient.invalidateQueries({ queryKey: ["publish", props.actorId, props.projectId] });
      return true;
    } catch (cause) {
      setError({ name, message: errorText(cause) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const save = (name: string, value: string) =>
    act(name, () =>
      fetchJson(keysPath(props.projectId, name), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      }),
    );

  const remove = (name: string) => act(name, () => fetchJson(keysPath(props.projectId, name), { method: "DELETE" }));

  return (
    <div className="app-keys" data-testid="app-keys">
      <div className="app-keys-head">
        <Icon name="key" title="" />
        <h4>Keys for outside services</h4>
        {needed > 0 ? (
          <span className="badge" data-tone="warn" data-testid="app-keys-needed">
            {needed === 1 ? "1 needed" : `${needed} needed`}
          </span>
        ) : null}
      </div>
      <p className="state-detail app-keys-intro">
        Only your app&rsquo;s server can use these. Caddie never shows a saved key again, and the AI never sees it.
      </p>
      {keys.isError ? (
        <p role="alert" className="state-detail">
          Couldn&rsquo;t load the keys.{" "}
          <button type="button" className="r-link" onClick={() => void keys.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {!configured ? (
        <p className="state-detail" data-testid="app-keys-unavailable">
          Saving keys isn&rsquo;t set up on this Caddie server yet.
        </p>
      ) : null}
      {list.length > 0 ? (
        <ul className="app-keys-list">
          {list.map((key) => (
            <li key={key.name} className="app-keys-row" data-testid={`app-key-${key.name}`} data-status={key.status}>
              <div className="app-keys-what">
                <span className="app-keys-desc">{key.description ?? key.name}</span>
                <span className="app-keys-meta">
                  <code>{key.name}</code>
                  {key.status === "set" ? (
                    <span className="badge" data-tone="ok">
                      <Icon name="check" title="" /> Saved
                    </span>
                  ) : (
                    <span className="badge" data-tone="warn">
                      Needed
                    </span>
                  )}
                </span>
                {key.helpUrl && key.status === "requested" ? (
                  <a className="app-keys-help" href={key.helpUrl} target="_blank" rel="noopener noreferrer">
                    Where to get it ({hostOf(key.helpUrl)})
                  </a>
                ) : null}
              </div>
              {editing === key.name ? (
                <KeyValueForm
                  name={key.name}
                  busy={busy === key.name}
                  submitLabel={key.status === "set" ? "Save new key" : "Save key"}
                  onCancel={() => setEditing(null)}
                  onSave={async (value) => {
                    if (await save(key.name, value)) setEditing(null);
                  }}
                />
              ) : confirmRemove === key.name ? (
                <div className="app-keys-confirm" role="group" aria-label={`Remove ${key.name}`}>
                  <span>
                    {key.requested
                      ? "Remove this key? The app will ask for it again."
                      : "Remove this key? The app stops being able to use it."}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null}
                    data-testid={`app-key-remove-confirm-${key.name}`}
                    onClick={async () => {
                      if (await remove(key.name)) setConfirmRemove(null);
                    }}
                  >
                    {busy === key.name ? "Removing…" : "Remove"}
                  </button>
                  <button type="button" className="r-link" onClick={() => setConfirmRemove(null)}>
                    Keep it
                  </button>
                </div>
              ) : configured ? (
                <div className="row-actions">
                  <button
                    type="button"
                    className={key.status === "set" ? "btn-ghost" : "btn-key"}
                    disabled={busy !== null}
                    data-testid={`app-key-edit-${key.name}`}
                    onClick={() => {
                      setConfirmRemove(null);
                      setEditing(key.name);
                    }}
                  >
                    {key.status === "set" ? "Replace" : "Add key"}
                  </button>
                  {key.status === "set" || !key.requested ? (
                    <button
                      type="button"
                      className="r-link"
                      disabled={busy !== null}
                      data-testid={`app-key-remove-${key.name}`}
                      onClick={() => {
                        setEditing(null);
                        setConfirmRemove(key.name);
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ) : null}
              {error?.name === key.name ? (
                <p role="alert" className="app-keys-error">
                  {error.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : configured && keys.isSuccess ? (
        <p className="state-detail app-keys-empty">This app doesn&rsquo;t need any keys yet.</p>
      ) : null}
      {configured && keys.isSuccess ? (
        adding ? (
          <NewKeyForm
            busy={busy === "__new"}
            error={error?.name === "__new" ? error.message : null}
            onCancel={() => {
              setAdding(false);
              if (error?.name === "__new") setError(null);
            }}
            onSave={async (name, value) => {
              if (await act("__new", () =>
                fetchJson(keysPath(props.projectId, name), {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ value }),
                }),
              ))
                setAdding(false);
            }}
          />
        ) : (
          <button type="button" className="r-link app-keys-add" data-testid="app-keys-add" onClick={() => setAdding(true)}>
            <Icon name="plus" title="" /> Add a key
          </button>
        )
      ) : null}
    </div>
  );
}

function KeyValueForm(props: {
  name: string;
  busy: boolean;
  submitLabel: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
}): ReactElement {
  const [value, setValue] = useState("");
  const id = `app-key-value-${props.name}`;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) void props.onSave(value);
  }
  return (
    <form className="app-keys-form" onSubmit={submit}>
      <label htmlFor={id} className="app-keys-label">
        Paste the key
      </label>
      <input
        id={id}
        className="input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        data-testid={`app-key-input-${props.name}`}
        autoFocus
      />
      <div className="row-actions">
        <button type="submit" className="btn-key" disabled={props.busy || value.trim().length === 0} data-testid={`app-key-save-${props.name}`}>
          {props.busy ? "Saving…" : props.submitLabel}
        </button>
        <button type="button" className="r-link" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function NewKeyForm(props: {
  busy: boolean;
  error: string | null;
  onSave: (name: string, value: string) => Promise<void>;
  onCancel: () => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameOk = NAME_PATTERN.test(name);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (nameOk && value.trim()) void props.onSave(name, value);
  }
  return (
    <form className="app-keys-form" onSubmit={submit} data-testid="app-keys-new">
      <label htmlFor="app-key-new-name" className="app-keys-label">
        Name
      </label>
      <input
        id="app-key-new-name"
        className="input"
        placeholder="WEATHER_API_KEY"
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(event) => setName(toKeyName(event.target.value))}
        aria-describedby="app-key-new-name-hint"
        data-testid="app-keys-new-name"
        autoFocus
      />
      <span id="app-key-new-name-hint" className="app-keys-hint">
        Use the name your app&rsquo;s code reads, like WEATHER_API_KEY.
      </span>
      <label htmlFor="app-key-new-value" className="app-keys-label">
        Key
      </label>
      <input
        id="app-key-new-value"
        className="input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        data-testid="app-keys-new-value"
      />
      {props.error ? (
        <p role="alert" className="app-keys-error">
          {props.error}
        </p>
      ) : null}
      <div className="row-actions">
        <button type="submit" className="btn-key" disabled={props.busy || !nameOk || value.trim().length === 0} data-testid="app-keys-new-save">
          {props.busy ? "Saving…" : "Save key"}
        </button>
        <button type="button" className="r-link" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
