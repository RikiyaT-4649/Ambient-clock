const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../reliability.js'), 'utf8');
function environment(settings = {}) {
    let now = Date.parse('2026-10-26T03:00:00Z'), mono = 1000, id = 0, calls = 0;
    const timers = new Map(), storage = new Map(), published = [], health = [];
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    const context = vm.createContext({ Date: Clock, performance: { now: () => mono }, console, Intl,
        AbortController: settings.noAbort ? undefined : AbortController,
        document: { visibilityState: 'visible' }, navigator: { onLine: true, geolocation: { getCurrentPosition(ok) { if (!settings.gpsHang) ok({ coords: { latitude: 35, longitude: 139 } }); } } },
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => { storage.set(key, value); } },
        setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
        setInterval: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms, interval: ms }); return key; },
        clearTimeout: key => timers.delete(key),
        fetch: (url, options) => { calls++; return settings.fetch ? settings.fetch(calls, options) : Promise.resolve(response(data())); }
    });
    vm.runInContext(source, context);
    const api = context.AmbientReliability;
    function data() {
        const days = [0,1,2].map(n => Math.floor(now / 86400000) * 86400000 + n * 86400000);
        return { timezone: 'Asia/Tokyo', utc_offset_seconds: 32400,
            current: { time: now / 1000, temperature_2m: 22, cloud_cover: 50, precipitation: 0, wind_speed_10m: 10, wind_direction_10m: 270, weather_code: 3 },
            daily: { sunrise: days.map(d => (d - 10800000) / 1000), sunset: days.map(d => (d + 32400000) / 1000) } };
    }
    function service(extra = {}) { return api.createWeatherService(Object.assign({ fallback: { lat: 35, lon: 139 }, valid: (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon), url: () => '/weather', city: async () => 'Tokyo', onCity() {}, onData: d => published.push(d), onStatus: h => health.push(h) }, extra)); }
    async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
    async function advance(ms, runTimers = true) {
        const end = now + ms;
        if (!runTimers) { now = end; mono += ms; return; }
        while (true) {
            const due = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
            if (!due) break;
            const [key, timer] = due; mono += Math.max(0, timer.at - now); now = Math.max(now, timer.at);
            timers.delete(key); if (timer.interval) timers.set(key, { ...timer, at: now + timer.interval });
            timer.fn(); await flush();
        }
        mono += end - now; now = end; await flush();
    }
    return { api, context, storage, published, health, data, service, flush, advance, get now() { return now; }, get calls() { return calls; }, moveClock(ms) { now += ms; } };
}
function response(body, status = 200, after = null) { return { ok: status >= 200 && status < 300, status, headers: { get: () => after }, json: async () => body }; }
test('1: response-body deadline frees the request', async () => {
    const e = environment({ fetch: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
    const s = e.service(); await s.start(); await e.flush(); await e.advance(16000);
    assert.equal(s.snapshot().pending, false); assert.equal(s.snapshot().lastError, 'timeout');
});
test('1: timeout also works without AbortController', async () => {
    const e = environment({ noAbort: true, fetch: () => new Promise(() => {}) });
    const p = e.api.requestJSON('/weather').catch(error => error.kind);
    await e.advance(16000); assert.equal(await p, 'timeout');
});
test('2: expired suspended request is replaced; late old result cannot commit', async () => {
    let resolveOld; const e = environment({ fetch: n => n === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(response(e.data())) });
    const s = e.service(); await s.start(); await e.flush();
    await e.advance(20000, false); s.wake(); await e.flush();
    assert.equal(e.calls, 2); assert.equal(e.published.length, 1);
    resolveOld(response(e.data())); await e.flush(); assert.equal(e.published.length, 1);
});
test('3: first failure recovers and publishes a complete weather record', async () => {
    const e = environment({ fetch: async n => n === 1 ? response({},503) : response(e.data()) });
    const s = e.service(); await s.start(); await e.flush(); await e.advance(95000);
    assert.equal(e.published.length, 1); assert.equal(s.snapshot().status,'live');
});
test('5: online hint does not prevent a real request', async () => {
    const e = environment(); e.context.navigator.onLine = false;
    const s = e.service(); await s.start(); await e.flush(); assert.equal(e.published.length,1);
});
test('6: stalled location falls back independently after 10 seconds', async () => {
    const e = environment({ gpsHang:true }); const s=e.service(); const p=s.start();
    await e.advance(10001); await p; await e.flush(); assert.equal(e.published.length,1);
});
test('6: geocoding may stall without blocking weather', async () => {
    const e=environment(); const s=e.service({city:()=>new Promise(()=>{})}); s.start(); await e.flush(); assert.equal(e.published.length,1);
});
test('9: wake refreshes old weather and coalesces repeated events', async () => {
    const e=environment(); const s=e.service(); await s.start(); await e.flush();
    await e.advance(360000,false); s.wake();s.wake();s.wake();await e.flush();assert.equal(e.calls,2);
});
test('10: missing, null and out-of-range fields are rejected', () => {
    const e=environment();
    for (const [key,value] of [['temperature_2m',null],['cloud_cover',101],['precipitation',-1],['wind_speed_10m',NaN],['weather_code',999]]) {
        const raw=e.data();raw.current[key]=value;assert.throws(()=>e.api.parseWeather(raw,e.now));
    }
    const raw=e.data();raw.daily.sunrise=[];assert.throws(()=>e.api.parseWeather(raw,e.now));
});
test('11: stale/future observations cannot masquerade as fresh data', () => {
    const e=environment();for(const delta of [-3*3600,3600]){const raw=e.data();raw.current.time+=delta;assert.throws(()=>e.api.parseWeather(raw,e.now));}
});
test('12: presentation failure does not turn transport success into retries', async () => {
    const e=environment();const s=e.service({onData(){throw Error('Canvas failed');}});await s.start();await e.flush();
    assert.equal(s.snapshot().status,'live');assert(s.snapshot().lastSuccess);assert(s.snapshot().events.some(e=>e.kind==='presentation-error'));
});
test('13: reconnect bypasses ordinary backoff once, not on every event', async () => {
    const e=environment({fetch:async n=>n===1?response({},500):response(e.data())});const s=e.service();await s.start();await e.flush();
    s.wake();s.wake();await e.flush();assert.equal(e.calls,2);assert.equal(s.snapshot().status,'live');
});
test('14: Retry-After is honored even on repeated wake events', async () => {
    const e=environment({fetch:async()=>response({},429,'120')});const s=e.service();await s.start();await e.flush();
    s.wake();await e.advance(90000);s.wake();await e.flush();assert.equal(e.calls,1);
});
test('15: backward wall-clock correction does not postpone weather forever', async () => {
    const e=environment();const s=e.service();await s.start();await e.flush();e.moveClock(-3600000);s.tick();await e.flush();assert.equal(e.calls,2);
});
test('16: valid cache restores immediately and still refreshes', async () => {
    const e=environment();e.storage.set('ambientWeatherCacheV1',JSON.stringify({version:1,raw:e.data(),coords:{lat:35,lon:139},city:'Tokyo',savedAt:e.now-60000}));
    const s=e.service();await s.start();await e.flush();assert.equal(e.published.length,2);assert.equal(e.calls,1);
});
test('16: expired/corrupted cached data is not shown', async () => {
    const e=environment();e.storage.set('ambientWeatherCacheV1',JSON.stringify({version:1,raw:{},coords:{lat:35,lon:139},savedAt:e.now-7*3600000}));
    const s=e.service();await s.start();await e.flush();assert.equal(e.published.length,1);
});
test('timezone: UNIX sun timestamps stay absolute across DST and location zones', () => {
    const e=environment();const raw=e.data();raw.timezone='America/New_York';const data=e.api.parseWeather(raw,e.now);
    assert.equal(data.days[0].sunriseMs,raw.daily.sunrise[0]*1000);
    assert.equal(e.api.dayKey(Date.parse('2026-11-01T05:30:00Z'),'America/New_York'),'2026-11-01');
    assert.equal(e.api.dayKey(Date.parse('2026-11-01T06:30:00Z'),'America/New_York'),'2026-11-01');
});
test('diagnostics remain bounded over many failures', async () => {
    const e=environment({fetch:async()=>response({},500)});const s=e.service();await s.start();await e.flush();
    for(let i=0;i<60;i++){await e.advance(61000,false);s.wake();await e.flush();}
    assert(s.snapshot().events.length<=40);assert(JSON.parse(e.storage.get('ambientWeatherDiagnostics')).length<=10);
});
test('legacy XHR timeout and Retry-After work without AbortController', async () => {
    const e=environment({noAbort:true});
    e.context.XMLHttpRequest=class { open(){} send(){e.context.setTimeout(()=>this.ontimeout(),this.timeout);} abort(){this.onabort();} };
    const p=e.api.requestJSON('/weather').catch(error=>error.kind);
    await e.advance(16000);assert.equal(await p,'timeout');
    e.context.XMLHttpRequest=class { open(){} getResponseHeader(){return '120';} send(){this.status=429;this.onload();} };
    const error=await e.api.requestJSON('/weather').catch(error=>error);
    assert.equal(error.retryAfter,120000);assert.equal(error.status,429);
});
test('an early wake during initial fetch does not consume the recovery probe', async () => {
    let fail;
    const e=environment({fetch:n=>n===1?new Promise((_,reject)=>{fail=reject;}):Promise.resolve(response(e.data()))});
    const s=e.service();await s.start();await e.flush();s.wake();fail(Error('Connection lost'));await e.flush();
    s.wake();await e.flush();assert.equal(e.calls,2);assert.equal(s.snapshot().status,'live');
});
