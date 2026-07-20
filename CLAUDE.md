# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Last Mile is a client-only PWA (no build step, no bundler, no backend) for delivery drivers to record and search rural addresses that mainstream maps miss (partidas, diseminados, caminos in the Vega Baja region). Vanilla JS + Leaflet + IndexedDB. UI language is Spanish.

## Commands

- **Run locally**: serve the repo root over HTTP (any static server — e.g. `python3 -m http.server 8000`). Opening `index.html` via `file://` breaks the service worker, IndexedDB persistence, and geolocation.
- **Rebuild a town dataset**: `python3 tools/build_dataset.py <municipality_code> <town_id> <town_display_name>` — downloads the Catastro INSPIRE Addresses GML for that municipality, filters/cleans rural addresses, writes `data/<town_id>.json` and updates `data/index.json`. Pass `--gml <path>` to skip the download and use a local GML file. Standard library only; no pip deps.
- **No test suite**: verification is done in a real browser (Playwright/Chrome MCP), not with unit tests. When changing runtime behaviour, exercise the affected flow end-to-end.

## Architecture

### Three-tier persistence model

The app juggles three storage layers with distinct semantics — this is the single most important thing to internalize before editing `app.js`:

1. **IndexedDB `addresses` store** (`state.addresses`) — the driver's own saved points. Full CRUD, always exported on backup.
2. **IndexedDB `places` store** (`state.places`, keyed by town, indexed by `town`) — official Catastro points bulk-loaded from `data/<town>.json`. Individual records can carry `edited: true` when the driver corrects a name/note/position; edited records are preserved across dataset updates and rides along in the export payload as `placeEdits`.
3. **`localStorage` settings** (`state.settings`) — per-town visibility toggles, onboarding flag, own-visibility toggle. Never contains address data.

Datasets in `data/*.json` are NOT precached by the service worker (`sw.js` deliberately skips `data/` paths) — the app owns their offline behaviour via IndexedDB.

### Boot sequence

`initShell()` runs immediately: registers the SW and wires the splash "Iniciar" button. Nothing else happens until the driver taps Iniciar — `initApp()` then creates the map, opens IndexedDB, loads addresses + downloaded towns, fetches the manifest, and shows onboarding if no town is downloaded. This is intentional: instant paint, zero tile requests until the driver actually starts.

### Search fan-out

`onSearchInput` renders in two passes:
1. Local (own addresses + in-memory dataset places) synchronously.
2. Remote Nominatim after `search.debounceMs` (700ms) and `minQueryLength` (3) — these values are non-negotiable per Nominatim usage policy. Do not lower them.

Dataset matching iterates `activeTowns()` (downloaded AND visible). Each place carries a pre-normalized `hay` string (see `makeMemPlace`) to make token matching accent-insensitive without re-normalizing on every keystroke.

### Map rendering at scale

Official points render as `L.circleMarker` on a single shared `L.canvas` renderer (`ensureCanvasRenderer`) — DOM markers would collapse at 30k+ points. Rendering is gated by:
- `zoomThreshold` (14): below this, dots are cleared and a one-shot toast prompts to zoom in.
- `renderCap` (1500): hard cap per render pass; overflow is silently dropped.
- `boundsPad` (0.2): render slightly beyond the viewport so panning feels seamless.
- `debounceMs` (150): coalesce rapid moveend/zoomend events.

`state.pendingFocusPlaceId` is a one-shot: `focusPlace()` sets it, `renderDatasetDots()` consumes it once. Don't let it linger across renders — it would pop popups open on unrelated pans.

### Placement mode is a state machine

`state.placementMode` combined with `editingId` (own address) or `editingPlaceId` (official point) drives four flows: new-from-map, new-from-remote-search, edit-own, edit-official. `onMapClick` branches on these: while editing, a map tap only moves the temp marker; while creating new, it also opens the form and reverse-geocodes to prefill. Keep this branching intact — collapsing it re-introduces the "tapping the map while editing wipes the form" bug.

### Dataset builder specifics

`tools/build_dataset.py` is standard-library-only and encodes several municipality-specific quirks. Full operating guide (adding a town, name-quality workflow, OVC enrichment): `docs/datasets.md`.
- Only **rural thoroughfare types** in `RURAL_TYPES` are kept (PD/DS/LG/CM/VR/CR/BO/HT/PG/PB/CS/AL). Urban types (CL/AV/PZ…) are dropped — regular maps handle those. `PL` (polígono) is urban by default with a rural keyword rescue + per-town allow-list (`RURAL_PL_ZONES`); `PG` is unused in Alicante (Catastro uses `PL`) but kept for other provinces.
- Addresses with number `S-N` (sin numero) are KEPT as places with `num: 'S/N'` and a mandatory `ref` field — the driver-facing identifier, in tiers: rural parcel (`Políg. 20 · Parc. 295`), OVC-sourced designator (`Parcela 34`), or compact cadastral ref as last resort. Each S/N point keeps its own coordinates (never averaged into a zone centroid).
- Names are cleaned with `clean_zone`: trailing-article normalization (`BOCH, EL` → `El Boch`), GP-fragment stripping (`MOCO EL GP.3` → `El Moco`, merging fragments), verified abbreviation expansion, Spanish title case with minor-word rules, fallback prepends (`LG 2` → `Lugar 2`), and per-town overrides in `CANONICAL_ZONE_NAMES`.
- **Id-stability contract (critical)**: place ids come from a FROZEN legacy cleaner (`_legacy_clean_zone`), never from the display name — driver edits are keyed by id, so id churn orphans them. Never change the legacy cleaner, never generate sequential S/N ids (they anchor on the cadastral parcel ref). Before shipping a rebuild, diff old vs new per town: 0 lost ids, 0 moved coords, only expected additions/renames.
- Coordinates come in EPSG:25830 (UTM 30N / ETRS89) and are inverse-projected to WGS84 with an inlined Snyder series — do NOT swap this for a library dep. The SRS is asserted per-address; a mismatch aborts the build.
- Dedup key is `(zone, number)` with coordinate averaging as the centroid; zones in `DISTANCE_MERGE_ZONES` only merge collisions closer than 150 m (same number reused for distant houses stays two places).
- `resolve_version` keeps the previous version if the `places` array is byte-identical, otherwise bumps it — without this, regenerated datasets stay at v1 forever and the app's "Actualizar" button never appears for already-downloaded towns.
- Catastro's TLS chain fails verification on some machines; the script uses an unverified SSL context on purpose (payload is public open data).

### Service worker cache strategy

`sw.js` is network-first with cache fallback on the app shell only. Bump `CACHE_VERSION` when the shell changes to force a clean precache. Never add `data/` files to `SHELL` — datasets live in IndexedDB and have their own offline path.

## Conventions specific to this repo

- **No frameworks, no build step, no npm.** Adding a bundler or dependency requires an explicit decision — the "open the folder in a browser" simplicity is a feature.
- **Spanish in the UI, English in code and comments** (per user global rule).
- **Tabs for indentation, single quotes, no semicolons, 120 col** (per user global Prettier config).
- **Escape all user-controlled strings** flowing into `innerHTML` (`escapeHtml`). Popups, list cards, and dataset rows all interpolate — an XSS regression here is the highest-priority defect.
- **Coordinate validation** goes through `toFiniteNumber` (not raw `Number()`, which coerces `null`/`''` to 0 and would silently accept missing coords as `0,0`).
- **Timers on `state.confirmTimers`** back the two-tap-to-delete confirmation pattern on both address cards and town rows. Clear them on completion, not just on timeout.
