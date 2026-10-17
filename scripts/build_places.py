#!/usr/bin/env python3
"""Build data/places.json from OpenStreetMap (Overpass API).
Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
Usage: build_places.py [--from-file osm.json]
Entries within 150 m of a live-data clinic (data/waits.json) are dropped as duplicates.
"""
import json, math, re, os, sys, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
Q = ('[out:json][timeout:180];area["ISO3166-1"="NZ"][admin_level=2]->.nz;'
     '(nwr["amenity"~"^(hospital|clinic|doctors)$"](area.nz);'
     'nwr["healthcare"~"^(hospital|clinic|doctor)$"](area.nz););out center tags;')

def load_osm():
    if '--from-file' in sys.argv:
        return json.load(open(sys.argv[sys.argv.index('--from-file') + 1]))
    body = urllib.parse.urlencode({'data': Q}).encode()
    req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=body,
                                 headers={'User-Agent': 'HaveSick-places-builder/0.1'})
    return json.load(urllib.request.urlopen(req, timeout=240))

def dist_m(a, b, c, d):
    p = math.pi / 180
    h = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))

URGENT_WORDS = ('urgent', 'accident', 'after hours', 'afterhours', 'after-hours', 'a&m', 'a & m', '24 hour', '24/7', 'shorecare')

def main():
    osm = load_osm()['elements']
    try:
        live = json.load(open(os.path.join(DATA, 'waits.json')))['places']
    except Exception:
        live = []
    out, seen = [], set()
    for e in osm:
        t = e.get('tags', {})
        name = t.get('name') or t.get('official_name')
        if not name: continue
        lat = e.get('lat') or e.get('center', {}).get('lat')
        lon = e.get('lon') or e.get('center', {}).get('lon')
        if lat is None: continue
        a = t.get('amenity') or ''
        hc = t.get('healthcare') or ''
        if a not in ('hospital', 'clinic', 'doctors') and hc not in ('hospital', 'clinic', 'doctor'): continue
        low = name.lower()
        if a == 'hospital' or hc == 'hospital':
            kind = 'ed' if t.get('emergency') == 'yes' else 'hospital'
        elif any(w in low for w in URGENT_WORDS) or t.get('emergency') == 'yes':
            kind = 'urgent'
        elif a == 'clinic' or hc == 'clinic':
            kind = 'clinic'
        else:
            kind = 'doctors'
        key = (low, round(lat, 3), round(lon, 3))
        if key in seen: continue
        seen.add(key)
        if any(dist_m(lat, lon, p['lat'], p['lon']) < 150 for p in live): continue
        rec = dict(id=f"osm-{e['type'][0]}{e['id']}", name=name, kind=kind, lat=round(lat, 6), lon=round(lon, 6))
        for k, src in (('phone', ('phone', 'contact:phone')), ('website', ('website', 'contact:website')),
                       ('hours', ('opening_hours',))):
            for s in src:
                if t.get(s): rec[k] = t[s]; break
        addr = ' '.join(filter(None, [t.get('addr:housenumber'), t.get('addr:street')]))
        city = t.get('addr:city') or t.get('addr:suburb')
        if addr or city: rec['address'] = ', '.join(filter(None, [addr, city]))
        out.append(rec)
    # merge duplicate hospital entries (OSM often has node + building way, or "X Hospital" vs "X Public Hospital")
    def norm(n):
        return ' '.join(w for w in re.sub(r'[^a-z0-9 ]', ' ', n.lower()).split() if w not in ('public', 'hospital', 'the', 'emergency', 'department', 'ed'))
    out.sort(key=lambda r: (r['kind'] != 'ed', -len(r)))  # prefer ED-tagged, then richer records
    kept = []
    for r in out:
        if r['kind'] in ('ed', 'hospital') and any(k['kind'] in ('ed', 'hospital') and norm(k['name']) == norm(r['name'])
                                                     and dist_m(r['lat'], r['lon'], k['lat'], k['lon']) < 500 for k in kept):
            continue
        kept.append(r)
    out = kept
    doc = dict(attribution='© OpenStreetMap contributors (ODbL)', source='Overpass API',
               count=len(out), places=out)
    json.dump(doc, open(os.path.join(DATA, 'places.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    from collections import Counter
    print(len(out), Counter(p['kind'] for p in out))

if __name__ == '__main__':
    main()
