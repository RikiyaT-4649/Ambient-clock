/* Long-running weather transport. No rendering or framework dependencies. */
(function (root) {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    function fault(kind, status, retryAfter) {
        const error = new Error(kind);
        Object.assign(error, { kind, status, retryAfter });
        return error;
    }
    function read(key) { try { const value = localStorage.getItem(key); return value && value.length <= 65536 ? JSON.parse(value) : null; } catch (_) { return null; } }
    function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* Optional storage. */ } }
    function retryDelay(value) {
        const wait = value ? (/^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : 0;
        return Math.max(0, Math.min(86400000, wait || 0));
    }
    function dayKey(ms, zone, offset = 0) {
        try {
            if (!zone) throw new Error('No timezone');
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
            const get = type => parts.find(p => p.type === type).value;
            return `${get('year')}-${get('month')}-${get('day')}`;
        } catch (_) { return new Date(ms + offset * 1000).toISOString().slice(0, 10); }
    }
    function timestamp(value, offset = 0) {
        if (finite(value)) return value * 1000;
        if (typeof value !== 'string') return NaN;
        return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z') - (/[zZ]|[+-]\d\d:\d\d$/.test(value) ? 0 : offset * 1000);
    }
    function parseWeather(raw, now, cached = false) {
        if (!raw || !raw.current || !raw.daily) throw fault('invalid-data');
        const c = raw.current, d = raw.daily, offset = raw.utc_offset_seconds;
        if (!finite(offset) || Math.abs(offset) > 50400 || typeof raw.timezone !== 'string' || !raw.timezone) throw fault('invalid-timezone');
        const fields = {
            temp: c.temperature_2m, cloudCover: c.cloud_cover, precipitation: c.precipitation,
            windSpeed: c.wind_speed_10m === undefined ? c.windspeed_10m : c.wind_speed_10m,
            windDirection: c.wind_direction_10m === undefined ? c.winddirection_10m : c.wind_direction_10m,
            code: c.weather_code === undefined ? c.weathercode : c.weather_code
        };
        const limits = { temp: [-100, 65], cloudCover: [0, 100], precipitation: [0, 1000], windSpeed: [0, 500], windDirection: [0, 360] };
        for (const key of Object.keys(limits)) {
            if (!finite(fields[key]) || fields[key] < limits[key][0] || fields[key] > limits[key][1]) throw fault('invalid-' + key);
        }
        if (![0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(fields.code)) throw fault('invalid-weather-code');
        const observedAt = timestamp(c.time, offset);
        if (!finite(observedAt) || observedAt > now + 30 * 60000 || now - observedAt > (cached ? 6 : 2) * 3600000) throw fault('stale-data');
        if (!Array.isArray(d.sunrise) || !Array.isArray(d.sunset) || !d.sunrise.length || d.sunrise.length !== d.sunset.length) throw fault('invalid-sun-data');
        const days = d.sunrise.map((rise, i) => {
            const set = d.sunset[i];
            if (rise === null && set === null && Array.isArray(d.time)) {
                return { key: dayKey(timestamp(d.time[i], offset), raw.timezone, offset), sunriseMs: null, sunsetMs: null };
            }
            const sunriseMs = timestamp(rise, offset), sunsetMs = timestamp(set, offset);
            if (!finite(sunriseMs) || !finite(sunsetMs) || sunsetMs <= sunriseMs || sunsetMs - sunriseMs > 86400000) throw fault('invalid-sun-data');
            return { key: dayKey(sunriseMs, raw.timezone, offset), sunriseMs, sunsetMs };
        });
        if (!cached && !days.some(day => day.key === dayKey(now, raw.timezone, offset))) throw fault('invalid-sun-date');
        return Object.assign(fields, { observedAt, days, timezone: raw.timezone, utcOffsetSeconds: offset });
    }
    async function requestJSON(url, options = {}) {
        if ((typeof AbortController !== 'function' || typeof fetch !== 'function') && typeof XMLHttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                if (options.attach) options.attach(xhr);
                xhr.open('GET', url); xhr.timeout = options.timeout || 15000;
                xhr.onload = () => {
                    if (xhr.status < 200 || xhr.status >= 300) return reject(fault('http-' + xhr.status, xhr.status, retryDelay(xhr.getResponseHeader('Retry-After'))));
                    try { resolve(JSON.parse(xhr.responseText)); } catch (_) { reject(fault('invalid-json')); }
                };
                xhr.onerror = () => reject(fault('network-error'));
                xhr.ontimeout = xhr.onabort = () => reject(fault('timeout'));
                xhr.send();
            });
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeout = options.timeout || 15000;
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => { if (controller) controller.abort(); reject(fault('timeout')); }, timeout);
        });
        if (options.attach) options.attach(controller);
        try {
            return await Promise.race([deadline, (async () => {
                const response = await fetch(url, { signal: controller ? controller.signal : undefined, cache: 'no-store' });
                if (!response.ok) {
                    const value = response.headers && response.headers.get('Retry-After');
                    throw fault('http-' + response.status, response.status, retryDelay(value));
                }
                return await response.json(); // The deadline includes the response body.
            })()]);
        } finally { clearTimeout(timer); }
    }
    function locate(fallback, valid) {
        return new Promise(resolve => {
            let done = false;
            const finish = coords => { if (done) return; done = true; clearTimeout(timer); resolve(coords); };
            const timer = setTimeout(() => finish(fallback), 10000);
            try {
                if (!navigator.geolocation) return finish(fallback);
                navigator.geolocation.getCurrentPosition(p => finish(valid(p.coords.latitude, p.coords.longitude) ? { lat: p.coords.latitude, lon: p.coords.longitude } : fallback), () => finish(fallback), { timeout: 8000, maximumAge: 300000, enableHighAccuracy: false });
            } catch (_) { finish(fallback); }
        });
    }
    function createWeatherService(options) {
        const interval = options.interval || 1800000, timeout = options.timeout || 15000;
        let nextAt = 0, notBefore = 0, active = null, sequence = 0, failures = 0, started = false, starting = false;
        let lastLogSave = 0;
        let lastWall = Date.now(), lastMono = performance.now(), lastWakeProbe = -Infinity;
        let lastSuccess = 0, observedAt = 0, status = 'starting', lastError = null;
        let coords = options.fallback, city = 'Unknown Location', saved = read('ambientWeatherCacheV1');
        const events = [];
        function emit(kind) {
            status = kind;
            try { options.onStatus(snapshot()); } catch (_) { /* Status UI is optional. */ }
        }
        function log(kind) {
            events.push({ time: Date.now(), kind });
            if (events.length > 40) events.shift();
            if (Date.now() - lastLogSave > 60000) {
                write('ambientWeatherDiagnostics', events.slice(-10));
                lastLogSave = Date.now();
            }
        }
        function snapshot() { return { status, lastSuccess, observedAt, nextAt, pending: !!active, failures, lastError, events: events.slice() }; }
        function publish(data) {
            try { options.onData(data, { coords, city }); } catch (_) { log('presentation-error'); }
        }
        function cancelExpired(now) {
            if (active && (now - active.wall > timeout + 2000 || performance.now() - active.mono > timeout + 2000 || now < active.wall - 1000)) {
                if (active.controller) active.controller.abort();
                active = null; sequence++; nextAt = now; log('request-recovered');
            }
        }
        async function refresh() {
            const now = Date.now(); cancelExpired(now);
            if (!started || active || now < nextAt || now < notBefore || document.visibilityState === 'hidden') return;
            const attempt = { id: ++sequence, wall: now, mono: performance.now(), controller: null };
            active = attempt; emit('updating');
            try {
                const raw = await requestJSON(options.url(coords), { timeout, attach: ctrl => { attempt.controller = ctrl; } });
                if (active !== attempt) return;
                const data = parseWeather(raw, Date.now());
                if (observedAt && data.observedAt < observedAt) throw fault('older-data');
                lastSuccess = Date.now(); observedAt = data.observedAt;
                failures = 0; lastError = null; notBefore = 0;
                nextAt = lastSuccess + interval + Math.random() * 90000;
                write('ambientWeatherCacheV1', { version: 1, raw, coords, city, savedAt: lastSuccess });
                publish(data); log('success'); emit('live');
            } catch (error) {
                if (active !== attempt) return;
                failures++;
                lastError = error.kind || 'network-error'; log(lastError);
                const backoff = Math.min(interval, 60000 * Math.pow(2, Math.min(5, failures - 1)));
                if (error.status === 429 || error.status === 503) notBefore = Date.now() + (error.retryAfter || (error.status === 429 ? interval : 0));
                nextAt = Math.max(notBefore, Date.now() + backoff + Math.random() * 15000);
                emit(lastSuccess ? 'stale' : 'retrying');
            } finally { if (active === attempt) { active = null; emit(status); } }
        }
        function tick() {
            const now = Date.now(), mono = performance.now();
            if (Math.abs((now - lastWall) - (mono - lastMono)) > 120000 || now < lastWall - 1000) {
                nextAt = now;
                if (now < lastWall) {
                    notBefore = Math.max(0, notBefore + now - lastWall);
                    observedAt = 0; lastSuccess = Math.min(lastSuccess, now);
                }
                log('clock-adjusted');
            }
            lastWall = now; lastMono = mono;
            cancelExpired(now);
            if (started) refresh();
        }
        function wake() {
            const now = Date.now(); cancelExpired(now);
            if (document.visibilityState === 'hidden' || !started || active) return;
            if (now - lastWakeProbe > 60000 && (!lastSuccess || now - lastSuccess > 300000 || failures)) {
                lastWakeProbe = now; nextAt = Math.max(now, notBefore);
            }
            tick();
        }
        async function start() {
            if (started || starting) return;
            starting = true;
            if (saved && saved.version === 1 && saved.coords && options.valid(saved.coords.lat, saved.coords.lon) && finite(saved.savedAt) && saved.savedAt <= Date.now() && Date.now() - saved.savedAt < 21600000) {
                try {
                    const data = parseWeather(saved.raw, Date.now(), true);
                    coords = saved.coords; city = typeof saved.city === 'string' ? saved.city : city;
                    lastSuccess = saved.savedAt; observedAt = data.observedAt; publish(data); emit('cached');
                } catch (_) { log('cache-rejected'); }
            }
            const located = await locate(coords, options.valid);
            if (Math.abs(located.lat - coords.lat) > 0.05 || Math.abs(located.lon - coords.lon) > 0.05) city = 'Unknown Location';
            coords = located;
            started = true; nextAt = 0;
            refresh(); // Reverse geocoding must never block the weather.
            try {
                const name = await options.city(coords);
                if (typeof name === 'string') city = name;
                options.onCity(city);
                const cache = read('ambientWeatherCacheV1');
                if (cache && cache.coords && cache.coords.lat === coords.lat && cache.coords.lon === coords.lon) {
                    cache.city = city; write('ambientWeatherCacheV1', cache);
                }
            } catch (_) { log('city-unavailable'); }
        }
        setInterval(tick, 30000);
        return { start, tick, wake, refresh, snapshot };
    }
    root.AmbientReliability = { requestJSON, parseWeather, dayKey, createWeatherService, read, write };
})(typeof window === 'undefined' ? globalThis : window);
