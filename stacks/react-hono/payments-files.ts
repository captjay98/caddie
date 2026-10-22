/**
 * Payments and subscriptions in TEST MODE (plan part J, lane 9).
 *
 * These files are GENERATED into an app only when its "How your app works"
 * block (part B) declares `payments`, and they are all PROTECTED — a builder
 * never edits them, so the "Test mode — no money moves" banner and the locked-
 * route 402 can't be removed:
 *
 *   migrations/0000_caddie_payments.sql   caddie_subscriptions + caddie_payments
 *                                          (sorts after 0000_caddie_auth.sql and
 *                                          before the generated 0001_schema.sql).
 *   caddie/payments.ts                     the server: /api/caddie/billing,
 *                                          checkout, cancel, end-now, plus
 *                                          planAccess() for the generated access
 *                                          check (part B) to answer 402 on a
 *                                          locked route.
 *   caddie/Billing.tsx                     the React screens: plans, Upgrade, the
 *                                          checkout form, the renewal date and
 *                                          Cancel, each carrying the banner.
 *
 * Nothing real happens: no money moves, no provider is called, no outside
 * request is made. Test cards follow D10 — 4242 4242 4242 4242 succeeds,
 * 4000 0000 0000 0002 is declined, anything else is refused. The card number,
 * expiry and CVC are checked and then DROPPED; only the last 4 digits and the
 * outcome are kept. A plan renews one month or year after checkout; Cancel
 * keeps it until the renewal date; End now ends it at once (test mode only, so
 * a demo can show the locked state again).
 *
 * Going real later changes only Caddie's side: these same routes would call
 * Caddie's platform instead of the local tables, and the app's own code — which
 * only ever calls /api/caddie/billing and the screens — does not change.
 *
 * The generated sources avoid backticks and "${" so they can live in
 * String.raw (same rule as auth-files.ts).
 */

const file = (text: string) => text.replace(/^\n/, '');

// The em-dash, interpolated into String.raw templates. bun's transpiler turns a
// LITERAL non-ASCII character inside String.raw into the text "\u2014" (six
// chars), so the generated file would show "Test mode \u2014 no money moves".
// Interpolating it keeps the real character while String.raw still preserves
// the regex backslashes (\d, \D) the generated server needs.
const EM = '\u2014';

// The ellipsis, for the same reason as EM (bun mangles literal non-ASCII in String.raw).
const ELL = '\u2026';

/**
 * The one test "provider": D10's three cards, decided from the digits alone.
 * Exported so the behaviour has ONE definition the generated route and the
 * tests both read. Returns the outcome the row records.
 */
export type TestCardOutcome = 'paid' | 'declined' | 'refused';

export const PAYING_TEST_CARD = '4242424242424242';
export const DECLINED_TEST_CARD = '4000000000000002';

/** The banner on every billing screen; protected, so it can't be removed. */
export const TEST_MODE_BANNER = 'Test mode — no money moves';

/** The body a locked route answers with before checkout (part E step 9). */
export const PLAN_REQUIRED_BODY = { reason: 'plan_required' } as const;

export const PAYMENTS_FILES: Readonly<Record<string, string>> = {
	// Sorts after 0000_caddie_auth.sql and before 0001_schema.sql (name order).
	'migrations/0000_caddie_payments.sql': file(String.raw`
-- Caddie runtime migration ${EM} do not edit. Payments in TEST MODE (part J): a
-- person's current plan (caddie_subscriptions) and a record of each test
-- checkout (caddie_payments). No full card number is ever stored ${EM} only the
-- last 4 digits and the outcome.
create table caddie_subscriptions (
  personId text not null primary key,
  planId text not null,
  status text not null,
  renewsAt text,
  cancelAt text,
  createdAt text not null,
  updatedAt text not null
);

create table caddie_payments (
  id text not null primary key,
  personId text not null,
  planId text not null,
  amountMinor integer not null,
  currency text not null,
  outcome text not null,
  cardLast4 text not null,
  createdAt text not null
);

create index ix_caddie_payments_personId on caddie_payments (personId);
`),

	'caddie/payments.ts': file(String.raw`
// Caddie runtime file ${EM} do not edit. Payments and subscriptions in TEST MODE.
// No money moves, no provider is called. Mount it from src/server.ts:
//
//   import { mountPayments } from "../caddie/payments";
//   mountPayments(app, { currency: "USD", plans: [{ id: "pro", priceMinor: 900, interval: "month" }] });
//
// Routes (all under /api/caddie/, all need sign-in):
//   GET  /api/caddie/billing    the plans, the person's plan and its renewal date
//   POST /api/caddie/checkout   { planId, cardNumber, expiry, cvc }
//   POST /api/caddie/cancel     keep the plan until its renewal date
//   POST /api/caddie/end-now    end it at once (TEST MODE only, for demos)
//
// The generated access check (part B) calls planAccess(c, plans) before a
// locked route runs and answers 402 { "reason": "plan_required" } when the
// person has no active plan in the set. Screens live in caddie/Billing.tsx.
import type { Context, Hono } from "hono";
import { requireUser } from "./auth";
import type { D1Database } from "./d1";
import type { CaddiePlatform } from "./platform";

export interface BillingPlan {
  id: string;
  /** Whole minor units (cents). */
  priceMinor: number;
  interval: "month" | "year";
}

export interface PaymentsConfig {
  /** A 3-letter currency code, e.g. "USD". */
  currency: string;
  plans: BillingPlan[];
}

type PaymentsEnv = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string };

export interface SubscriptionRow {
  personId: string;
  planId: string;
  status: "active" | "canceled" | "ended";
  renewsAt: string | null;
  cancelAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// The one test "provider": D10. The outcome is decided from the digits alone ${EM}
// nothing is sent anywhere. 4242${ELL} succeeds, 4000 0000 0000 0002 is declined,
// anything else is refused.
export type CardOutcome = "paid" | "declined" | "refused";

export function testCardOutcome(cardNumber: string): CardOutcome {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits === "4242424242424242") return "paid";
  if (digits === "4000000000000002") return "declined";
  return "refused";
}

/** The last 4 digits ${EM} the ONLY part of the card ever kept. */
export function last4(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, "");
  return digits.slice(-4);
}

/** One month or one year after the given moment, as ISO text. */
export function renewalFrom(start: Date, interval: "month" | "year"): string {
  const next = new Date(start.getTime());
  if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

function json415(c: Context) {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
}

/** The person's current subscription row, or null. */
export async function subscriptionOf(db: D1Database, personId: string): Promise<SubscriptionRow | null> {
  return db.prepare("select * from caddie_subscriptions where personId = ?").bind(personId).first<SubscriptionRow>();
}

/**
 * Whether the person has an ACTIVE plan in the given set right now. An ended or
 * canceled-and-past-its-renewal subscription does not count. Used by the
 * generated access check for locked routes.
 */
export async function hasActivePlan(db: D1Database, personId: string, planIds: string[], now = new Date()): Promise<boolean> {
  const row = await subscriptionOf(db, personId);
  if (!row || !planIds.includes(row.planId)) return false;
  if (row.status === "ended") return false;
  // "canceled" keeps access until renewsAt; after that it is over.
  if (row.renewsAt && new Date(row.renewsAt).getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Guard a locked route: answer 402 { reason: "plan_required" } unless the
 * signed-in person has an active plan in planIds. The generated access check
 * calls this; builders never write it.
 */
export async function planAccess(c: Context, planIds: string[]): Promise<Response | null> {
  const user = await requireUser(c);
  const env = c.env as PaymentsEnv;
  if (await hasActivePlan(env.DB, user.id, planIds)) return null;
  return c.json({ reason: "plan_required" }, 402);
}

/** Add the billing routes under /api/caddie/. Call once in src/server.ts. */
export function mountPayments<E extends { Bindings: PaymentsEnv }>(app: Hono<E>, config: PaymentsConfig): void {
  const plans = config.plans;
  const planById = new Map(plans.map((p) => [p.id, p]));

  app.get("/caddie/billing", async (c) => {
    const user = await requireUser(c);
    const env = c.env as PaymentsEnv;
    const current = await subscriptionOf(env.DB, user.id);
    return c.json({
      testMode: true,
      currency: config.currency,
      plans,
      current: current
        ? { planId: current.planId, status: current.status, renewsAt: current.renewsAt, cancelAt: current.cancelAt }
        : null,
    });
  });

  app.post("/caddie/checkout", async (c) => {
    const user = await requireUser(c);
    const env = c.env as PaymentsEnv;
    if (!json415(c)) return c.json({ error: "Send JSON." }, 415);
    const body = (await c.req.json().catch(() => ({}))) as { planId?: unknown; cardNumber?: unknown; expiry?: unknown; cvc?: unknown };
    const plan = typeof body.planId === "string" ? planById.get(body.planId) : undefined;
    if (!plan) return c.json({ error: "Choose a plan." }, 400);
    const cardNumber = typeof body.cardNumber === "string" ? body.cardNumber : "";
    const expiry = typeof body.expiry === "string" ? body.expiry : "";
    const cvc = typeof body.cvc === "string" ? body.cvc : "";
    if (!/^\d{2}\s*\/\s*\d{2,4}$/.test(expiry.trim()) || !/^\d{3,4}$/.test(cvc.trim())) {
      return c.json({ error: "Enter the card's expiry (MM/YY) and CVC." }, 400);
    }
    // Decide the outcome from the digits (D10) and then DROP the card: only the
    // last 4 and the outcome are kept. expiry and cvc are never stored.
    const outcome = testCardOutcome(cardNumber);
    const now = new Date();
    await env.DB.prepare(
      "insert into caddie_payments (id, personId, planId, amountMinor, currency, outcome, cardLast4, createdAt) values (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), user.id, plan.id, plan.priceMinor, config.currency, outcome, last4(cardNumber), now.toISOString())
      .run();
    if (outcome !== "paid") {
      return c.json({ outcome, error: outcome === "declined" ? "That card was declined (test card)." : "That card number isn't a test card." }, 402);
    }
    const renewsAt = renewalFrom(now, plan.interval);
    await env.DB.prepare(
      "insert into caddie_subscriptions (personId, planId, status, renewsAt, cancelAt, createdAt, updatedAt)" +
        " values (?, ?, 'active', ?, null, ?, ?)" +
        " on conflict(personId) do update set planId = excluded.planId, status = 'active', renewsAt = excluded.renewsAt," +
        " cancelAt = null, updatedAt = excluded.updatedAt",
    )
      .bind(user.id, plan.id, renewsAt, now.toISOString(), now.toISOString())
      .run();
    return c.json({ outcome: "paid", planId: plan.id, renewsAt });
  });

  app.post("/caddie/cancel", async (c) => {
    const user = await requireUser(c);
    const env = c.env as PaymentsEnv;
    const current = await subscriptionOf(env.DB, user.id);
    if (!current || current.status === "ended") return c.json({ error: "No active plan." }, 400);
    const now = new Date().toISOString();
    // Cancel keeps the plan until its renewal date (renewsAt unchanged).
    await env.DB.prepare("update caddie_subscriptions set status = 'canceled', cancelAt = ?, updatedAt = ? where personId = ?")
      .bind(now, now, user.id)
      .run();
    return c.json({ status: "canceled", renewsAt: current.renewsAt });
  });

  // TEST MODE only: end the plan at once, so a demo can show the locked state
  // again. There is no real-world equivalent; going real drops this route.
  app.post("/caddie/end-now", async (c) => {
    const user = await requireUser(c);
    const env = c.env as PaymentsEnv;
    const current = await subscriptionOf(env.DB, user.id);
    if (!current || current.status === "ended") return c.json({ error: "No active plan." }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare("update caddie_subscriptions set status = 'ended', renewsAt = null, cancelAt = ?, updatedAt = ? where personId = ?")
      .bind(now, now, user.id)
      .run();
    return c.json({ status: "ended" });
  });
}
`),

	'caddie/Billing.tsx': file(String.raw`
// Caddie runtime file ${EM} do not edit. The billing screens in TEST MODE: the
// plans, Upgrade, the test checkout form, the renewal date and Cancel. Every
// billing screen carries the banner "Test mode ${EM} no money moves"; this file is
// protected, so the banner can't be removed.
//
//   import { Billing } from "../caddie/Billing";
//   // in a screen: <Billing />
//
// Use the D10 test cards: 4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 is
// declined. Style it from src/styles.css with the caddie-billing classes.
import { useEffect, useState, type FormEvent } from "react";

export const TEST_MODE_BANNER = "Test mode ${EM} no money moves";

interface Plan {
  id: string;
  priceMinor: number;
  interval: "month" | "year";
}

interface BillingState {
  currency: string;
  plans: Plan[];
  current: { planId: string; status: "active" | "canceled" | "ended"; renewsAt: string | null; cancelAt: string | null } | null;
}

function price(currency: string, minor: number): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2) + " " + currency;
  }
}

function TestModeBanner() {
  return (
    <p className="caddie-billing-banner" role="note">
      {TEST_MODE_BANNER}
    </p>
  );
}

async function getBilling(): Promise<BillingState | null> {
  const res = await fetch("/api/caddie/billing");
  if (!res.ok) return null;
  return (await res.json()) as BillingState;
}

export function Billing(props: { title?: string }) {
  const [state, setState] = useState<BillingState | null | undefined>(undefined);
  const [planId, setPlanId] = useState<string>("");
  const [card, setCard] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function reload() {
    const next = await getBilling();
    setState(next);
    if (next && !planId && next.plans[0]) setPlanId(next.plans[0].id);
  }

  useEffect(() => {
    void reload();
  }, []);

  async function checkout(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/caddie/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, cardNumber: card, expiry, cvc }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; outcome?: string };
    setBusy(false);
    if (res.ok) {
      setMessage("You're on the plan (test mode ${EM} no money moved).");
      setCard("");
      setExpiry("");
      setCvc("");
      await reload();
    } else {
      setMessage(data.error ?? "Checkout didn't go through.");
    }
  }

  async function act(path: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    await fetch(path, { method: "POST" });
    setBusy(false);
    await reload();
  }

  if (state === undefined) return <p>Loading${ELL}</p>;
  if (state === null)
    return (
      <div className="caddie-billing">
        <TestModeBanner />
        <p>Sign in to manage your plan.</p>
      </div>
    );

  const current = state.current;
  const active = current && current.status !== "ended";

  return (
    <div className="caddie-billing">
      <h2>{props.title ?? "Plans"}</h2>
      <TestModeBanner />
      {active && current ? (
        <div className="caddie-billing-current">
          <p>
            You're on <strong>{current.planId}</strong>
            {current.status === "canceled" ? " (canceling)" : ""}.
          </p>
          {current.renewsAt ? (
            <p>
              {current.status === "canceled" ? "Access until " : "Renews "}
              {new Date(current.renewsAt).toLocaleDateString()}.
            </p>
          ) : null}
          {current.status === "active" ? (
            <button type="button" disabled={busy} onClick={() => void act("/api/caddie/cancel")}>
              Cancel plan
            </button>
          ) : null}
          <button type="button" className="caddie-billing-endnow" disabled={busy} onClick={() => void act("/api/caddie/end-now")}>
            End now (test mode)
          </button>
        </div>
      ) : (
        <form className="caddie-billing-checkout" onSubmit={checkout}>
          <fieldset>
            <legend>Choose a plan</legend>
            {state.plans.map((plan) => (
              <label key={plan.id}>
                <input type="radio" name="plan" value={plan.id} checked={planId === plan.id} onChange={() => setPlanId(plan.id)} />
                {plan.id} ${EM} {price(state.currency, plan.priceMinor)}/{plan.interval}
              </label>
            ))}
          </fieldset>
          <label htmlFor="caddie-billing-card">Card number</label>
          <input
            id="caddie-billing-card"
            inputMode="numeric"
            autoComplete="off"
            placeholder="4242 4242 4242 4242"
            value={card}
            onChange={(event) => setCard(event.target.value)}
            required
          />
          <label htmlFor="caddie-billing-expiry">Expiry (MM/YY)</label>
          <input id="caddie-billing-expiry" placeholder="12/34" value={expiry} onChange={(event) => setExpiry(event.target.value)} required />
          <label htmlFor="caddie-billing-cvc">CVC</label>
          <input id="caddie-billing-cvc" inputMode="numeric" placeholder="123" value={cvc} onChange={(event) => setCvc(event.target.value)} required />
          <button type="submit" disabled={busy}>
            {busy ? "Working${ELL}" : "Upgrade"}
          </button>
        </form>
      )}
      {message ? (
        <p role="status" className="caddie-billing-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}
`),
};
