import json, math
from decimal import Decimal, getcontext
getcontext().prec = 90
WAD = 10**18; H = 2_592_000; MAXW = 10_000
Z = 1_644_853_626_951_472_714; Z2 = Z*Z//WAD
T = [int(WAD * (Decimal(2) ** (Decimal(-1) / Decimal(2**i)))) for i in range(1, 33)]  # independent table
def decay(v, dt):
    h = dt // H
    if h >= 128: return 0
    v >>= h
    bits = ((dt % H) << 32) // H
    for i in range(32):
        if v == 0: break
        if bits & (1 << (31 - i)): v = v * T[i] // WAD
    return v
def record(pw, fw, last, passed, w, now):
    dt = max(now - last, 0)
    pw, fw = decay(pw, dt), decay(fw, dt)
    add = w * (WAD // MAXW)
    if passed: pw = min(pw + add, 2**128 - 1)
    else: fw = min(fw + add, 2**128 - 1)
    return pw, fw, max(now, last)
def conf(pp, pf, pw, fw, last, now):
    dt = max(now - last, 0)
    P = pp*WAD + decay(pw, dt); F = pf*WAD + decay(fw, dt); n = P + F
    if n == 0: return 0, 0
    p = P*WAD//n; z2n = Z2*WAD//n; denom = WAD + z2n; center = p + z2n//2
    inner = p*(WAD-p)//n + z2n*WAD//n//4
    rad = Z*math.isqrt(inner*WAD)//WAD
    lower = max(center - rad, 0)*WAD//denom
    bps = min(lower*MAXW//WAD, MAXW); nm = min(n*1000//WAD, 2**64-1)
    return bps, nm
d = json.load(open('contracts/stylus/lemma-confidence/vectors.json'))
ok = 0; bad = []
tbl = [int(x) for x in d['constants']['decayTable']]
if tbl != T: bad.append(('decayTable', 'differs from independent high-precision computation', [i for i in range(32) if tbl[i]!=T[i]]))
else: ok += 1
for c in d['constants']:
    if c in ('zWad','z2Wad','wad','halfLifeSeconds','maxWeightBps'):
        exp = {'zWad':Z,'z2Wad':Z2,'wad':WAD,'halfLifeSeconds':H,'maxWeightBps':MAXW}[c]
        if int(d['constants'][c]) != exp: bad.append((c, d['constants'][c], exp))
        else: ok += 1
for v in d['decay']:
    got = decay(int(v['valueWad']), int(v['dt']))
    if got != int(v['expected']): bad.append(('decay', v['name'], got, v['expected']))
    else: ok += 1
for v in d['record']:
    s = v['stats']; got = record(int(s['passWad']), int(s['failWad']), int(s['last']), v['passed'], v['weightBps'], int(v['now']))
    e = v['expected']
    if got != (int(e['passWad']), int(e['failWad']), int(e['last'])): bad.append(('record', v['name'], got, e))
    else: ok += 1
for v in d['confidence']:
    s = v['stats']; got = conf(v['prior']['passes'], v['prior']['failures'], int(s['passWad']), int(s['failWad']), int(s['last']), int(v['now']))
    e = v['expected']
    if got != (e['confidenceBps'], int(e['effectiveNMilli'])): bad.append(('confidence', v['name'], got, e))
    else: ok += 1
for v in d['fold']:
    outs = sorted(v['outcomes'], key=lambda o: int(o['at']))
    pw = fw = last = 0
    for o in outs: pw, fw, last = record(pw, fw, last, o['passed'], o['weightBps'], int(o['at']))
    got = conf(v['prior']['passes'], v['prior']['failures'], pw, fw, last, int(v['now']))
    e = v['expected']; es = e['stats']
    if got != (e['confidenceBps'], int(e['effectiveNMilli'])) or (pw, fw, last) != (int(es['passWad']), int(es['failWad']), int(es['last'])): bad.append(('fold', v['name'], got, (pw,fw,last), e))
    else: ok += 1
print('constants keys:', sorted(d['constants'].keys()))
print('checked ok:', ok, 'mismatches:', len(bad))
for b in bad: print('  MISMATCH', b)
# textbook float comparison for the prior-only vectors
for v in d['confidence']:
    if v['stats']['passWad']=='0' and v['stats']['failWad']=='0' and (v['prior']['passes']+v['prior']['failures'])>0:
        n=v['prior']['passes']+v['prior']['failures']; p=v['prior']['passes']/n; z=1.6448536269514722
        w=(p+z*z/(2*n)-z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n)
        print(f"  textbook {v['name']!r}: float lower={w:.6f} -> {int(w*10000)} bps; vector={v['expected']['confidenceBps']}")
print('names:', [v['name'] for v in d['confidence']])
