# ADU Atlas integration

FirstPass answers *"will these plans pass code review?"* ADU Atlas answers the
question that comes **before** that: *"what are the objective zoning / ADU rules
for this parcel, and can you cite them?"* Wiring the two means a project can start
from an address and hand FirstPass a deterministic, officially-cited baseline of
site standards instead of having the band research agents derive them from scratch.

## What it does

`firstpass.adu_atlas.code_requirements_from_atlas(address, project_type)` calls the
[ADU Atlas API](https://adu-atlas-api.onrender.com) and maps its `/feasibility`
response into FirstPass `CodeRequirement`s:

- Parcel APN and base zoning district (`category="parcel"` / `"zoning"`).
- Every development standard it returns - max height, max size, side / rear / front
  setback, parking, owner-occupancy, permit review days, impact-fee threshold,
  fire-sprinkler trigger - each with `official_source=True`, the source URL, and the
  authority (e.g. `AB 2221`, `LAMC Sec. 12.22`). State-law citations are tagged
  `category="statute"`; anything Atlas flags `needs_review` /
  `possibly_more_restrictive_than_state_baseline` sets `needs_verification=True`.

Atlas covers 8 CA cities (LA, San Diego, San Jose, San Francisco, Sacramento, Long
Beach, Irvine, Oakland). For any other address - or if the API is unreachable - the
mapper returns `[]` and FirstPass runs exactly as it does today. It never fabricates.

## How to turn it on

The merge is **opt-in** and wired into the requirements-assembly seam
(`synthesis.synthesize_from_files`). Enable it and point it at the API:

```bash
export ADU_ATLAS_ENABLED=1
export ADU_ATLAS_BASE_URL="https://adu-atlas-api.onrender.com/v1"   # default
export ADU_ATLAS_API_KEY="<your key>"                              # X-API-Key
# or via the RapidAPI gateway:
export ADU_ATLAS_RAPIDAPI_HOST="property-feasibility4.p.rapidapi.com"
export RAPIDAPI_KEY="<your rapidapi key>"
```

When enabled, Atlas requirements are prepended to the municipal set and win on any
same-topic collision (deterministic + cited beats an LLM excerpt). Leave the flag
unset and nothing changes.

## Direct use

You can also call it standalone, without the pipeline:

```python
from firstpass.adu_atlas import code_requirements_from_atlas
reqs = code_requirements_from_atlas("1234 S Main St, Los Angeles, CA", "detached_adu")
```

## Reliability - what FirstPass sees when Atlas is degraded

The adapter is built so ADU Atlas can never take FirstPass down. It fails safe on
every axis:

- **Never raises.** Timeouts, connection errors, 5xx, malformed JSON - all return
  `{}` internally and map to `[]`. FirstPass runs its normal pipeline unchanged.
- **Retries transient failures** (cold-start timeout, connect error, 5xx) up to 3
  attempts with backoff; a cold free-tier instance is tolerated.
- **Does not retry terminal 4xx** (bad request / auth / quota) - no retry storms.
- **Caches** successful responses per process, so a stable address set is called
  once per run.
- **Empty / non-production / `insufficient_data` -> `[]`.** Atlas never fabricates,
  and the adapter drops null-valued fields, so FirstPass only ever receives cited,
  real values or nothing.

### Coverage honesty (important)

A jurisdiction being "production" means its zoning + rules are wired and verified;
it does NOT guarantee every address resolves. The request path geocodes the address
(Census -> OpenStreetMap Nominatim -> optional paid providers). The keyless
geocoders throttle under load, so a first-touch call for a brand-new address can
return `insufficient_data` even in a covered city; a retry (or a repeat once cached)
then succeeds. **For guaranteed first-touch reliability at volume, set a paid
geocoder key on the ADU Atlas service** (`GOOGLE_MAPS_GEOCODING_API_KEY` or
`MAPBOX_ACCESS_TOKEN` in its Render env) - the chain already uses it when present.
Until then the free path is best-effort and FirstPass degrades gracefully when it
misses.

<!-- easymd:log -->
## 🧾 Activity
- agent created the document (2392 chars)
- agent replaced the document (2491 chars)
- agent replaced the document (4144 chars)
- agent replaced the document (4187 chars)
- agent replaced the document (4230 chars)
- agent replaced the document (4273 chars)
- agent replaced the document (4316 chars)
- agent created the document (4359 chars)
<!-- /easymd:log -->
