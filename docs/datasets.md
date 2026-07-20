# Dataset methodology

Operating guide for `tools/build_dataset.py` — how the official-point datasets in `data/*.json`
are built, filtered, named, and enriched, and the rules that must hold when adding a new town.
Standard library only; no pip deps. UI is Spanish, code/docs are English.

---

## 1. Build a town

```bash
# download + build in one step
python3 tools/build_dataset.py <municipality_code> <town_id> "<Display Name>"
python3 tools/build_dataset.py 03059 crevillent Crevillent

# reuse a local GML (no download); sourceDate comes from the file mtime, so set it to the
# Catastro publication date if you want it faithful (touch -t YYYYMMDD1200 file.gml)
python3 tools/build_dataset.py 03059 crevillent Crevillent --gml /path/A.ES.SDGC.AD.03059.gml
```

Writes `data/<town_id>.json` and updates the `data/index.json` manifest.

### Finding a municipality code
Codes are `PPNNN` (PP = 2-digit province, `03` = Alicante). Read the province ATOM feed and
match the town name to its zip href (the script's `find_zip_url` does this given the code):

```
https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/03/ES.SDGC.AD.atom_03.xml
# entry: .../03/03059-CREVILLENT/A.ES.SDGC.AD.03059.zip  -> code 03059
```

Catastro's TLS chain fails verification on some machines; the script uses an unverified SSL
context on purpose (public open data).

### Reading the build output
```
Addresses read: 13278                 # Address features in the GML
Thoroughfare names: 345               # distinct thoroughfare names
Kept rural numbered addresses: 8059 {'PD': 7991, ...}   # after type filter, excl. S/N
Rural S/N addresses: 93               # kept sin-numero points (see tier b/c)
Deduped places: 3880                  # final place count = numbered + S/N
Partidas: 62                          # distinct display zones
Version: 3                            # see §5 (resolve_version)
sourceDate: 2026-02-20                # Catastro publication date
```

---

## 2. Filtering model (which thoroughfares are kept)

Only **rural thoroughfare types** in `RURAL_TYPES` survive; urban ones (CL, AV, PZ, TR, PS, UR,
RD…) are dropped — regular maps already find those. Kept: `PD DS LG CM VR CR BO HT PG PB CS AL`
(+ `PL`, special-cased).

- **`PG` (polígono)** is kept in the map but is **unused across the Alicante towns** — they
  register polígonos as `PL`. Left in for other provinces that may use `PG` for rural land.
- **`PL` is URBAN by default** (industrial estates, PERI/PAU/UE sectors, coastal urbanisations
  like `PINAR DE BONANZA` that look like plain place-names). It is kept only when:
  1. the name contains a rural keyword (`RURAL_PL_KEYWORDS`: PARTID, DISEMIN, PARAJE, CASERIO,
     ALQUERIA, MASIA) — auto-rescues e.g. `PL DISEMINADOS`; or
  2. the exact name is in the reviewed `RURAL_PL_ZONES` allow-list (per municipality code).

  **Density heuristic for allow-list decisions**: rural scattered housing ≈ **0.3–0.7 dwellings/ha**;
  urban urbanisations ≈ **2–6/ha**. Example: Albatera `PL MOS DEL BOU` = 0.73/ha (kept) vs Orihuela
  `PL PINAR DE BONANZA` = 3.34/ha (dropped). Never allow-list a zone whose name already exists under
  another type in the same town (it would perturb existing places, not add missing ones).

---

## 3. Address tiers (how a point becomes a place)

The owner's framing — emit the address a resident would actually use:

**(a) Numbered** — no ambiguity. `id = {legacy-zone-slug}-{number}`, `name = "Zone, N"`, no `ref`.

**(b) S/N with a rural parcel ref** — `localId` ends in `...S-N.03059A02000295` → rural cadastral
ref (municipality + sector letter + 3-digit polígono + 5-digit parcela). Emitted as
`"ref": "Políg. 20 · Parc. 295"` (leading zeros stripped). This IS how rural addresses are written.
Each S/N point keeps its own coordinates; dedup only collapses points at the same spot (1 m grid) —
never by parcel ref (one parcel can hold dwellings hundreds of metres apart).

**(c) S/N with an urban-format ref** (14-char cartographic, e.g. `2251560XH9324N`) — has no
polígono/parcela. Its official domicilio is looked up **once** via Catastro OVC and baked into
`OVC_SN_REF_LABELS`; refs not listed fall back to `"ref": "Ref. <RC>"` (the official identifier —
searchable, unique, never a wrong label). Goal: **zero S/N places without a `ref`**.

### OVC lookup flow (for tier c on a new town)
Public, no auth. Consulta de Datos No Protegidos por Referencia Catastral (REST):

```
https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/rest/Consulta_DNPRC?RefCat=<14-char RC>
```

Response (namespace `http://www.catastro.meh.es/`):
- `<ldt>` — full domicilio text (e.g. `BO CALLOSILLA  Suelo PARCELA 34 03360 CALLOSA DE SEGURA`).
- `<dir>`: `tv` (type) · `nv` (name) · `pnp` (street number, `0`/absent = none) · `td` (designator).
- `<luso>` — land use (many S/N urban refs are `suelos sin edificar` = unbuilt plots, not dwellings).

Interpret and emit:
- `td` gives a **plot number** (`PARCELA 34`) → `"Parcela 34"`.
- `td`/`dir` gives a **real street** (`CL. JOSEPH ORTIN 10`) → `"Calle Joseph Ortin 10"`.
- `td` empty and `dir` just echoes the zone → **fall back to `Ref. <RC>`**.

Be respectful: one-time lookups, ~0.8–1 s between requests. Record the lookup date in the code
comment above `OVC_SN_REF_LABELS`. Empirically (2026-07-20) ~60% of urban refs yielded a
distinguishing designator (mostly plot numbers); the rest fell back to `Ref. <RC>`.

---

## 4. Name-quality workflow for a new town

After the first build, audit the distinct `partida` values and fix at the source. What to look for:

- **Fragmentation by cadastral group tokens**: `MOCO EL GP.3`, `GP.4`… are one partida. The
  `GROUP_TOKEN_RE` strip merges them into `El Moco`. A reused number across GP fragments is a
  **different house** — never distance-merge these.
- **Spelling variants of one zone**: `S ANTONIO DE LA FLORIDA` vs `SAN ANTONIO FLORIDA`.
- **Abbreviations**: `Cr`→Carretera, `Vd`→Vereda, `Cmno`→Camino, `S/Sta/Sto`→San/Santa/Santo.
- **Article inconsistency**: `Dehesa la` / `Moco El` → `La Dehesa` / `El Moco`.

**Verify names against municipal sources** (town hall street index, Sede Catastro) before adding a
canonical override — do NOT guess truncations (`S Ba`, `V Bene`, `Nacion-340-R Ab` are left as-is).

Where each fix goes:

| Fix | Constant / mechanism |
|---|---|
| Always-on word expansion (non-saint) | `ABBREVIATIONS` |
| Saint expansion, guarded by a real following name token | `SAINT_ABBREVIATIONS` (`_is_name_token`) |
| Verified diacritics (proper nouns) | `PROPER_NOUN_ACCENTS` |
| Per-town display rename / spelling fix / **zone merge** | `CANONICAL_ZONE_NAMES[muni]` (keyed by the cleaned base name) |
| Distance-merge two spellings of the **same** place | `DISTANCE_MERGE_ZONES[muni]` |

**`DISTANCE_MERGE_ZONES` / the 150 m rule**: only for zones that are two spellings of ONE place.
Colliding `(zone, number)` points ≤150 m apart merge-average (a duplicate registered under both
spellings); >150 m stay separate (the number was reused for a distant house). Never list GP-fragment
zones here.

---

## 5. ID-stability contract (most critical)

Place ids are the key under which drivers' edits (`placeEdits`) are stored. **Ids must never churn.**

- **Ids are frozen** via the legacy cleaner: `legacy_zone_slug` → `_legacy_clean_zone` +
  `_legacy_title_case_es`. Numbered id = `{legacy-slug}-{number}`. This reproduces every shipped id
  byte-for-byte regardless of display changes.
- **Display names evolve separately** via `clean_zone` + `canonical_zone`. Changing a display name,
  adding an abbreviation, or renaming a zone does NOT change ids (slugs are case/accent-insensitive
  and legacy-derived).
- **S/N ids** derive from the persistent cadastral parcel ref (`{legacy-slug}-sn-{ref}`, plus the
  grid cell only when one parcel holds several distinct points). Order-independent and stable.

### Never do
- **Never modify `_legacy_clean_zone` / `_legacy_title_case_es`** (or `slugify` in a way that changes
  output) — it silently re-keys every place.
- **Never derive S/N ids from enumeration order** — they must come from the parcel ref / coordinates.
- **Never add the display name-fixes to the legacy cleaner.**
- **Never `ref` a numbered place** (tier a stays byte-identical).

### Pre-ship verification checklist
Diff the new `data/<town>.json` against the previously shipped one, per town:

- [ ] **0 lost ids** — except ids intentionally removed by a documented close-merge (e.g. the 8
      `san-antonio-florida-*` duplicates); list any.
- [ ] **0 moved coordinates** on surviving ids — except the merge survivors above.
- [ ] **0 duplicate ids** in the output.
- [ ] Every **added** place is a new S/N point or a justified PL/allow-list inclusion.
- [ ] Numbered records byte-identical (no `ref`, same coords/name/id).
- [ ] Name changes are all intended renames.

### `resolve_version`
Bumps the version when the `places` array bytes change; keeps the previous version when identical
(so re-running a build with no data change does not spuriously bump). A town with no affected points
keeps its version. This drives the app's "Actualizar" prompt for already-downloaded towns.
