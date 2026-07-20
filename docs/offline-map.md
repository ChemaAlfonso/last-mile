# Offline vector basemap

Operating guide for the offline map layer: how `data/basemap-comarca.pmtiles` is generated,
served, and consumed, plus the licensing rules. Companion to [`docs/datasets.md`](datasets.md).
Standard library only for the build; no pip deps, no build step, no backend.

The offline basemap lets drivers see roads (to follow an offline route) with no network. It is a
single **vector** PMTiles archive rendered on a **Canvas 2D** Leaflet layer — no WebGL, which matters
on low-end rural Android phones.

---

## 1. What ships

| Artifact | Path | What it is |
|---|---|---|
| Basemap archive | `data/basemap-comarca.pmtiles` | One MVT vector PMTiles file covering the whole covered comarca |
| Renderer | `vendor/protomaps-leaflet.js` | Vendored UMD build of `protomaps-leaflet` v5.1.0 (global `protomapsL`, bundles the pmtiles reader) |
| Build tool | `tools/build_basemap.py` | Computes the bbox from `data/*.json`, shells out to the `pmtiles` CLI, verifies the result |
| Dev server | `tools/dev_server.py` | Static server **with HTTP Range support** (the stock `http.server` breaks PMTiles locally) |

Current archive (measured 2026-07-20):

- **Size:** 25,087,261 bytes (~25.1 MB)
- **Format:** PMTiles spec v3, tile type `mvt` (vector), internal + tile compression gzip
- **Zoom:** data z0–15; the renderer **overzooms** z15 data to draw z16/z17 street detail (no extra bytes)
- **Bounds:** lng −1.08500 … −0.66600, lat 37.85000 … 38.35600 (comarca address bbox + 0.05° margin)
- **Source:** Protomaps daily planet build `https://build.protomaps.com/20260720.pmtiles`, extracted for the bbox only
- **Attribution embedded in header:** `© OpenStreetMap`

> One comarca file (not 10 per-town files) is intentional: at ~25 MB for the whole region the
> per-town split saves little and PMTiles range-reads mean the client only fetches the bytes for
> tiles it actually draws. If per-town parity with the dataset download UX is ever wanted,
> `pmtiles extract --bbox=<town bbox>` produces a small per-town file with no other changes.

---

## 2. Generate / update

```bash
# needs the pmtiles CLI: brew install pmtiles
#   (or a binary from https://github.com/protomaps/go-pmtiles/releases)
python3 tools/build_basemap.py                       # latest daily build, 0.05° margin
python3 tools/build_basemap.py --margin 0.05
python3 tools/build_basemap.py --source https://build.protomaps.com/20260720.pmtiles
python3 tools/build_basemap.py --verify-only         # re-check the existing file only
```

What it does:

1. Reads every `data/<town>.json`, encloses all address points, pads by `--margin` degrees.
2. Finds the most recent Protomaps daily build (they retain ~7 days) or uses `--source`.
3. Runs `pmtiles extract <build> data/basemap-comarca.pmtiles --bbox=<min_lng,min_lat,max_lng,max_lat>`.
   This **range-reads** only the region out of the planet build (~26 MB transferred, ~72 requests).
4. Verifies by parsing the PMTiles v3 header directly (stdlib): magic bytes, `mvt` tile type,
   bounds cover the requested bbox, max zoom ≥ 15. Prints a summary and exits non-zero on failure.

**Refresh cadence:** the map only needs rebuilding when OSM coverage improves noticeably or a new town
is added (which changes the bbox). It is independent of the Catastro dataset versioning in `index.json`.

---

## 3. Serve it

### Local development

Use the range-capable dev server — **not** `python3 -m http.server`, which returns the whole 25 MB
file for every tile request and the map never renders:

```bash
python3 tools/dev_server.py 8000     # http://localhost:8000, Range-aware
```

### Production (nginx)

nginx serves byte ranges for static files by default (`Accept-Ranges: bytes`), which is all PMTiles
needs. The **one hard rule** is: **never gzip/brotli the `.pmtiles` file** — the client addresses it by
byte offset, and re-compressing at the HTTP layer shifts every offset and corrupts range reads. The MVT
tiles inside are already gzip-compressed individually.

```nginx
# Serve .pmtiles as an opaque static file with working range requests.
location ~* \.pmtiles$ {
    gzip off;          # MUST be off — re-compression breaks byte-range addressing
    # brotli off;      # uncomment if the brotli module is loaded
    add_header Accept-Ranges bytes;      # default for static files; explicit for clarity
    default_type application/octet-stream;
    expires 7d;        # optional: it changes rarely
}
```

Do not put the file behind a proxy/CDN layer that strips or rewrites `Range` / `Content-Range` headers.
Same-origin serving means no CORS config is required.

---

## 4. App integration (for the app-side code)

The vendored file exposes the global **`protomapsL`** and bundles the pmtiles reader — no separate
pmtiles script is needed. Load order in the shell: Leaflet, then `vendor/protomaps-leaflet.js`.

**Online path** (served by nginx with Range):

```js
const layer = protomapsL.leafletLayer({
    url: 'data/basemap-comarca.pmtiles',
    flavor: 'light',                 // built-in Protomaps theme
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
})
layer.addTo(map)
```

**Offline path** (the file downloaded once and kept as a Blob in IndexedDB/Cache Storage): hand
`leafletLayer` a `blob:` object URL. The bundled pmtiles reader issues ranged `fetch()` calls, and
browsers satisfy `Range` on `blob:` URLs locally (no network):

```js
// blob: the whole .pmtiles ArrayBuffer/Blob loaded from IndexedDB
const objectUrl = URL.createObjectURL(blob)
const layer = protomapsL.leafletLayer({ url: objectUrl, flavor: 'light', attribution: OSM_ATTR })
layer.addTo(map)
// revoke objectUrl when the layer is torn down (map teardown / town switch)
```

Things the app code must know:

- **`leafletLayer({ url })`** accepts a string URL **or** a `PMTiles` instance (`url?: PMTiles | string`).
- The global exports `leafletLayer`, `PmtilesSource`, `ZxySource`, `View`, `TileCache`, the symbolizers,
  and `paintRules` / `labelRules`. It does **not** re-export the raw pmtiles `PMTiles` / `FileSource`
  classes — hence the `blob:`-URL approach above rather than constructing a `FileSource` from a `Blob`.
- **Verify the `blob:`-URL range path in a real browser** before committing to it (Chrome/Safari/Firefox
  all honour `Range` on blob URLs in practice, but this could not be exercised headless here). Fallback if
  it ever misbehaves: also vendor the standalone `pmtiles` UMD (MIT) and build
  `protomapsL.leafletLayer({ url: new pmtiles.PMTiles(new pmtiles.FileSource(blobFile)) })`.
- The archive is **not** precached by the service worker (same policy as `data/*.json`): it is downloaded
  on demand and stored in IndexedDB/Cache Storage, and the app owns its offline lifecycle.
- Styling: pass `flavor` (`'light'` | `'dark'` | `'white'` | `'grayscale'` | `'black'`) for the built-in
  Protomaps themes, or supply custom `paintRules` / `labelRules`.

---

## 5. Storage expectations (driver's phone)

| Layer | Size |
|---|---|
| Vector basemap (whole comarca) | ~25 MB |
| Address datasets (all 10 towns, already shipped) | ~2.5 MB |
| Routing graph (Phase 2, when added) | ~1.5 MB (est.) |
| **Total offline navigation footprint** | **~29 MB** |

Vector is ~5–10× smaller than the raster equivalent (self-hosted OSM raster z12–17 for the same bbox is
~440 MB) and avoids WebGL.

---

## 6. Licensing checklist (must comply before shipping the map)

All base map data derives from **OpenStreetMap**, licensed **ODbL 1.0**. Self-hosting Protomaps/OSM
extracts is explicitly permitted; the obligation is **attribution**.

- [ ] Show **`© OpenStreetMap contributors`** on the map, visible without interaction, with
      "OpenStreetMap" linking to **https://www.openstreetmap.org/copyright**. Pass it as the
      `attribution` option on the layer (see snippets above) so Leaflet's attribution control shows it.
- [ ] Credit the basemap style: **Protomaps** (BSD-3-Clause renderer + style). The daily builds also use
      the **OpenMapTiles** schema — add an "OpenMapTiles" credit (https://openmaptiles.org/) if you keep
      that schema. A short line in the README "Créditos" section covers this.
- [ ] The vendored `vendor/protomaps-leaflet.js` keeps its BSD-3-Clause header — do not strip it.
- [ ] The `.pmtiles` archive is an OSM-derived Produced Work; keep the OSM attribution wherever it is
      displayed. (Distinct from the Phase-2 routing **graph**, which is a Derivative Database and must
      additionally carry an ODbL notice.)

The repo's MIT `LICENSE.md` covers the **code**; it does not relicense the **map/OSM data**, which stays ODbL.
