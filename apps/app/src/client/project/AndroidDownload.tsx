import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson, postJson } from '../api.ts';
import type { AndroidDownloadView } from '../../server/android-app.ts';

/** A signed link is obtained only when the owner asks to download or show QR. */
export function AndroidDownload({ actorId, projectId }: { actorId: string; projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/android`;
  const state = useQuery({ queryKey: ['android-download', actorId, projectId], queryFn: () => fetchJson<{ android: AndroidDownloadView | null }>(base), refetchInterval: 10_000 });
  const [qr, setQr] = useState<{ svg: string; expiresAt: string } | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const android = state.data?.android;
  useEffect(() => { setQr(null); setShowQr(false); setError(null); }, [actorId, projectId, android?.outputId]);
  // A regular web project (or a failed metadata read) never gets Android actions.
  if (!android) return null;
  const phone = /\bAndroid\b/i.test(navigator.userAgent);
  async function prepare(download: boolean) {
    setBusy(true); setError(null);
    try {
      const result = await postJson<{ android: AndroidDownloadView; qrSvg: string }>(`${base}/link`, {});
      if (!result.android.url || !result.android.expiresAt) throw new Error('The Android download is not ready.');
      setQr({ svg: result.qrSvg, expiresAt: result.android.expiresAt });
      if (download) {
        const link = document.createElement('a'); link.href = result.android.url; link.download = ''; document.body.append(link); link.click(); link.remove();
      } else setShowQr(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The Android download could not be prepared.'); }
    finally { setBusy(false); }
  }
  return <section className="android-download" data-testid="android-download" aria-label="Android app">
    <p className="state-detail">{android.message}</p>
    {android.bytes ? <div className="row-actions">
      <button className="btn-key" type="button" disabled={busy} onClick={() => void prepare(true)}>
        {busy ? 'Preparing download…' : phone ? 'Install on this phone (.apk)' : `Download Android app (${(android.bytes / 1_000_000).toFixed(1)} MB)`}
      </button>
      {!phone ? <button className="btn-ghost" type="button" disabled={busy} aria-expanded={showQr} onClick={() => showQr ? setShowQr(false) : void prepare(false)}>Scan to install on Android</button> : null}
    </div> : null}
    {showQr && qr ? <div className="android-download-qr">
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`} width="240" height="240" alt="Scan to download this Android app" />
      <p className="state-detail">This private link expires in 30 minutes. Show a new code after it expires.</p>
    </div> : null}
    {error ? <p className="state-detail" role="alert">{error}</p> : null}
  </section>;
}
