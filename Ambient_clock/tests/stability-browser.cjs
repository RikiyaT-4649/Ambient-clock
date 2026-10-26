const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
let mode = 'ok', calls = 0, serverNow = Date.parse('2026-10-26T03:00:00Z');
function fixture() {
    const midnight = Math.floor((serverNow + 32400000) / 86400000) * 86400000 - 32400000;
    return { timezone: 'Asia/Tokyo', utc_offset_seconds: 32400,
        current: { time: serverNow / 1000, temperature_2m: 22, cloud_cover: 50, precipitation: 0, wind_speed_10m: 10, wind_direction_10m: 270, weather_code: 3 },
        daily: { sunrise: [0,1,2].map(n => (midnight + n * 86400000 + 21600000) / 1000), sunset: [0,1,2].map(n => (midnight + n * 86400000 + 64800000) / 1000) } };
}
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/weather') {
        calls++;
        if (mode === '503' || (mode === 'first-fail' && calls === 1)) { res.writeHead(503); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        if (mode === 'stall') return res.write('{"current":');
        const raw = fixture(); if (mode === 'invalid') raw.current.temperature_2m = null;
        return res.end(JSON.stringify(raw));
    }
    if (url.pathname === '/api/city') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ address: { city: 'Tokyo' } })); }
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try {
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' })[path.extname(file)] || 'application/octet-stream');
        res.end(fs.readFileSync(file));
    } catch (_) { res.writeHead(404); res.end(); }
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const errors = [];
    async function open(options = {}) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo', geolocation: { latitude: 35, longitude: 139 }, permissions: ['geolocation'] });
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        await page.clock.install({ time: new Date(serverNow) });
        await page.route('https://fonts.googleapis.com/**', route => route.abort());
        await page.route('https://fonts.gstatic.com/**', route => route.abort());
        await page.addInitScript(options => {
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (url, init) => nativeFetch(typeof url === 'string' && url.includes('api.open-meteo.com') ? '/api/weather' : typeof url === 'string' && url.includes('nominatim.openstreetmap.org') ? '/api/city' : url, init);
            if (options.noCanvas) HTMLCanvasElement.prototype.getContext = () => null;
            if (options.mockWake) {
                window.wakeRequests = 0;
                Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
                    if (++window.wakeRequests === 1) throw Error('Battery policy');
                    const lock = new EventTarget(); lock.release = async () => lock.dispatchEvent(new Event('release')); return lock;
                } } });
            }
        }, options);
        await page.goto(origin);
        await page.waitForFunction(() => rendererReady && document.body.classList.contains('app-loaded'));
        return { context, page };
    }
    try {
        mode = 'stall'; calls = 0;
        let { context, page } = await open();
        await page.waitForFunction(() => weatherService.snapshot().pending);
        await page.waitForTimeout(200);
        await page.clock.fastForward(16000);
        await page.waitForFunction(() => !weatherService.snapshot().pending);
        assert.equal(await page.evaluate(() => weatherService.snapshot().lastError), 'timeout');
        mode = 'ok'; await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForFunction(() => weatherService.snapshot().status === 'live');
        assert.equal(await page.locator('#weather-display').evaluate(el => el.style.opacity), '1');
        console.log('PASS 1–2: real stalled HTTP body times out; reconnect recovers');
        await context.close();

        mode = 'first-fail'; calls = 0;
        ({ context, page } = await open({ mockWake: true }));
        await page.waitForFunction(() => weatherService.snapshot().failures === 1);
        await page.waitForFunction(() => weatherState.city === 'Tokyo');
        await page.clock.fastForward(95000);
        await page.waitForFunction(() => weatherService.snapshot().status === 'live');
        assert.equal(await page.locator('#weather-temp').textContent(), '22°C');
        assert.equal(await page.locator('#weather-display').evaluate(el => el.style.opacity), '1');
        assert.equal(await page.locator('#weather-location').textContent(), 'TOKYO');
        console.log('PASS 3: initial 503 recovers with visible weather and city');

        // An expired timer produces an ordinary UI notice, while the clock runs.
        await page.evaluate(() => { pomodoroSeconds = 1; startPomodoro(); });
        await page.clock.fastForward(2200);
        assert.equal(await page.evaluate(() => pomodoroRunning), false);
        assert.equal(await page.evaluate(() => pomodoroMode), 'break');
        assert(await page.locator('#notification').isVisible());
        const clockBefore = await page.locator('#time').textContent();
        await page.clock.fastForward(3000);
        assert.notEqual(await page.locator('#time').textContent(), clockBefore);
        await page.locator('#notification-dismiss').click();
        await page.evaluate(() => { alarmEnabled = true; alarmNextAt = Date.now() + 5000; showAlarm(); });
        await page.clock.fastForward(65000);
        assert((await page.locator('#notification-message').textContent()).includes('Alarm:'));
        assert(await page.evaluate(() => alarmNextAt > Date.now()));
        await page.evaluate(() => { alarmEnabled = false; showAlarm(); saveTools(); document.getElementById('notification').hidden = true; });
        console.log('PASS 4,20: nonblocking notification and deadline-based timer');

        await page.evaluate(() => toggleWakeLock());
        assert.equal(await page.locator('#btn-wakelock').textContent(), 'Always On waiting');
        await page.clock.fastForward(6000);
        await page.waitForFunction(() => !!wakeLock);
        assert.equal(await page.locator('#btn-wakelock').textContent(), 'Always On ON');
        await page.evaluate(() => wakeLock.release());
        assert.equal(await page.locator('#btn-wakelock').textContent(), 'Always On waiting');
        await page.clock.fastForward(6000); await page.waitForFunction(() => !!wakeLock);
        await page.evaluate(() => toggleWakeLock());
        assert.equal(await page.locator('#btn-wakelock').textContent(), 'Always On OFF');
        console.log('PASS 19: wake-lock failure/release never reports a false ON, and retries');

        // Rain rendering failure must not block successful weather transport.
        await page.evaluate(() => {
            window.savedCloudDraw = cloudManager.drawClouds;
            cloudManager.drawClouds = () => { throw Error('Injected drawing error'); };
            invalidateScene(); clearTimeout(_frameTimer);
            if (_frameRequest !== null) cancelAnimationFrame(_frameRequest);
            animateParticles(performance.now());
        });
        await page.clock.fastForward(1000);
        assert(await page.evaluate(() => localIssues.some(e => e.kind === 'render-error')));
        const priorSuccess = await page.evaluate(() => weatherService.snapshot().lastSuccess);
        serverNow += 10 * 60000; await page.clock.setSystemTime(new Date(serverNow));
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await page.waitForFunction(prior => weatherService.snapshot().lastSuccess > prior, priorSuccess);
        assert.equal(await page.evaluate(() => weatherService.snapshot().status), 'live');
        await page.evaluate(() => { cloudManager.drawClouds = window.savedCloudDraw; });
        await page.clock.runFor(10000);
        assert.equal(await page.evaluate(() => renderFailures), 0);
        console.log('PASS 8,12: renderer exceptions recover without breaking weather');

        await page.evaluate(() => {
            canvas.dispatchEvent(new Event('contextlost'));
            if (graphicsAvailable) throw Error('Lost context still enabled');
            canvas.dispatchEvent(new Event('contextrestored'));
        });
        assert.equal(await page.evaluate(() => graphicsAvailable), true);
        assert(await page.evaluate(() => _canvasSizedDpr > 0));
        await page.evaluate(() => { for (let i=0;i<600;i++) getStarSprite((i%32)*8,Math.floor(i/32)*8,0,2,3); });
        assert(await page.evaluate(() => starSpriteCache.size <= 384));
        console.log('PASS 17: context restoration rebuilds transforms/caches; star cache stays bounded');

        // Simulate a 72-hour suspension/outage, then a real recovery.
        mode = '503'; serverNow += 72 * 3600000;
        await page.clock.setSystemTime(new Date(serverNow));
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await page.waitForFunction(() => weatherService.snapshot().failures > 0);
        assert.equal(await page.evaluate(() => weatherState.sunEstimated), true);
        assert(await page.evaluate(() => getSolarProgress() >= 0));
        mode = 'ok'; serverNow += 65000;
        await page.clock.setSystemTime(new Date(serverNow));
        await page.evaluate(() => document.dispatchEvent(new Event('resume')));
        await page.waitForFunction(() => weatherService.snapshot().status === 'live');
        assert.equal(await page.evaluate(() => weatherState.sunEstimated), false);
        assert.equal(await page.evaluate(() => isNighttime()), false);
        console.log('PASS 7,9: date rollover uses an estimate during outage and restores real sun data after resume');

        // Timer state survives an OS-style document reload.
        await page.evaluate(() => { resetPomodoro(); pomodoroSeconds=20; startPomodoro(); });
        await page.clock.fastForward(3000);
        await page.reload(); await page.waitForFunction(() => rendererReady);
        assert.equal(await page.evaluate(() => pomodoroRunning), true);
        assert(await page.evaluate(() => pomodoroSeconds <= 20));
        await page.evaluate(() => resetPomodoro());
        mode = 'stall'; await page.reload();
        await page.waitForFunction(() => weatherService.snapshot().pending);
        assert.equal(await page.locator('#weather-temp').textContent(), '22°C');
        assert.equal(await page.locator('#weather-display').evaluate(el => el.style.opacity), '1');
        console.log('PASS 16,20: cached weather and running timer survive reload');
        await context.close();

        mode='ok'; calls=0;
        ({ context,page } = await open({noCanvas:true}));
        await page.waitForFunction(() => weatherService.snapshot().status === 'live');
        assert.equal(await page.evaluate(() => graphicsAvailable),false);
        assert.equal(await page.locator('#weather-temp').textContent(),'22°C');
        const before=await page.locator('#time').textContent(); await page.clock.fastForward(2000);
        assert.notEqual(await page.locator('#time').textContent(),before);
        console.log('PASS 18: unavailable Canvas retains live weather and ticking clock');
        await context.close();
        assert.equal(errors.length,0,errors.join('\n'));
    } finally {
        await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exit(1); });
