import { useQuery } from '@tanstack/react-query';
import { useSearch, Link } from '@tanstack/react-router';
import { fetchJson, postJson } from '../api.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { InteractivePreview } from './InteractivePreview.tsx';
import { StatePanel } from '../states.tsx';

/** Refreshable exact-target app view. A stale share never silently opens a
 * different revision, and generated code keeps the existing opaque sandbox. */
export function PreviewPage() {
 const chrome = useWorkspaceChrome();
 const search = useSearch({ strict: false }) as { project?: string; preview?: string; source?: string };
 const projectId = search.project;
 const metadata = useQuery({ queryKey: ['preview-metadata', chrome.actorId, projectId, search.preview], enabled: Boolean(chrome.actorId && projectId && search.preview && search.source === 'workflow'), staleTime: Infinity, queryFn: () => fetchJson<{ outputId: string; kind: 'web' | 'flutter'; hasServer: boolean }>(`/api/projects/${encodeURIComponent(projectId!)}/workflow/preview/${encodeURIComponent(search.preview!)}/metadata`) });
 const shares = useQuery({ queryKey: ['preview-target', chrome.actorId, projectId, search.preview], enabled: Boolean(chrome.actorId && projectId && search.source === 'share'), queryFn: () => fetchJson<{ previews: { id: string; revisionId: string; revoked: boolean; expiresAt: string }[] }>(`/api/projects/${encodeURIComponent(projectId!)}/previews`) });
 if (!projectId || !search.preview) return <StatePanel kind="empty" title="Choose an app preview" detail="Open a ready preview from Caddie or Brief." />;
 const source = search.source ?? 'artifact';
 if ((source === 'workflow' && metadata.isPending) || (source === 'share' && shares.isPending)) return <StatePanel kind="loading" title="Opening your app…" />;
 if (metadata.isError && source === 'workflow' || shares.isError && source === 'share') return <StatePanel kind="error" title="The preview could not be opened" onRetry={() => { void metadata.refetch(); void shares.refetch(); }} />;
 const share = shares.data?.previews.find(item => item.id === search.preview);
 if (source === 'share' && (!share || share.revoked || Date.parse(share.expiresAt) <= Date.now())) return <StatePanel kind="empty" title="This preview is no longer available" detail="It may have expired or been revoked. Open the project to choose another version." />;
 const artifactId = source === 'share' ? share!.revisionId : search.preview;
 const hasServer = metadata.data?.hasServer;
 const prefix = `/api/projects/${encodeURIComponent(projectId)}/workflow/preview/${encodeURIComponent(artifactId)}`;
 return <div className="preview-page" data-testid="preview-page"><header><div><p className="kicker">APP PREVIEW</p><h1>{chrome.buildProjects.find(p => p.id === projectId)?.name ?? 'Try your app'}</h1><p className="state-detail">Try the app here. Publishing is a separate decision.</p></div><Link to="/project" search={{ project: projectId }} className="btn-ghost">Back to project</Link></header><InteractivePreview actorId={chrome.actorId!} projectId={projectId} artifactId={artifactId} standalone {...(source === 'workflow' ? { contentUrl: prefix, kind: metadata.data?.kind ?? 'web', ...(hasServer ? { appRequestUrl: `${prefix}/app`, onResetData: () => postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/preview-data/reset`, {}).then(() => {}) } : {}) } : {})} /></div>;
}
