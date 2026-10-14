import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

export async function onboardingStatus(db: D1Database, actorId: string): Promise<{ completedAt: string | null }> {
 const { results } = await db.prepare('SELECT o.completedAt FROM user_onboarding o JOIN user_profiles p ON p.userId = o.userId WHERE o.userId = ?').bind(actorId).all<{ completedAt: string }>();
 return { completedAt: results[0]?.completedAt ?? null };
}

export async function completeOnboarding(db: D1Database, actorId: string): Promise<{ completedAt: string | null }> {
 const { results } = await db.prepare('SELECT userId FROM user_profiles WHERE userId = ?').bind(actorId).all();
 if (!results.length) throw new ScopeError(409, 'profile_required', 'Save your profile before finishing onboarding.');
 await db.prepare('INSERT INTO user_onboarding (userId, completedAt) VALUES (?, ?) ON CONFLICT(userId) DO NOTHING').bind(actorId, new Date().toISOString()).run();
 return onboardingStatus(db, actorId);
}
