# Offline routing graph

Data pipeline and format contract for Phase 2 (offline turn-by-turn to rural
addresses). This document is the contract for the JavaScript integrator: it
describes the graph file field-by-field so the in-app A\* / snapping / guidance
layer can be built without re-reading the Python.

The build tool is `tools/build_routing.py`; the built graph is
`data/graph-comarca.json`. For basemap tiles and nginx serving notes see
[offline-map.md](./offline-map.md) if present — this document covers only the
routing graph.

## What the graph is

A single **undirected** road graph for the whole comarca, derived from
OpenStreetMap via the Overpass API, with a per-edge direction flag for oneway
streets. Every OSM geometry vertex of a drivable way is a graph node (dense
graph — geometry is preserved, nothing is contracted), so the same node array
doubles as the polyline you draw the route with and the point cloud you snap the
driver's GPS to. Each edge carries an estimated travel time.

The file is **compact-encoded** (Morton-ordered nodes, delta integers) to fit a
phone download; you decode it once at load into flat typed arrays. Decode is
~15 lines of JS, shown below.

## Licensing (read first)

The graph is a **derivative database of OpenStreetMap** and is therefore
licensed under the **Open Database License (ODbL) 1.0**. Consequences the app
must honour:

- The file carries `attribution: "(c) OpenStreetMap contributors"` and a
  `licenseNote`. Keep the attribution visible wherever the routing/map is shown
  (the basemap already shows it; the same credit covers this graph).
- Share-alike applies to the **database** (this JSON). If you publish a modified
  graph, publish it under ODbL too.
- A **computed route** (a path, its distance, its instructions) is a *Produced
  Work*, not a database, and is **not** bound by share-alike. Showing routes to
  drivers carries no obligation beyond the attribution.

## File format

`data/graph-comarca.json` — one minified JSON object, UTF-8. Served as plain
JSON (nginx gzips on the fly); see [size](#size--why-plain-json).

### Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `format` | string | Always `"lastmile-routing-graph"`. Sanity-check on load. |
| `formatVersion` | int | Schema version, currently `1`. Bump on any breaking change. |
| `source` | string | `"OpenStreetMap via Overpass API"`. |
| `attribution` | string | `"(c) OpenStreetMap contributors"` — must be displayed. |
| `license` / `licenseNote` | string | ODbL 1.0 + human-readable summary. |
| `buildDate` | string | `YYYY-MM-DD` (UTC). |
| `bbox` | `[s,w,n,e]` | Covered box `[south, west, north, east]`, WGS84 degrees. |
| `weightUnit` | string | `"centiseconds"` — unit of every `edges.cost`. |
| `coordScale` | int | `1000000`. Divide decoded integer coords by this to get degrees. |
| `encoding` | string | One-line reminder of the delta scheme (this section is the full spec). |
| `speedTable` | object | `highway class → km/h` used to weight edges. |
| `counts` | object | `{nodes, edges, directedEdges, largestScc}`. `edges` = undirected rows. |
| `classes` | array | String table of highway classes (indexed by `edges.cls`). |
| `names` | array | String table of road names (indexed by `edges.name`, `-1` = none). |
| `nodes` | object | `{dlat, dlng}` — delta-encoded coordinates, see below. |
| `edges` | object | `{fromDelta, toRel, cost, dir, cls, name}` — see below. |

### nodes — delta-encoded, Morton order

```json
"nodes": { "dlat": [38176000, 12, -4, 31, ...], "dlng": [-877699, -2, 9, ...] }
```

Nodes are ordered along a **Morton (Z-order) curve** so spatially-near nodes get
near indices. Coordinates are stored as **integer microdegrees** (degrees ×
`coordScale`), first value absolute, the rest **deltas**. Decode with a running
sum; the array index is the node id used everywhere else:

```js
const S = g.coordScale
const {dlat, dlng} = g.nodes
const NN = dlat.length
const lat = new Float64Array(NN), lng = new Float64Array(NN)
let la = 0, lo = 0
for (let i = 0; i < NN; i++) { la += dlat[i]; lo += dlng[i]; lat[i] = la / S; lng[i] = lo / S }
```

The decode is exact (lossless at 6-decimal / ~0.11 m precision). Consecutive
nodes along an edge trace the real road polyline. Build a spatial index (grid or
k-d tree) over `lat/lng` once for GPS and start/destination snapping.

### classes / names

```json
"classes": ["track", "residential", "unclassified", "secondary", ...]
"names":   ["Camino de San Cayetano", "CV-873", ...]
```

Two deduplicated string tables. Edges reference them by index. `names` holds the
way `name`, falling back to `ref`; a way with neither is referenced by name
index `-1`.

### edges — undirected, sorted, delta-encoded

Six parallel columns, all length `= counts.edges`. Column `k` describes edge
`k`; every edge connects node `a[k]` and node `b[k]`:

```json
"edges": {
  "fromDelta": [0, 0, 1, 0, ...],   // a[k] = running sum (edges sorted by a, then b)
  "toRel":     [3, 51, -2, 7, ...], // b[k] = a[k] + toRel[k]
  "cost":      [431, 128, 12, ...], // travel time, CENTISECONDS (0.01 s), integer >= 1
  "dir":       [0, 0, 1, 0, ...],   // 0 = both ways, 1 = a -> b only (oneway)
  "cls":       [0, 0, 3, ...],      // index into classes[]
  "name":      [-1, 5, 5, ...]      // index into names[], or -1 if unnamed
}
```

- **`a` is delta-encoded** (`fromDelta` is a running difference; edges are sorted
  by `a` then `b`, so most deltas are `0` or `1`). **`b` is stored relative to
  `a`** (`toRel = b − a`); because of the Morton ordering the two endpoints are
  close in index, so `toRel` is small. This is what makes the columns compress.
- **`cost`** = `round(length_m / (speed_kmh / 3.6) × 100)` centiseconds, clamped
  `≥ 1`. Divide by 100 for seconds, 6000 for minutes.
- **`dir`** encodes oneway: `0` = drivable both ways; `1` = drivable only from
  `a` to `b` (the way's `oneway=-1` and roundabout cases were already normalised
  into the `a → b` direction at build time).

Decode into a directed adjacency list once at load:

```js
const {fromDelta, toRel, cost, dir, cls, name} = g.edges
const EE = fromDelta.length
const a = new Int32Array(EE), b = new Int32Array(EE)
let ai = 0
for (let e = 0; e < EE; e++) { ai += fromDelta[e]; a[e] = ai; b[e] = ai + toRel[e] }

const adj = Array.from({length: NN}, () => [])   // node -> [ [neighbour, cost, edge], ... ]
for (let e = 0; e < EE; e++) {
  adj[a[e]].push([b[e], cost[e], e])
  if (dir[e] === 0) adj[b[e]].push([a[e], cost[e], e])   // reverse only for two-way edges
}
```

That is O(N+E), a handful of ms, and keeps memory low (numbers only; strings live
once in the tables). For A\* the neighbour weight is `cost`; for instructions,
walk the `edge` indices of the result path and coalesce consecutive edges that
share `cls`/`name`. A\* heuristic: `haversine(node, goal) / maxSpeed_ms × 100`
centiseconds (admissible against the fastest class in `speedTable`).

### counts.largestScc

Nodes in the largest **strongly connected component**. Nodes outside it are
unreachable pockets (dead-end service loops, oneway traps, areas clipped at the
bbox edge). If a snap lands on such a node the route may fail; snapping should
prefer the main component when a place sits near several roads.

## Build / update procedure

```
python3 tools/build_routing.py                 # full comarca, default margin
python3 tools/build_routing.py --margin 0.03   # widen the box
python3 tools/build_routing.py --cache DIR      # raw Overpass tile cache location
```

Standard library only, no pip deps (matches `tools/build_dataset.py`).

1. **BBox** is computed from every point in `data/*.json` plus `--margin`
   (default 0.02°, ~2.2 km), so rebuilding the address datasets and then the
   graph keeps them aligned — same approach as the basemap build.
2. **Fetch.** The box is split into tiles ≤ 0.12° per side and each is pulled
   with `way["highway"](bbox); out geom tags;`. Endpoints are rotated on error
   (one try each per round — 504/429 are common on the loaded public
   instances; `private.coffee`, `kumi.systems`, `overpass-api.de` back each
   other up) with retry + polite pacing.
3. **Cache.** Each raw tile response is cached under `--cache` (default
   `tools/.overpass-cache/`, keyed by tile bbox). Re-runs read the cache and hit
   the network zero times — delete the cache dir to force a fresh pull. Building
   the full comarca from scratch takes a few minutes; re-encoding from cache is
   ~4 s.
4. **Filter + build topology** (below), Morton-renumber, delta-encode,
   round-trip **self-check** (the build aborts if the encoding does not decode
   back to the same graph), then write `data/graph-comarca.json` and print stats
   including the largest-SCC coverage.

To refresh from newer OSM data, delete the cache dir and re-run.

### Topology by coordinate key (not node id)

Nodes are stitched by their rounded `(lat, lon)` (6 decimals). Overpass returns
**byte-identical** coordinates for the same underlying OSM node wherever two ways
meet, so this merges shared nodes exactly as OSM node ids would — while keeping
the query light (`out geom`). The node-id query (`out body; >; out skel qt;`)
roughly doubles the payload and **times out on the loaded public endpoints** for
a comarca-sized box, which is why it is not used.

### Speed table (edge weights)

`class → km/h`, free-flow. Edge weight = length ÷ speed. Tune here to change
routing preference between road classes.

| class | km/h | | class | km/h |
|---|---|---|---|---|
| motorway | 100 | | unclassified | 45 |
| trunk | 90 | | residential | 40 |
| primary | 80 | | road | 40 |
| secondary | 70 | | service | 30 |
| tertiary | 60 | | track | 20 |
| living_street | 20 | | *_link | 40–60 |

No turn costs, no traffic, no surface penalty — out of scope for v1. The JS
layer may add turn / U-turn penalties on top of edge cost if needed.

### Filtering decisions

- **Kept classes:** `motorway, trunk, primary, secondary, tertiary,
  unclassified, residential, living_street, service, track, road` and their
  `_link` ramps. `track` is deliberately **kept** — rural partidas are reached
  by unpaved caminos mapped as `track`.
- **Dropped classes:** `footway, path, cycleway, pedestrian, bridleway, steps,
  corridor` — **unless** the way carries `motor_vehicle=yes|permissive|
  destination|designated|delivery|customers`, in which case it is kept as a slow
  (20 km/h) link. Everything else (`construction, proposed, raceway, platform`…)
  is dropped.
- **Access.** The most specific access tag present wins, in order
  `motor_vehicle > motorcar > vehicle > access`. A **negative** value
  (`no, private, agricultural, forestry, military`) **excludes** the way; a
  positive value keeps it. `access=destination` is treated as **allowed** — for
  a last-mile delivery app the driver *is* the destination, so gated
  `access=destination` service roads and driveways stay in the graph.
- **Oneway.** `oneway=yes|true|1` → `a → b` only; `oneway=-1|reverse` → stored so
  the single allowed direction is `a → b` (node order reversed at build);
  `junction=roundabout|circular` → `a → b` only (implicit oneway); otherwise
  two-way. Motorways are **not** auto-onewayed — OSM maps dual carriageways as
  two separate ways, so direction is already explicit.
- **Box edge.** A way that leaves the bbox keeps only the segments whose two
  vertices are both present; the graph degrades gracefully at the edge instead
  of losing whole ways. Small clipped stubs show up as orphan SCC islands.

## Verification checklist

Run `verify_routing.py` (in the research scratchpad) after every build. Targets:

1. **Connectivity** — `counts.largestScc / counts.nodes` **> 95 %**; eyeball the
   largest orphan islands.
2. **Routing** — A\* between 30+ random real `data/*.json` places (snapped to the
   nearest node) — ~100 % connected within the main component, single-digit-to-
   low-tens ms per query in CPython.
3. **Sample routes** — 3 cross-town routes with a plausible class/name sequence
   (minor roads near the ends, higher classes in the middle).
4. **Partida reachability** — the reference partidas (Cachapets, El Cachap, San
   Antonio de la Florida, El Moco) snap within a sane distance, land in the
   largest SCC, and reach their town core.

## Size / why plain JSON

Committed as plain minified JSON, not pre-gzipped, because nginx serves it with
on-the-fly gzip (same wire size a pre-gzipped file would give), the browser and
service worker cache the decompressed JSON either way, and a plain `.json` is
inspectable and diff-able. The compact encoding (Morton + delta + undirected) is
what keeps the gzipped transfer under the ~2 MB budget; without it the same graph
is ~4 MB gz. If it ever grows past ~2 MB gz, the next lever is contracting
degree-2 chains into edges that carry their geometry as polylines (OSRM-style),
which trades a simpler routing graph for a more complex snapping/geometry path.

## As-built stats (2026-07-20, OSM via Overpass)

| Metric | Value |
|---|---|
| bbox | `[37.880047, -1.054771, 38.325976, -0.695918]` |
| kept drivable ways | 38,441 |
| nodes | 288,270 |
| undirected edges | 308,319 |
| directed edges (expanded) | 559,341 |
| largest SCC | 283,076 nodes (**98.20 %**) |
| named ways | 6,254 |
| file size | 7.42 MB raw · **1.92 MB gzip -9** |

Verification (`verify_routing.py`): 30/30 random cross-town place pairs
connected, A\* avg 19.9 ms / max 54.7 ms (CPython), snap distance avg 36 m /
max 141 m. All four reference partidas snap within 26–58 m, sit in the largest
SCC, and route to their town core in 3–7 min.

## OSM data quirks in this comarca (for the integrator)

- **1.8 % of nodes are off the main component** — 1,678 small islands, the
  biggest ~368 nodes. Prefer snapping to a node in the largest SCC; a snap onto
  an island can produce "no route". A cheap guard is to precompute component
  membership at load (Kosaraju/Tarjan, O(N+E)) and skip island nodes when
  snapping.
- **Most rural roads are unnamed** (`name = -1`) — only ~6.3 k of the ways carry
  a name/ref. Guidance instructions must degrade to geometry-based cues
  ("gire a la derecha", distance-to-turn) rather than street names on the many
  unnamed caminos and tracks.
- **`track` carries a large share of the rural network.** Many partidas are only
  reachable over `track`/`unclassified` caminos; do not down-rank them out of
  routes or the app cannot reach its own addresses.
- **`access=destination` gated roads are included** on purpose — expect some
  service roads/driveways that a generic router would refuse. That is correct
  for delivery but means a route may legitimately end on a restricted-access
  stub.
