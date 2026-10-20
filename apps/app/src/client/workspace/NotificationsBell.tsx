import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { formatTimeAgo } from '@caddie/ui/time';
import { Icon } from '../icons.tsx';
import { useMarkNotificationRead, useUnreadNotifications, type AppNotification } from '../queries.ts';
import { useWorkspaceChrome } from './Chrome.tsx';

/**
 * The bell (plan 5.4): what Caddie raised while the person was away, such as a
 * build it paused. The count is the unread notifications; the panel lists each
 * in Caddie's own words. Opening a paused build marks it read and goes to that
 * build; any other notification is simply marked read. A failed read shows no
 * count rather than an error in the top bar.
 */
export function NotificationsBell(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const unread = useUnreadNotifications(actor);
	const markRead = useMarkNotificationRead(actor);
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const notes = unread.data ?? [];
	const count = notes.length;

	const act = async (note: AppNotification) => {
		try {
			await markRead.mutateAsync(note.id);
		} catch {
			/* Still go where it points; the bell keeps it until a read succeeds. */
		}
		setOpen(false);
		if (note.kind === 'build_paused' && note.projectId) {
			void navigate({ to: '/runs', search: { project: note.projectId } as never });
		}
	};

	return (
		<div
			className="account-menu notify-menu"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
			}}
		>
			<button
				type="button"
				className="capsule-icon notify-bell"
				data-testid="notifications-bell"
				aria-label={count > 0 ? `Notifications, ${count} new` : 'Notifications'}
				aria-expanded={open}
				title="Notifications"
				onClick={() => setOpen(!open)}
			>
				<Icon name="bell" title="Notifications" />
				{count > 0 ? (
					<span className="notify-count" data-testid="notifications-count" aria-hidden="true">
						{count > 9 ? '9+' : count}
					</span>
				) : null}
			</button>
			{open ? (
				<div className="account-menu-pop notify-pop" role="dialog" aria-label="Notifications" data-testid="notifications-panel">
					{count === 0 ? (
						<p className="notify-empty" data-testid="notifications-empty">
							Nothing new.
						</p>
					) : (
						<ul className="notify-list">
							{notes.map((note) => (
								<li key={note.id} className="notify-item" data-testid="notification">
									<b className="notify-title">{note.title}</b>
									<span className="notify-body">{note.body}</span>
									<span className="notify-meta">
										<span className="notify-time">{formatTimeAgo(note.createdAt)}</span>
										<button
											type="button"
											className="notify-open"
											data-testid="notification-open"
											disabled={markRead.isPending}
											onClick={() => void act(note)}
										>
											{note.kind === 'build_paused' && note.projectId ? 'Open the build' : 'Mark as read'}
										</button>
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}
