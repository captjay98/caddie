import type { D1Database } from '../auth.ts';
import { SandboxError, type SandboxPersistencePort, type SandboxRecord } from './sandbox.ts';

/** Durable across Worker isolates and requests; never recreate this store per request. */
export class D1SandboxPersistence implements SandboxPersistencePort {
	constructor(private readonly db: D1Database) {}

	async load(key: string): Promise<SandboxRecord | null> {
		const { results } = await this.db.prepare('SELECT recordJson FROM sandbox_bindings WHERE key = ?').bind(key).all<{ recordJson: string }>();
		const json = results[0]?.recordJson;
		if (!json) return null;
		try {
			const record = JSON.parse(json) as SandboxRecord;
			if (record.key !== key || !['session', 'operation', 'artifact'].includes(record.kind)) throw new Error('invalid binding');
			return record;
		} catch {
			throw new SandboxError(500, 'PERSISTENCE_CORRUPT', 'Stored sandbox binding is invalid; refusing to reset the workspace.', { key });
		}
	}

	async save(record: SandboxRecord): Promise<void> {
		await this.db.prepare(`INSERT INTO sandbox_bindings (key, kind, sessionId, projectId, runId, recordJson, updatedAt)
			VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
			kind = excluded.kind, sessionId = excluded.sessionId, projectId = excluded.projectId,
			runId = excluded.runId, recordJson = excluded.recordJson, updatedAt = excluded.updatedAt`)
			.bind(record.key, record.kind, record.sessionId, record.projectId, record.runId, JSON.stringify(record), record.updatedAt).run();
	}

	async claim(record: SandboxRecord): Promise<boolean> {
		const result = await this.db.prepare(`INSERT INTO sandbox_bindings (key, kind, sessionId, projectId, runId, recordJson, updatedAt)
			VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`)
			.bind(record.key, record.kind, record.sessionId, record.projectId, record.runId, JSON.stringify(record), record.updatedAt).run();
		return changed(result);
	}

	async compareAndSave(expected: SandboxRecord, record: SandboxRecord): Promise<boolean> {
		if (expected.key !== record.key) throw new SandboxError(400, 'INVALID_INPUT', 'Cannot change a sandbox binding key.');
		const result = await this.db.prepare(`UPDATE sandbox_bindings SET kind = ?, sessionId = ?, projectId = ?, runId = ?, recordJson = ?, updatedAt = ?
			WHERE key = ? AND recordJson = ?`)
			.bind(record.kind, record.sessionId, record.projectId, record.runId, JSON.stringify(record), record.updatedAt, record.key, JSON.stringify(expected)).run();
		return changed(result);
	}
}

function changed(result: unknown): boolean {
	const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
	if (typeof changes !== 'number') throw new SandboxError(500, 'PERSISTENCE_RESULT_INVALID', 'D1 did not report whether the sandbox binding was saved.');
	return changes === 1;
}
