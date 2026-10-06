/**
 * Minimal LRU cache (audit P05 finding 4): a plain `Map` grown per request
 * and never evicted is an unbounded memory leak in a long-lived Worker
 * isolate. This cache keeps the same get/set surface but bounds memory:
 * inserts beyond `maxEntries` evict the least-recently-used entry.
 *
 * Recency discipline: `get`/`has` on a PRESENT key makes it most-recent;
 * `set` on an existing key refreshes it. A miss never evicts anything.
 *
 * Used for the coordinator's runId → current plan revision map, which must
 * outlive the HTTP request that populated it (the agent turn reads it later
 * in the same isolate) — the bound is the compromise: recent runs stay hot,
 * memory stays finite.
 */
export class LruCache<K, V> {
	private readonly map = new Map<K, V>();

	constructor(private readonly maxEntries: number) {
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
			throw new Error('LruCache maxEntries must be a positive integer');
		}
	}

	get size(): number {
		return this.map.size;
	}

	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		// Refresh recency: delete + re-insert moves the key to the tail.
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	has(key: K): boolean {
		return this.map.has(key);
	}

	set(key: K, value: V): void {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.maxEntries) {
			const oldest = this.map.keys().next();
			if (oldest.done) break;
			this.map.delete(oldest.value);
		}
	}
}
