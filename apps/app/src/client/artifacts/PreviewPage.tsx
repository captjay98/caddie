import { useQuery } from '@tanstack/react-query';
import { useSearch, Link } from '@tanstack/react-router';
import { fetchJson, postJson } from '../api.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { InteractivePreview } from './InteractivePreview.tsx';
import { StatePanel } from '../states.tsx';
import { workflowQueryOptions } from '../workflow-query.ts';
import { ProjectTabs } from '../workspace/ProjectTabs.tsx';
import { AskForChange } from '../project/AskForChange.tsx';

/** Refreshable exact-target app view. A stale share never silently opens a
 * different revision, and generated code keeps the existing opaque sandbox. */
export function PreviewPage() {
 const chrome = useWorkspaceChrome();
 const search = useSearch({ strict: false }) as { project?: string; preview?: string; source?: string };
 const projectId = search.project;
 const workflow = useQuery({ ...workflowQueryOptions(chrome.actorId, projectId ?? null), enabled: Boolean(chrome.actorId && projectId && !search.preview) });
 const previewId = search.preview ?? workflow.data?.workflow?.previewId ?? (workflow.data?.importPreview?.status === 'ready' ? workflow.data.importPreview.outputId : undefined) ?? undefined;
 // A built app's preview id is always a workflow output (`out_…`); only
 // imported previews live in artifact revisions (`art_…`). A stale or
 // defaulted `source=artifact` in the URL must not route a built output down
 // the artifact path — its document lookup 404s there (2026-10-28 preview fix).
 const source = search.source === 'share' && search.preview
  ? 'share'
  : !search.preview || search.preview.startsWith('out_')
    ? 'workflow'
    : search.source === 'workflow' ? 'workflow' : 'artifact';
 const metadata = useQuery({ queryKey: ['preview-metadata', chrome.actorId, projectId, previewId], enabled: Boolean(chrome.actorId && projectId && previewId && source === 'workflow'), staleTime: Infinity, queryFn: () => fetchJson<{ outputId: string; kind: 'web' | 'flutter'; hasServer: boolean }>(`/api/projects/${encodeURIComponent(projectId!)}/workflow/preview/${encodeURIComponent(previewId!)}/metadata`) });
 const shares = useQuery({ queryKey: ['preview-target', chrome.actorId, projectId, search.preview], enabled: Boolean(chrome.actorId && projectId && search.source === 'share'), queryFn: () => fetchJson<{ previews: { id: string; revisionId: string; revoked: boolean; expiresAt: string }[] }>(`/api/projects/${encodeURIComponent(projectId!)}/previews`) });
 if (!projectId) return <StatePanel kind="empty" title="Choose an app preview" detail="Open a ready preview from Caddie or Brief." />;
 const share = shares.data?.previews.find(item => item.id === search.preview);
 const hasServer = metadata.data?.hasServer;
 // One stable frame: the header and the step rail are mounted from the first
 // paint and only the preview area changes. Swapping the whole page for a
 // loading panel made the header, steps and app window jump as each query
 // landed (owner 2026-10-27: "this layout shifts").
 const preview = (() => {
  if (!search.preview && workflow.isPending) return <StatePanel kind="loading" title="Finding your preview…" />;
  if (!search.preview && workflow.isError) return <StatePanel kind="error" title="The preview could not be loaded" onRetry={() => void workflow.refetch()} />;
  if (!previewId) return <>
   <StatePanel kind="empty" title="Your preview will appear here" detail="Once Caddie has built and checked your app, you can try it here." />
   <Link to="/runs" search={{ project: projectId }} className="btn-ghost">See build progress</Link>
  </>;
  if ((source === 'workflow' && metadata.isPending) || (source === 'share' && shares.isPending)) return <StatePanel kind="loading" title="Opening your app…" />;
  if (metadata.isError && source === 'workflow' || shares.isError && source === 'share') return <StatePanel kind="error" title="The preview could not be opened" onRetry={() => { void metadata.refetch(); void shares.refetch(); }} />;
  if (source === 'share' && (!share || share.revoked || Date.parse(share.expiresAt) <= Date.now())) return <StatePanel kind="empty" title="This preview is no longer available" detail="It may have expired or been revoked. Open the project to choose another version." />;
  const artifactId = source === 'share' ? share!.revisionId : previewId;
  const prefix = `/api/projects/${encodeURIComponent(projectId)}/workflow/preview/${encodeURIComponent(artifactId)}`;
  return <InteractivePreview actorId={chrome.actorId!} projectId={projectId} artifactId={artifactId} standalone {...(source === 'workflow' ? { contentUrl: prefix, kind: metadata.data?.kind ?? 'web', ...(hasServer ? { appRequestUrl: `${prefix}/app`, onResetData: () => postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/preview-data/reset`, {}).then(() => {}) } : {}) } : {})} />;
 })();
 return <div className="preview-page" data-testid="preview-page"><ProjectTabs current="preview" /><header className="preview-bar"><div><h1>Try your app</h1><p className="state-detail">Changes you make here use private test data.</p></div>{previewId ? <AskForChange projectId={projectId} /> : null}</header>{preview}</div>;
}
