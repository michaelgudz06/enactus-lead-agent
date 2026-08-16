# Enactus SFU — Lead Agent

Sponsor prospecting and pipeline tracking for the Enactus SFU External Relations
team. You describe the sponsors you want in plain English; the app searches the
open web, qualifies what it finds, and drops the survivors into a pipeline the
team works out of for the rest of the year.

It replaces the spreadsheet-and-shared-inbox setup that used to get rebuilt from
scratch at every executive handover.

## Why it exists

External Relations turns over completely each year. The prospect list, the
notes on who already said no, and the reason a company was worth approaching all
used to live in one outgoing VP's head. This keeps them in a database instead.

## What it does

| Page | Purpose |
| --- | --- |
| `/agent` | Describe a target ("bakeries in Burnaby that sponsor student events"). Streams its reasoning while it works. |
| `/board` | Kanban pipeline: Prospects → Researched → Outreach Sent → In Conversation → Closed. Drag to advance; closing a win asks for the dollar value. |
| `/leads` | Flat CRM list with sort, search, and filters by industry, owner, status, and missing contact info. |
| `/map` | Every geocoded lead as a pin, coloured by pipeline stage, plus territories to sweep. |
| `/settings` | Sender identities, outreach templates, CSV export. |

Drafting an email opens it as a Gmail draft in the sender's own account. Nothing
is ever sent automatically.

## How a run works

1. **Search** — Exa queries the open web for candidate companies.
2. **Reason** — DeepSeek R1 (via OpenRouter) argues each candidate against the
   club's actual asks, streaming its reasoning to the page.
3. **Structure** — a fast model turns that prose into rows.
4. **Qualify** — Apollo confirms the company is real, still trading, and in the
   right region. Chambers of commerce, trade associations, and anything Enactus
   would have to *pay* to join are dropped here.
5. **Persist** — survivors are written to Neon and appear on the board mid-run.

A run is a single 60-second serverless function, so one run tops out at 25
leads. Asking for more says so and tells you to run it again.

### Ground rules baked into the code

These are enforced in code, not in prompts, because a prompt is a suggestion:

- **No invented facts.** A name, email, or number survives only if it appears
  verbatim in fetched evidence. Every figure on screen is computed in TypeScript
  from stored values — none is model output.
- **No guessed map pins.** `src/lib/geocode.ts` decides precision before
  anything is geocoded, and only street- and city-level matches are pinned.
  "Global (Swiss HQ)" is shown as unplaceable rather than dropped into Vancouver.
- **No scraping LinkedIn.** Public pages via Exa, company sites via Firecrawl,
  and search links for a human to click. That is the whole contact pipeline.

## Running it locally

```bash
npm install
npm run dev
```

Then create `.env.local`:

```
DATABASE_URL=            # Neon connection string
OPENROUTER_API_KEY=      # DeepSeek R1 + structuring model
EXA_API_KEY=             # candidate search
APOLLO_API_KEY=          # qualification (optional; run degrades, never breaks)
FIRECRAWL_API_KEY=       # contact lookup (optional)
GOOGLE_PLACES_API_KEY=   # local business lookup (optional)
SESSION_SECRET=          # any long random string
APP_TEAM_PASSWORD=       # shared team login
```

Only the first three are required for a run to work. Apply `neon-setup.sql` to
your database once before the first start.

Access is a single shared team password rather than per-user accounts —
deliberate, for a five-person volunteer team with annual turnover, and the
obvious thing to replace first if the team grows.

## Checks

```bash
npm run check
```

`scripts/selfcheck.ts` asserts the pure logic — count parsing, geocode
precision, filtering and sorting, email linting, money parsing — with no test
framework and no database. Everything it covers is dependency-free by design, so
it runs in about a second.

```bash
npm run lint
npx tsc --noEmit
```

## Layout

```
src/app/(app)/     the five pages
src/app/api/       route handlers
src/lib/           the actual logic — agent pipeline, providers, pure helpers
scripts/           selfcheck, territory seed
neon-setup.sql     schema (7 tables, all prefixed enactus_)
```

Anything in `src/lib/` that `selfcheck.ts` covers has no static imports, so it
can be run directly under `node --experimental-strip-types`. Constants and types
arrive as arguments instead.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · Neon Postgres ·
Leaflet + OpenStreetMap · deployed on Vercel.
