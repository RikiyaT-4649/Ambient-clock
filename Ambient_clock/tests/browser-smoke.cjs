const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const output = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'ambient-clock-check-'));
const baseURL = process.env.BROWSER_BASE_URL || 'http://127.0.0.1:8765/Ambient_clock/';
(async () => {
    const browser = await chromium.launch({headless: true, channel: 'chrome'});
    const context = await browser.newContext({ viewport: {width: 390, height: 844}, deviceScaleFactor: 3 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    for (const scene of ['day', 'sunset', 'night', 'rain', 'snow', 'storm']) {
        await page.goto(`${baseURL}?preview=${scene}`);
        await page.waitForFunction(() => document.body.classList.contains('app-loaded'));
        await page.waitForTimeout(1200);
        const stats = await page.evaluate(() => ({
            scene: previewName, particle: currentParticleType, count: particles.length,
            textures: cloudTextureCache.size,
            textureBytes: [...cloudTextureCache.values()].reduce((n,c) => n + c.width*c.height*4, 0),
            clouds: cloudManager.layers.flat().length,
            shared: new Set(cloudManager.layers.flat().map(c=>c.offscreenCanvas).filter(Boolean)).size,
            cloudSize: [cloudCanvas.width, cloudCanvas.height],
            quality: renderQuality.profile.name, loaded: document.body.classList.contains('app-loaded'),
            clock: document.getElementById('time').textContent
        }));
        console.log(JSON.stringify(stats));
        assert(stats.loaded);
        assert(stats.textureBytes < 3 * 1024 * 1024);
        assert(stats.textures <= 3);
        if (scene === 'night') assert.equal(stats.particle, 'star');
        if (scene === 'rain' || scene === 'storm') assert.equal(stats.particle, 'rain');
        if (scene === 'snow') assert.equal(stats.particle, 'snow');
        assert.equal(errors.length, 0, errors.join('\n'));
        await page.screenshot({path: path.join(output, `${scene}.png`)});
    }
    await page.locator('#btn-tools').click();
    await page.locator('#quality-mode').selectOption('eco');
    assert.equal(await page.evaluate(() => renderQuality.profile.name), 'Eco');
    await page.locator('#quality-mode').selectOption('high');
    assert.equal(await page.evaluate(() => renderQuality.profile.name), 'High');
    await page.locator('#quality-mode').selectOption('auto');
    // Adaptive quality uses sustained load, never one expensive frame.
    await page.evaluate(() => {
        renderQuality.setLevel(2);
        renderQuality.lastChange = performance.now() - 10000;
        for (let i = 0; i < 42; i++) renderQuality.observe(40, 100, 0);
    });
    assert.equal(await page.evaluate(() => renderQuality.level), 1);
    await page.evaluate(() => {
        renderQuality.setLevel(0);
        renderQuality.lastChange = performance.now() - 50000;
        for (let i = 0; i < 460; i++) renderQuality.observe(0.1, 100, 0);
    });
    assert.equal(await page.evaluate(() => renderQuality.level), 1);
    await page.locator('#dimmer-range').fill('0.3');
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'));
    assert.equal(await page.locator('#dimmer-range').inputValue(), '0.3');
    await page.locator('#btn-clock-toggle').click();
    assert(await page.locator('#analog-clock').evaluate(el => el.classList.contains('visible')));
    // Two integrations of the same duration travel the same distance at 15/30fps.
    const displacement = await page.evaluate(() => {
        const run = fps => {
            const p = new Particle('rain'); p.x=100; p.y=0; p.speedY=12; p.speedX=0;
            for(let i=0;i<fps;i++) p.update(10/fps);
            return p.y;
        };
        return [run(15),run(30)];
    });
    assert(Math.abs(displacement[0]-displacement[1]) < 0.001);
    const rain = await page.evaluate(() => {
        const drop = new Particle('rain');
        const layer = drop.rainLayer;
        for (let i = 0; i < 100; i++) {
            drop.reset();
            if (!(drop.y < 0 || drop.x < 0 || drop.x > canvasW)) throw Error('Rain appeared inside viewport');
            if (drop.rainLayer !== layer) throw Error('Rain changed depth during recycling');
        }
        return {
            sprites: spriteCache.rain.length,
            bytes: spriteCache.rain.reduce((n, s) => n + s.canvas.width * s.canvas.height * 4, 0)
        };
    });
    assert.equal(rain.sprites, 3);
    assert(rain.bytes < 65536);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {configurable:true,value:'hidden'});
        document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.evaluate(() => _frameRequest), null);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {configurable:true,value:'visible'});
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => lastFrameTime > 0));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => renderQuality.profile.name), 'Eco');
    assert.equal(await page.evaluate(() => lightningManager.activeBolts.length), 0);
    await page.setViewportSize({width: 844, height: 390});
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => canvasW), 844);
    assert.equal(errors.length, 0, errors.join('\n'));
    await browser.close();
    console.log('Screenshots:', output);
    console.log('PASS: scenes, memory bounds, quality controls/adaptation, persistence, clock, elapsed motion, background/resume, reduced motion, rotation');
})().catch(e => {console.error(e); process.exit(1);});

