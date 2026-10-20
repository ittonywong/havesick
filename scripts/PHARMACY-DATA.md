# Pharmacies & medicines data (Have Sick Phase 1)

Built offline by `scripts/build_pharmacy.py` → `data/pharmacies.json`, `data/medicines.json`, `data/pharmacy-build-report.json`.
The browser only ever reads these static files (after the user accepts the disclaimer). No live API calls, no Worker.

## Refresh (monthly, manual)
```
pip install openpyxl
python3 scripts/build_pharmacy.py --cache build-cache --refresh   # downloads the newest official files (polite, cached)
```
Then commit the three `data/pharmacy*.json` / `data/medicines.json` files. `build-cache/` is NOT part of the site.
If the disclaimer text changes, bump `DISCLAIMER_VERSION` in `assets/rx.js` (users are asked again).

## Sources (this build)
| Source | File / date | Licence |
|---|---|---|
| Medsafe Pharmacy Licence Register | PharmacyLicenceRegister.xlsx, "Register updated: 1 July 2026" | Crown copyright — Medsafe terms: acknowledge the Medsafe web site as source; no commercial use without written permission (Have Sick is free, no ads) |
| Pharmac Pharmaceutical Schedule | Schedule_2026-10.xml, edition October 2026, published 2026-10-08 | CC BY 4.0 — not endorsed by Pharmac |
| Medsafe CMI / data sheet indexes | revised 19 October 2026 / 19 October 2026 | links only (no content copied) |
| OpenStreetMap (Overpass, 2 queries) | osm_base 2026-10-20T07:20:10Z | ODbL — © OpenStreetMap contributors |

## Medsafe ↔ OSM matching
- Master list = every row of the Medsafe Pharmacy Licence Register (official). OSM is only used to add coordinates, opening_hours and phone.
- Names/addresses are folded (lower case, macrons removed, & -> and, street suffix abbreviations expanded).
- Tier A (address): OSM addr:housenumber + addr:street equal a number+street in the register address, no postcode conflict, AND (same postcode OR the address contains an OSM place name near the OSM point OR name similarity >= 0.34 OR same chain brand).
- Tier B (name + locality): distinctive-name Jaccard similarity >= 0.67 (generic words like pharmacy/chemist/unichem/life removed), the register address contains the name of an OSM place within 2-20 km of the OSM point (radius by place type), no postcode or street conflict.
- Tier C (name + street): similarity >= 0.5, same street name, locality check passes, no postcode conflict.
- One-to-one greedy assignment by score; if another candidate scores within 0.25 the pair is REJECTED as ambiguous (except duplicate OSM objects < 150 m apart).
- Unmatched register rows are shown without a map position, grouped by Health NZ district. Unmatched OSM objects are NOT shown (not verifiable against the register).

Result: 381 of 1097 register rows matched (34.7%): tier A 176, B 204, C 1;
38 candidate pairs rejected as ambiguous; 355 OSM objects not shown.
With opening hours 187, with phone 122. Every match is listed in `data/pharmacy-build-report.json` for audit.

## Medicine funding status
- Section B (community) only. Brand status per pack: Price ≤ Subsidy → fully funded, Price > Subsidy → partly funded. No numbers are written.
- Medicine shown "Fully funded" if at least one listed brand/form is fully funded; "Partly funded" if all are partly funded.
- "Conditions may apply" when the Schedule has Special Authority / endorsement / specialist / PCT / form rules.
- "Not funded (community)" only for Medsafe CMI product names that are not in Section B and do not overlap any listed brand
  or generic name (injections/vaccines excluded) — 281 names. Vaccines in Section I are shown as
  "National Immunisation Schedule".
- CMI / data sheet links: exact product-name match only (brand, or brand + first word of the chemical); otherwise the Medsafe search page.
