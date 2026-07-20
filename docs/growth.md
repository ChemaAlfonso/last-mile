# Growth guide — adding towns and zones

The end-to-end recipe for expanding coverage: new towns, and what happens to the
offline basemap and routing graph when you do. Detailed per-artifact docs:
[datasets.md](./datasets.md) (address points), [offline-map.md](./offline-map.md)
(vector basemap), [offline-routing.md](./offline-routing.md) (road graph).

## The three artifacts and how they update

| Artifact | File(s) | Scope | Versioned by |
|---|---|---|---|
| Address points | `data/<town>.json` | one per town | `version` per town in `data/index.json` (auto-bumped by the builder when places change) |
| Offline basemap | `data/basemap-comarca.pmtiles` | single file, whole covered area | `basemap.version` in `data/index.json` (manual bump) |
| Routing graph | `data/graph-comarca.json` | single file, whole covered area | `graph.version` in `data/index.json` (manual bump) |

The app never needs code changes for any of this. Drivers get everything through
the one versioned flow: downloading a town also installs basemap + graph;
installed users see the boot "Hay actualizaciones" modal / "Actualizar" buttons
whenever any declared version is newer than what their device stores.

## Adding a town — checklist

1. **Build the dataset**: `python3 tools/build_dataset.py <municipality_code> <town_id> "<Display Name>"`.
   Writes `data/<town_id>.json` and adds the town to `data/index.json` (existing
   keys, including `basemap`/`graph`, are preserved).
2. **Name quality pass** (the only artisanal step): follow the workflow in
   [datasets.md](./datasets.md) — verify partida names against municipal sources,
   add `CANONICAL_ZONE_NAMES` overrides / `RURAL_PL_ZONES` entries as needed,
   and diff old vs new ids (0 lost ids is the shipping bar).
3. **Rebuild the basemap**: `python3 tools/build_basemap.py`. Its bbox is derived
   from every point in `data/*.json` plus a margin, so it grows to cover the new
   town automatically.
4. **Rebuild the graph**: `python3 tools/build_routing.py`. Same auto-bbox.
   Run its verification checklist (see offline-routing.md) before shipping.
5. **Bump versions in `data/index.json`**: town versions are already handled by
   the builder; raise `basemap.version` and `graph.version` by 1 and update each
   `size` to the new byte counts (`wc -c` on the files). If you skip this, users
   who already installed them will never refresh.
6. **Deploy** (`npm run deploy-lastmile` from epic-server). `data/` travels with
   the rsync; nothing else to configure — nginx gzips the graph JSON on the fly.

New users downloading any town get the fresh files; existing users see
"Actualizar" and pull all three in one tap.

## Routing coverage vs downloaded towns

The graph and basemap cover the whole built area as single files, independent of
which towns a driver downloaded. Offline navigation therefore works across town
borders (Almoradí → a Callosa house) as long as both ends are inside the covered
area. Starting from outside it: snapping is capped at 500 m from the nearest
graph road, beyond that `computeRoute` returns null and the UI says there is no
offline route — graceful, no error.

## Known limit: distant zones

Basemap and graph are deliberately **one file each**. Adding neighbouring towns
grows them modestly and nothing changes. Jumping to a distant region (another
province) would blow up the covering rectangle with empty space — the wrong
tool. The planned evolution for that case is sharding per zone (multiple
`basemap-<zone>` / `graph-<zone>` files): the IndexedDB stores already key
records by id and the manifest is extensible, so it is added plumbing, not a
redesign. Do not build it before a distant zone actually exists.
