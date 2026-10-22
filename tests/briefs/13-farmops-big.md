# FarmOps (big)

- id: farmops-big
- size: big
- source: /Users/captjay98/projects/farmhand/v0-farmops (read-only reference, the owner's existing product) and plan part I section I
- theme: Agriculture — a full farm operations platform (Nebius x NVIDIA Global AI Hackathon big-app test)
- paired: no
- teamMode: on
- bigApp: yes
- modules: farms-and-team; structures-and-production-units; farm-events; feed; sales-expenses-suppliers; tasks; ai-insights-on-photos; notifications; subscriptions
- admin: yes

> This is the one big brief: a v0-farmops-sized farm platform with about 35-40
> tables across the 9 modules part I lists, an admin area, and the two
> test-mode features the plan allows this week — subscriptions (part J, "Test
> mode — no money moves") and notifications/emails to the project's test inbox
> (part K, "Not sent — test mode"). It is the campaign's measure of whether big
> apps build (plan section 10: big_apps → owner at >=75% of modules merged with
> every check green and the browser check passing; on-for-judges only at 100%).

## The 9 modules

1. Farms and team — farms, members and roles (owner, manager, worker); the
   team table and per-team/per-role access. This is the `core` module.
2. Structures and production units — poultry houses, ponds, and the batches in them.
3. Farm events — mortality, vaccinations, and dated notes against a unit.
4. Feed — feed types, stock levels, purchases, and usage against a unit.
5. Sales, expenses and suppliers — income and outgoings, and who supplied what.
6. Tasks — the day's tasks, assigned to members, with a done state.
7. AI insights on photos — a daily insight over the farm's own data, and an
   image insight: attach a photo of an animal or crop and get a read on it
   (part M, super tier, test mode for any paid behaviour).
8. Notifications — alerts (a mortality spike, low feed stock) that land in the
   project's test inbox, marked "Not sent — test mode" (part K).
9. Subscriptions — Free / Growth / Pro plans gating some reports, in test mode
   with the banner "Test mode — no money moves" (part J, test cards per D10).

Plus an admin area: the farm/app admin can manage members, see an audit of
actions, and toggle which plan a farm is on.

## What the person wants (their own words)

I want the full farm manager, not a cut-down version — everything in one app for
a real farm business. Each farm has its team with roles. I track my houses and
ponds and the batches in them, the daily events (deaths, vaccinations, notes),
all my feed (types, stock, what I bought, what each batch used), my sales,
expenses and suppliers, and the day's tasks for my workers. I want AI insights
that read my own numbers each day, and I want to snap a photo of a sick-looking
bird and get a read on it. The app should alert me when something's wrong —
mortality spiking, feed running low — and those alerts should show up in the
app's inbox. I want paid plans (Free, Growth, Pro) that unlock the better
reports, shown clearly as test mode so no real money moves. And an admin area so
I can manage my team, see what's been done, and change a farm's plan.

## Complete when

- I can sign in with an emailed code.
- Each of the 9 modules builds, with its tables and screens, under one shared schema.
- A farm has members with roles; any member sees the farm's records; a person
  from another farm cannot see, change, or delete them.
- For every record type in every module: it saves, survives a restart with the
  same values, can be edited and deleted, and is private to the farm as above.
- A `team-role` route (e.g. owner/manager-only) refuses a worker and allows the owner.
- An `admin` route refuses a non-admin member and allows the app's admin.
- AI insights return readable summaries from saved data; the photo insight
  accepts an image and returns a read (test-labelled for any paid behaviour).
- Notifications/alerts land in the project's test inbox marked "Not sent — test
  mode"; nothing is actually sent.
- Subscriptions: a locked report answers "plan required" until a test checkout
  with the paying card, then unlocks; the paying/declined/other test cards
  behave per D10; every billing screen shows "Test mode — no money moves".
- Every screen shows what the server saved.
- Build limit: the big-app limit ($40, D4). Wait up to 4 hours for the build.
