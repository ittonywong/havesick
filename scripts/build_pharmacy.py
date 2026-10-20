#!/usr/bin/env python3
"""Build the static data files for the Have Sick "Pharmacies & medicines" section.

Outputs (repo-root relative):
  data/pharmacies.json  - Medsafe Pharmacy Licence Register, merged with OpenStreetMap (ODbL) where a
                          high-confidence match exists (coordinates, opening_hours, phone).
  data/medicines.json   - Pharmac Pharmaceutical Schedule (CC BY 4.0), Section B (community), reduced to
                          FUNDING STATUS ONLY (no price / subsidy / surcharge numbers are written), plus
                          links to Medsafe CMI / data sheet PDFs where the product name matches exactly.
  data/pharmacy-build-report.json - match statistics, method, source dates (for audit; not used by the page).

Sources (all official / openly licensed; nothing is scraped from retailers):
  Medsafe   https://www.medsafe.govt.nz/compliance/PharmacyLicenceRegister.xlsx   (Crown copyright, reuse allowed)
  Pharmac   https://schedule.pharmac.govt.nz/pub/schedule/archive/Schedule_YYYY-MM.xml (CC BY 4.0)
  Medsafe   https://www.medsafe.govt.nz/Consumers/CMI/CMIIndex.htm and /profs/Datasheet/datasheet.htm
  OSM       Overpass API, ONE query for pharmacies + ONE for place names (used only to check localities),
            identified User-Agent, exponential back-off, results cached in --cache. Never queried by the browser.

Usage:
  python3 scripts/build_pharmacy.py --cache build-cache            # reuse cached files where present
  python3 scripts/build_pharmacy.py --cache build-cache --refresh  # re-download everything (polite)
Requires: Python 3.9+, openpyxl.
"""
import argparse, datetime as dt, html, json, math, os, re, sys, time, unicodedata, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

UA = "HaveSick-build/1.0 (static data build for a free, ad-free NZ health info site; github.com/ittonywong/havesick)"
OVERPASS = "https://overpass-api.de/api/interpreter"
MEDSAFE_REG = "https://www.medsafe.govt.nz/compliance/PharmacyLicenceRegister.xlsx"
MEDSAFE_REG_PAGE = "https://www.medsafe.govt.nz/compliance/pharmacy-licence-register.asp"
CMI_INDEX = "https://www.medsafe.govt.nz/Consumers/CMI/CMIIndex.htm"
DS_INDEX = "https://www.medsafe.govt.nz/profs/Datasheet/datasheet.htm"
PHARMAC_ARCHIVE = "https://schedule.pharmac.govt.nz/pub/schedule/archive/"
Q_PHARM = ('[out:json][timeout:180];area["ISO3166-1"="NZ"][admin_level=2]->.nz;'
           '(nwr["amenity"="pharmacy"](area.nz);nwr["healthcare"="pharmacy"](area.nz););out center tags;')
Q_PLACES = ('[out:json][timeout:180];area["ISO3166-1"="NZ"][admin_level=2]->.nz;'
            'node["place"~"^(city|town|village|suburb|hamlet|neighbourhood|quarter|locality)$"]["name"](area.nz);out;')

# ---------------------------------------------------------------- download helpers
def fetch(url, dest, data=None, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=240) as r:
                body = r.read()
            with open(dest, "wb") as f:
                f.write(body)
            return
        except Exception as e:  # 429/502/504 from Overpass: back off
            wait = 30 * (2 ** i)
            print(f"  fetch failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"could not fetch {url}")

def cached(cache, name, url, refresh, data=None):
    p = os.path.join(cache, name)
    if refresh or not os.path.exists(p):
        print("download", url)
        fetch(url, p, data)
        time.sleep(2)
    return p

# ---------------------------------------------------------------- text normalisation
def fold(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ").replace("@", " at ").replace("’", "'")
    s = re.sub(r"[^a-z0-9' ]+", " ", s).replace("'", "")
    return re.sub(r"\s+", " ", s).strip()

SUFFIX = {"rd": "road", "st": "street", "ave": "avenue", "av": "avenue", "dr": "drive", "pl": "place",
          "cres": "crescent", "cr": "crescent", "tce": "terrace", "hwy": "highway", "ln": "lane", "sq": "square",
          "blvd": "boulevard", "pde": "parade", "cl": "close", "ct": "court", "gr": "grove", "mt": "mount"}
STREET_WORDS = {"road", "street", "avenue", "drive", "place", "crescent", "terrace", "highway", "lane", "square",
                "boulevard", "parade", "close", "court", "grove", "way", "quay", "mall", "esplanade", "rise",
                "promenade", "strand", "row", "track", "loop", "line", "centre", "plaza", "walk", "glade", "heights"}
UNIT_WORDS = {"shop", "shops", "unit", "level", "suite", "retail", "number", "lot", "building", "block", "gate", "kiosk"}

def street_norm(s):
    return " ".join(SUFFIX.get(t, t) for t in fold(s).split())

def parse_reg_address(addr):
    """-> list of (housenumber, street) and set of street names, postcode, folded words."""
    toks = [SUFFIX.get(t, t) for t in fold(addr).split()]
    pairs, streets = [], set()
    for i, t in enumerate(toks):
        if t in STREET_WORDS and i > 0:
            j = i - 1; name = []
            while j >= 0 and not re.fullmatch(r"\d+[a-z]?", toks[j]) and toks[j] not in UNIT_WORDS and len(name) < 4 \
                    and toks[j] not in STREET_WORDS and toks[j] not in {"and", "cnr", "corner", "of"}:
                name.insert(0, toks[j]); j -= 1
            if not name:
                continue
            st = " ".join(name + [t]); streets.add(st)
            if j >= 0 and re.fullmatch(r"\d+[a-z]?", toks[j]) and not (j > 0 and toks[j - 1] in UNIT_WORDS):
                pairs.append((toks[j], st))
                # "20 - 21 Queen Street": the first number of a range is also a valid house number
                if j > 0 and re.fullmatch(r"\d+[a-z]?", toks[j - 1]) and not (j > 1 and toks[j - 2] in UNIT_WORDS):
                    pairs.append((toks[j - 1], st))
    pc = re.findall(r"\b(\d{4})\b\s*$", str(addr).strip())
    return pairs, streets, (pc[0] if pc else None), " " + " ".join(toks) + " "

GENERIC = {"pharmacy", "pharmacies", "chemist", "chemists", "limited", "ltd", "the", "and", "at", "of", "nz",
           "unichem", "life", "warehouse", "bargain", "amcal", "discount", "dispensary", "healthcare", "health",
           "care", "family", "medical", "centre", "center", "community", "plus", "store", "co", "company", "2012",
           "kiwi", "pharmacist", "pharmacists", "rx", "group", "new", "zealand"}
BRANDS = [("chemist warehouse", "cw"), ("bargain chemist", "bc"), ("unichem", "unichem"), ("life pharmacy", "life"),
          ("amcal", "amcal"), ("countdown pharmacy", "woolworths"), ("woolworths", "woolworths"), ("pharmasave", "pharmasave")]

def brand_of(*names):
    for n in names:
        f = fold(n)
        for k, v in BRANDS:
            if k in f:
                return v
    return None

def name_tokens(s):
    return {SUFFIX.get(t, t) for t in fold(s).split() if t not in GENERIC and len(t) > 1}

PLACE_TOKENS = set()

def jacc(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0

def hav(lat1, lon1, lat2, lon2):
    r = math.radians
    a = math.sin(r(lat2 - lat1) / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lon2 - lon1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))

# ---------------------------------------------------------------- pharmacies
def build_pharmacies(reg_path, osm_path, places_path, reg_meta):
    import openpyxl
    ws = openpyxl.load_workbook(reg_path, read_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    hdr = [str(h).strip().upper() for h in rows[0]]
    need = ["LEGAL_ENTITY_NAME", "PREMISES_NAME", "STREET_ADDRESS", "HEALTHNZ_DISTRICT", "HEALTHNZ_REGION"]
    ix = {k: hdr.index(k) for k in need}
    reg = []
    for r in rows[1:]:
        if not r or not r[ix["PREMISES_NAME"]]:
            continue
        rec = {k: (str(r[ix[k]]).strip() if r[ix[k]] is not None else "") for k in need}
        pairs, streets, pc, words = parse_reg_address(rec["STREET_ADDRESS"])
        rec.update(pairs=pairs, streets=streets, pc=pc, words=words,
                   ntok=name_tokens(rec["PREMISES_NAME"]) | name_tokens(rec["LEGAL_ENTITY_NAME"]) if False else name_tokens(rec["PREMISES_NAME"]),
                   ltok=name_tokens(rec["LEGAL_ENTITY_NAME"]), brand=brand_of(rec["PREMISES_NAME"]))
        reg.append(rec)

    osm_doc = json.load(open(osm_path))
    places = json.load(open(places_path))["elements"]
    RADIUS = {"city": 20, "town": 8, "village": 4, "suburb": 3, "quarter": 2.5, "neighbourhood": 2, "hamlet": 3, "locality": 3}
    grid = defaultdict(list)
    for p in places:
        grid[(round(p["lat"] * 5), round(p["lon"] * 5))].append(p)

    def localities(lat, lon):
        out = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for p in grid[(round(lat * 5) + dx, round(lon * 5) + dy)]:
                    if hav(lat, lon, p["lat"], p["lon"]) <= RADIUS[p["tags"]["place"]]:
                        n = fold(p["tags"]["name"])
                        if len(n) >= 4:
                            out.add(n)
        # cities have a 20 km radius: also scan wider for them
        for p in places:
            if p["tags"]["place"] == "city" and hav(lat, lon, p["lat"], p["lon"]) <= 20:
                out.add(fold(p["tags"]["name"]))
        return out

    PLACE_TOKENS.clear()
    for p in places:
        PLACE_TOKENS.update(t for t in fold(p["tags"]["name"]).split() if len(t) > 1)
    osm = []
    for e in osm_doc["elements"]:
        t = e.get("tags", {})
        lat = e.get("lat", e.get("center", {}).get("lat")); lon = e.get("lon", e.get("center", {}).get("lon"))
        if lat is None or not t.get("name") and not t.get("brand"):
            continue
        if t.get("disused:amenity") or t.get("vacant"):
            continue
        nm = t.get("name") or t.get("brand")
        o = dict(id=f'{e["type"][0]}{e["id"]}', lat=round(lat, 6), lon=round(lon, 6), name=nm,
                 hn=fold(t.get("addr:housenumber", "")), st=street_norm(t.get("addr:street", "")),
                 pc=t.get("addr:postcode"), ntok=name_tokens(nm) | name_tokens(t.get("branch", "")),
                 brand=brand_of(nm, t.get("brand", "")), hours=t.get("opening_hours"),
                 phone=t.get("phone") or t.get("contact:phone"),
                 extra=" " + " ".join(fold(t.get(k, "")) for k in ("addr:suburb", "addr:city", "addr:place", "addr:hamlet")) + " ")
        o["loc"] = localities(lat, lon)
        osm.append(o)

    def hn_eq(a, b):
        if not a or not b:
            return False
        a0 = re.split(r"[-/ ]", a)[0]; b0 = re.split(r"[-/ ]", b)[0]
        return a0 == b0 or re.sub(r"[a-z]$", "", a0) == re.sub(r"[a-z]$", "", b0) and (a0.isdigit() or b0.isdigit())

    cands = []
    for ri, r in enumerate(reg):
        for oi, o in enumerate(osm):
            # cheap prefilter: share a street name, a postcode or a distinctive name token
            share_st = o["st"] and o["st"] in r["streets"]
            sim = max(jacc(r["ntok"], o["ntok"]), jacc(r["ltok"], o["ntok"]) * 0.9)
            if not (share_st or sim > 0 or (o["pc"] and o["pc"] == r["pc"])):
                continue
            pc_conflict = bool(o["pc"] and r["pc"] and o["pc"] != r["pc"])
            st_conflict = bool(o["st"] and r["streets"] and o["st"] not in r["streets"])
            loc_ok = any(f" {n} " in r["words"] for n in o["loc"]) or \
                     any(w and f" {w} " in r["words"] for w in o["extra"].split("  ") if len(w.strip()) >= 4)
            addr = share_st and any(hn_eq(o["hn"], h) for h, s in r["pairs"] if s == o["st"])
            brand_ok = bool(r["brand"] and r["brand"] == o["brand"])
            brand_conflict = bool(r["brand"] and o["brand"] and r["brand"] != o["brand"])
            # names whose only distinctive words are place names ("Cambridge Pharmacy") need the same chain (or none)
            placey = (r["ntok"] & o["ntok"]) <= PLACE_TOKENS
            brand_same = (r["brand"] == o["brand"])
            tier = None
            if addr and not pc_conflict and (o["pc"] == r["pc"] or loc_ok or sim >= 0.34 or brand_ok) \
                    and (not brand_conflict or sim >= 0.34):
                tier, score = "A", 3 + sim
            elif sim >= 0.67 and loc_ok and not pc_conflict and not st_conflict and not brand_conflict \
                    and (not placey or brand_same):
                tier, score = "B", 2 + sim
            elif share_st and sim >= 0.5 and loc_ok and not pc_conflict and not brand_conflict and (not placey or brand_same):
                tier, score = "C", 1.5 + sim
            if tier:
                cands.append((score, ri, oi, tier))

    # one-to-one assignment, refusing ambiguous cases
    by_reg = defaultdict(list); by_osm = defaultdict(list)
    for c in cands:
        by_reg[c[1]].append(c); by_osm[c[2]].append(c)
    match, amb, amb_list = {}, Counter(), []
    used_o = set()
    for score, ri, oi, tier in sorted(cands, reverse=True):
        if ri in match or oi in used_o:
            continue
        rivals_o = [c for c in by_reg[ri] if c[2] != oi and c[2] not in used_o]
        rivals_r = [c for c in by_osm[oi] if c[1] != ri and c[1] not in match]
        # a rival OSM object within 150 m is the same shop mapped twice (node + building) -> not ambiguous
        rivals_o = [c for c in rivals_o if hav(osm[c[2]]["lat"], osm[c[2]]["lon"], osm[oi]["lat"], osm[oi]["lon"]) > 0.15]
        if any(score - c[0] < 0.25 for c in rivals_o) or any(score - c[0] < 0.25 for c in rivals_r):
            amb[tier] += 1
            amb_list.append({"tier": tier, "register": reg[ri]["PREMISES_NAME"], "reg_addr": reg[ri]["STREET_ADDRESS"],
                             "osm": osm[oi]["name"], "osm_id": osm[oi]["id"]})
            continue
        match[ri] = (oi, tier, round(score, 2)); used_o.add(oi)

    out = []
    tiers = Counter()
    for ri, r in enumerate(reg):
        p = {"n": r["PREMISES_NAME"], "a": r["STREET_ADDRESS"], "d": r["HEALTHNZ_DISTRICT"], "r": r["HEALTHNZ_REGION"]}
        if ri in match:
            oi, tier, sc = match[ri]; o = osm[oi]; tiers[tier] += 1
            p.update(lat=o["lat"], lon=o["lon"], osm=o["id"], m=tier)
            if o["hours"]: p["h"] = o["hours"]
            if o["phone"]: p["p"] = o["phone"]
        out.append(p)
    out.sort(key=lambda p: (p["d"], fold(p["n"])))
    stats = {
        "register_rows": len(reg), "osm_objects_with_name": len(osm), "matched": len(match),
        "match_rate_pct": round(100 * len(match) / len(reg), 1), "by_tier": dict(tiers),
        "rejected_ambiguous": dict(amb),
        "with_coordinates": sum(1 for p in out if "lat" in p), "with_hours": sum(1 for p in out if "h" in p),
        "with_phone": sum(1 for p in out if "p" in p),
        "osm_unmatched_not_shown": len(osm) - len(used_o),
    }
    audit = [{"tier": t, "register": reg[ri]["PREMISES_NAME"], "reg_addr": reg[ri]["STREET_ADDRESS"],
              "osm": osm[oi]["name"], "osm_id": osm[oi]["id"], "osm_addr": f'{osm[oi]["hn"]} {osm[oi]["st"]} {osm[oi]["pc"] or ""}'.strip(),
              "score": sc} for ri, (oi, t, sc) in sorted(match.items())]
    return out, stats, {"matches": audit, "rejected_ambiguous": amb_list}

# ---------------------------------------------------------------- Medsafe CMI / data sheet indexes
def parse_index(path, base):
    h = open(path, encoding="latin-1").read()
    out = defaultdict(list)
    for href, txt in re.findall(r'<a[^>]+href="([^"]+\.pdf)"[^>]*>(.*?)</a>', h, re.S | re.I):
        title = html.unescape(re.sub(r"\s+", " ", re.sub("<[^>]+>", "", txt))).strip()
        title = re.sub(r"\s+,", ",", title)
        if not title:
            continue
        product = title.split(",")[0]
        url = urllib.parse.quote(urllib.parse.urljoin(base, href.strip()), safe=":/?&=#%~+-._")  # e.g. spaces in file names
        key = re.sub(r"[^a-z0-9]", "", fold(product))
        key2 = re.sub(r"\d+(mg|mcg|g|ml)?$", "", key)  # "Promethazine 25" -> "promethazine"
        for k in {key, key2}:
            if k and (title, url) not in out[k]:
                out[k].append((title, url))
    return out

def revised(path):
    m = re.search(r"Revised:\s*([^<]+)", open(path, encoding="latin-1").read())
    return m.group(1).strip() if m else None

# ---------------------------------------------------------------- Pharmac schedule
NS = "{http://schedule.pharmac.govt.nz/2006/07/Schedule#}"
COND_RULES = {"Special", "SubRxF", "SpecEnd", "PCT", "FormReqd"}

def build_medicines(xml_path, cmi, ds):
    root = ET.parse(xml_path).getroot()
    front = root.find(NS + "Front")
    edition = front.findtext(NS + "Edition"); published = front.findtext(NS + "Published")
    sec = next(s for s in root.findall(NS + "Section") if s.get("ID") == "B")
    chems = {}
    def cond(el):
        return any(r.get("Type") in COND_RULES for r in el.findall(NS + "Rule")) or el.find(NS + "Request") is not None
    for ch in sec.iter(NS + "Chemical"):
        cname = (ch.findtext(NS + "Name") or "").strip()
        if not cname:
            continue
        c = chems.setdefault(cname.lower(), {"n": cname, "f": {}, "c": False})
        c["c"] = c["c"] or cond(ch)
        for fo in ch.findall(NS + "Formulation"):
            fname = (fo.findtext(NS + "Name") or "").strip()
            f = c["f"].setdefault(fname, {"n": fname, "b": {}, "c": False})
            f["c"] = f["c"] or cond(fo)
            for br in fo.findall(NS + "Brand"):
                bname = (br.findtext(NS + "Name") or "").strip()
                st = []
                for pk in br.findall(NS + "Pack"):
                    try:
                        price = float(pk.findtext(NS + "Price")); sub = float(pk.findtext(NS + "Subsidy"))
                    except (TypeError, ValueError):
                        continue
                    st.append("F" if price <= sub + 1e-9 else "P")
                s = "F" if st and all(x == "F" for x in st) else ("P" if st else "?")
                prev = f["b"].get(bname)
                f["b"][bname] = s if prev in (None, s) else "P"
    # links: exact product-name match only (brand, or "brand chemical-first-word")
    links, link_ix = [], {}
    def lid(kind, title, url):
        k = (kind, url, title)
        if k not in link_ix:
            link_ix[k] = len(links); links.append([kind, title, url])
        return link_ix[k]
    meds, pharmac_keys = [], set()
    nlinked = 0
    for c in sorted(chems.values(), key=lambda c: c["n"].lower()):
        forms = []
        allb = set()
        for f in c["f"].values():
            brands = []
            for bname, s in sorted(f["b"].items()):
                allb.add(bname)
                brands.append([bname, s])
            forms.append({"n": f["n"], "b": brands, **({"c": 1} if f["c"] else {})})
        lk = []
        first = re.sub(r"[^a-z0-9]", "", fold(c["n"]).split(" ")[0]) if c["n"] else ""
        for b in sorted(allb):
            kb = re.sub(r"[^a-z0-9]", "", fold(b))
            pharmac_keys.add(kb)
            for idx, kind in ((cmi, "cmi"), (ds, "ds")):
                hits = idx.get(kb) or idx.get(kb + first) or []
                for title, url in hits[:3]:
                    i = lid(kind, title, url)
                    if i not in lk:
                        lk.append(i)
        stat = {s for f in forms for _, s in f["b"]}
        overall = "F" if "F" in stat else ("P" if "P" in stat else "?")
        m = {"n": c["n"], "s": overall, "f": forms}
        if c["c"] or any(f.get("c") for f in forms):
            m["c"] = 1
        if lk:
            m["l"] = lk[:12]; nlinked += 1
        meds.append(m)
    # Section I (National Immunisation Schedule): names only, so vaccines are never shown as "not funded"
    imm = {}
    seci = next((s for s in root.findall(NS + "Section") if s.get("ID") == "I"), None)
    if seci is not None:
        for ch in seci.iter(NS + "Chemical"):
            cn = (ch.findtext(NS + "Name") or "").strip()
            bl = sorted({(b.findtext(NS + "Name") or "").strip() for b in ch.iter(NS + "Brand")} - {""})
            if cn:
                e = imm.setdefault(cn.lower(), {"n": cn, "b": set()}); e["b"].update(bl)
                for b in bl:
                    pharmac_keys.add(re.sub(r"[^a-z0-9]", "", fold(b)))
    immun = []
    for e in sorted(imm.values(), key=lambda e: e["n"].lower()):
        lk = []
        for b in sorted(e["b"]):
            kb = re.sub(r"[^a-z0-9]", "", fold(b))
            for idx, kind in ((cmi, "cmi"), (ds, "ds")):
                for title, url in (idx.get(kb) or [])[:2]:
                    i = lid(kind, title, url)
                    if i not in lk:
                        lk.append(i)
        immun.append({"n": e["n"], "b": sorted(e["b"]), **({"l": lk[:8]} if lk else {})})
    # Medsafe-approved products with a CMI that are NOT in Section B under that product name -> "not listed"
    notlisted = {}
    chem_words = set()
    for c in chems.values():
        for w in re.split(r"[ ,\[\]()+/-]+", fold(c["n"])):
            if len(w) >= 5 and w not in {"with", "sodium", "hydrochloride", "acid", "potassium", "calcium", "acetate", "phosphate", "sulphate", "maleate", "oral", "vitamin", "compound", "magnesium", "chloride", "citrate"}:
                chem_words.add(" " + w + " ")
    brand_keys_long = {k for k in pharmac_keys if len(k) >= 5}
    brand_first_words = set()
    for c in chems.values():
        for f in c["f"].values():
            for b in f["b"]:
                brand_first_words.add(re.split(r"[ -]", fold(b))[0])
    for k, items in cmi.items():
        if k in pharmac_keys:
            continue
        for title, url in items:
            prod = title.split(",")[0].strip()
            form = title.lower()
            # injected / infused / vaccine products are mostly given by clinics or hospitals: do not label them
            # "not funded (community)" (could mislead) -> left out of the search entirely
            if re.search(r"injection|infusion|vaccine|implant|for inhalation anaesthe|dental", form):
                continue
            pk = re.sub(r"[^a-z0-9]", "", fold(prod))
            pk2 = re.sub(r"\d+(mg|mcg|g|ml)?$", "", pk)
            fp = " " + fold(prod) + " "
            # conservative: generic-named products ("Paracetamol + Codeine", "Noumed Paracetamol Osteo") and names that
            # overlap a listed brand ("Telfast" vs "Telfast Oral Liquid") are left out, so a funded medicine is
            # never shown as "not funded" just because the CMI uses a different product name
            fw = fold(prod).split(" ")[0]
            if any(w in fp for w in chem_words) or any(pk.startswith(b) or b.startswith(pk) for b in brand_keys_long) \
                    or (len(fw) >= 4 and fw in brand_first_words):
                continue
            if pk in pharmac_keys or pk2 in pharmac_keys or "vaccine" in pk or any(fold(prod) == fold(c["n"]) for c in chems.values()):
                continue
            notlisted.setdefault(prod.lower(), {"n": prod, "l": []})
            i = lid("cmi", title, url)
            if i not in notlisted[prod.lower()]["l"]:
                notlisted[prod.lower()]["l"].append(i)
    nl = sorted(notlisted.values(), key=lambda x: x["n"].lower())
    stats = {"chemicals": len(meds), "brands": len({b for m in meds for f in m["f"] for b, _ in f["b"]}),
             "chemicals_fully_funded_any": sum(m["s"] == "F" for m in meds),
             "chemicals_partly_only": sum(m["s"] == "P" for m in meds),
             "chemicals_status_unknown": sum(m["s"] == "?" for m in meds),
             "chemicals_with_conditions": sum(1 for m in meds if m.get("c")),
             "chemicals_with_medsafe_links": nlinked, "links": len(links),
             "cmi_products_not_in_schedule": len(nl)}
    stats["immunisation_schedule_entries"] = len(immun)
    return meds, nl, immun, links, stats, edition, published

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default="build-cache")
    ap.add_argument("--out", default="data")
    ap.add_argument("--schedule", help="Schedule XML file name in the archive, e.g. Schedule_2026-10.xml (default: latest)")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True); os.makedirs(a.out, exist_ok=True)

    sched = a.schedule
    if not sched:
        cands = sorted(f for f in os.listdir(a.cache) if re.fullmatch(r"Schedule_\d{4}-\d{2}\.xml", f))
        if a.refresh or not cands:
            idx = cached(a.cache, "pharmac_archive.html", PHARMAC_ARCHIVE, True)
            names = sorted(set(re.findall(r"Schedule_\d{4}-\d{2}\.xml", open(idx).read())))
            sched = names[-1]
        else:
            sched = cands[-1]
    xml = cached(a.cache, sched, PHARMAC_ARCHIVE + sched, a.refresh)
    reg = cached(a.cache, "reg.xlsx", MEDSAFE_REG, a.refresh)
    regpage = cached(a.cache, "reg_page.html", MEDSAFE_REG_PAGE, a.refresh)
    cmi_p = cached(a.cache, "cmi_index.html", CMI_INDEX, a.refresh)
    ds_p = cached(a.cache, "ds_index.html", DS_INDEX, a.refresh)
    osm_p = cached(a.cache, "osm_nz_pharmacies.json", OVERPASS, a.refresh, urllib.parse.urlencode({"data": Q_PHARM}).encode())
    pl_p = cached(a.cache, "osm_places.json", OVERPASS, a.refresh, urllib.parse.urlencode({"data": Q_PLACES}).encode())

    rp = open(regpage, encoding="latin-1").read()
    m = re.search(r"Register updated:\s*([^<]+)", rp); reg_updated = m.group(1).strip() if m else None
    osm_base = json.load(open(osm_p)).get("osm3s", {}).get("timestamp_osm_base")

    pharm, pstats, audit = build_pharmacies(reg, osm_p, pl_p, None)
    cmi = parse_index(cmi_p, CMI_INDEX); ds = parse_index(ds_p, DS_INDEX)
    meds, notlisted, immun, links, mstats, edition, published = build_medicines(xml, cmi, ds)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    pj = {"generated": now,
          "sources": {"medsafe_register_updated": reg_updated, "medsafe_register_url": MEDSAFE_REG_PAGE,
                      "osm_base": osm_base},
          "stats": {k: pstats[k] for k in ("register_rows", "matched", "match_rate_pct", "with_coordinates", "with_hours", "with_phone")},
          "pharmacies": pharm}
    mj = {"generated": now,
          "sources": {"pharmac_edition": edition, "pharmac_published": published, "pharmac_file": sched,
                      "pharmac_url": PHARMAC_ARCHIVE + sched, "cmi_index_revised": revised(cmi_p),
                      "datasheet_index_revised": revised(ds_p)},
          "medicines": meds, "immunisation": immun, "notListed": notlisted, "links": links}
    for name, obj in (("pharmacies.json", pj), ("medicines.json", mj)):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    rep = {"generated": now, "pharmacy_stats": pstats, "medicine_stats": mstats,
           "sources": {**pj["sources"], **mj["sources"]},
           "matching_method": [
               "Master list = every row of the Medsafe Pharmacy Licence Register (official). OSM is only used to add coordinates, opening_hours and phone.",
               "Names/addresses are folded (lower case, macrons removed, & -> and, street suffix abbreviations expanded).",
               "Tier A (address): OSM addr:housenumber + addr:street equal a number+street in the register address, no postcode conflict, AND (same postcode OR the address contains an OSM place name near the OSM point OR name similarity >= 0.34 OR same chain brand).",
               "Tier B (name + locality): distinctive-name Jaccard similarity >= 0.67 (generic words like pharmacy/chemist/unichem/life removed), the register address contains the name of an OSM place within 2-20 km of the OSM point (radius by place type), no postcode or street conflict.",
               "Tier C (name + street): similarity >= 0.5, same street name, locality check passes, no postcode conflict.",
               "One-to-one greedy assignment by score; if another candidate scores within 0.25 the pair is REJECTED as ambiguous (except duplicate OSM objects < 150 m apart).",
               "Unmatched register rows are shown without a map position, grouped by Health NZ district. Unmatched OSM objects are NOT shown (not verifiable against the register).",
           ],
           **audit}
    with open(os.path.join(a.out, "pharmacy-build-report.json"), "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)
    print(json.dumps({"pharmacy": pstats, "medicine": mstats}, indent=1))

if __name__ == "__main__":
    main()
