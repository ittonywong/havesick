#!/usr/bin/env python3
"""Have Sick collector v2: fetch verified NZ live wait sources -> data/waits.json.

Standard library only (runs on GitHub Actions with the runner's python3).

Politeness:
  * exactly ONE HTTP request per source per run (plus robots.txt, max once per day per host)
  * identifying User-Agent with project URL
  * honours robots.txt (urllib.robotparser); a Disallow => source skipped
  * gzip, and conditional requests (If-None-Match / If-Modified-Since) where the server supports them
  * exponential backoff after errors (10 min, 20, 40, 80 … max 2 h); honours Retry-After on 429/503
Robustness: if a source fails / is skipped, its last good values are kept and flagged stale.

Env vars (tests):
  HAVESICK_FAIL=pegasus,anglesea   simulate failures      HAVESICK_OUT=path   output file
  HAVESICK_IGNORE_BACKOFF=1        always try every source
"""
import datetime as dt, gzip, html, json, os, re, sys, urllib.error, urllib.request, urllib.robotparser
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

NZ = ZoneInfo('Pacific/Auckland')
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('HAVESICK_OUT', os.path.join(HERE, '..', 'data', 'waits.json'))
FAIL = set(filter(None, os.environ.get('HAVESICK_FAIL', '').split(',')))
IGNORE_BACKOFF = os.environ.get('HAVESICK_IGNORE_BACKOFF') == '1'
UA = 'HaveSick/0.2 (personal family wait-time viewer; +https://github.com/ittonywong/havesick)'
UA_TOKEN = 'HaveSick'
TIMEOUT = 25
BACKOFF_BASE_MIN, BACKOFF_MAX_MIN = 10, 120
ROBOTS_TTL_H = 24


def now_utc():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)

def iso(d):
    return d.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z') if d else None

def parse_iso(s):
    try: return dt.datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None
    except Exception: return None

class NotModified(Exception):
    pass

class HTTPStatus(Exception):
    def __init__(self, code, retry_after=None):
        super().__init__(f'HTTP {code}'); self.code = code; self.retry_after = retry_after

def fetch(url, state, conditional=True):
    """One GET. Updates state['http'] with etag/last_modified/bytes. Raises NotModified on 304."""
    h = {'User-Agent': UA, 'Accept-Encoding': 'gzip', 'Accept': '*/*'}
    http = state.setdefault('http', {})
    if conditional and http.get('etag'): h['If-None-Match'] = http['etag']
    if conditional and http.get('last_modified'): h['If-Modified-Since'] = http['last_modified']
    req = urllib.request.Request(url, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        if e.code == 304:
            http['last_status'] = 304; http['bytes'] = 0
            raise NotModified()
        ra = e.headers.get('Retry-After') if e.headers else None
        raise HTTPStatus(e.code, ra)
    raw = r.read()
    http['bytes'] = len(raw); http['last_status'] = r.status
    if (r.headers.get('Content-Encoding') or '').lower() == 'gzip':
        raw = gzip.decompress(raw)
    http['etag'] = r.headers.get('ETag')
    http['last_modified'] = r.headers.get('Last-Modified')
    return raw.decode('utf-8', 'replace'), r.headers

ROBOTS = {}
def robots_allowed(url, robots_cache):
    """robots.txt check, cached in waits.json for 24 h per host (so ~1 extra request/day/host)."""
    from urllib.parse import urlsplit
    host = '{0.scheme}://{0.netloc}'.format(urlsplit(url))
    ent = robots_cache.get(host)
    fresh = ent and parse_iso(ent.get('fetched_at')) and (now_utc() - parse_iso(ent['fetched_at'])).total_seconds() < ROBOTS_TTL_H * 3600
    if not fresh:
        body = ''
        try:
            req = urllib.request.Request(host + '/robots.txt', headers={'User-Agent': UA})
            body = urllib.request.urlopen(req, timeout=TIMEOUT).read().decode('utf-8', 'replace')
            status = 'ok'
        except urllib.error.HTTPError as e:
            status = f'http {e.code}'  # 4xx => no robots.txt => allowed (RFC 9309)
            if e.code >= 500: body = 'User-agent: *\nDisallow: /'
        except Exception as e:
            status = f'error {type(e).__name__}'  # unreachable: be conservative only if we never had one
            body = (ent or {}).get('body', '')
        ent = dict(fetched_at=iso(now_utc()), status=status, body=body[:20000])
        robots_cache[host] = ent
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(ent.get('body', '').splitlines())
    return rp.can_fetch(UA_TOKEN, url)

def text(s):
    s = re.sub(r'<script.*?</script>|<style.*?</style>', '', s, flags=re.S)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s)))

def to_int(x):
    try: return int(str(x).strip())
    except Exception: return None

# ---------------------------------------------------------------- sources
def src_whitecross(state):
    url = 'https://www.whitecross.co.nz/urgent-care-wait-times'
    s, _ = fetch(url, state, conditional=False)  # server sends no validators
    items = list(re.finditer(r'data-clinic-name="([^"]*)"\s*data-clinic-code="([^"]*)"\s*data-is-open="([^"]*)"\s*data-coordinates="([^"]*)".*?data-waiting-time="([^"]*)"', s, re.S))
    if not items: raise ValueError('no clinics parsed (page layout changed?)')
    places = []
    for i, m in enumerate(items):
        end = items[i + 1].start() if i + 1 < len(items) else len(s)
        block = s[m.start():end]
        tel = re.search(r'href="tel:([^"]+)"', block)
        link = re.search(r'href="(/clinics/[^"]+)"', block)
        lat, lon = (float(x) for x in m.group(4).split(','))
        lvl = to_int(m.group(5))
        places.append(dict(
            id='whitecross-' + m.group(2).lower(), name=html.unescape(m.group(1)), brand='White Cross',
            kind='urgent', lat=lat, lon=lon, is_open=(m.group(3) == 'True'),
            phone=tel.group(1).strip() if tel else None,
            website='https://www.whitecross.co.nz' + link.group(1) if link else url,
            wait=dict(type='busyness', value=lvl, scale_max=10,
                      label=f'{lvl}/10 busyness' if lvl is not None else None)))
    return places, None, 'Rendered live on each page load (no timestamp published)'

def src_pegasus(state):
    url = 'https://www.pegasus.health.nz/wait-time-dashboard'
    s, _ = fetch(url, state, conditional=False)  # no-store, no validators
    t = text(s)
    h = re.search(r'Less Urgent Patients\s+(\d+)(\+)?\s+Hours?', t)
    pw = re.search(r'(\d+)\s+Patients Waiting', t)
    tr = re.search(r'(\d+)\s+Patients Receiving Treatment', t)
    tc = re.search(r'(\d+)\s+Time-Critical Patients', t)
    lu = re.search(r'Last updated:\s*(\d{1,2}:\d{2}\s*[AP]M,\s*\d{1,2}\s+\w{3}\s+\d{4})', t)
    if not (h and pw): raise ValueError('wait values not found (page layout changed?)')
    src_upd = dt.datetime.strptime(re.sub(r'\s+', ' ', lu.group(1)), '%I:%M %p, %d %b %Y').replace(tzinfo=NZ) if lu else None
    hrs = int(h.group(1))
    return [dict(
        id='pegasus-24hoursurgery', name='24 Hour Surgery (Pegasus Health)', kind='urgent',
        lat=-43.5216188, lon=172.6415322,  # OSM node, 401 Madras Street, Christchurch
        is_open=True, hours='24/7', phone='03 365 7777', website='https://www.24hoursurgery.co.nz/',
        wait=dict(type='minutes', value=hrs * 60, approx_hours=True, plus=bool(h.group(2)),
                  label=f'~{hrs}{"+" if h.group(2) else ""} h (less-urgent patients)'),
        patients_waiting=int(pw.group(1)), in_treatment=to_int(tr.group(1)) if tr else None,
        time_critical=to_int(tc.group(1)) if tc else None,
        source_updated_at=iso(src_upd))], src_upd, 'Page "Last updated" text (appears to equal page render time)'

def parse_hm(s):
    m = re.match(r'^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*$', s or '')
    if not m or not (m.group(1) or m.group(2)): return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)

def src_accidenthealth(state):
    url = 'https://www.accidenthealth.co.nz/'
    s, _ = fetch(url, state, conditional=False)
    pw = re.search(r'id="patientsWaiting">([^<]*)<', s)
    aw = re.search(r'id="averageWait">([^<]*)<', s)
    if not (pw and aw): raise ValueError('wait values not found')
    raw = aw.group(1).strip()
    closed = raw.lower().startswith('closed')
    mins = None if closed else parse_hm(raw)
    if not closed and mins is None: raise ValueError(f'unrecognised wait value {raw!r}')
    nz_now = dt.datetime.now(NZ)
    return [dict(
        id='accidenthealth-tauranga', name='Accident & HealthCare Tauranga', kind='urgent',
        lat=-37.6892522, lon=176.1681636,  # OSM/Nominatim: 19 Second Avenue, Tauranga
        is_open=(not closed) and 8 <= nz_now.hour < 20, hours='8am–8pm daily', phone='07 577 0010', website=url,
        wait=dict(type='minutes', value=mins, label=('Closed' if closed else raw + ' (non-urgent)')),
        patients_waiting=to_int(pw.group(1)))], None, 'Rendered live on page load; the page itself refreshes every 120 s'

def src_anglesea(state):
    url = 'https://angleseawaittimes.org.nz/waittimes.json'
    s, hdr = fetch(url, state, conditional=True)  # ETag + Last-Modified supported => 304s
    j = json.loads(s)
    lm = hdr.get('Last-Modified')
    src_upd = parsedate_to_datetime(lm) if lm else None
    w = to_int(j['waittime_hours']) * 60 + to_int(j['waittime_minutes'])
    ed = to_int(j.get('ed_hours', 0)) * 60 + to_int(j.get('ed_minutes', 0))
    return [dict(
        id='anglesea-hamilton', name='Anglesea Clinic (Accident & Medical)', kind='urgent',
        lat=-37.7922146, lon=175.2830788,  # OSM building "Anglesea Clinic", 3 Thackeray St, Hamilton
        is_open=True, hours='24/7', phone='07 858 0800', website='https://www.angleseaclinic.org.nz/',
        wait=dict(type='minutes', value=w, label=f'{w // 60}h {w % 60}m'),
        ed_wait_minutes=ed, patients_waiting=to_int(j.get('patients')),
        source_updated_at=iso(src_upd))], src_upd, 'HTTP Last-Modified of waittimes.json (updated irregularly)'

SOURCES = {
    'whitecross': ('White Cross (Auckland & Whangārei)', 'https://www.whitecross.co.nz/urgent-care-wait-times', src_whitecross),
    'pegasus': ('Pegasus 24 Hour Surgery (Christchurch)', 'https://www.pegasus.health.nz/wait-time-dashboard', src_pegasus),
    'accidenthealth': ('Accident & HealthCare (Tauranga)', 'https://www.accidenthealth.co.nz/', src_accidenthealth),
    'anglesea': ('Anglesea Clinic (Hamilton)', 'https://angleseawaittimes.org.nz/waittimes.json', src_anglesea),
}

def main():
    try:
        prev = json.load(open(OUT, encoding='utf-8'))
    except Exception:
        prev = {}
    prev_src = prev.get('sources', {})
    robots_cache = prev.get('robots', {})
    prev_places = {}
    for p in prev.get('places', []):
        prev_places.setdefault(p.get('source'), []).append(p)

    started = now_utc()
    out_sources, out_places = {}, []
    for sid, (name, page, fn) in SOURCES.items():
        ps = prev_src.get(sid, {})
        state = dict(http=dict(ps.get('http', {})))
        fetched = now_utc()
        rec = dict(name=name, url=page, attempted_at=iso(fetched))
        old = prev_places.get(sid, [])
        nxt = parse_iso(ps.get('next_attempt_at'))
        try:
            if nxt and fetched < nxt and not IGNORE_BACKOFF:
                raise RuntimeError(f'backoff: skipped until {iso(nxt)}')
            if not robots_allowed(page, robots_cache):
                raise PermissionError('disallowed by robots.txt')
            if sid in FAIL: raise RuntimeError('simulated failure (HAVESICK_FAIL)')
            places, src_upd, note = fn(state)
            for p in places:
                p.update(source=sid, fetched_at=iso(fetched), stale=False)
                p.setdefault('source_updated_at', iso(src_upd))
            rec.update(status='ok', fetched_at=iso(fetched), last_success_at=iso(fetched), source_updated_at=iso(src_upd),
                       source_updated_note=note, error=None, failures=0, next_attempt_at=None, count=len(places))
            out_places += places
        except NotModified:
            # 304: source confirms nothing changed -> previous values are still current
            for p in old:
                p.update(fetched_at=iso(fetched), stale=False)
            out_places += old
            rec.update(status='ok', not_modified=True, fetched_at=iso(fetched), last_success_at=iso(fetched),
                       source_updated_at=ps.get('source_updated_at'), source_updated_note=ps.get('source_updated_note'),
                       error=None, failures=0, next_attempt_at=None, count=len(old))
        except Exception as e:
            skipped = isinstance(e, RuntimeError) and str(e).startswith('backoff')
            for p in old:
                p['stale'] = True  # keep last good value but flag it
            out_places += old
            failures = ps.get('failures', 0) + (0 if skipped else 1)
            if skipped:
                next_at = nxt
            else:
                delay = min(BACKOFF_BASE_MIN * 2 ** max(failures - 1, 0), BACKOFF_MAX_MIN)
                if isinstance(e, HTTPStatus) and e.retry_after and str(e.retry_after).isdigit():
                    delay = max(delay, min(int(e.retry_after) // 60, 24 * 60))
                if isinstance(e, PermissionError): delay = 24 * 60
                next_at = fetched + dt.timedelta(minutes=delay) - dt.timedelta(seconds=60)  # 60 s slack for cron jitter
            rec.update(status='skipped' if skipped else 'error', error=f'{type(e).__name__}: {e}'[:300],
                       fetched_at=ps.get('fetched_at'), last_success_at=ps.get('last_success_at'),
                       source_updated_at=ps.get('source_updated_at'), source_updated_note=ps.get('source_updated_note'),
                       failures=failures, next_attempt_at=iso(next_at), count=len(old), kept_last_good=bool(old))
        rec['http'] = state['http']
        out_sources[sid] = rec

    doc = dict(generated_at=iso(started), user_agent=UA, sources=out_sources, places=out_places, robots=robots_cache)
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    for sid, r in out_sources.items():
        print(f"{sid:15} {r['status']:7} n={r['count']:2} bytes={r['http'].get('bytes')} http={r['http'].get('last_status')} "
              f"fetched={r.get('fetched_at')} src_upd={r.get('source_updated_at')} {r.get('error') or ''}")
    for p in out_places:
        print(f"  {p['name'][:45]:45} {p['wait'].get('label')!s:32} pw={p.get('patients_waiting')} stale={p['stale']}")
    ok = sum(r['status'] == 'ok' for r in out_sources.values())
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
