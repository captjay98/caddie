# FarmLog AI

- id: farmlog
- size: medium
- source: repo (Caddie project "FarmLog AI", purpose recorded in docs/reviews/2026-10-21-projects-redesign; no verbatim original brief is recorded)
- theme: Agriculture — smallholder farm operations (Nebius x NVIDIA Global AI Hackathon)
- paired: no
- teamMode: off

> Note on provenance: the original user brief for FarmLog AI is NOT recorded
> verbatim in the repo. What IS recorded is the project's purpose — "Helps
> small farmers log feed and spot a sick animal early" — and a mocked project
> screen whose app card reads "Today's feed · 3 of 4 pens logged" and "Goat 12
> is eating less · Down 40% over 3 days. Check on her." plus a mocked seed
> prompt "Build FarmLog AI for small farmers" (docs/reviews/2026-10-21-
> projects-redesign/tools/{capture-today,build-mockups}.ts). This brief is
> written FROM that recorded material, in the voice a farmer would use, and
> marked reconstructed.

## What the person wants (their own words) — reconstructed

I keep a few pens of animals and I lose track of feed. I want an app where
each day I log how much feed each pen got, so I can see which pens I've done
and which I've missed. If an animal starts eating a lot less for a few days I
want the app to flag it so I can check on it before it gets really sick. Just
me using it, saved so I don't lose last week's logs.

## Complete when

- I can sign in with an emailed code and only see my own farm's logs.
- I can add a pen and log a daily feed amount for a pen; both save.
- After a restart, my pens and feed logs are still there with the same values.
- A feed log can be edited and deleted.
- Another signed-in person cannot see, change, or delete my pens or logs.
- There is a "today" view showing which pens have been logged today.
- The AI insight flags an animal/pen whose feed has dropped sharply over recent
  days, computed from saved logs.
- Every screen shows what the server saved.
