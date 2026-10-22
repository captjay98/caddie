# HerdVoice

- id: herdvoice
- size: medium
- source: repo (docs/evidence/2026-10-20-herdvoice-demo/README.md and handover-2026-10-22.md — the six recorded features; no verbatim original brief is recorded)
- theme: Agriculture / animal health (Nebius x NVIDIA Global AI Hackathon)
- paired: no
- teamMode: off

> Note on provenance: the original user brief is NOT recorded verbatim. The
> repo DOES record the built app's purpose — "Lets herders report a sick
> animal by voice, in their own language" — and its exact six features
> (`animal-registry`, `case-capture`, `ai-analysis`, `herd-timeline`,
> `offline-sync`, `disease-guide`) with the real demo path "type a case, get
> ranked causes and a next action, reload, see it in the timeline"
> (docs/evidence/2026-10-20-herdvoice-demo). This brief is written FROM that
> recorded material, in a herder's voice, and marked reconstructed. The known
> defects that rolled it back (in-memory storage; wrong AI tier "balanced")
> are exactly the persistence and AI-tier failures team mode's checks catch.

## What the person wants (their own words) — reconstructed

I keep livestock and when an animal falls sick I want to describe what's wrong
in plain words and have the app suggest what it might be and what to do next. I
want to register my animals, record a case for an animal (the symptoms), and
get back the most likely causes ranked with a recommended next action. I want a
timeline of all the cases so far, and a simple guide to common diseases. It has
to keep my animals and cases saved — the last version forgot everything when I
reloaded.

## Complete when

- I can sign in with an emailed code and only see my own animals and cases.
- I can register an animal and record a case (symptoms) for it; both save.
- After a reload/restart, my animals and cases are still there with the same values.
- An animal and a case can be edited and deleted.
- Another signed-in person cannot see, change, or delete my animals or cases.
- The AI analysis returns ranked likely causes and a recommended next action
  for a case, and that result is saved (not "analysis pending").
- There is a herd timeline listing cases from saved data, and a disease guide.
- Every screen shows what the server saved, including after a reload.
