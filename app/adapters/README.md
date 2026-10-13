# Adapters

Each source keeps its own shape; these translate it into the one envelope
`POST /ingest` accepts. See `../docs/ingest.md` for the contract.

## Deal Machine → shipped inside the extension

**Since migration 84 the extension is CLOZR's runtime, not its peer.** Its
settings, Facebook groups and buttons live on CLOZR's Deal Machine screen; the
extension pulls them and pushes its heartbeat, runs, log and opt-ins through
`POST /deal-machine` (`supabase/functions/deal-machine`), signed with the same
key as `/ingest`. The bridge is `chrome-extension/clozr-control.js` in
the upstream deal-machine site repo. What it *finds* still arrives through the
envelope below.

**`deal-machine/clozr-sink.js` is superseded.** The mapping it describes now
lives in the extension itself, in
the upstream deal-machine site repo, `chrome-extension/background.js` — see the
"Clozr sync" block at the top of that file. The sink is kept here as the
readable statement of the mapping; it is not the code that runs, so change
`background.js` and not this file.

That move also fixed the reason nothing had ever arrived. The extension was
posting to `/api/extension/deal`, `/api/extension/run` and
`/api/extension/contact` with an `x-extension-key` header. **Those routes never
existed**: CLOZR is a Next.js static export (`output: 'export'`), so it has no
server runtime and cannot answer an API route at all. Every push failed into a
`clozrSyncStats.failed` counter that nothing surfaced, so the mirror looked
configured and had delivered nothing. It posts the envelope below to `/ingest`
now, which is the door that was built for it.

What it sends:

| | |
| --- | --- |
| `source` | `deal_machine`, which must match the key's own name |
| `source_id` | the listing or post id, falling back to the address — never a timestamp, or a re-scrape makes a second lead |
| `property` | `line1`, `city`, `state`, `zip`, `beds`, `baths`, `sqft`, `year_built`, `property_type` |
| `person` | `name`, `phone`, `email` |
| `deal` | `asking_price`, `arv`, `rehab`, `mao`, `motivation`, `notes`, `lead_source`, `market`, `listing_url`, `photos[]` |
| `options.run_compr` | set when the extension's Auto-run COMPR is on; an owner can still veto it per key |
| `raw` | the whole scraped object, so a wrong mapping is replayable |

A captured cash buyer or wholesaler opt-in goes as its own POST carrying only
`buyer` — CLOZR reads that section only when `property` and `person` are both
absent, so it can never ride along on a deal.

MAO uses the extension's own rule, from `chrome-extension/RUNBOOK.md`:
`Asking ≤ (70% ARV − Rehab − $20k)`.

4xx stops immediately (a bad envelope or dead key; retrying can't fix it). 429,
5xx and network errors retry 4 times with backoff, which is safe because the
endpoint is idempotent.

Both ends are configured from CLOZR's **Deal Machine** screen (the orange mark
in the top bar): it issues the key, shows the endpoint, holds the Auto-run
COMPR switch and lists what has landed.

## Talkr → `../supabase/functions/talkr-webhook/`

**Talkr needs no code change.** Create a webhook subscription over there pointing
at `https://<project>.supabase.co/functions/v1/talkr-webhook`, paste the signing
secret it issues into Settings → Ingest keys, and it's connected.

The adapter lives on the receiving side because Talkr can only post its own
shape. It verifies `X-Talkr-Signature` (`HMAC-SHA256(secret, "<t>.<body>")`,
5-minute replay window), then routes through the same `ingest_apply` as
everything else.

Talkr's event `id` is the `source_id`, which is what its own docs tell consumers
to dedupe on — its fan-out is at-least-once and unordered.

## When a mapping is wrong

The `data` shape inside a Talkr event, and the Deal Machine deal object's field
names, were **not** readable from outside those repos. Both mappers read from a
list of plausible aliases and both ship the whole original in `raw`.

So a wrong mapping is cheap: fix the paths, then replay the payloads already
stored — no need to ask anyone to re-send.

```sql
select public.ingest_replay(<workspace_id>, 'talkr');
select public.ingest_replay(<workspace_id>, 'deal_machine', now() - interval '7 days');
```

## Adding a source

1. `INGEST_SOURCES` in `lib/ingest.ts` — a name and a label.
2. Issue a key in Settings.
3. Map that source's shape to the envelope, wherever is natural for it: in the
   sender when it can be changed (Deal Machine), in an edge function when it
   can't (Talkr).

Nothing in the database changes. That is the point of the single contract.
