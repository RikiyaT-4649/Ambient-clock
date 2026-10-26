        // Repeatable visual previews never change the real clock used by timers.
        const PREVIEW_SCENES = {
            day: { hour: 12, condition: 'Clear', cloudCover: 22, precipitation: 0 },
            sunset: { hour: 17.6, condition: 'Clouds', cloudCover: 38, precipitation: 0 },
            night: { hour: 23, condition: 'Clear', cloudCover: 8, precipitation: 0 },
            rain: { hour: 16, condition: 'Rain', cloudCover: 92, precipitation: 5 },
            snow: { hour: 8, condition: 'Snow', cloudCover: 85, precipitation: 1 },
            storm: { hour: 18.5, condition: 'Thunderstorm', cloudCover: 100, precipitation: 15 }
        };
        const previewName = new URLSearchParams(location.search).get('preview');
        const previewScene = Object.prototype.hasOwnProperty.call(PREVIEW_SCENES, previewName) ? PREVIEW_SCENES[previewName] : null;
        function sceneDate() {
            const date = new Date();
            if (previewScene) date.setHours(Math.floor(previewScene.hour), Math.round(previewScene.hour % 1 * 60), 0, 0);
            return date;
        }

        let rendererReady = false, graphicsAvailable = false;
        const localIssues = [];
        function reportIssue(kind) {
            localIssues.push({ time: Date.now(), kind });
            if (localIssues.length > 30) localIssues.shift();
        }
        function safeVisualUpdate() {
            if (!rendererReady) return;
            try {
                const now = sceneDate();
                updateTimeOfDay(now.getHours(), now.getMinutes());
                updateCelestialBody(now.getHours(), now.getMinutes());
                updateWeatherEffects();
            } catch (_) { reportIssue('weather-visual-error'); }
        }
        function safeCanvasContext(element) {
            let context = null;
            try { context = element.getContext('2d'); } catch (_) { /* Static fallback. */ }
            if (context) return context;
            reportIssue('canvas-unavailable');
            const noop = () => {};
            const fallback = { _unavailable: true, canvas: element };
            for (const name of ['setTransform','save','restore','scale','translate','rotate','clearRect','fillRect','strokeRect','beginPath','closePath','moveTo','lineTo','quadraticCurveTo','bezierCurveTo','arc','ellipse','rect','clip','fill','stroke','drawImage','fillText','strokeText','setLineDash']) fallback[name] = noop;
            fallback.createLinearGradient = fallback.createRadialGradient = () => ({ addColorStop: noop });
            fallback.measureText = () => ({ width: 0 });
            return fallback;
        }
        function usableContext(context) {
            try { return !context._unavailable && !(typeof context.isContextLost === 'function' && context.isContextLost()); }
            catch (_) { return false; }
        }
        // Logical viewport dimensions (CSS pixels) — the single source of truth for
        // all coordinate math and canvas sizing. Declared first because the clock /
        // celestial code runs during startup, before the canvas section below.
        // Uses the LAYOUT viewport, which (unlike window.innerWidth/innerHeight on
        // Android) doesn't drift when the browser toolbar hides or the page zooms.
        let canvasW = document.documentElement.clientWidth || window.innerWidth;
        let canvasH = document.documentElement.clientHeight || window.innerHeight;

        // --- 1. Weather System ---
        const weatherState = {
            condition: null,        // 'Clear', 'Clouds', 'Rain', 'Snow', 'Thunderstorm', 'Mist'
            temp: null,
            windSpeed: 0,
            windDirection: null,    // Direction wind comes FROM, degrees (meteorological)
            windHoriz: 1,           // Precomputed horizontal screen push: -1 (left) .. +1 (right)
            cloudCover: 0,          // Cloud coverage (0-100%)
            precipitation: 0,       // Precipitation rate (mm/h)
            moonPhase: 0.5,
            sunrise: null,          // Sunrise time
            sunset: null,           // Sunset time
            sunriseMs: null,        // Cached: sunrise as milliseconds timestamp
            sunsetMs: null,         // Cached: sunset as milliseconds timestamp
            city: null,             // City name
            coords: { lat: 35.6762, lon: 139.6503 } // Tokyo fallback
        };

        // Validate latitude and longitude values
        function validateCoordinates(lat, lon) {
            // Check if values are numbers
            if (typeof lat !== 'number' || typeof lon !== 'number') {
                return false;
            }
            // Check if values are finite (not NaN, Infinity, -Infinity)
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return false;
            }
            // Check latitude range: -90 to 90
            if (lat < -90 || lat > 90) {
                return false;
            }
            // Check longitude range: -180 to 180
            if (lon < -180 || lon > 180) {
                return false;
            }
            return true;
        }

        async function getCityName(lat, lon) {
            if (!validateCoordinates(lat, lon)) return 'Unknown Location';
            const data = await AmbientReliability.requestJSON('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lon + '&accept-language=en', { timeout: 10000 });
            const a = data && data.address;
            return a && (a.city || a.town || a.village || a.state || a.country) || 'Unknown Location';
        }

        // Store wind direction and precompute its horizontal screen component
        // ONCE per weather update, so the animation loop never does trig.
        // Meteorological direction = where wind blows FROM. West wind (270°)
        // moves air east → rightward (+x). East component = -sin(dirFrom).
        function applyWindDirection(dirDeg) {
            weatherState.windDirection = (typeof dirDeg === 'number') ? dirDeg : null;
            weatherState.windHoriz = (typeof dirDeg === 'number')
                ? -Math.sin(dirDeg * Math.PI / 180)
                : 1; // No data → gentle rightward drift
        }

        // Map Open-Meteo weather codes to conditions
        function mapWeatherCode(code) {
            if (code === 0) return 'Clear';
            if (code >= 1 && code <= 3) return 'Clouds';
            if (code === 45 || code === 48) return 'Mist';
            if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'Rain';
            if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'Snow';
            if (code >= 95 && code <= 99) return 'Thunderstorm';
            return 'Clear'; // Default
        }

        // Calculate rain particle count based on precipitation rate (logarithmic scale)
        // 降水量 (mm/h) からパーティクル数を対数スケールで計算
        function calculateRainParticles(precipitationRate) {
            if (precipitationRate <= 0) return 0;

            // Logarithmic scale using log10 with offset for smooth curve
            // Extended range: 10-1000 particles
            // 0.01mm/h → ~24 particles (barely visible)
            // 0.1mm/h → ~109 particles (light drizzle)
            // 1mm/h → ~354 particles (light rain)
            // 5mm/h → ~569 particles (moderate rain)
            // 10mm/h → ~671 particles (heavy rain)
            // 50mm/h → ~893 particles (very heavy rain)
            // 100mm/h → ~1000 particles (extreme rainfall)

            const baseCount = 10;
            const multiplier = 165; // Halved for performance (was 330)
            const offset = 0.1;  // Prevents log of very small values
            const factor = 10;

            const count = baseCount + multiplier * Math.log10((precipitationRate + offset) * factor);

            // Clamp between minimum and maximum values (max 500, was 1000)
            return Math.max(10, Math.min(500, Math.round(count)));
        }

        // Calculate Julian Day Number from a Date object
        // ユリウス日を計算（グレゴリオ暦の日付から）
        function calculateJulianDay(date) {
            const year = date.getUTCFullYear();
            const month = date.getUTCMonth() + 1; // JavaScript months are 0-indexed
            const day = date.getUTCDate();
            const hour = date.getUTCHours();
            const minute = date.getUTCMinutes();
            const second = date.getUTCSeconds();

            // Convert time to decimal day
            const decimalDay = day + (hour / 24) + (minute / 1440) + (second / 86400);

            // Julian Day calculation algorithm
            let a = Math.floor((14 - month) / 12);
            let y = year + 4800 - a;
            let m = month + 12 * a - 3;

            let jd = decimalDay + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;

            return jd+0.5;
        }

        // Calculate moon phase (0.0 = New Moon, 0.5 = Full Moon, 1.0 = New Moon)
        // 月の位相を計算（0.0=新月、0.5=満月、1.0=新月）
        function calculateMoonPhase(date = new Date()) {
            // Known new moon: January 6, 2000, 18:14 UTC (JD = 2451550.26)
            const knownNewMoonJD = 2451550.26;

            // Synodic month length (average lunar cycle duration in days)
            // 朔望月の長さ（平均）
            const synodicMonth = 29.53058867;

            // Calculate current Julian Day
            const currentJD = calculateJulianDay(date);

            // Calculate days since known new moon
            const daysSinceNewMoon = currentJD - knownNewMoonJD;

            // Calculate current position in lunar cycle
            const cyclePosition = daysSinceNewMoon / synodicMonth;

            // Get fractional part (0.0 to 1.0)
            const moonPhase = cyclePosition - Math.floor(cyclePosition);

            return moonPhase;
        }

        // Format time from ISO string (e.g., "2025-12-20T06:30" -> "06:30")
        function formatTime(isoString) {
            if (!isoString) return '--:--';
            const date = new Date(isoString);
            try { return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: weatherState.timezone || undefined }); } catch (_) { return '--:--'; }
        }

        // Calculate sun position as percentage (0% = sunrise, 100% = sunset)
        // Returns: 0-100 if sun is up, null if it's night time
        function calculateSunPosition() {
            if (!weatherState.sunrise || !weatherState.sunset) {
                return null; // No data available
            }

            const now = new Date();
            const sunrise = new Date(weatherState.sunrise);
            const sunset = new Date(weatherState.sunset);

            // Check if it's daytime
            if (now < sunrise || now > sunset) {
                return null; // It's night
            }

            // Calculate position as percentage
            const totalDayMinutes = (sunset - sunrise) / 1000 / 60; // Total minutes from sunrise to sunset
            const elapsedMinutes = (now - sunrise) / 1000 / 60;     // Minutes since sunrise

            const position = (elapsedMinutes / totalDayMinutes) * 100;
            return Math.max(0, Math.min(100, position)); // Clamp between 0-100
        }

        const WEATHER_REFRESH_MS = 30 * 60 * 1000;
        let sunSyncAfter = 0;
        function weatherMinutes(ms) {
            try {
                if (!weatherState.timezone) throw new Error('Local time');
                const parts = new Intl.DateTimeFormat('en-GB', { timeZone: weatherState.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
                return Number(parts.find(p => p.type === 'hour').value) % 24 * 60 + Number(parts.find(p => p.type === 'minute').value);
            } catch (_) {
                const offset = weatherState.utcOffsetSeconds;
                const date = new Date(ms + (Number.isFinite(offset) ? offset * 1000 : 0));
                return Number.isFinite(offset) ? date.getUTCHours() * 60 + date.getUTCMinutes() : date.getHours() * 60 + date.getMinutes();
            }
        }
        function syncSunData(force = false) {
            if (previewScene || !weatherState.days) return;
            const now = Date.now();
            if (!force && now < sunSyncAfter && sunSyncAfter - now < 60000) return;
            sunSyncAfter = now + 60000;
            const offset = weatherState.utcOffsetSeconds || 0;
            const key = AmbientReliability.dayKey(now, weatherState.timezone, offset);
            const day = weatherState.days.find(d => d.key === key);
            weatherState.sunEstimated = !day || day.sunriseMs === null;
            const rise = day && day.sunriseMs !== null ? day.sunriseMs : Date.parse(key + 'T06:00:00Z') - offset * 1000;
            const set = day && day.sunsetMs !== null ? day.sunsetMs : Date.parse(key + 'T18:00:00Z') - offset * 1000;
            weatherState.sunriseMs = rise; weatherState.sunsetMs = set;
            weatherState.sunrise = new Date(rise).toISOString(); weatherState.sunset = new Date(set).toISOString();
            const prefix = weatherState.sunEstimated ? '~' : '';
            document.getElementById('sun-times').textContent = '☀️ ' + prefix + formatTime(weatherState.sunrise) + ' | 🌙 ' + prefix + formatTime(weatherState.sunset);
        }
        function showWeather() {
            document.getElementById('weather-location').textContent = (weatherState.city || 'Unknown Location').toUpperCase();
            document.getElementById('weather-temp').textContent = Math.round(weatherState.temp) + '°C';
            document.getElementById('weather-desc').textContent = weatherState.condition;
            document.getElementById('weather-display').style.opacity = '1';
        }
        const weatherService = AmbientReliability.createWeatherService({
            interval: WEATHER_REFRESH_MS, fallback: weatherState.coords, valid: validateCoordinates,
            url: coords => 'https://api.open-meteo.com/v1/forecast?latitude=' + coords.lat + '&longitude=' + coords.lon + '&current=temperature_2m,cloud_cover,weather_code,wind_speed_10m,wind_direction_10m,precipitation&daily=sunrise,sunset&forecast_days=3&timezone=auto&timeformat=unixtime&temperature_unit=celsius&wind_speed_unit=kmh',
            city: coords => getCityName(coords.lat, coords.lon),
            onCity: city => { weatherState.city = city; document.getElementById('weather-location').textContent = city.toUpperCase(); },
            onStatus: () => { if (rendererReady) updateWeatherHealth(); },
            onData: (data, meta) => {
                Object.assign(weatherState, data, meta, { condition: mapWeatherCode(data.code), moonPhase: calculateMoonPhase() });
                applyWindDirection(data.windDirection);
                syncSunData(true);
                showWeather();
                safeVisualUpdate();
                if (rendererReady) { try { updateRainSprite(); } catch (_) { reportIssue('rain-sprite-error'); } }
            }
        });
        function initWeather() {
            if (previewScene) {
                const rise = sceneDate(); rise.setHours(6, 0, 0, 0);
                const set = sceneDate(); set.setHours(18, 0, 0, 0);
                Object.assign(weatherState, previewScene, { city: 'Preview · ' + previewName, temp: previewName === 'snow' ? -2 : 19, windSpeed: 12, moonPhase: 0.43, sunrise: rise.toISOString(), sunset: set.toISOString(), sunriseMs: +rise, sunsetMs: +set });
                applyWindDirection(260); showWeather();
                document.getElementById('sun-times').textContent = '☀️ 06:00 | 🌙 18:00';
                safeVisualUpdate();
                if (rendererReady) updateRainSprite();
            } else weatherService.start().catch(() => reportIssue('weather-start-error'));
            document.body.classList.add('app-loaded');
        }
        function updateWeather() { if (!previewScene) return weatherService.refresh(); }
        function weatherWatchdog() {
            if (!previewScene) weatherService.tick();
            syncSunData();
        }
        function recoverPage() {
            if (document.visibilityState === 'hidden') return;
            if (!previewScene) weatherService.wake();
            sunSyncAfter = 0;
            if (rendererReady) {
                try { resumeRendering(); safeVisualUpdate(); } catch (_) { reportIssue('resume-error'); }
                try { syncPomodoro(); checkAlarm(); requestWakeLock(); } catch (_) { reportIssue('tools-resume-error'); }
            }
        }
        window.addEventListener('DOMContentLoaded', initWeather, { once: true });
        window.addEventListener('online', recoverPage);
        window.addEventListener('pageshow', recoverPage);
        document.addEventListener('resume', recoverPage);
        document.addEventListener('visibilitychange', recoverPage);

        // --- 2. Clock Logic + Time of Day System ---
        let isAnalogClock = false;
        let lastUpdateMinute = -1; // 前回更新した分を記録

        // Clock text breathing - subtle time-of-day color in text-shadow
        function updateClockBreathing(hour) {
            const timeEl = document.getElementById('time');
            const dateEl = document.getElementById('date');
            if (!timeEl || !dateEl) return;

            // Determine glow color based on time of day
            let glowR = 255, glowG = 255, glowB = 255; // Default: white
            let glowIntensity = 0.15;

            if (hour >= 5 && hour < 8) {
                // Dawn: warm amber glow
                glowR = 255; glowG = 200; glowB = 140;
                glowIntensity = 0.2;
            } else if (hour >= 8 && hour < 16) {
                // Daytime: cool white-blue
                glowR = 220; glowG = 240; glowB = 255;
                glowIntensity = 0.12;
            } else if (hour >= 16 && hour < 20) {
                // Evening: warm orange
                glowR = 255; glowG = 180; glowB = 100;
                glowIntensity = 0.22;
            } else {
                // Night: cool blue
                glowR = 140; glowG = 170; glowB = 255;
                glowIntensity = 0.18;
            }

            const glowColor = `rgba(${glowR}, ${glowG}, ${glowB}, ${glowIntensity})`;
            const glowColor2 = `rgba(${glowR}, ${glowG}, ${glowB}, ${glowIntensity * 0.5})`;

            timeEl.style.textShadow = `
                0 2px 20px rgba(0, 0, 0, 0.35),
                0 4px 40px rgba(0, 0, 0, 0.25),
                0 8px 60px rgba(0, 0, 0, 0.15),
                0 0 30px rgba(0, 0, 0, 0.4),
                0 0 50px rgba(0, 0, 0, 0.25),
                0 0 40px ${glowColor},
                0 0 80px ${glowColor2}`;

            dateEl.style.textShadow = `
                0 2px 15px rgba(0, 0, 0, 0.35),
                0 4px 30px rgba(0, 0, 0, 0.2),
                0 0 20px rgba(0, 0, 0, 0.3),
                0 0 35px rgba(0, 0, 0, 0.15),
                0 0 25px ${glowColor}`;
        }

        function updateClock() {
            const now = sceneDate();
            const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
            const dateOptions = { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' };
            const dateStr = now.toLocaleDateString('en-US', dateOptions);

            setInfo('time', timeStr);
            setInfo('date', dateStr);

            // アナログ時計の針を更新
            if (isAnalogClock) {
                updateAnalogClock(now);
            }

            // Cheap safety net: catches throttled/dropped refresh timers.
            weatherWatchdog();
            if (rendererReady) updateWeatherHealth();

            // Keep the live-parameters panel current while it's open.
            if (typeof updateInfoPanel === 'function') {
                const ip = document.getElementById('info-panel');
                if (ip && ip.classList.contains('visible')) updateInfoPanel();
            }

            // 背景と天体の更新は1分ごとに実行（チカチカ防止）
            const currentMinute = Math.floor(+now / 60000);
            if (currentMinute !== lastUpdateMinute) {
                lastUpdateMinute = currentMinute;
                try {
                // 時間帯に応じた背景を更新
                updateTimeOfDay(now.getHours(), now.getMinutes());
                // 太陽・月の位置を更新
                updateCelestialBody(now.getHours(), now.getMinutes());
                // 時計テキストの呼吸（時間帯で微妙にtext-shadowの色を変化）
                updateClockBreathing(now.getHours());
                } catch (_) { reportIssue('clock-visual-error'); }
            }
        }

        function updateAnalogClock(now) {
            const hours = now.getHours() % 12;
            const minutes = now.getMinutes();
            const seconds = now.getSeconds();

            // 角度を計算（12時を0度として時計回りに回転）
            const secondDeg = (seconds / 60) * 360;
            const minuteDeg = (minutes / 60) * 360 + (seconds / 60) * 6;
            const hourDeg = (hours / 12) * 360 + (minutes / 60) * 30;

            document.getElementById('second-hand').style.transform = `rotate(${secondDeg}deg)`;
            document.getElementById('minute-hand').style.transform = `rotate(${minuteDeg}deg)`;
            document.getElementById('hour-hand').style.transform = `rotate(${hourDeg}deg)`;
        }

        setInterval(updateClock, 1000);
        updateClock();

        // Color interpolation function (supports hex color codes)
        function interpolateColor(color1, color2, factor) {
            // Keep the existing solar keyframes, with a softer atmospheric palette.
            const palette = {
                '#1e3a8a': '#172b50', '#e91e63': '#846e95', '#ff8c00': '#e8b69c',
                '#1e40af': '#29466b', '#ff006e': '#b18b9d', '#ffa500': '#f5ce9f',
                '#2563eb': '#285f91', '#38bdf8': '#78b3d2', '#e0f2fe': '#d6e5e7',
                '#1d4ed8': '#225783', '#0ea5e9': '#70acd0', '#f0f9ff': '#dce9e9',
                '#64748b': '#405c7a', '#fbbf24': '#bd9b94', '#fed7aa': '#f3d2a3',
                '#475569': '#354566', '#f59e0b': '#b17f89', '#fecaca': '#efb985',
                '#312e81': '#202b4a', '#b91c1c': '#815b7b', '#7c3aed': '#e69b83',
                '#4c1d95': '#172340', '#6b21a8': '#bb7d83', '#581c87': '#3d3659', '#3b0764': '#806279'
            };
            color1 = palette[color1] || color1;
            color2 = palette[color2] || color2;
            // Convert hex color code to RGB
            const hexToRgb = (hex) => {
                const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                return result ? [
                    parseInt(result[1], 16),
                    parseInt(result[2], 16),
                    parseInt(result[3], 16)
                ] : null;
            };

            const c1 = hexToRgb(color1);
            const c2 = hexToRgb(color2);

            if (!c1 || !c2) return color1; // Return original color on error

            const r = Math.round(c1[0] + (c2[0] - c1[0]) * factor);
            const g = Math.round(c1[1] + (c2[1] - c1[1]) * factor);
            const b = Math.round(c1[2] + (c2[2] - c1[2]) * factor);
            return `rgb(${r}, ${g}, ${b})`;
        }

        // Weather color blending utilities
        function parseRgb(colorString) {
            // Parse rgb(r, g, b) or hex color to [r, g, b]
            const rgbMatch = colorString.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (rgbMatch) {
                return [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])];
            }

            const hexMatch = colorString.match(/#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i);
            if (hexMatch) {
                return [parseInt(hexMatch[1], 16), parseInt(hexMatch[2], 16), parseInt(hexMatch[3], 16)];
            }

            return [128, 128, 128]; // Fallback gray
        }

        function rgbToString(r, g, b) {
            return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
        }

        function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h, s, l = (max + min) / 2;

            if (max === min) {
                h = s = 0;
            } else {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                    case g: h = ((b - r) / d + 2) / 6; break;
                    case b: h = ((r - g) / d + 4) / 6; break;
                }
            }
            return [h * 360, s * 100, l * 100];
        }

        function hslToRgb(h, s, l) {
            h /= 360; s /= 100; l /= 100;
            let r, g, b;

            if (s === 0) {
                r = g = b = l;
            } else {
                const hue2rgb = (p, q, t) => {
                    if (t < 0) t += 1;
                    if (t > 1) t -= 1;
                    if (t < 1/6) return p + (q - p) * 6 * t;
                    if (t < 1/2) return q;
                    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                    return p;
                };
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                r = hue2rgb(p, q, h + 1/3);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1/3);
            }
            return [r * 255, g * 255, b * 255];
        }

        function adjustSaturation(rgb, factor) {
            const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
            return hslToRgb(h, s * factor, l);
        }

        function adjustBrightness(rgb, factor) {
            const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
            return hslToRgb(h, s, l * factor);
        }

        function applyTint(rgb, tint, brightnessFactor) {
            let [r, g, b] = rgb;
            r = Math.max(0, Math.min(255, r + tint.r));
            g = Math.max(0, Math.min(255, g + tint.g));
            b = Math.max(0, Math.min(255, b + tint.b));

            const [h, s, l] = rgbToHsl(r, g, b);
            return hslToRgb(h, s, l * brightnessFactor);
        }

        // Blend weather effects with time-of-day colors
        function blendWeatherColors(color1, color2, color3, condition) {
            if (!condition) return [color1, color2, color3];

            const rgb1 = parseRgb(color1);
            const rgb2 = parseRgb(color2);
            const rgb3 = parseRgb(color3);

            let adjusted1, adjusted2, adjusted3;

            switch(condition) {
                case 'Clear':
                    // Enhance saturation for more vibrant colors
                    adjusted1 = adjustSaturation(rgb1, 1.15);
                    adjusted2 = adjustSaturation(rgb2, 1.15);
                    adjusted3 = adjustSaturation(rgb3, 1.15);
                    break;

                case 'Clouds':
                    // 演出3: 天候による彩度の抑制 - Reduce saturation by 20% for pastel effect
                    adjusted1 = adjustSaturation(rgb1, 0.8);
                    adjusted2 = adjustSaturation(rgb2, 0.8);
                    adjusted3 = adjustSaturation(rgb3, 0.8);
                    break;

                case 'Rain':
                case 'Drizzle':
                    // A silver/slate sky gives fine rain a natural light source;
                    // preserve a little of the actual time-of-day palette.
                    const daylight = isNighttime() ? 0.28 : 0.82;
                    adjusted1 = rgb1.map((v, i) => v * 0.18 + [25, 38, 53][i] * daylight);
                    adjusted2 = rgb2.map((v, i) => v * 0.18 + [56, 73, 88][i] * daylight);
                    adjusted3 = rgb3.map((v, i) => v * 0.18 + [83, 103, 116][i] * daylight);
                    break;

                case 'Snow':
                    // White/cyan tint and increase brightness
                    adjusted1 = applyTint(rgb1, {r: 30, g: 30, b: 50}, 1.1);
                    adjusted2 = applyTint(rgb2, {r: 30, g: 30, b: 50}, 1.1);
                    adjusted3 = applyTint(rgb3, {r: 30, g: 30, b: 50}, 1.1);
                    break;

                case 'Thunderstorm':
                    // Darken significantly with purple tint
                    adjusted1 = applyTint(rgb1, {r: 10, g: -20, b: 30}, 0.6);
                    adjusted2 = applyTint(rgb2, {r: 10, g: -20, b: 30}, 0.6);
                    adjusted3 = applyTint(rgb3, {r: 10, g: -20, b: 30}, 0.6);
                    break;

                case 'Mist':
                case 'Fog':
                case 'Haze':
                    // Heavy desaturation with whitish overlay
                    adjusted1 = applyTint(adjustSaturation(rgb1, 0.4), {r: 50, g: 50, b: 50}, 1.0);
                    adjusted2 = applyTint(adjustSaturation(rgb2, 0.4), {r: 50, g: 50, b: 50}, 1.0);
                    adjusted3 = applyTint(adjustSaturation(rgb3, 0.4), {r: 50, g: 50, b: 50}, 1.0);
                    break;

                default:
                    return [color1, color2, color3];
            }

            return [
                rgbToString(adjusted1[0], adjusted1[1], adjusted1[2]),
                rgbToString(adjusted2[0], adjusted2[1], adjusted2[2]),
                rgbToString(adjusted3[0], adjusted3[1], adjusted3[2])
            ];
        }

        // 時間帯判定と背景更新（分単位で滑らかに変化）
        // 実際の日の出・日の入り時刻を使用
        function updateTimeOfDay(hour, minute = 0) {
            const bgContainer = document.getElementById('bg-container');
            const totalMinutes = weatherMinutes(+sceneDate());

            // 実際の日の出・日の入り時刻から時間帯を計算
            let timeGradients;

            if (weatherState.sunrise && weatherState.sunset) {
                // 実際のデータがある場合、日の出・日の入り時刻を基準に計算
                const sunriseTime = new Date(weatherState.sunrise);
                const sunsetTime = new Date(weatherState.sunset);
                const sunriseMinutes = weatherMinutes(+sunriseTime);
                const sunsetMinutes = weatherMinutes(+sunsetTime);

                // 動的な時間帯の定義（日の出・日の入り時刻を基準）- ドラマチックな色彩設計
                timeGradients = [
                    { time: 0, colors: ['#000000', '#0a0a1a', '#000000'] },      // 深夜 - 真っ黒
                    { time: Math.max(0, sunriseMinutes - 90), colors: ['#0a0a1a', '#1e1e3f', '#1a1a2e'] }, // 明け方前
                    { time: Math.max(0, sunriseMinutes - 30), colors: ['#1e3a8a', '#e91e63', '#ff8c00'] }, // 黎明 - 深い群青→マゼンタ→燃えるアンバー
                    { time: sunriseMinutes, colors: ['#1e40af', '#ff006e', '#ffa500'] },                   // 日の出 - 宇宙と火の境界線
                    { time: sunriseMinutes + 20, colors: ['#3b82f6', '#60a5fa', '#bfdbfe'] },              // 朝焼け - 青へ移行
                    { time: sunriseMinutes + 120, colors: ['#2563eb', '#38bdf8', '#e0f2fe'] },             // 朝 - 正午へ向かう
                    { time: Math.floor((sunriseMinutes + sunsetMinutes) / 2), colors: ['#1d4ed8', '#0ea5e9', '#f0f9ff'] }, // 正午 - ロイヤルブルー→スカイブルー→白いシアン
                    { time: sunsetMinutes - 120, colors: ['#1e40af', '#38bdf8', '#f0f9ff'] },              // 午後早め
                    { time: sunsetMinutes - 60, colors: ['#64748b', '#fbbf24', '#fed7aa'] },               // 黄昏 - スレートブルー→ハニーゴールド→ペールピーチ
                    { time: sunsetMinutes - 30, colors: ['#475569', '#f59e0b', '#fecaca'] },               // 夕方 - 黄金色のノスタルジー
                    { time: sunsetMinutes, colors: ['#312e81', '#b91c1c', '#7c3aed'] },                    // 残照前 - インディゴ→ルビーレッド→紫
                    { time: sunsetMinutes + 10, colors: ['#4c1d95', '#b91c1c', '#6b21a8'] },               // 日没 - 燃え尽きる情熱
                    { time: sunsetMinutes + 20, colors: ['#312e81', '#581c87', '#3b0764'] },               // 宵 - 深い紫の世界
                    { time: sunsetMinutes + 120, colors: ['#1a1a2e', '#0a0a1a', '#000000'] },              // 夜 - 真っ黒へ
                    { time: 24 * 60, colors: ['#000000', '#0a0a1a', '#000000'] },                          // 深夜（つなぎ）
                ];
            } else {
                // フォールバック: 固定的な時間帯（データがない場合）- ドラマチックな色彩設計
                timeGradients = [
                    { time: 0, colors: ['#000000', '#0a0a1a', '#000000'] },          // 深夜 - 真っ黒
                    { time: 4 * 60, colors: ['#0a0a1a', '#1e1e3f', '#1a1a2e'] },     // 明け方前
                    { time: 5 * 60, colors: ['#1e3a8a', '#e91e63', '#ff8c00'] },    // 黎明 - 深い群青→マゼンタ→燃えるアンバー
                    { time: 6 * 60, colors: ['#1e40af', '#ff006e', '#ffa500'] },     // 日の出 - 宇宙と火の境界線
                    { time: 6 * 60 + 20, colors: ['#3b82f6', '#60a5fa', '#bfdbfe'] },     // 朝焼け - 青へ移行
                    { time: 9 * 60, colors: ['#2563eb', '#38bdf8', '#e0f2fe'] },     // 朝 - 正午へ向かう
                    { time: 12 * 60, colors: ['#1d4ed8', '#0ea5e9', '#f0f9ff'] },    // 正午 - ロイヤルブルー→スカイブルー→白いシアン
                    { time: 16 * 60 + 30, colors: ['#1e40af', '#38bdf8', '#f0f9ff'] }, // 午後早め
                    { time: 17 * 60 + 30, colors: ['#64748b', '#fbbf24', '#fed7aa'] },    // 黄昏 - スレートブルー→ハニーゴールド→ペールピーチ
                    { time: 18 * 60, colors: ['#475569', '#f59e0b', '#fecaca'] },    // 夕方 - 黄金色のノスタルジー
                    { time: 18 * 60 + 30, colors: ['#312e81', '#b91c1c', '#7c3aed'] },    // 残照前 - インディゴ→ルビーレッド→紫
                    { time: 18 * 60 + 40, colors: ['#4c1d95', '#b91c1c', '#6b21a8'] }, // 日没 - 燃え尽きる情熱
                    { time: 18 * 60 + 50, colors: ['#312e81', '#581c87', '#3b0764'] },    // 宵 - 深い紫の世界
                    { time: 22 * 60, colors: ['#1a1a2e', '#0a0a1a', '#000000'] },    // 夜 - 真っ黒へ
                    { time: 24 * 60, colors: ['#000000', '#0a0a1a', '#000000'] },    // つなぎ - 真っ黒
                ];
            }

            // 現在の時刻に最も近い2つの時間帯を見つける
            let beforeGrad = timeGradients[0];
            let afterGrad = timeGradients[1];

            for (let i = 0; i < timeGradients.length - 1; i++) {
                if (totalMinutes >= timeGradients[i].time && totalMinutes < timeGradients[i + 1].time) {
                    beforeGrad = timeGradients[i];
                    afterGrad = timeGradients[i + 1];
                    break;
                }
            }

            // 2つの時間帯の間での進行度を計算
            const timeDiff = afterGrad.time - beforeGrad.time;
            const progress = (totalMinutes - beforeGrad.time) / timeDiff;

            // Interpolate each color
            let color1 = interpolateColor(beforeGrad.colors[0], afterGrad.colors[0], progress);
            let color2 = interpolateColor(beforeGrad.colors[1], afterGrad.colors[1], progress);
            let color3 = interpolateColor(beforeGrad.colors[2], afterGrad.colors[2], progress);

            // 演出2: 太陽・月との色連動 - Celestial body color linkage
            // Check if sun/moon is passing through the middle gradient layer (around 70% height)
            const celestialBody = document.getElementById('celestial-body');
            if (celestialBody && celestialBody.style.opacity === '1') {
                const celestialTop = parseFloat(celestialBody.style.top);
                const screenHeight = canvasH;
                const celestialRelativePos = celestialTop / screenHeight;

                // If celestial body is in the middle gradient zone (60%-80% from top), boost saturation
                if (celestialRelativePos >= 0.6 && celestialRelativePos <= 0.8) {
                    const rgb2 = parseRgb(color2);
                    const boostedRgb2 = adjustSaturation(rgb2, 1.1); // +10% saturation
                    color2 = `rgb(${Math.round(boostedRgb2[0])}, ${Math.round(boostedRgb2[1])}, ${Math.round(boostedRgb2[2])})`;
                }
            }

            // Full moon blue sky: shift deep night colors toward deep blue
            const moonPhase = weatherState.moonPhase || 0;
            if (isNighttime() && moonPhase >= 0.35 && moonPhase <= 0.65) {
                // Intensity peaks at exact full moon (0.5)
                const moonFullness = 1 - Math.abs(moonPhase - 0.5) / 0.15; // 0-1
                const blueShift = moonFullness * 0.6; // Max 60% blend

                // Blend each color toward a deep moonlit blue
                const moonBlue1 = { r: 5, g: 5, b: 18 };   // #050512
                const moonBlue2 = { r: 8, g: 10, b: 28 };   // #080a1c
                const moonBlue3 = { r: 5, g: 5, b: 16 };   // #050510

                const rgb1 = parseRgb(color1);
                const rgb2 = parseRgb(color2);
                const rgb3 = parseRgb(color3);

                const blend = (a, b, t) => Math.round(a + (b - a) * t);
                color1 = `rgb(${blend(rgb1[0], moonBlue1.r, blueShift)}, ${blend(rgb1[1], moonBlue1.g, blueShift)}, ${blend(rgb1[2], moonBlue1.b, blueShift)})`;
                color2 = `rgb(${blend(rgb2[0], moonBlue2.r, blueShift)}, ${blend(rgb2[1], moonBlue2.g, blueShift)}, ${blend(rgb2[2], moonBlue2.b, blueShift)})`;
                color3 = `rgb(${blend(rgb3[0], moonBlue3.r, blueShift)}, ${blend(rgb3[1], moonBlue3.g, blueShift)}, ${blend(rgb3[2], moonBlue3.b, blueShift)})`;
            }

            // Apply weather color blending if available
            if (weatherState.condition) {
                [color1, color2, color3] = blendWeatherColors(color1, color2, color3, weatherState.condition);
            }

            // 演出1: グラデーションの比率を崩す - Gradient ratio adjustment (70% instead of 50%)
            const gradient = `linear-gradient(to bottom, ${color1} 0%, ${color2} 70%, ${color3} 100%)`;
            bgContainer.style.background = gradient;
            const sky = document.getElementById('sky-cover-overlay');
            if (sky.classList.contains('rain-atmosphere')) sky.classList.toggle('rain-night', isNighttime());
        }

        // Calculate solar progress (0.0 = sunrise, 1.0 = sunset, -1 = night)
        function getSolarProgress() {
            syncSunData();
            const now = +sceneDate();
            const { sunriseMs, sunsetMs } = weatherState;

            // If no cached timestamps, estimate based on time (6:00-18:00)
            if (sunriseMs === null || sunsetMs === null) {
                const d = new Date(now);
                const timeInMinutes = d.getHours() * 60 + d.getMinutes();
                const sunriseMinutes = 6 * 60; // 6:00 AM
                const sunsetMinutes = 18 * 60; // 6:00 PM

                if (timeInMinutes >= sunriseMinutes && timeInMinutes <= sunsetMinutes) {
                    return (timeInMinutes - sunriseMinutes) / (sunsetMinutes - sunriseMinutes);
                } else {
                    return -1;
                }
            }

            if (now >= sunriseMs && now <= sunsetMs) {
                // Daytime: 0.0 (sunrise) to 1.0 (sunset)
                return (now - sunriseMs) / (sunsetMs - sunriseMs);
            } else {
                // Night time
                return -1;
            }
        }

        // Check if it's nighttime based on cached sunrise/sunset timestamps
        function isNighttime() {
            syncSunData();
            const { sunriseMs, sunsetMs } = weatherState;

            // If no cached timestamps, use fixed time (20:00-05:00)
            if (sunriseMs === null || sunsetMs === null) {
                const hour = sceneDate().getHours();
                return hour >= 20 || hour < 5;
            }

            const now = +sceneDate();
            // Night is after sunset or before sunrise
            return now < sunriseMs || now > sunsetMs;
        }

        // Update sun and moon position and display (using actual sunrise/sunset times)
        function updateCelestialBody(hour, minute) {
            const celestialBody = document.getElementById('celestial-body');
            const solarProgress = getSolarProgress();

            // 日没30分前のsolarProgressを計算
            let sunsetStartProgress = 0.9; // デフォルト値
            const { sunrise, sunset } = weatherState;
            if (sunrise && sunset) {
                const sunriseTime = new Date(sunrise).getTime();
                const sunsetTime = new Date(sunset).getTime();
                const daylightDuration = sunsetTime - sunriseTime; // 日照時間（ミリ秒）
                const thirtyMinutes = 30 * 60 * 1000; // 30分（ミリ秒）
                sunsetStartProgress = 1 - (thirtyMinutes / daylightDuration); // 日没30分前
            }

            // Common arc parameters - higher orbit to avoid clock text
            const centerX = canvasW / 2;
            const radiusX = canvasW * 0.4;
            const radiusY = canvasH * 0.5; // Large arc for high peak (30% from top at noon)

            if (solarProgress >= 0 && solarProgress <= 1.0) {
                // Daytime: Show sun (日中は常に太陽を表示)
                celestialBody.className = 'sun';

                // Sun movement: sunrise (left) → noon (top ~30% from top) → sunset (right)
                const angle = Math.PI * solarProgress; // 0 → π
                const x = centerX + Math.cos(Math.PI - angle) * radiusX - 40;
                const y = canvasH * 0.8 - Math.sin(angle) * radiusY - 40; // Peak at 30% from top

                celestialBody.style.left = x + 'px';
                celestialBody.style.top = y + 'px';
                celestialBody.style.opacity = '1';
                celestialBody.innerHTML = ''; // 太陽は背景グラデーションとbox-shadowのみ

                // 時間帯による太陽の性格変化
                let sunSize, sunGradient, sunShadow, sunFilter, sunClipPath;
                const baseSize = Math.min(72, Math.max(44, canvasW * 0.12));

                if (solarProgress <= 0.2) {
                    // ① 黎明（日の出）：希望の火種 - 大きく、ごく薄いピンク、ぼかし強め
                    sunSize = baseSize * 1.1;
                    sunGradient = 'radial-gradient(circle, #ffffff 0%, #ffffff 40%, #fffaf5 70%, #fff0e8 100%)';
                    sunShadow = `
                        0 0 80px rgba(255, 255, 255, 0.9),
                        0 0 160px rgba(255, 245, 240, 0.6),
                        0 0 350px rgba(255, 230, 220, 0.3)
                    `;
                    sunFilter = 'blur(2px)'; // ぼかし強め
                    sunClipPath = 'none';

                } else if (solarProgress >= 0.4 && solarProgress <= 0.6) {
                    // ② 正午（昼間）：天頂の王者 - 小さく、純白で眩しい、鋭い影
                    sunSize = baseSize * 0.8;
                    sunGradient = 'radial-gradient(circle, #ffffff 0%, #ffffff 60%, #fffdf8 80%, #fffbf0 100%)';
                    sunShadow = `
                        0 0 60px rgba(255, 255, 255, 0.9),
                        0 0 120px rgba(255, 253, 240, 0.6),
                        0 0 250px rgba(255, 250, 240, 0.3)
                    `;
                    sunFilter = 'blur(0px)'; // 鋭く
                    sunClipPath = 'none';

                } else if (solarProgress >= 0.7 && solarProgress < sunsetStartProgress) {
                    // ③ 黄昏（夕方）：黄金の慈しみ - 大きく、ごく薄いゴールド、光の広がりなし
                    sunSize = baseSize * 1.2;
                    sunGradient = 'radial-gradient(circle, #ffffff 0%, #ffffff 40%, #fffdf0 70%, #fff5e0 100%)';
                    sunShadow = 'none'; // 光の広がりを削除
                    sunFilter = 'blur(1px)';
                    sunClipPath = 'none';

                } else if (solarProgress >= sunsetStartProgress) {
                    // ④ 残照（日没直前）：情熱の終焉 - ごく薄い赤、地平線に沈む、光の広がりなし
                    sunSize = baseSize * 1.15;
                    sunGradient = 'radial-gradient(circle, #ffffff 0%, #fff5f5 40%, #ffe8e8 70%, #ffd0d0 100%)';
                    sunShadow = 'none'; // 光の広がりを削除
                    sunFilter = 'blur(3px)';
                    // 地平線に沈むように下から直線的に消える（円形を保持）
                    // 日没30分前から日没までの範囲で徐々に沈む
                    const sunsetRange = 1.0 - sunsetStartProgress; // 沈む期間（日没30分前～日没）
                    const fadeProgress = Math.min(1.0, (solarProgress - sunsetStartProgress) / sunsetRange); // 0.0 -> 1.0

                    if (fadeProgress >= 0.5) {
                        // 半分沈んだら完全に非表示
                        celestialBody.style.opacity = '0';
                        sunClipPath = 'none';
                    } else {
                        // 半分沈むまでは徐々に切り取る（0%～100%）
                        celestialBody.style.opacity = '1';
                        sunClipPath = `inset(0 0 ${fadeProgress * 100}% 0)`;
                    }

                } else {
                    // 中間の時間帯（朝〜午前、午後）は通常の太陽 - 白く眩しく
                    sunSize = baseSize;
                    sunGradient = 'radial-gradient(circle, #ffffff 0%, #ffffff 60%, #fffdf8 80%, #fffbf0 100%)';
                    sunShadow = `
                        0 0 60px rgba(255, 255, 255, 0.9),
                        0 0 120px rgba(255, 253, 240, 0.6),
                        0 0 250px rgba(255, 250, 240, 0.3)
                    `;
                    sunFilter = 'blur(0px)';
                    sunClipPath = 'none';
                }

                // スタイルを適用
                celestialBody.style.width = sunSize + 'px';
                celestialBody.style.height = sunSize + 'px';
                celestialBody.style.background = sunGradient;
                // A bounded radial glow replaces several 250–350px blur shadows.
                celestialBody.style.boxShadow = 'none';
                celestialBody.style.filter = sunFilter;
                celestialBody.style.clipPath = sunClipPath;
                celestialBody.style.transform = 'none'; // Reset moon rotation

                // 位置の微調整（サイズ変更に対応）
                celestialBody.style.left = (x - (sunSize - 80) / 2) + 'px';
                celestialBody.style.top = (y - (sunSize - 80) / 2) + 'px';

                // 日暈（ハロー）の表示制御 - 日中の時間帯（黎明を除く）
                if (solarProgress >= 0.1 && solarProgress <= 0.9) {
                    celestialBody.classList.add('show-halo');
                } else {
                    celestialBody.classList.remove('show-halo');
                }
            } else {
                // Night time: Show moon
                celestialBody.className = 'moon';
                celestialBody.style.clipPath = 'none';
                celestialBody.style.filter = 'none';
                celestialBody.style.width = '80px';
                celestialBody.style.height = '80px';

                // Calculate moon progress based on time between sunset and next sunrise
                const now = +sceneDate();
                const sunsetTime = weatherState.sunset ? new Date(weatherState.sunset).getTime() : null;
                const sunriseTime = weatherState.sunrise ? new Date(weatherState.sunrise).getTime() : null;

                let moonProgress = 0.5; // Default to middle of night

                if (sunsetTime && sunriseTime) {
                    // Determine if we're after sunset or before sunrise
                    let nightStart, nightEnd;

                    if (now > sunsetTime) {
                        // After sunset: use today's sunset to tomorrow's sunrise
                        nightStart = sunsetTime;
                        nightEnd = sunriseTime + 86400000; // Tomorrow's sunrise
                    } else {
                        // Before sunrise: use yesterday's sunset to today's sunrise
                        nightStart = sunsetTime - 86400000; // Yesterday's sunset
                        nightEnd = sunriseTime;
                    }

                    const nightDuration = nightEnd - nightStart;
                    const elapsedNight = now - nightStart;

                    if (nightDuration > 0 && elapsedNight >= 0) {
                        moonProgress = Math.max(0, Math.min(1, elapsedNight / nightDuration));
                    }
                }

                // Moon movement: sunset (left) → midnight (top ~30% from top) → sunrise (right)
                const angle = Math.PI * moonProgress;
                const x = centerX + Math.cos(Math.PI - angle) * radiusX - 40;
                const y = canvasH * 0.8 - Math.sin(angle) * radiusY - 40; // Peak at 30% from top

                celestialBody.style.left = x + 'px';
                celestialBody.style.top = y + 'px';
                celestialBody.style.opacity = '1';

                const phase = weatherState.moonPhase || 0.5;

                // Calculate moon rotation based on position in the sky
                // moonProgress: 0.0 (sunset/left) → 0.5 (midnight/zenith) → 1.0 (sunrise/right)
                // rotation: -30° (tilt left) → 0° (vertical) → +30° (tilt right)
                const moonRotation = (moonProgress - 0.5) * 60; // -30° to +30°

                // 月の見た目を生成する関数
                celestialBody.innerHTML = getMoonSVG(phase);

                // 背景色と影をリセット（SVGで描くため、CSSの円は透明にする）
                celestialBody.style.background = 'transparent';
                celestialBody.style.boxShadow = 'none'; // CSSの影は消してSVGのglowを使う
                // Apply rotation to celestialBody element directly (CSP-compliant)
                celestialBody.style.transform = `rotate(${moonRotation}deg)`;
            }
            // Let cloud cover veil the disc as well as the rest of the sky.
            const cover = Math.max(0, Math.min(1, weatherState.cloudCover / 100));
            const raining = weatherState.condition !== 'Snow' &&
                (weatherState.precipitation > 0 || weatherState.condition === 'Rain' || weatherState.condition === 'Thunderstorm');
            const veil = raining ? Math.max(0.008, (1 - cover) * (1 - cover) * 0.35) : Math.max(0.06, 1 - cover * cover * 0.94);
            celestialBody.style.opacity = String(Number(celestialBody.style.opacity) * veil);
        }


        function getMoonSVG(phase, rotation = 0) {
    // 数学的に正確な満ち欠け計算
    // 外側の半円と内側の半楕円を組み合わせる方法
    // phase: 0 = 新月, 0.5 = 満月, 1.0 = 新月
    // rotation: 月の傾き（度）、moonProgressに基づいて計算
    // Note: rotation is now applied via celestialBody.style.transform (CSP-compliant)

    // Validate phase input
    if (typeof phase !== 'number' || !Number.isFinite(phase)) {
        // Invalid moon phase value (using default)
        phase = 0.5; // Default to full moon
    }
    // Clamp phase to valid range [0, 1]
    phase = Math.max(0, Math.min(1, phase));

    const R = 38; // SVG内での月の半径

    // 楕円の水平半径: rx = R * cos(2π * phase)
    const rx = R * Math.cos(2 * Math.PI * phase);

    // 新月の場合（ほぼ見えない）
    if (phase < 0.02 || phase > 0.98) {
        return `<div class="moon-new"></div>`;
    }

    // 満月の場合（完全な円）
    if (Math.abs(phase - 0.5) < 0.02) {
        return `<div class="moon-full-container"><img src="moon.jpg" class="moon-full-img" /></div>`;
    }

    // 満ち欠けの描画
    // SVGパスで「外側の半円」+「内側の半楕円」を描く
    let clipPath;

    if (phase < 0.5) {
        // 新月から満月へ：右側が明るくなる
        // 右半円（上から下へ）+ 楕円（下から上へ戻る）
        const sweepFlag = rx >= 0 ? 0 : 1;
        clipPath = `M 40 2 A 38 38 0 0 1 40 78 A ${Math.abs(rx)} 38 0 0 ${sweepFlag} 40 2 Z`;
    } else {
        // 満月から新月へ：左側が明るくなる
        // 左半円（上から下へ）+ 楕円（下から上へ戻る）
        const sweepFlag = rx <= 0 ? 0 : 1;
        clipPath = `M 40 2 A 38 38 0 0 0 40 78 A ${Math.abs(rx)} 38 0 0 ${sweepFlag} 40 2 Z`;
    }

    // ユニークなclipPath IDを生成
    const clipId = `moonClip${Math.random().toString(36).slice(2, 11)}`;

    // Earthshine: faint glow on the dark side of crescent moon
    // Visible when moon is a thin crescent (phase 0.05-0.25 or 0.75-0.95)
    let earthshineEl = '';
    const isCrescent = (phase > 0.02 && phase < 0.25) || (phase > 0.75 && phase < 0.98);
    if (isCrescent) {
        // Intensity peaks at thinnest crescent, fades toward quarter moon
        const distFromNew = phase < 0.5 ? phase : (1 - phase);
        const earthshineOpacity = Math.max(0, 0.12 - (distFromNew - 0.02) * 0.5);
        if (earthshineOpacity > 0.01) {
            earthshineEl = `<circle cx="40" cy="40" r="37" fill="rgba(100, 120, 150, ${earthshineOpacity.toFixed(3)})" />`;
        }
    }

    return `
    <svg class="moon-phase-svg" width="80" height="80" viewBox="0 0 80 80">
        <defs>
            <clipPath id="${clipId}">
                <path d="${clipPath}" />
            </clipPath>
        </defs>
        ${earthshineEl}
        <image href="moon.jpg" x="1" y="1" width="78" height="78" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice" />
    </svg>`;
}


        // --- 2. Immersive Mode (Hide UI when mouse is idle) ---
        const controlsWrapper = document.getElementById('controls-wrapper');
        let idleTimer;

        function resetIdleTimer() {
            controlsWrapper.classList.remove('fade-out');
            document.body.style.cursor = 'default';
            clearTimeout(idleTimer);
            
            idleTimer = setTimeout(() => {
                controlsWrapper.classList.add('fade-out');
                document.body.style.cursor = 'none'; // Hide cursor too
            }, 3000); // After 3 seconds
        }

        window.addEventListener('mousemove', resetIdleTimer);
        window.addEventListener('click', resetIdleTimer);
        window.addEventListener('touchstart', resetIdleTimer, { passive: true });
        resetIdleTimer();


        // --- 3. Particle System (Canvas) ---
        const canvas = document.getElementById('particle-canvas');
        let ctx = safeCanvasContext(canvas);

        // Cloud canvas (separate layer)
        const cloudCanvas = document.getElementById('cloud-canvas');
        let cloudCtx = safeCanvasContext(cloudCanvas);

        // Precipitation canvas (rain/snow/splashes) — frontmost weather layer,
        // sits above the sky-cover overlay so rain is never dimmed by it.
        const precipCanvas = document.getElementById('precip-canvas');
        let precipCtx = safeCanvasContext(precipCanvas);
        graphicsAvailable = [ctx, cloudCtx, precipCtx].every(usableContext);

        // Sin/Cos lookup table (1024 entries, ~0.35° precision)
        const LUT_SIZE = 1024;
        const LUT_MASK = LUT_SIZE - 1;
        const LUT_FACTOR = LUT_SIZE / (Math.PI * 2);
        const _sinTable = new Float32Array(LUT_SIZE);
        const _cosTable = new Float32Array(LUT_SIZE);
        for (let i = 0; i < LUT_SIZE; i++) {
            const a = (i / LUT_SIZE) * Math.PI * 2;
            _sinTable[i] = Math.sin(a);
            _cosTable[i] = Math.cos(a);
        }
        function sinLUT(rad) { return _sinTable[((rad * LUT_FACTOR) | 0) & LUT_MASK]; }
        function cosLUT(rad) { return _cosTable[((rad * LUT_FACTOR) | 0) & LUT_MASK]; }

        // Star glow sprite cache: avoids creating gradients per-star per-frame
        const starSpriteCache = new Map();
        function getStarSprite(r, g, b, size, glowMultiplier) {
            // Quantize to reduce cache entries: color (5-bit), size (0.5 step), glow (int)
            const qr = (r >> 3) << 3;
            const qg = (g >> 3) << 3;
            const qb = (b >> 3) << 3;
            const qs = Math.round(size * 2) / 2;
            const qm = Math.round(glowMultiplier);
            const key = `${qr},${qg},${qb},${qs},${qm}`;
            let sprite = starSpriteCache.get(key);
            if (sprite) return sprite;

            const radius = qs * qm;
            const dim = Math.ceil(radius * 2 + 4);
            const cx = dim / 2;
            const c = document.createElement('canvas');
            c.width = dim; c.height = dim;
            const sctx = safeCanvasContext(c);

            // Outer glow
            const glowGrad = sctx.createRadialGradient(cx, cx, 0, cx, cx, radius);
            glowGrad.addColorStop(0, `rgba(${qr},${qg},${qb},0.9)`);
            glowGrad.addColorStop(0.2, `rgba(${qr},${qg},${qb},0.5)`);
            glowGrad.addColorStop(0.5, `rgba(${qr},${qg},${qb},0.2)`);
            glowGrad.addColorStop(1, `rgba(${qr},${qg},${qb},0)`);
            sctx.fillStyle = glowGrad;
            sctx.beginPath(); sctx.arc(cx, cx, radius, 0, Math.PI * 2); sctx.fill();

            // Core
            const coreR = qs * 1.5;
            const coreGrad = sctx.createRadialGradient(cx, cx, 0, cx, cx, coreR);
            coreGrad.addColorStop(0, `rgba(255,255,255,1)`);
            coreGrad.addColorStop(0.5, `rgba(${qr},${qg},${qb},0.9)`);
            coreGrad.addColorStop(1, `rgba(${qr},${qg},${qb},0.4)`);
            sctx.fillStyle = coreGrad;
            sctx.beginPath(); sctx.arc(cx, cx, coreR, 0, Math.PI * 2); sctx.fill();

            // Bright center
            sctx.fillStyle = `rgba(255,255,255,0.9)`;
            sctx.beginPath(); sctx.arc(cx, cx, qs * 0.5, 0, Math.PI * 2); sctx.fill();

            sprite = { canvas: c, dim: dim };
            if (starSpriteCache.size >= 384) starSpriteCache.delete(starSpriteCache.keys().next().value);
            starSpriteCache.set(key, sprite);
            return sprite;
        }

        // Canvas size settings (cap dpr at 2 to balance sharpness and performance)
        // Adaptive render-resolution cap for performance on low-spec devices.
        // Computed once: low-RAM / low-core / very small phones render at 1x,
        // everything else caps at 1.5x. Clouds (blurred) and small particles
        // look virtually identical at these caps while fill-rate drops sharply.
        const LOW_END_DEVICE = (function () {
            const mem = navigator.deviceMemory || 4;        // GB (undefined on iOS Safari → assume 4)
            const cores = navigator.hardwareConcurrency || 4;
            return mem <= 3 || cores <= 4;
        })();
        const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
        const QUALITY_LEVELS = [
            { name: 'Eco', dpr: 1, cloudScale: 0.5, clouds: 9, particles: 0.4, fps: 15, cloudFps: 3, starFps: 4, splashes: 5 },
            { name: 'Balanced', dpr: 1.25, cloudScale: 0.65, clouds: 14, particles: 0.65, fps: 24, cloudFps: 5, starFps: 6, splashes: 12 },
            { name: 'High', dpr: 1.5, cloudScale: 0.8, clouds: 20, particles: 1, fps: 30, cloudFps: 8, starFps: 8, splashes: 24 }
        ];
        const renderQuality = {
            mode: 'auto', level: LOW_END_DEVICE ? 0 : 1,
            slowMs: 0, fastMs: 0, lastChange: 0,
            get profile() { return QUALITY_LEVELS[motionPreference.matches ? 0 : this.level]; },
            setMode(mode) {
                this.mode = ['auto', 'high', 'eco'].includes(mode) ? mode : 'auto';
                this.setLevel(this.mode === 'high' ? 2 : this.mode === 'eco' ? 0 : (LOW_END_DEVICE ? 0 : 1));
            },
            setLevel(level) {
                this.level = Math.max(0, Math.min(2, level));
                this.slowMs = this.fastMs = 0;
                this.lastChange = performance.now();
                document.documentElement.dataset.quality = this.profile.name.toLowerCase();
                resizeCanvas();
                if (cloudManager.initialized) cloudManager.init(weatherState.condition || 'Clear');
                const type = currentParticleType;
                particles = [];
                currentParticleType = 'none';
                if (type === 'star') lastStarUpdateTime = 0;
                updateParticleType(sceneDate().getHours());
                rainSplashes = [];
                invalidateScene();
            },
            observe(cost, elapsed, late) {
                if (this.mode !== 'auto' || motionPreference.matches) return;
                const budget = 1000 / this.profile.fps;
                const slow = cost > budget * 0.5 || late > budget * 0.8;
                this.slowMs = slow ? this.slowMs + elapsed : Math.max(0, this.slowMs - elapsed);
                this.fastMs = !slow && cost < budget * 0.2 ? this.fastMs + elapsed : 0;
                const sinceChange = performance.now() - this.lastChange;
                if (this.slowMs > 4000 && sinceChange > 8000 && this.level > 0) this.setLevel(this.level - 1);
                else if (this.fastMs > 45000 && sinceChange > 45000 && this.level < (LOW_END_DEVICE ? 1 : 2)) this.setLevel(this.level + 1);
            }
        };
        document.documentElement.dataset.quality = renderQuality.profile.name.toLowerCase();

        let _canvasSizedDpr = -1; // DPR the canvases were last built with
        let _canvasCloudScale = -1;
        function resizeCanvas() {
            const dpr = Math.min(window.devicePixelRatio || 1, renderQuality.profile.dpr);
            // Use the LAYOUT viewport (clientWidth/Height), not window.innerWidth/
            // innerHeight. On Android the latter tracks the *visual* viewport, so it
            // drifts when the toolbar hides/shows or the page is zoomed. That drift
            // left an un-cleared band where old frames accumulated into a grey smear.
            const newW = document.documentElement.clientWidth || window.innerWidth;
            const newH = document.documentElement.clientHeight || window.innerHeight;

            // Skip if nothing actually changed. Reassigning canvas.width/height is
            // expensive (it reallocates and blanks the backing store), and Android
            // fires resize events constantly while the toolbar animates.
            if (newW === canvasW && newH === canvasH && _canvasSizedDpr === dpr &&
                _canvasCloudScale === renderQuality.profile.cloudScale) return;

            canvasW = newW;
            canvasH = newH;
            _canvasSizedDpr = dpr;
            _canvasCloudScale = renderQuality.profile.cloudScale;

            canvas.width = canvasW * dpr;
            canvas.height = canvasH * dpr;
            canvas.style.width = canvasW + 'px';
            canvas.style.height = canvasH + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            const cloudDpr = renderQuality.profile.cloudScale;
            cloudCanvas.width = Math.round(canvasW * cloudDpr);
            cloudCanvas.height = Math.round(canvasH * cloudDpr);
            cloudCanvas.style.width = canvasW + 'px';
            cloudCanvas.style.height = canvasH + 'px';
            cloudCtx.setTransform(cloudCanvas.width / canvasW, 0, 0, cloudCanvas.height / canvasH, 0, 0);

            precipCanvas.width = canvasW * dpr;
            precipCanvas.height = canvasH * dpr;
            precipCanvas.style.width = canvasW + 'px';
            precipCanvas.style.height = canvasH + 'px';
            precipCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

            // Resizing clears all backing stores, including the slow layers.
            sceneDirty = true;

            // Setting .width/.height already blanks each backing store, so any
            // stale pixels from the previous size are gone here.
        }
        let sceneDirty = true;
        function invalidateScene() { sceneDirty = true; }
        resizeCanvas();

        // Debounced post-resize: rebuild particles, clouds, celestial body (200ms)
        let _resizeTimer = null;
        function onResizeComplete() {
            resizeCanvas();
            if (currentParticleType === 'rain' || currentParticleType === 'snow') {
                // Refill the whole viewport after rotation, rather than keeping
                // the old portrait-width strip until every drop has recycled.
                createParticles(currentParticleType, particles.length / renderQuality.profile.particles);
            }

            // B: Re-generate star positions for new dimensions
            if (typeof updateStarField === 'function') updateStarField();

            // C: Invalidate cloud effect caches
            if (typeof cloudManager !== 'undefined' && cloudManager.initialized) {
                for (const layer of cloudManager.layers) {
                    for (const cloud of layer) {
                        cloud.effectCacheDirty = true;
                    }
                }
            }

            // D: Recalculate celestial body position
            if (typeof updateCelestialBody === 'function') {
                const now = new Date();
                updateCelestialBody(now.getHours(), now.getMinutes());
            }

            // Invalidate sun halo cache
            if (typeof sunHaloManager !== 'undefined') {
                sunHaloManager._haloDirty = true;
            }
        }

        // E: Debounce resize events — immediate canvas resize + delayed rebuild
        window.addEventListener('resize', () => {
            resizeCanvas(); // Immediate: prevent black bars
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(onResizeComplete, 200);
        }, { passive: true });

        // iOS: 'resize' alone can miss orientation flips and the address-bar
        // show/hide, leaving black bars where the canvas didn't catch up.
        // Re-sync on orientationchange and on visualViewport changes too.
        window.addEventListener('orientationchange', () => {
            resizeCanvas();
            clearTimeout(_resizeTimer);
            // Fire twice: once now, once after iOS settles the new viewport.
            _resizeTimer = setTimeout(() => { resizeCanvas(); onResizeComplete(); }, 300);
        }, { passive: true });
        // The visual viewport fires rapidly on Android (toolbar show/hide, zoom).
        // Debounce it and let resizeCanvas() itself ignore no-op changes, so we
        // never rebuild canvases dozens of times per second.
        if (window.visualViewport) {
            let _vvTimer = null;
            window.visualViewport.addEventListener('resize', () => {
                clearTimeout(_vvTimer);
                _vvTimer = setTimeout(resizeCanvas, 150);
            }, { passive: true });
        }

        // ===== HIPPARCOS COORDINATE TRANSFORMATION UTILITIES =====

        // Calculate Greenwich Mean Sidereal Time in hours
        function calculateGMST(jd) {
            const T = (jd - 2451545.0) / 36525.0;
            const gmst = 18.697374558 + 24.06570982441908 * (jd - 2451545.0);
            return ((gmst % 24) + 24) % 24; // Ensure positive result
        }

        // Calculate Local Sidereal Time in hours
        function calculateLST(date, lonDeg) {
            const jd = calculateJulianDay(date);
            const gmst = calculateGMST(jd);
            const lst = gmst + lonDeg / 15.0; // Convert longitude to hours
            return ((lst % 24) + 24) % 24; // Ensure positive result
        }

        // Convert equatorial coordinates (RA, Dec) to horizontal coordinates (Alt, Az)
        // Inputs: RA, Dec in degrees; lat, lon in degrees; LST in hours
        // Returns: {alt, az} in degrees
        function equatorialToHorizontal(ra, dec, lat, lon, lst) {
            const raRad = ra * Math.PI / 180;
            const decRad = dec * Math.PI / 180;
            const latRad = lat * Math.PI / 180;
            const lstRad = lst * Math.PI / 12; // π/12 radians per hour

            const ha = lstRad - raRad; // Hour angle

            const sinAlt = Math.sin(decRad) * Math.sin(latRad) +
                           Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha);

            const alt = Math.asin(sinAlt);

            const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(alt));
            const sinAz = -Math.sin(ha) * Math.cos(decRad) / Math.cos(alt);

            let az = Math.atan2(sinAz, cosAz);

            return {
                alt: alt * 180 / Math.PI,
                az: (az * 180 / Math.PI + 360) % 360
            };
        }

        // Project altitude-azimuth coordinates to 2D screen position
        // Viewing perspective: Looking SOUTH, from horizon to zenith
        // Screen Bottom = South Horizon (Az 180°, Alt 0°)
        // Screen Left = East (Az 90°)
        // Screen Right = West (Az 270°)
        // Screen Top = Zenith/North
        // Returns null if star is below horizon or outside field of view
        function projectStarToScreen(alt, az) {
            if (alt < 0) return null; // Below horizon

            const centerX = canvasW / 2;
            const logicalH = canvasH;

            // Field of View settings
            // Vertical FOV: 0° (horizon/bottom) to 90° (zenith/top)
            const verticalFOV = 90;

            // Use a single scale for both axes to preserve aspect ratio
            // Scale is based on height to ensure bottom = horizon, top = zenith
            const scale = logicalH / verticalFOV;

            // Calculate horizontal FOV based on canvas width and same scale
            const horizontalFOV = canvasW / scale;

            // X-axis: Azimuth mapping
            // South (180°) should be at screen center
            // East (90°) on the left, West (270°) on the right
            let azFromSouth = az - 180; // Convert to South-centered: -90° (East) to +90° (West)

            // Normalize azimuth to -180 to +180 range
            if (azFromSouth > 180) azFromSouth -= 360;
            if (azFromSouth < -180) azFromSouth += 360;

            // Check if star is within horizontal FOV
            if (Math.abs(azFromSouth) > horizontalFOV / 2) {
                return null; // Outside field of view
            }

            // Calculate X position using the same scale as Y
            const x = centerX + (azFromSouth * scale);

            // Y-axis: Altitude mapping
            // Altitude 0° (horizon) → bottom of screen (logicalH)
            // Altitude 90° (zenith) → top of screen (0)
            const y = logicalH - (alt * scale);

            // Check if y is within canvas bounds (with small margin)
            if (y < -50 || y > logicalH + 50) {
                return null; // Too far outside vertical bounds
            }

            return { x, y };
        }

        // Parse hex color like "#aabfff" to {r, g, b}
        function parseColorHex(hex) {
            try {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                return { r, g, b };
            } catch (e) {
                return { r: 255, g: 255, b: 255 }; // Fallback to white
            }
        }

        // Map apparent magnitude to star size in pixels
        // Brighter (lower mag) = larger
        function magnitudeToSize(mag) {
            const magClamped = Math.max(-1.5, Math.min(6, mag));
            const normalized = (magClamped + 1.5) / 7.5; // 0 (brightest) to 1 (faintest)

            // Non-linear scaling to emphasize bright stars
            // Bright stars get larger size boost
            const scaleFactor = 1 - normalized;
            const enhancedScale = Math.pow(scaleFactor, 0.7); // Power curve for emphasis

            return 0.34 + enhancedScale * 2.5; // 0.34 to 2.84 px (brighter stars are much larger)
        }

        // Map apparent magnitude to base opacity (before twinkling)
        function magnitudeToBaseOpacity(mag) {
            const magClamped = Math.max(-1.5, Math.min(6, mag));
            const normalized = (magClamped + 1.5) / 7.5; // 0 (brightest) to 1 (faintest)

            // Non-linear scaling to emphasize bright stars
            const scaleFactor = 1 - normalized;
            const enhancedScale = Math.pow(scaleFactor, 0.6); // Power curve for emphasis

            return 0.45 + enhancedScale * 0.55; // 0.45 to 1.0 (brighter stars more opaque)
        }

        // Particle class
        class Particle {
            constructor(type) {
                this.type = type;
                this.reset();
            }

            reset(starData = null) {
                this.x = Math.random() * canvasW;
                this.y = this.type === 'star' ? Math.random() * canvasH : -10;
                this.size = Math.random() * 2 + 1;
                this.speedY = this.type === 'star' ? 0 : Math.random() * 2 + 1;
                this.speedX = this.type === 'star' ? 0 : Math.random() * 0.5 - 0.25;
                this.opacity = Math.random() * 0.5 + 0.3;

                // Enhanced star properties
                if (this.type === 'star') {
                    if (starData) {
                        // CATALOG STAR: Use data from Hipparcos catalog
                        this.x = starData.x;
                        this.y = starData.y;
                        this.baseSize = starData.size;
                        this.baseBrightness = starData.baseOpacity;
                        this.starColor = starData.color;
                        this.magnitude = starData.mag; // Store magnitude for glow calculations
                        this.isCatalogStar = true;
                    } else {
                        // RANDOM STAR: Legacy behavior (for fallback)
                        this.baseSize = Math.random() * 0.6 + 0.2; // Smaller stars (0.2-0.8)
                        this.baseBrightness = Math.random() * 0.5 + 0.5; // 0.5-1.0

                        // Star color temperature (white, blue-white, yellow-white)
                        const colorType = Math.random();
                        if (colorType < 0.6) {
                            this.starColor = { r: 255, g: 255, b: 255 }; // Pure white (most common)
                        } else if (colorType < 0.85) {
                            this.starColor = { r: 200, g: 220, b: 255 }; // Blue-white (hot stars)
                        } else {
                            this.starColor = { r: 255, g: 245, b: 220 }; // Yellow-white (cooler stars)
                        }
                        this.isCatalogStar = false;
                    }

                    // Altitude factor: 0 (top/zenith) to 1 (bottom/horizon)
                    this.altitude = canvasH > 0 ? this.y / canvasH : 0;

                    // Altitude-dependent twinkling: low stars twinkle more (atmospheric scintillation)
                    const altSpeedMult = 1 + this.altitude * 0.5; // 1.0x (zenith) to 1.5x (horizon)
                    this.twinkleSpeed = (Math.random() * 0.03 + 0.01) * altSpeedMult;
                    this.twinklePhase = Math.random() * Math.PI * 2;
                    // Amplitude multiplier stored for update() - low stars: up to 2x, high stars: 0.5x
                    this.twinkleAmplitude = 0.5 + this.altitude * 1.5; // 0.5 (zenith) to 2.0 (horizon)
                    // Color scintillation for low-altitude stars
                    this.scintillationPhase = Math.random() * Math.PI * 2;
                } else {
                    this.twinkleSpeed = Math.random() * 0.02 + 0.01;
                    this.twinklePhase = Math.random() * Math.PI * 2;
                }

                // Shooting star initialization
                if (this.type === 'shootingStar') {
                    this.x = Math.random() * canvasW * 0.8 + canvasW * 0.2;
                    this.y = Math.random() * canvasH * 0.3;
                    this.speedX = -(Math.random() * 8 + 6);
                    this.speedY = Math.random() * 4 + 3;
                    this.size = Math.random() * 1.5 + 1;
                    this.opacity = 1;
                    this.tailLength = Math.random() * 120 + 180; // 3-5x longer tail
                    this.life = 1;
                    this.trail = []; // Afterimage trail points
                }

                // Three stable depth bands: fine distant rain, a readable middle
                // layer, and a few soft foreground streaks. Keep the band on
                // recycling so the depth order never changes mid-flight.
                if (this.type === 'rain') {
                    const firstDrop = this.rainLayer === undefined;
                    if (firstDrop) {
                        const depth = Math.random();
                        this.rainLayer = depth < 0.60 ? 0 : depth < 0.93 ? 1 : 2;
                    }
                    const layer = RAIN_LAYERS[this.rainLayer];
                    this.depth = this.rainLayer / 2;
                    this.speedY = layer.speed * (0.92 + Math.random() * 0.16);
                    this.speedX = 0;
                    this.rainScale = 0.80 + Math.random() * 0.40;
                    this.length = layer.length * this.rainScale;
                    this.opacity = layer.opacity * (0.65 + Math.random() * 0.65);
                    if (firstDrop) {
                        this.x = Math.random() * canvasW;
                        this.y = Math.random() * (canvasH + this.length) - this.length;
                    } else {
                        // Sample the incoming top/side boundary by its particle
                        // flux. Recycling into the middle of the sky would pop.
                        const sideFlux = Math.abs(rainSlant) * canvasH;
                        if (Math.random() * (canvasW + sideFlux) < sideFlux) {
                            this.x = rainSlant > 0 ? -this.length : canvasW + this.length;
                            this.y = Math.random() * canvasH;
                        } else {
                            this.x = Math.random() * canvasW;
                            this.y = -this.length;
                        }
                    }
                }

                // Snow initialization - enhanced drift with dual sine wave
                if (this.type === 'snow') {
                    this.size = Math.random() * 3 + 2; // 2-5
                    // Size-dependent fall speed: larger flakes fall faster
                    const sizeFactor = (this.size - 2) / 3; // 0.0-1.0
                    this.speedY = 0.3 + sizeFactor * 0.6 + Math.random() * 0.3;
                    this.speedX = Math.random() * 0.3 - 0.15;
                    this.opacity = Math.random() * 0.6 + 0.4;
                    // Dual sine wave drift
                    this.driftOffset = Math.random() * Math.PI * 2;
                    this.driftSpeed = Math.random() * 0.02 + 0.01;
                    this.driftOffset2 = Math.random() * Math.PI * 2; // Second wave
                    this.driftSpeed2 = Math.random() * 0.008 + 0.003; // Slower second wave
                    this.driftAmp2 = Math.random() * 0.8 + 0.3; // Second wave amplitude
                    // Occasional swirl (5% chance)
                    this.isSwirling = Math.random() < 0.05;
                    this.swirlPhase = Math.random() * Math.PI * 2;
                    this.swirlSpeed = Math.random() * 0.04 + 0.02;
                    this.swirlRadius = Math.random() * 1.5 + 0.5;
                    // Sprite index (0-4, mapped from size 2-6)
                    this.spriteIndex = Math.min(4, Math.max(0, Math.round(this.size) - 2));
                }
            }

            update(step = 1) {
                if (this.type === 'star') {
                    // Altitude-dependent twinkling (simplified single wave)
                    this.twinklePhase += this.twinkleSpeed * step;

                    // Reduce twinkle amplitude for bright stars to prevent excessive brightness
                    const brightnessAdjustment = this.baseBrightness > 0.8 ? 0.6 : 1.0;

                    // Single sine wave, scaled by altitude-dependent amplitude (LUT)
                    const ampFactor = (this.twinkleAmplitude || 1) * 0.25;
                    const wave = sinLUT(this.twinklePhase) * ampFactor * brightnessAdjustment;

                    // Color scintillation for low-altitude stars (subtle R/B shift)
                    if (this.altitude > 0.6 && this.scintillationPhase !== undefined) {
                        this.scintillationPhase += 0.05 * step;
                    }

                    // Base opacity with wave modulation
                    let brightness = this.baseBrightness + wave;

                    // Clamp brightness
                    const maxBrightness = this.baseBrightness > 0.85 ? 0.92 : 1.0;
                    this.opacity = Math.max(0.2, Math.min(maxBrightness, brightness));

                    // Size variation with twinkling (stars appear to pulsate)
                    this.currentSize = this.baseSize * (0.8 + this.opacity * 0.4);

                } else if (this.type === 'shootingStar') {
                    // Record trail point before moving
                    this.trail.push({ x: this.x, y: this.y, opacity: this.opacity, time: Date.now() });

                    // Shooting star movement
                    this.x += this.speedX * step;
                    this.y += this.speedY * step;
                    this.life -= 0.008 * step;
                    this.opacity = this.life;

                    // Fade out old trail points (0.5s afterimage)
                    const now = Date.now();
                    this.trail = this.trail.filter(p => now - p.time < 500);

                    // Remove when off-screen and trail is gone
                    if ((this.life <= 0 || this.x < -100 || this.y > canvasH + 100) && this.trail.length === 0) {
                        return 'remove';
                    }
                } else if (this.type === 'snow') {
                    // Snow movement with enhanced dual sine wave drift (LUT-optimized)
                    // windHoriz gives the real wind direction (sign + strength).
                    const windDrift = (weatherState.windSpeed || 0) * (weatherState.windHoriz || 0) * 0.05;

                    this.driftOffset += this.driftSpeed * step;
                    this.driftOffset2 += this.driftSpeed2 * step;
                    this.y += this.speedY * step;

                    let dx = this.speedX + sinLUT(this.driftOffset) * 0.5
                           + sinLUT(this.driftOffset2) * this.driftAmp2 + windDrift;

                    if (this.isSwirling) {
                        this.swirlPhase += this.swirlSpeed * step;
                        dx += cosLUT(this.swirlPhase) * this.swirlRadius;
                        this.y += sinLUT(this.swirlPhase) * this.swirlRadius * 0.3 * step;
                    }

                    this.x += dx * step;

                    if (this.y > canvasH) this.reset();
                } else {
                    // Rain falling with wind effect — slants in the real wind
                    // direction (windHoriz is signed: +right / -left).
                    const windDrift = this.speedY * rainSlant;

                    this.y += this.speedY * step;
                    this.x += (this.speedX + windDrift) * step;

                    // Reset if out of bounds (bottom or sides due to wind)
                    if (this.y > canvasH + this.length ||
                        (windDrift < 0 && this.x < -this.length) ||
                        (windDrift > 0 && this.x > canvasW + this.length)) {
                        // Create splash effect when hitting ground (not when blown off-screen)
                        if (this.rainLayer === 2 && this.y > canvasH && Math.random() < 0.05) {
                            // Hard cap: in heavy rain this array could otherwise
                            // grow without bound and slowly drag the framerate down.
                            if (!motionPreference.matches && rainSplashes.length < renderQuality.profile.splashes) {
                                rainSplashes.push(new RainSplash(this.x, canvasH - 5));
                            }
                        }
                        this.reset();
                    }
                }
            }

            draw() {
                // Rain and snow use sprite cache — no save/restore needed
                // Rain & snow draw on the PRECIP canvas — the frontmost weather
                // layer, above clouds AND the sky-cover overlay (clouds → overlay
                // → rain), so precipitation is in front and never dimmed.
                if (this.type === 'snow') {
                    precipCtx.globalAlpha = this.opacity;
                    const sprite = spriteCache.snow[this.spriteIndex || 0];
                    precipCtx.drawImage(sprite.canvas, this.x - sprite.dim / 2, this.y - sprite.dim / 2);
                    return;
                }
                if (this.type === 'rain') {
                    const sprite = spriteCache.rain[this.rainLayer];
                    const scale = this.rainScale;
                    const sw = sprite.width * scale;
                    const sh = sprite.height * scale;
                    if (this.x + sw < 0 || this.x - sw > canvasW || this.y + sh < 0) return;
                    // A broad light field makes rain appear and disappear gently,
                    // rather than flashing individual drops or blurring the frame.
                    const light = Math.max(0, 1 - Math.abs(this.x / canvasW - 0.28) * 1.5);
                    const edge = Math.max(0, Math.min(1, (this.y + sh) / 45, (canvasH + sh - this.y) / 80));
                    precipCtx.globalAlpha = Math.min(0.8, this.opacity * (0.65 + light * 0.75) * edge);
                    precipCtx.drawImage(sprite.canvas, this.x - sw / 2, this.y - sh / 2, sw, sh);
                    return;
                }

                if (this.type === 'star') {
                    // No save/restore needed — stars use sprite cache + simple lines
                    const cloudCover = weatherState.cloudCover || 0;
                    const cloudCoverFactor = 1 - (cloudCover / 100) * 0.9;
                    ctx.globalAlpha = this.opacity * Math.max(0.1, cloudCoverFactor);
                }

                if (this.type === 'star') {
                    let { r, g, b } = this.starColor;
                    const size = this.currentSize || this.baseSize;

                    // Color scintillation for low-altitude stars
                    if (this.altitude > 0.6 && this.scintillationPhase !== undefined) {
                        const scintAmount = (this.altitude - 0.6) * 25;
                        const scintWave = sinLUT(this.scintillationPhase);
                        r = Math.min(255, Math.max(0, r + scintWave * scintAmount));
                        b = Math.min(255, Math.max(0, b - scintWave * scintAmount));
                    }

                    // Glow multiplier
                    let glowMultiplier = 4;
                    if (this.magnitude !== undefined) {
                        if (this.magnitude < 2) {
                            glowMultiplier = 6 + (2 - this.magnitude) * 1.5;
                        } else if (this.magnitude < 3) {
                            glowMultiplier = 5;
                        }
                    }

                    // Draw cached sprite (no gradient creation per frame)
                    const sprite = getStarSprite(r, g, b, size, glowMultiplier);
                    ctx.drawImage(sprite.canvas,
                        this.x - sprite.dim / 2, this.y - sprite.dim / 2);

                    // Cross sparkle (lightweight lines, only for bright stars)
                    if (this.opacity > 0.7) {
                        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(this.opacity - 0.7) * 2})`;
                        ctx.lineWidth = 0.5;
                        ctx.beginPath();
                        ctx.moveTo(this.x, this.y - size * 2);
                        ctx.lineTo(this.x, this.y + size * 2);
                        ctx.moveTo(this.x - size * 2, this.y);
                        ctx.lineTo(this.x + size * 2, this.y);
                        ctx.stroke();
                    }

                    return;
                }

                // Shooting stars need save/restore for shadowBlur, lineCap
                if (this.type === 'shootingStar') {
                    ctx.save();
                    ctx.globalAlpha = this.opacity;
                    const now = Date.now();

                    // Draw afterimage trail (fading glow from previous positions)
                    if (this.trail.length > 1) {
                        for (let i = 0; i < this.trail.length - 1; i++) {
                            const p = this.trail[i];
                            const age = (now - p.time) / 500; // 0.0 (fresh) to 1.0 (gone)
                            const trailAlpha = (1 - age) * 0.3 * p.opacity;
                            if (trailAlpha <= 0) continue;
                            // Purple-tinted afterglow
                            ctx.fillStyle = `rgba(160, 140, 220, ${trailAlpha})`;
                            ctx.beginPath();
                            ctx.arc(p.x, p.y, this.size * (1 - age * 0.5), 0, Math.PI * 2);
                            ctx.fill();
                        }
                    }

                    // Only draw head and tail if still alive
                    if (this.life > 0) {
                        // Compute tail endpoint (longer tail)
                        const speed = Math.sqrt(this.speedX * this.speedX + this.speedY * this.speedY);
                        const tailFactor = this.tailLength / speed;
                        const tailEndX = this.x - this.speedX * tailFactor;
                        const tailEndY = this.y - this.speedY * tailFactor;

                        // Multi-color gradient tail: white → blue-white → faint purple → transparent
                        const gradient = ctx.createLinearGradient(this.x, this.y, tailEndX, tailEndY);
                        gradient.addColorStop(0, `rgba(255, 255, 255, ${this.opacity})`);
                        gradient.addColorStop(0.15, `rgba(220, 230, 255, ${this.opacity * 0.8})`);
                        gradient.addColorStop(0.4, `rgba(160, 180, 255, ${this.opacity * 0.4})`);
                        gradient.addColorStop(0.7, `rgba(140, 120, 200, ${this.opacity * 0.15})`);
                        gradient.addColorStop(1, 'rgba(120, 100, 180, 0)');

                        // Draw main tail
                        ctx.strokeStyle = gradient;
                        ctx.lineWidth = this.size * 2;
                        ctx.lineCap = 'round';
                        ctx.beginPath();
                        ctx.moveTo(this.x, this.y);
                        ctx.lineTo(tailEndX, tailEndY);
                        ctx.stroke();

                        // Draw thinner bright core along front portion
                        const coreGrad = ctx.createLinearGradient(this.x, this.y,
                            this.x - this.speedX * tailFactor * 0.3, this.y - this.speedY * tailFactor * 0.3);
                        coreGrad.addColorStop(0, `rgba(255, 255, 255, ${this.opacity})`);
                        coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                        ctx.strokeStyle = coreGrad;
                        ctx.lineWidth = this.size * 0.8;
                        ctx.beginPath();
                        ctx.moveTo(this.x, this.y);
                        ctx.lineTo(this.x - this.speedX * tailFactor * 0.3, this.y - this.speedY * tailFactor * 0.3);
                        ctx.stroke();

                        // Draw head (bright dot with glow)
                        ctx.shadowBlur = 20;
                        ctx.shadowColor = `rgba(200, 220, 255, ${this.opacity})`;
                        ctx.fillStyle = '#ffffff';
                        ctx.beginPath();
                        ctx.arc(this.x, this.y, this.size * 1.5, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.shadowBlur = 0;
                    }
                    ctx.restore();
                }
            }
        }

        // --- Rain Splash Effect ---

        // Splash droplet particle with physics-based motion
        class SplashDroplet {
            constructor(x, y, angle, speed) {
                // Initial position (impact point)
                this.x = x;
                this.y = y;
                this.startY = y;

                // Physics parameters
                this.vx = Math.cos(angle) * speed; // Horizontal velocity (px/frame)
                this.vy = Math.sin(angle) * speed; // Vertical velocity (px/frame)
                this.gravity = 0.4; // Gravity acceleration (px/frame²)
                this.damping = 0.98; // Air resistance (velocity multiplier)
                this.restitution = 0.3; // Bounce coefficient (0-1)

                // Visual properties
                this.size = Math.random() * 1.5 + 0.5; // Droplet size
                this.opacity = 0.9;
                this.lifetime = 0;
                this.maxLifetime = 60; // Frames (~1 second at 60fps)
                this.bounces = 0;
                this.maxBounces = 2;
            }

            update(step = 1) {
                this.lifetime += step;

                // Physics: Projectile motion with gravity
                // x(t) = x₀ + vₓ * t
                // y(t) = y₀ + vᵧ * t + 0.5 * g * t²
                this.x += this.vx * step;
                this.y += this.vy * step;

                // Apply gravity to vertical velocity
                // vᵧ(t) = v₀ᵧ + g * t
                this.vy += this.gravity * step;

                // Apply air resistance (damping)
                this.vx *= Math.pow(this.damping, step);
                this.vy *= Math.pow(this.damping, step);

                // Ground collision detection and bounce
                if (this.y >= canvasH - 5) {
                    this.y = canvasH - 5;

                    if (this.bounces < this.maxBounces && Math.abs(this.vy) > 0.5) {
                        // Bounce: reverse vertical velocity with energy loss
                        this.vy *= -this.restitution;
                        this.bounces++;
                    } else {
                        // Stop bouncing, slide to halt
                        this.vy = 0;
                        this.vx *= Math.pow(0.9, step); // Friction
                    }
                }

                // Fade out over lifetime
                this.opacity = 0.9 * (1 - this.lifetime / this.maxLifetime);

                // Remove when lifetime expires or droplet is barely moving
                if (this.lifetime >= this.maxLifetime ||
                    (this.bounces >= this.maxBounces && Math.abs(this.vx) < 0.1 && Math.abs(this.vy) < 0.1)) {
                    return 'remove';
                }

                return null;
            }

            draw() {
                // Sprite-cached droplet (no per-frame gradient). Drawn on the
                // precip canvas so splashes sit with the rain, in front of clouds.
                precipCtx.globalAlpha = this.opacity;
                const dim = spriteCache.splashDroplet.width;
                const scale = this.size * 0.5;
                precipCtx.drawImage(spriteCache.splashDroplet, this.x - dim * scale / 2, this.y - dim * scale / 2, dim * scale, dim * scale);
            }
        }

        // Ripple effect at impact point
        class RainSplash {
            constructor(x, y) {
                this.x = x;
                this.y = y;
                this.radius = 0;
                this.maxRadius = 6 + Math.random() * 4; // Larger ripples
                this.lifetime = 0;
                this.maxLifetime = 20; // Frames
                this.opacity = 0.9;

                // Create splash droplets (water particles flying outward)
                this.droplets = [];
                const dropletCount = Math.floor(Math.random() * 2) + 2; // 2-3 droplets (reduced from 4-8)

                for (let i = 0; i < dropletCount; i++) {
                    // Angle: mostly upward and outward (60-120 degrees)
                    const angle = -Math.PI * 0.7 + (Math.random() - 0.5) * Math.PI * 0.6;
                    // Speed: random initial velocity
                    const speed = Math.random() * 3 + 2; // 2-5 px/frame

                    this.droplets.push(new SplashDroplet(x, y, angle, speed));
                }
            }

            update(step = 1) {
                this.lifetime += step;

                // Expand ripple with easing (fast start, slow end)
                const progress = this.lifetime / this.maxLifetime;
                const easeOut = 1 - Math.pow(1 - progress, 3); // Cubic ease-out
                this.radius = this.maxRadius * easeOut;
                this.opacity = 0.9 * (1 - progress);

                // Update splash droplets
                this.droplets = this.droplets.filter(droplet => droplet.update(step) !== 'remove');

                return this.lifetime >= this.maxLifetime ? 'remove' : null;
            }

            draw() {
                // Single ripple (removed inner ripple for performance)
                precipCtx.globalAlpha = this.opacity;
                precipCtx.strokeStyle = '#aaddff';
                precipCtx.lineWidth = 1;
                precipCtx.beginPath();
                precipCtx.ellipse(this.x, this.y, this.radius, this.radius * 0.28, 0, 0, Math.PI * 2);
                precipCtx.stroke();

                // Draw splash droplets
                for (let i = 0; i < this.droplets.length; i++) {
                    this.droplets[i].draw();
                }
            }
        }

        // Splash particles array
        let rainSplashes = [];

        // --- リアルな雲の「素材（ノイズテクスチャ）」を生成する関数 ---
        const cloudBrushCanvas = document.createElement('canvas');
        const cloudBrushCtx = safeCanvasContext(cloudBrushCanvas);
        // 解像度を上げてディテールを細かくする
        cloudBrushCanvas.width = 256;
        cloudBrushCanvas.height = 256;

        function createCloudBrush() {
            const ctx = cloudBrushCtx;
            const w = cloudBrushCanvas.width;
            const h = cloudBrushCanvas.height;
            const cx = w / 2;
            const cy = h / 2;

            ctx.clearRect(0, 0, w, h);

            // 1. ベースのソフトな円を描く
            const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
            gradient.addColorStop(0, 'rgba(255, 255, 255, 0.08)'); // 薄くする
            gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)');
            gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
            ctx.fill();

            // 2. 「ノイズ（ムラ）」を加える
            // 小さな白い円をランダムに多数描画して、ザラザラした質感を出す
            // これが写真のような「雲のディテール」になります
            ctx.globalCompositeOperation = 'source-over';
            const noiseCount = 250; // ノイズの粒子の数（最適化: 400 → 250）

            for (let i = 0; i < noiseCount; i++) {
                // 中心に近いほど濃密に
                const angle = Math.random() * Math.PI * 2;
                const radius = Math.random() * (w / 2);
                const x = cx + Math.cos(angle) * radius * Math.pow(Math.random(), 0.5); // 中心に集める
                const y = cy + Math.sin(angle) * radius * Math.pow(Math.random(), 0.5);

                const size = Math.random() * 20 + 5; // ノイズの大きさ
                const opacity = Math.random() * 0.05 + 0.01; // 非常に薄く

                const noiseGrad = ctx.createRadialGradient(x, y, 0, x, y, size);
                noiseGrad.addColorStop(0, `rgba(255, 255, 255, ${opacity})`);
                noiseGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

                ctx.fillStyle = noiseGrad;
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        // 初期化実行
        createCloudBrush();

        // --- 画像ベースの雲クラス ---
        // 雲画像のプリロード
        const cloudImages = {
            far: new Image(),
            main: new Image(),
            near: new Image(),
            loaded: 0
        };
        cloudImages.far.src = 'cloud_far_1.png';
        cloudImages.main.src = 'cloud_main_1.png';
        cloudImages.near.src = 'cloud_near_1.png';
        cloudImages.far.onload = cloudImages.main.onload = cloudImages.near.onload = () => {
            cloudImages.loaded++;
            if (cloudImages.loaded === 3) {
            }
        };

        // One bounded source-sized texture per appearance, shared by all clouds.
        const cloudTextureCache = new Map();
        class CloudParticle {
            constructor(layer, weatherCondition, forceType = null) {
                this.layer = layer; // 0=遠景, 1=中景, 2=近景（3層構造）

                // レイヤーごとに画像を選択
                if (layer === 0) {
                    this.image = cloudImages.far;
                    this.imageType = 'far';
                } else if (layer === 2) {
                    this.image = cloudImages.near;
                    this.imageType = 'near';
                } else {
                    this.image = cloudImages.main;
                    this.imageType = 'main';
                }

                // 配置：画面全体に広く分散（左端から右端まで、上部から下部まで）
                this.x = Math.random() * (canvasW * 2.5) - (canvasW * 0.5);
                this.y = Math.random() * (canvasH * 0.7); // Y軸範囲を拡大

                // パララックス速度（3層構造）
                // windFactor: how strongly wind pushes this layer. Near clouds
                // react most, far clouds least — preserves depth (parallax).
                if (layer === 0) {
                    this.speed = 0.05; // 遠景 - 遅い
                    this.windFactor = 0.35;
                } else if (layer === 1) {
                    this.speed = 0.13; // 中景 - 中間（元のLayer 2の速度）
                    this.windFactor = 0.65;
                } else if (layer === 2) {
                    this.speed = 0.40; // 近景 - 速い
                    this.windFactor = 1.0;
                }

                // サイズ：遠景は大きく、近景は小さく（遠近感）- バリエーション拡大
                if (layer === 0) {
                    this.scale = 1.4 + Math.random() * 0.8; // 1.4-2.2（より広範囲に）
                } else if (layer === 2) {
                    this.scale = 0.5 + Math.random() * 0.5; // 0.5-1.0（より広範囲に）
                } else {
                    this.scale = 0.7 + Math.random() * 0.6; // 0.7-1.3（より広範囲に）
                }

                // ランダムな回転角度（-12度〜+12度）
                this.rotation = (Math.random() - 0.5) * 24 * (Math.PI / 180); // ラジアンに変換

                // ミラーリング（継ぎ目をなくす）
                this.mirrored = Math.random() > 0.5;

                // オフスクリーンキャンバスを作成（パフォーマンス最適化）
                this.offscreenCanvas = null;
                this.effectCacheDirty = true; // エフェクト付きキャッシュが未生成

                // 見た目の設定
                this.setWeatherAppearance(weatherCondition, layer);
            }

            setWeatherAppearance(condition, layer) {
                // 空気遠近法を適用したレイヤー別設定（3層構造）
                // パフォーマンス重視：hue-rotateは使用せず、brightness/contrast/saturationのみ

                if (layer === 0) {
                    // === 遠くの雲 (Deep) ===
                    // 背景に溶け込むテクスチャのような役割
                    // 画像素材自体を深い紺色（#1A1C2C）にする想定
                    this.baseOpacity = 0.05; // 5%に下げて背景に完全に馴染ませる
                    this.brightness = 0.25; // 非常に暗く（背景の黒に近い）
                    this.contrast = 0.7; // 低コントラスト（カラーバンディング防止）
                    this.saturation = 0.6; // 彩度を下げて背景に溶け込ませる
                    this.blur = 0; // ぼかしなし（遠いが明確）

                } else if (layer === 2) {
                    // === 近くの雲 (Near) ===
                    // カメラのすぐ前を通り過ぎる霧のような役割
                    // 画像素材自体を明るめの青灰色（#708090）にする想定
                    this.baseOpacity = 0.25; // 20-30%
                    this.brightness = 0.65; // やや明るめ
                    this.contrast = 0.85; // 控えめのコントラスト
                    this.saturation = 0.7;
                    this.blur = 4; // 強いぼかし（ピンボケ効果）

                } else {
                    // === 中央の雲 (Middle) - Layer 1 ===
                    // メインとなる雲、最も重要な層
                    // 画像素材自体を暗い青灰色（#3D4663）にする想定
                    this.baseOpacity = 0.40; // 中景の主要レイヤー
                    this.brightness = 0.42; // 中間の暗さ
                    this.contrast = 1.0; // 1.1から1.0に下げてカラーバンディング防止
                    this.saturation = 0.8;
                    this.blur = 0; // ぼかしなし（ディテール重視）
                }

                // 天気条件による調整
                switch(condition) {
                    case 'Clear':
                        this.baseOpacity *= 0.7;
                        this.brightness *= 1.3;
                        break;
                    case 'Clouds':
                        this.baseOpacity *= 1.0;
                        break;
                    case 'Rain':
                    case 'Drizzle':
                    case 'Thunderstorm':
                        // 雨雲：より暗く、濃く
                        this.baseOpacity *= 1.3;
                        this.brightness *= 0.5;
                        this.contrast *= 1.3;
                        this.saturation *= 0.5; // 彩度を下げて重苦しく
                        break;
                    case 'Mist':
                    case 'Fog':
                        // 霧：全体的にぼかしと透明度を上げる
                        this.baseOpacity *= 1.5;
                        this.brightness *= 0.9;
                        this.blur = (this.blur || 0) + 3;
                        this.saturation *= 0.6;
                        break;
                }

                // Density scales with the real cloud-cover %: thin/wispy when
                // partly cloudy, thick when overcast. (Set once at creation —
                // no per-frame cost.)
                const cover = Math.max(0, Math.min(100, weatherState.cloudCover || 0));
                const densityFactor = 0.6 + (cover / 100) * 0.6; // 0.6x .. 1.2x
                this.baseOpacity *= densityFactor;
                const solar = getSolarProgress();
                if (solar >= 0 && condition !== 'Rain' && condition !== 'Thunderstorm') {
                    this.brightness *= 1.4;
                    this.baseOpacity *= 0.85;
                }
            }

            update(step = 1) {
                // Gentle baseline drift + real wind (precomputed, per-layer).
                // Clouds can now drift either direction depending on real wind.
                const wind = (cloudManager.windPush || 0) * this.windFactor;
                this.x += (this.speed + wind) * step;

                // Seamless wrap on whichever edge the cloud exits.
                const margin = (this.image.naturalWidth || 994) * this.scale * 1.5;
                if (this.x > canvasW + margin) {
                    this.x = -margin;
                    this.y = Math.random() * (canvasH * 0.7);
                    this.mirrored = Math.random() > 0.5;
                } else if (this.x < -margin) {
                    this.x = canvasW + margin;
                    this.y = Math.random() * (canvasH * 0.7);
                    this.mirrored = Math.random() > 0.5;
                }
            }

            draw(ctx) {
                if (!this.image || !this.image.complete) return;
                if (!this.image.width || !this.image.height) return;

                // 画像サイズ計算
                let scaleAdjustment = 1.0;
                if (this.blur && this.blur > 0) {
                    scaleAdjustment = 1.0 + (this.blur * 0.01);
                }
                const imgWidth = this.image.width * this.scale * scaleAdjustment;
                const imgHeight = this.image.height * this.scale * scaleAdjustment;
                // Conservative rotated bounds: skip fully invisible clouds.
                const radius = imgWidth + imgHeight / 2;
                if (this.x + radius < 0 || this.x - radius > canvasW ||
                    this.y + radius < 0 || this.y - radius > canvasH) return;

                // エフェクト付きキャッシュを初回のみ生成
                if (this.effectCacheDirty) {
                    let filterStr = `brightness(${this.brightness}) contrast(${this.contrast}) saturate(${this.saturation || 1})`;
                    if (this.blur) filterStr += ` blur(${this.blur}px)`;
                    this.offscreenCanvas = this._buildEffectCache(filterStr);
                    this.effectCacheDirty = false;
                }

                // ブレンドモード決定
                let blendMode = 'screen';
                if (this.layer === 2) blendMode = 'soft-light';

                // キャッシュ済みオフスクリーンをメインCanvasに合成（軽量）
                ctx.save();
                ctx.globalAlpha = this.baseOpacity;
                ctx.globalCompositeOperation = blendMode;
                ctx.translate(this.x, this.y);
                ctx.rotate(this.rotation);
                if (this.mirrored) ctx.scale(-1, 1);
                ctx.drawImage(this.offscreenCanvas, -imgWidth, -imgHeight / 2, imgWidth * 2, imgHeight);
                ctx.restore();
            }

            // エフェクト付きオフスクリーンCanvasを一度だけ構築（以降キャッシュとして再利用）
            _buildEffectCache(filterStr) {
                const key = this.imageType + ':' + filterStr;
                if (cloudTextureCache.has(key)) return cloudTextureCache.get(key);
                const imgWidth = Math.min(384, this.image.naturalWidth);
                const imgHeight = Math.round(imgWidth * this.image.naturalHeight / this.image.naturalWidth);
                const offscreen = document.createElement('canvas');
                const offCtx = safeCanvasContext(offscreen);

                offscreen.width = imgWidth * 2;
                offscreen.height = imgHeight;

                offCtx.globalCompositeOperation = 'source-over';
                offCtx.globalAlpha = 1.0;

                // === 1. 雲画像を描画 ===
                offCtx.filter = filterStr;
                offCtx.drawImage(this.image, 0, 0, imgWidth, imgHeight);
                offCtx.drawImage(this.image, imgWidth, 0, imgWidth, imgHeight);
                offCtx.filter = 'none';

                // === 2. 垂直方向の色調グラデーション（厚み表現） ===
                offCtx.globalCompositeOperation = 'overlay';
                const verticalGradient = offCtx.createLinearGradient(0, 0, 0, imgHeight);
                verticalGradient.addColorStop(0, 'rgba(200, 220, 255, 0.2)');
                verticalGradient.addColorStop(0.5, 'rgba(128, 128, 128, 0)');
                verticalGradient.addColorStop(1, 'rgba(15, 20, 40, 0.4)');
                offCtx.fillStyle = verticalGradient;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);

                // === 3. ソフトエッジ・マスク（放射状透過） ===
                offCtx.globalCompositeOperation = 'destination-in';
                const radialMask = offCtx.createRadialGradient(
                    imgWidth, imgHeight / 2, 0,
                    imgWidth, imgHeight / 2, imgWidth * 1.5
                );
                radialMask.addColorStop(0, 'rgba(0, 0, 0, 1)');
                radialMask.addColorStop(0.4, 'rgba(0, 0, 0, 0.7)');
                radialMask.addColorStop(0.7, 'rgba(0, 0, 0, 0.2)');
                radialMask.addColorStop(1, 'rgba(0, 0, 0, 0)');
                offCtx.fillStyle = radialMask;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);

                // === 4. 矩形エッジの強制透過 ===
                offCtx.globalCompositeOperation = 'destination-in';
                const horizontalMask = offCtx.createLinearGradient(0, 0, imgWidth * 2, 0);
                horizontalMask.addColorStop(0, 'rgba(0, 0, 0, 0)');
                horizontalMask.addColorStop(0.28, 'rgba(0, 0, 0, 1)');
                horizontalMask.addColorStop(0.72, 'rgba(0, 0, 0, 1)');
                horizontalMask.addColorStop(1, 'rgba(0, 0, 0, 0)');
                offCtx.fillStyle = horizontalMask;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);

                const verticalMask = offCtx.createLinearGradient(0, 0, 0, imgHeight);
                verticalMask.addColorStop(0, 'rgba(0, 0, 0, 0)');
                verticalMask.addColorStop(0.32, 'rgba(0, 0, 0, 1)');
                verticalMask.addColorStop(0.68, 'rgba(0, 0, 0, 1)');
                verticalMask.addColorStop(1, 'rgba(0, 0, 0, 0)');
                offCtx.fillStyle = verticalMask;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);
                offCtx.globalCompositeOperation = 'source-over';
                cloudTextureCache.set(key, offscreen);
                return offscreen;
            }
        }

        // Sun Halo Manager - 日暈（太陽の周りの光の輪）- オフスクリーンキャッシュ方式
        const sunHaloManager = {
            active: false,
            sunX: 0,
            sunY: 0,
            sunRadius: 40,
            lastCloudCheckTime: 0,
            cachedCloudOverlapBonus: 0,
            cloudCheckInterval: 600000,
            lastConditionCheckTime: 0,
            conditionCheckInterval: 60000,
            cachedIntensityMultiplier: 1.0,
            // オフスクリーンCanvasキャッシュ
            _haloCanvas: null,
            _haloDirty: true,

            updateConditionsAndPosition() {
                const now = Date.now();
                if (now - this.lastConditionCheckTime < this.conditionCheckInterval) return;
                this.lastConditionCheckTime = now;
                this._haloDirty = true; // 条件変化でキャッシュ無効化

                const solarProgress = getSolarProgress();
                const cloudCover = weatherState.cloudCover || 0;
                const condition = weatherState.condition || '';

                const isDaytime = solarProgress >= 0.1 && solarProgress <= 0.9;
                const isValidWeather = condition === 'Clear' || condition === 'Clouds';
                const isValidCloudCover = cloudCover >= 20 && cloudCover <= 50;
                this.active = isDaytime && isValidWeather && isValidCloudCover;

                if (solarProgress >= 0 && solarProgress <= 1) {
                    const centerX = canvasW / 2;
                    const radiusX = canvasW * 0.4;
                    const radiusY = canvasH * 0.5;
                    const angle = Math.PI * solarProgress;
                    this.sunX = centerX + Math.cos(Math.PI - angle) * radiusX;
                    this.sunY = canvasH * 0.8 - Math.sin(angle) * radiusY;
                }

                if (solarProgress < 0.3) {
                    this.cachedIntensityMultiplier = 1.3;
                } else if (solarProgress > 0.7) {
                    this.cachedIntensityMultiplier = 1.3;
                } else {
                    this.cachedIntensityMultiplier = 1.0;
                }
            },

            // オフスクリーンCanvasにblur付き日暈を一度だけ描画
            _rebuildCache() {
                const haloRadius = this.sunRadius * 5;
                const ringWidth = this.sunRadius * 1.5;
                const totalRadius = haloRadius + ringWidth + 55; // blur余白（blur 35px対応）
                const dim = Math.ceil(totalRadius * 2 + 4);
                const cx = dim / 2;

                if (!this._haloCanvas) {
                    this._haloCanvas = document.createElement('canvas');
                    this._haloCtx = safeCanvasContext(this._haloCanvas);
                }
                this._haloCanvas.width = dim;
                this._haloCanvas.height = dim;
                const hctx = this._haloCtx;

                // 雲重なりボーナス
                let cloudOverlapBonus = 0;
                const currentTime = Date.now();
                if (currentTime - this.lastCloudCheckTime >= this.cloudCheckInterval) {
                    let nearbyCloudCount = 0;
                    const detectionRadius = this.sunRadius * 6;
                    for (let layerIndex = 1; layerIndex < cloudManager.layers.length; layerIndex++) {
                        const layer = cloudManager.layers[layerIndex];
                        for (let i = 0; i < layer.length; i += 2) {
                            const cloud = layer[i];
                            const dx = cloud.x - this.sunX;
                            const dy = cloud.y - this.sunY;
                            if (Math.sqrt(dx * dx + dy * dy) < detectionRadius) nearbyCloudCount++;
                        }
                    }
                    cloudOverlapBonus = Math.min(0.1, nearbyCloudCount * 0.02);
                    this.cachedCloudOverlapBonus = cloudOverlapBonus;
                    this.lastCloudCheckTime = currentTime;
                } else {
                    cloudOverlapBonus = this.cachedCloudOverlapBonus;
                }

                const intensityMultiplier = this.cachedIntensityMultiplier;
                const baseOpacity = (0.15 + cloudOverlapBonus) * intensityMultiplier;
                const brightnessBoost = 1.0 + cloudOverlapBonus * 2;

                // 内側の暗闘（blur付き）
                const innerDarkness = hctx.createRadialGradient(
                    cx, cx, this.sunRadius * 1.2,
                    cx, cx, haloRadius - ringWidth * 0.5
                );
                innerDarkness.addColorStop(0, 'rgba(0, 0, 30, 0)');
                innerDarkness.addColorStop(0.3, 'rgba(0, 0, 40, 0.15)');
                innerDarkness.addColorStop(0.7, 'rgba(0, 0, 50, 0.25)');
                innerDarkness.addColorStop(1, 'rgba(0, 0, 60, 0.1)');

                hctx.globalCompositeOperation = 'multiply';
                hctx.filter = 'blur(30px)';
                hctx.fillStyle = innerDarkness;
                hctx.beginPath();
                hctx.arc(cx, cx, haloRadius - ringWidth * 0.5, 0, Math.PI * 2);
                hctx.fill();

                // 虹色の輪（blur付き・滑らかなグラデーション）
                const gradient = hctx.createRadialGradient(
                    cx, cx, haloRadius - ringWidth,
                    cx, cx, haloRadius + ringWidth
                );
                const bo = baseOpacity * brightnessBoost;
                // 内側フェードイン（緩やか）
                gradient.addColorStop(0,    `rgba(255, 100, 100, 0)`);
                gradient.addColorStop(0.10, `rgba(255, 110, 100, ${bo * 0.1})`);
                gradient.addColorStop(0.20, `rgba(255, 130, 100, ${bo * 0.4})`);
                // 赤 → オレンジ
                gradient.addColorStop(0.30, `rgba(255, 150, 100, ${bo * 0.7})`);
                gradient.addColorStop(0.35, `rgba(255, 185, 125, ${bo * 0.85})`);
                // オレンジ → 黄
                gradient.addColorStop(0.40, `rgba(255, 220, 150, ${bo * 0.95})`);
                gradient.addColorStop(0.45, `rgba(255, 240, 175, ${bo})`);
                // 黄 → 緑
                gradient.addColorStop(0.50, `rgba(240, 255, 200, ${bo})`);
                gradient.addColorStop(0.55, `rgba(220, 255, 200, ${bo * 0.95})`);
                // 緑 → 青
                gradient.addColorStop(0.60, `rgba(190, 245, 210, ${bo * 0.85})`);
                gradient.addColorStop(0.65, `rgba(170, 225, 235, ${bo * 0.7})`);
                gradient.addColorStop(0.70, `rgba(150, 200, 255, ${bo * 0.55})`);
                // 外側フェードアウト（緩やか）
                gradient.addColorStop(0.80, `rgba(150, 175, 255, ${bo * 0.25})`);
                gradient.addColorStop(0.90, `rgba(150, 160, 255, ${bo * 0.08})`);
                gradient.addColorStop(1,    `rgba(150, 150, 255, 0)`);

                hctx.globalCompositeOperation = 'screen';
                hctx.filter = 'blur(35px)';
                hctx.fillStyle = gradient;
                hctx.beginPath();
                hctx.arc(cx, cx, haloRadius + ringWidth, 0, Math.PI * 2);
                hctx.fill();

                hctx.filter = 'none';
                this._haloDirty = false;
            },

            // 毎フレーム: キャッシュ済みCanvasをdrawImageするだけ
            drawHalo(ctx) {
                if (!this.active) return;
                if (this._haloDirty || !this._haloCanvas) this._rebuildCache();

                const dim = this._haloCanvas.width;
                ctx.drawImage(this._haloCanvas, this.sunX - dim / 2, this.sunY - dim / 2);
            }
        };

        // Cloud Manager - Handles 3 parallax layers (軽量化のため3層に削減)
        const cloudManager = {
            layers: [[], [], []],
            maxClouds: 30, // 軽量化のため30個に削減
            initialized: false,
            forceCloudType: null, // For testing: force specific cloud type

            init(weatherCondition) {
                // Clear existing clouds
                this.layers = [[], [], []];
                cloudTextureCache.clear();
                invalidateScene();

                // Determine cloud count based on actual cloud cover data
                const cloudCover = weatherState.cloudCover || 0; // 0-100%
                let cloudCount;

                // Special cases for specific weather conditions
                if (weatherCondition === 'Mist' || weatherCondition === 'Fog') {
                    cloudCount = [0, 0, 0]; // No high clouds for fog
                } else if (weatherCondition === 'Thunderstorm') {
                    // Thunderstorm: dense, dark clouds (boost cloud count)
                    const total = renderQuality.profile.clouds;
                    cloudCount = [Math.round(total * 0.3), Math.round(total * 0.5), Math.round(total * 0.2)];
                } else {
                    // Faithfully track the real cloud-cover percentage.
                    // ~0% = clear sky (no/almost no clouds), 100% = fully overcast.
                    // Capped at 28 clouds total to stay light.
                    const cover = Math.max(0, Math.min(100, cloudCover));
                    // Each cloud is a large blended drawImage every frame, so cap
                    // the count harder on low-end devices (still looks overcast).
                    const maxForDevice = renderQuality.profile.clouds;
                    const totalClouds = Math.round((cover / 100) * maxForDevice);

                    if (totalClouds <= 0) {
                        // Genuinely clear sky → leave it empty for realism.
                        cloudCount = [0, 0, 0];
                    } else {
                        // Distribute across the 3 parallax layers (30/40/30).
                        // Only guarantee a cloud in a layer once there's real cover,
                        // so a clear sky never shows stray clouds.
                        cloudCount = [
                            Math.max(1, Math.round(totalClouds * 0.30)), // far
                            Math.max(1, Math.round(totalClouds * 0.40)), // mid
                            Math.max(1, Math.round(totalClouds * 0.30))  // near
                        ];
                    }
                }

                // Create clouds for each layer
                for (let layer = 0; layer < this.layers.length; layer++) {
                    for (let i = 0; i < cloudCount[layer]; i++) {
                        this.layers[layer].push(new CloudParticle(layer, weatherCondition, this.forceCloudType));
                    }
                }

                this.initialized = true;
                const totalCloudCount = cloudCount.reduce((a, b) => a + b, 0);
                const typeInfo = this.forceCloudType ? ` (forced type: ${this.forceCloudType})` : '';
            },

            updateClouds(step = 1) {
                if (!this.initialized) return;

                // Precompute the horizontal wind push ONCE per update (shared by
                // every cloud) so per-cloud update() stays trig-free and cheap.
                // windHoriz (-1..+1) is the real wind direction; windSpeed (km/h)
                // its strength. 0.015 keeps motion gentle and readable.
                this.windPush = (weatherState.windSpeed || 0) *
                                (weatherState.windHoriz || 0) * 0.015;

                // Update all clouds in all layers
                for (let layer of this.layers) {
                    for (let cloud of layer) {
                        cloud.update(step);
                    }
                }
            },

            drawClouds(ctx) {
                if (!this.initialized) return;

                // Draw layers in order (back to front) for proper depth
                // 3層構造に対応
                for (let i = 0; i < this.layers.length; i++) {
                    for (let cloud of this.layers[i]) {
                        cloud.draw(ctx);
                    }
                }

                // Tint clouds with warm colors during dawn/dusk
                const sp = getSolarProgress();
                let tintIntensity = 0;
                let tintR = 255, tintG = 120, tintB = 60; // Warm amber

                if (sp >= 0 && sp < 0.15) {
                    // Dawn: pink-orange tint
                    tintIntensity = Math.sin((sp / 0.15) * Math.PI) * 0.35;
                    tintR = 255; tintG = 130; tintB = 80;
                } else if (sp > 0.85 && sp <= 1) {
                    // Dusk: deeper orange-red tint
                    tintIntensity = Math.sin(((1 - sp) / 0.15) * Math.PI) * 0.35;
                    tintR = 255; tintG = 100; tintB = 50;
                }

                if (tintIntensity > 0.01) {
                    const prevComp = ctx.globalCompositeOperation;
                    ctx.globalCompositeOperation = 'source-atop';
                    ctx.fillStyle = `rgba(${tintR}, ${tintG}, ${tintB}, ${tintIntensity})`;
                    ctx.fillRect(0, 0, canvasW, canvasH);
                    ctx.globalCompositeOperation = prevComp;
                }
            },

            setWeatherCondition(condition) {
                // Re-initialize with new weather condition
                this.init(condition);
            }
        };

        // --- Lightning System (Fractal Algorithm) ---
        class LightningBolt {
            constructor(type) {
                this.type = type; // 'ground' or 'cloud'
                this.segments = [];
                this.branches = [];
                this.lifetime = 0;
                this.maxLifetime = 10; // ~167ms at 60fps
                this.flashIntensity = 0.4; // Dramatic flash

                // Generate lightning path
                if (type === 'ground') {
                    // Cloud-to-ground lightning
                    const startX = Math.random() * canvasW;
                    const startY = Math.random() * canvasH * 0.3;
                    const endX = startX + (Math.random() - 0.5) * 200;
                    const endY = canvasH;
                    this.generateFractalPath(startX, startY, endX, endY, 0);
                } else {
                    // Cloud-to-cloud lightning
                    const startX = Math.random() * canvasW * 0.5;
                    const startY = Math.random() * canvasH * 0.2 + canvasH * 0.1;
                    const endX = startX + 200 + Math.random() * 400;
                    const endY = startY + (Math.random() - 0.5) * 100;
                    this.generateFractalPath(startX, startY, endX, endY, 0);
                }
            }

            generateFractalPath(x1, y1, x2, y2, depth) {
                const maxDepth = 3; // Recursion depth (reduced for performance)

                if (depth >= maxDepth) {
                    // Base case: Add segment
                    this.segments.push({x1, y1, x2, y2});
                    return;
                }

                // Calculate midpoint
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;

                // Offset midpoint perpendicular to path
                const dx = x2 - x1;
                const dy = y2 - y1;
                const length = Math.sqrt(dx * dx + dy * dy);

                // Perpendicular offset (decreases with depth)
                const offsetMagnitude = length * 0.3 * (1 - depth / maxDepth);
                const offsetX = midX + (-dy / length) * (Math.random() - 0.5) * offsetMagnitude;
                const offsetY = midY + (dx / length) * (Math.random() - 0.5) * offsetMagnitude;

                // Add branch (30% chance, not too deep)
                if (Math.random() < 0.3 && depth < maxDepth - 1) {
                    const branchLength = length * (0.3 + Math.random() * 0.3);
                    const branchAngle = (Math.random() - 0.5) * Math.PI * 0.6;
                    const branchEndX = offsetX + Math.cos(branchAngle) * branchLength;
                    const branchEndY = offsetY + Math.sin(branchAngle) * branchLength;

                    this.branches.push({
                        x1: offsetX,
                        y1: offsetY,
                        x2: branchEndX,
                        y2: branchEndY
                    });
                }

                // Recursive subdivision
                this.generateFractalPath(x1, y1, offsetX, offsetY, depth + 1);
                this.generateFractalPath(offsetX, offsetY, x2, y2, depth + 1);
            }

            update(step = 1) {
                this.lifetime += step;

                // Fade flash intensity
                if (this.lifetime > 2) {
                    this.flashIntensity *= Math.pow(0.7, step);
                }
            }

            draw(ctx) {
                if (this.lifetime >= this.maxLifetime) return;

                // Calculate opacity fade
                const opacity = 1 - (this.lifetime / this.maxLifetime);

                ctx.save();

                // Draw main bolt segments
                for (let segment of this.segments) {
                    // Glow effect (multiple layers)
                    for (let i = 0; i < 3; i++) {
                        ctx.strokeStyle = `rgba(255, 255, 255, ${opacity * (0.8 - i * 0.25)})`;
                        ctx.lineWidth = 4 - i;
                        ctx.lineCap = 'round';

                        ctx.beginPath();
                        ctx.moveTo(segment.x1, segment.y1);
                        ctx.lineTo(segment.x2, segment.y2);
                        ctx.stroke();
                    }

                    // Core bolt (bright white)
                    ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(segment.x1, segment.y1);
                    ctx.lineTo(segment.x2, segment.y2);
                    ctx.stroke();
                }

                // Draw branches (thinner, blue-white)
                for (let branch of this.branches) {
                    ctx.strokeStyle = `rgba(200, 220, 255, ${opacity * 0.7})`;
                    ctx.lineWidth = 1.5;
                    ctx.lineCap = 'round';

                    ctx.beginPath();
                    ctx.moveTo(branch.x1, branch.y1);
                    ctx.lineTo(branch.x2, branch.y2);
                    ctx.stroke();
                }

                ctx.restore();
            }
        }

        // Lightning Manager - Handles lightning during storms
        const lightningManager = {
            activeBolts: [],
            nextStrikeTime: 0,
            active: false,

            activate() {
                this.active = true;
                this.nextStrikeTime = Date.now() + (Math.random() * 420000 + 180000); // 180-600s (3-10 min)
            },

            deactivate() {
                this.active = false;
                this.activeBolts = [];
            },

            update(step = 1) {
                if (!this.active) return;

                const now = Date.now();

                // Check if time for new strike
                if (!motionPreference.matches && now >= this.nextStrikeTime && this.activeBolts.length === 0) {
                    this.createLightning();
                    this.nextStrikeTime = now + (Math.random() * 420000 + 180000); // 180-600s (3-10 min)
                }

                // Update existing bolts
                for (let bolt of this.activeBolts) {
                    bolt.update(step);
                }

                // Remove expired bolts
                this.activeBolts = this.activeBolts.filter(bolt => bolt.lifetime < bolt.maxLifetime);
            },

            createLightning() {
                // 70% cloud-to-ground, 30% cloud-to-cloud
                const type = Math.random() < 0.7 ? 'ground' : 'cloud';
                this.activeBolts.push(new LightningBolt(type));

                // 30% chance of multi-strike (2-3 rapid flashes)
                if (Math.random() < 0.3) {
                    setTimeout(() => {
                        if (this.active) {
                            this.activeBolts.push(new LightningBolt(type));
                        }
                    }, 100 + Math.random() * 200);

                    if (Math.random() < 0.5) {
                        setTimeout(() => {
                            if (this.active) {
                                this.activeBolts.push(new LightningBolt(type));
                            }
                        }, 300 + Math.random() * 300);
                    }
                }

                // Afterflash: dimmer re-illumination 0.3-1s after main bolt
                setTimeout(() => {
                    if (this.active) {
                        const afterBolt = new LightningBolt(type);
                        afterBolt.flashIntensity = 0.15; // Dimmer afterflash
                        afterBolt.maxLifetime = 6; // Shorter duration
                        this.activeBolts.push(afterBolt);
                    }
                }, 300 + Math.random() * 700);
            },

            drawLightning(ctx) {
                if (!this.active) return;

                // Draw screen flash effect (subtle)
                if (this.activeBolts.length > 0) {
                    const maxFlash = Math.max(...this.activeBolts.map(b => b.flashIntensity));
                    if (maxFlash > 0.01) {
                        ctx.save();
                        ctx.globalAlpha = maxFlash;
                        ctx.fillStyle = '#aaddff';
                        ctx.fillRect(0, 0, canvasW, canvasH);
                        ctx.restore();
                    }
                }

                // Draw all bolts
                for (let bolt of this.activeBolts) {
                    bolt.draw(ctx);
                }
            }
        };

        // Particle array
        let particles = [];
        let currentParticleType = 'star';

        // Real-time star field data (Hipparcos catalog)
        let catalogStars = [];

        // Star label display toggle
        let showStarLabels = false;
        let lastStarUpdateTime = 0;
        const STAR_UPDATE_INTERVAL = 60000; // Update star positions every 60 seconds

        // ===== HIPPARCOS STAR FIELD MANAGEMENT =====

        // ===== SPATIAL PARTITIONING FOR STAR FIELD OPTIMIZATION =====
        // Divide celestial sphere into grid cells for efficient visibility culling
        const STAR_GRID = {
            RA_DIVISIONS: 12,    // 30° per cell
            DEC_DIVISIONS: 6,    // 30° per cell
            cells: null,         // Will be initialized as 2D array
            initialized: false
        };

        // Get grid cell indices for a given RA/Dec
        function getGridIndices(ra, dec) {
            const raIndex = Math.floor(ra / 30) % 12;
            const decIndex = Math.floor((dec + 90) / 30);
            return { raIndex, decIndex: Math.min(5, Math.max(0, decIndex)) };
        }

        // Initialize the spatial grid with star data (called once)
        function initializeStarGrid() {
            if (STAR_GRID.initialized) return;
            if (typeof HIPPARCOS_STARS === 'undefined' || !HIPPARCOS_STARS) return;

            // Create empty grid
            STAR_GRID.cells = [];
            for (let ra = 0; ra < STAR_GRID.RA_DIVISIONS; ra++) {
                STAR_GRID.cells[ra] = [];
                for (let dec = 0; dec < STAR_GRID.DEC_DIVISIONS; dec++) {
                    STAR_GRID.cells[ra][dec] = [];
                }
            }

            // Populate grid with stars
            for (const starEntry of HIPPARCOS_STARS) {
                const ra = starEntry[0];
                const dec = starEntry[1];
                const { raIndex, decIndex } = getGridIndices(ra, dec);
                STAR_GRID.cells[raIndex][decIndex].push(starEntry);
            }

            STAR_GRID.initialized = true;
        }

        // Get visible grid cells based on current LST and observer latitude
        // Returns array of {raIndex, decIndex} for cells that might be visible
        function getVisibleGridCells(lst, lat) {
            const visibleCells = [];

            // Convert LST (hours) to RA (degrees) - LST indicates which RA is on meridian
            const meridianRA = (lst * 15) % 360; // 15° per hour

            // Determine visible RA range (looking south, FOV ~180° horizontally)
            // Stars within ±90° of meridian could be visible
            const raMin = (meridianRA - 90 + 360) % 360;
            const raMax = (meridianRA + 90) % 360;

            // Determine visible Dec range based on latitude
            // Looking south from horizon to zenith, visible Dec range is roughly:
            // From (lat - 90) to lat (for southern horizon to zenith when looking south)
            // But we need some margin for the full sky view
            const decMin = Math.max(-90, lat - 90);
            const decMax = Math.min(90, lat + 45); // Can see past zenith to north

            // Find all grid cells within visible range
            for (let raIdx = 0; raIdx < STAR_GRID.RA_DIVISIONS; raIdx++) {
                const cellRAMin = raIdx * 30;
                const cellRAMax = (raIdx + 1) * 30;

                // Check if this RA cell is in visible range (handle wraparound)
                let raVisible = false;
                if (raMin <= raMax) {
                    // Normal case: no wraparound
                    raVisible = (cellRAMax > raMin && cellRAMin < raMax);
                } else {
                    // Wraparound case: raMin > raMax (e.g., 270° to 90°)
                    raVisible = (cellRAMax > raMin || cellRAMin < raMax);
                }

                if (!raVisible) continue;

                for (let decIdx = 0; decIdx < STAR_GRID.DEC_DIVISIONS; decIdx++) {
                    const cellDecMin = decIdx * 30 - 90;
                    const cellDecMax = (decIdx + 1) * 30 - 90;

                    // Check if this Dec cell is in visible range
                    if (cellDecMax > decMin && cellDecMin < decMax) {
                        visibleCells.push({ raIndex: raIdx, decIndex: decIdx });
                    }
                }
            }

            return visibleCells;
        }

        // Get stars from visible grid cells only
        function getStarsFromVisibleCells(lst, lat) {
            if (!STAR_GRID.initialized) {
                initializeStarGrid();
            }
            if (!STAR_GRID.cells) return HIPPARCOS_STARS; // Fallback

            const visibleCells = getVisibleGridCells(lst, lat);
            const stars = [];

            for (const cell of visibleCells) {
                const cellStars = STAR_GRID.cells[cell.raIndex][cell.decIndex];
                stars.push(...cellStars);
            }

            return stars;
        }

        // Cached bright star labels (rebuilt when catalog updates)
        let cachedBrightStars = [];

        function updateBrightStarCache() {
            if (catalogStars.length === 0) {
                cachedBrightStars = [];
                return;
            }
            cachedBrightStars = catalogStars.filter(star => star.name && star.mag <= 1.5);
        }

        // Draw star labels for bright stars (uses cached filter result)
        function drawStarLabels() {
            if (!showStarLabels || currentParticleType !== 'star' || cachedBrightStars.length === 0) {
                return;
            }

            ctx.save();
            ctx.font = '14px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
            ctx.shadowBlur = 8;

            for (const star of cachedBrightStars) {
                // Position label slightly above the star
                const labelX = star.x;
                const labelY = star.y - star.size - 15;

                // Draw semi-transparent background for better readability
                const textWidth = ctx.measureText(star.name).width;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                ctx.fillRect(labelX - textWidth / 2 - 4, labelY - 10, textWidth + 8, 20);

                // Draw star name in white
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fillText(star.name, labelX, labelY);
            }

            ctx.restore();
        }

        // Convert Hipparcos catalog to real-time positioned stars
        // This function runs every 60 seconds to update star positions
        // Uses spatial partitioning to reduce coordinate transformation calculations
        function createCatalogStars() {
            if (typeof HIPPARCOS_STARS === 'undefined' || !HIPPARCOS_STARS || HIPPARCOS_STARS.length === 0) {
                // HIPPARCOS_STARS not loaded, using fallback
                return null;
            }

            const now = sceneDate();
            const { lat, lon } = weatherState.coords;
            const lst = calculateLST(now, lon);

            // Get only stars from potentially visible grid cells (spatial partitioning optimization)
            const candidateStars = getStarsFromVisibleCells(lst, lat);

            const visibleStars = [];

            for (const starEntry of candidateStars) {
                const ra = starEntry[0];
                const dec = starEntry[1];
                const mag = starEntry[2];
                const colorHex = starEntry[3];
                const name = starEntry[4] || null; // Star name (if available)

                // 1. Transform celestial coordinates to horizontal
                const { alt, az } = equatorialToHorizontal(ra, dec, lat, lon, lst);

                // 2. Filter: only include stars above horizon
                if (alt < 0) continue;

                // 3. Project to screen coordinates
                const screenPos = projectStarToScreen(alt, az);
                if (!screenPos) continue;

                // 4. Map magnitude to size and brightness
                const size = magnitudeToSize(mag);
                const baseOpacity = magnitudeToBaseOpacity(mag);
                const color = parseColorHex(colorHex);

                // 5. Build star data object
                visibleStars.push({
                    ra, dec, mag,
                    alt, az,
                    x: screenPos.x,
                    y: screenPos.y,
                    size,
                    baseOpacity,
                    color,
                    name // Include star name
                });
            }

            // 6. Sort by magnitude (brightest first) and limit to 200 stars
            visibleStars.sort((a, b) => a.mag - b.mag);
            const maxStars = Math.round(200 * renderQuality.profile.particles);
            return visibleStars.slice(0, maxStars);
        }

        // Load and display catalog stars on night scenes
        function initializeCatalogStars() {
            const isNight = isNighttime();

            if (!isNight) return;

            const now = Date.now();

            // Update star field every 60 seconds (Earth rotation is slow)
            if (currentParticleType === 'star' && now - lastStarUpdateTime < STAR_UPDATE_INTERVAL && particles.length > 0) {
                return;
            }


            catalogStars = createCatalogStars();
            lastStarUpdateTime = now;

            if (catalogStars && catalogStars.length > 0) {

                // Clear existing particles and replace with catalog stars
                particles = [];
                currentParticleType = 'star';
                invalidateScene();

                // Create Particle objects from catalog data
                for (const starData of catalogStars) {
                    const particle = new Particle('star');
                    particle.reset(starData);
                    particles.push(particle);
                }

                // Update bright star label cache
                updateBrightStarCache();

            } else {
                // Fallback to random stars if catalog fails
                // No visible catalog stars, using random fallback
                createParticles('star', 800);
                cachedBrightStars = [];
            }
        }

        // Low-end devices get fewer particles. Every particle costs an update +
        // a drawImage each frame, so this is the single biggest lever on old
        // phones — and at these counts the sky still looks full.
        function createParticles(type, count) {
            const n = Math.max(0, Math.round(count * renderQuality.profile.particles));
            invalidateScene();
            particles = [];
            currentParticleType = type;
            for (let i = 0; i < n; i++) {
                particles.push(new Particle(type));
            }
            if (type === 'rain') particles.sort((a, b) => a.rainLayer - b.rainLayer);
        }

        // --- Sprite cache for rain, snow, and splash droplets ---
        const spriteCache = {};
        const RAIN_LAYERS = [
            { length: 17, width: 0.55, speed: 26, opacity: 0.25 },
            { length: 32, width: 0.85, speed: 48, opacity: 0.36 },
            { length: 54, width: 1.25, speed: 82, opacity: 0.23 }
        ];
        let rainSlant = 0;

        // Create a rain sprite pre-rotated by the given angle
        function createRainSprite(angle, layerIndex) {
            const layer = RAIN_LAYERS[layerIndex];
            const w = layer.width, h = layer.length;
            // Rotated bounding box
            const sin = Math.abs(Math.sin(angle));
            const cos = Math.abs(Math.cos(angle));
            const rw = Math.ceil(w * cos + h * sin) + 8;
            const rh = Math.ceil(w * sin + h * cos) + 8;
            const c = document.createElement('canvas');
            // Tiny 2x sprites keep subpixel streaks soft on both 1x and Retina
            // canvases; all gradients and glow are baked once, never per drop.
            c.width = rw * 2; c.height = rh * 2;
            const cx = safeCanvasContext(c);
            cx.scale(2, 2);
            cx.translate(rw / 2, rh / 2);
            cx.rotate(angle);
            // Draw raindrop centered at origin
            const grad = cx.createLinearGradient(0, -h / 2, 0, h / 2);
            grad.addColorStop(0, 'rgba(216, 231, 243, 0)');
            grad.addColorStop(0.25, 'rgba(216, 231, 243, 0.25)');
            grad.addColorStop(0.78, 'rgba(235, 244, 250, 0.95)');
            grad.addColorStop(1, 'rgba(235, 244, 250, 0)');
            cx.strokeStyle = grad;
            cx.lineCap = 'round';
            cx.beginPath();
            cx.moveTo(0, -h / 2);
            cx.lineTo(0, h / 2);
            cx.globalAlpha = layerIndex === 2 ? 0.20 : 0.08;
            cx.lineWidth = w + (layerIndex === 2 ? 3 : 1.2);
            cx.stroke();
            cx.globalAlpha = layerIndex === 2 ? 0.65 : 1;
            cx.lineWidth = w;
            cx.stroke();
            return { canvas: c, width: rw, height: rh };
        }

        // Rebuild rain sprite when wind changes (called from weather update)
        let _cachedRainWindSpeed = -999;
        let _cachedRainWindHoriz = null;
        function updateRainSprite() {
            const ws = weatherState.windSpeed || 0;
            // Only rebuild if wind changed significantly (>2 km/h difference)
            const windHoriz = weatherState.windHoriz;
            rainSlant = windHoriz * Math.min(0.32, ws * 0.008);
            if (ws === _cachedRainWindSpeed && windHoriz === _cachedRainWindHoriz) return;
            _cachedRainWindSpeed = ws;
            _cachedRainWindHoriz = windHoriz;
            // Motion and streak orientation use exactly the same wind slope.
            const angle = -Math.atan(rainSlant);
            spriteCache.rain = RAIN_LAYERS.map((_, i) => createRainSprite(angle, i));
        }

        function createSnowSprites() {
            // Pre-render multiple snow sizes with glow baked in
            const sprites = [];
            for (let i = 0; i < 5; i++) {
                const size = 2 + i; // 2-6 radius
                const padding = 10;
                const dim = (size + padding) * 2;
                const c = document.createElement('canvas');
                c.width = dim; c.height = dim;
                const cx = safeCanvasContext(c);
                const center = dim / 2;
                // Glow layer
                const glow = cx.createRadialGradient(center, center, 0, center, center, size + padding);
                glow.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
                glow.addColorStop(0.3, 'rgba(255, 255, 255, 0.3)');
                glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
                cx.fillStyle = glow;
                cx.beginPath();
                cx.arc(center, center, size + padding, 0, Math.PI * 2);
                cx.fill();
                // Core
                cx.fillStyle = '#ffffff';
                cx.beginPath();
                cx.arc(center, center, size, 0, Math.PI * 2);
                cx.fill();
                sprites.push({ canvas: c, size: size, dim: dim });
            }
            return sprites;
        }

        function createSplashDropletSprite() {
            // Pre-render a small droplet with glow
            const dim = 8;
            const c = document.createElement('canvas');
            c.width = dim; c.height = dim;
            const cx = safeCanvasContext(c);
            const center = dim / 2;
            const grad = cx.createRadialGradient(center, center, 0, center, center, center);
            grad.addColorStop(0, 'rgba(136, 192, 208, 1)');
            grad.addColorStop(0.5, 'rgba(136, 192, 208, 0.5)');
            grad.addColorStop(1, 'rgba(136, 192, 208, 0)');
            cx.fillStyle = grad;
            cx.beginPath();
            cx.arc(center, center, center, 0, Math.PI * 2);
            cx.fill();
            return c;
        }

        // Initialize sprite cache
        updateRainSprite();
        spriteCache.snow = createSnowSprites();
        spriteCache.splashDroplet = createSplashDropletSprite();

        // Create initial particles - full starry sky
        createParticles('star', 800);

        // Shooting star management
        let lastShootingStarTime = Date.now();
        let nextShootingStarDelay = Math.random() * 200000 + 150000; // 150-350 seconds (2.5-6 minutes)

        // --- Horizon Atmospheric Glow ---
        function drawHorizonGlow(ctx = cloudCtx) {
            const solarProgress = getSolarProgress();
            const h = canvasH;
            const w = canvasW;
            const glowHeight = h * 0.18; // Glow occupies bottom 18%
            const y0 = h - glowHeight;

            if (solarProgress >= 0 && solarProgress <= 1) {
                // Daytime: subtle warm glow during dawn/dusk
                let intensity = 0;
                if (solarProgress < 0.12) {
                    // Dawn: intensity ramps up then fades
                    intensity = Math.sin((solarProgress / 0.12) * Math.PI) * 0.25;
                } else if (solarProgress > 0.88) {
                    // Dusk: intensity ramps up then fades
                    intensity = Math.sin(((1 - solarProgress) / 0.12) * Math.PI) * 0.25;
                }
                if (intensity > 0.01) {
                    const grad = ctx.createLinearGradient(0, h, 0, y0);
                    // Warm orange-amber glow
                    grad.addColorStop(0, `rgba(255, 140, 50, ${intensity})`);
                    grad.addColorStop(0.4, `rgba(255, 100, 60, ${intensity * 0.4})`);
                    grad.addColorStop(1, 'rgba(255, 80, 40, 0)');
                    ctx.fillStyle = grad;
                    ctx.fillRect(0, y0, w, glowHeight);

                    // Radial glow centered on sun position (sunrise/sunset radiance)
                    const centerX = w / 2;
                    const radiusX = w * 0.4;
                    const angle = Math.PI * solarProgress;
                    const sunX = centerX + Math.cos(Math.PI - angle) * radiusX;
                    const sunY = h * 0.8 - Math.sin(angle) * (h * 0.5);
                    const glowRadius = w * 0.35;

                    const radGlow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, glowRadius);
                    const radIntensity = intensity * 1.2;
                    radGlow.addColorStop(0, `rgba(255, 180, 100, ${radIntensity * 0.6})`);
                    radGlow.addColorStop(0.3, `rgba(255, 140, 80, ${radIntensity * 0.3})`);
                    radGlow.addColorStop(0.6, `rgba(255, 100, 60, ${radIntensity * 0.1})`);
                    radGlow.addColorStop(1, 'rgba(255, 80, 40, 0)');
                    ctx.fillStyle = radGlow;
                    ctx.fillRect(0, 0, w, h);
                }
            } else {
                // Nighttime: very faint navy atmospheric glow.
                // This branch runs every frame, so cache the (size-only) gradient
                // instead of recreating it each tick. Rebuilt on canvas resize.
                if (!_nightGlowGrad || _nightGlowGradH !== h) {
                    const grad = ctx.createLinearGradient(0, h, 0, y0);
                    grad.addColorStop(0, 'rgba(20, 30, 60, 0.08)');
                    grad.addColorStop(0.5, 'rgba(15, 20, 50, 0.03)');
                    grad.addColorStop(1, 'rgba(10, 15, 40, 0)');
                    _nightGlowGrad = grad;
                    _nightGlowGradH = h;
                }
                ctx.fillStyle = _nightGlowGrad;
                ctx.fillRect(0, y0, w, glowHeight);
            }
        }
        let _nightGlowGrad = null, _nightGlowGradH = -1;

        // Slow layers retain their pixels between updates. Rain gets the budget
        // it needs without re-rasterizing the entire sky at the same rate.
        let _frameTimer = null, _frameRequest = null;
        let lastRenderHeartbeat = performance.now(), renderFailures = 0, renderRepairAfter = 0;
        let lastFrameTime = 0, lastCloudFrame = 0, lastStarFrame = 0, nextFrameDue = 0;
        function scheduleNextFrame(delay) {
            clearTimeout(_frameTimer);
            if (document.visibilityState !== 'visible' || !graphicsAvailable) return;
            nextFrameDue = performance.now() + delay;
            _frameTimer = setTimeout(() => {
                _frameRequest = requestAnimationFrame(animateParticles);
            }, delay);
        }

        function animateParticles(currentTime) {
            _frameRequest = null;
            if (document.visibilityState !== 'visible' || !graphicsAvailable) return;
            let delay = 1000 / renderQuality.profile.fps;
            try {
                delay = drawFrame(currentTime);
                lastRenderHeartbeat = performance.now(); renderFailures = 0;
            } catch (_) {
                reportIssue('render-error');
                renderFailures++;
                renderRepairAfter = performance.now() + Math.min(30000, 1000 * Math.pow(2, renderFailures));
                delay = Math.min(30000, 1000 * Math.pow(2, renderFailures));
                try { if (renderQuality.level > 0) renderQuality.setLevel(0); } catch (_) { /* Keep weather alive. */ }
            } finally { scheduleNextFrame(delay); }
        }
        function drawFrame(currentTime) {
            _frameRequest = null;
            if (document.visibilityState !== 'visible') return;
            const started = performance.now();
            const elapsed = lastFrameTime ? Math.min(250, currentTime - lastFrameTime) : 100;
            lastFrameTime = currentTime;
            const profile = renderQuality.profile;
            const reducedMotion = motionPreference.matches;
            const precip = currentParticleType === 'rain' || currentParticleType === 'snow';
            const shooting = particles.some(p => p.type === 'shootingStar');
            const fps = reducedMotion ? 2 : (precip || shooting || lightningManager.activeBolts.length ? profile.fps : profile.starFps);

            if (sceneDirty || currentTime - lastCloudFrame >= (reducedMotion ? 1000 : 1000 / profile.cloudFps)) {
                const cloudStep = lastCloudFrame ? Math.min(1000, currentTime - lastCloudFrame) / 200 : 0;
                cloudCtx.clearRect(0, 0, canvasW, canvasH);
                drawHorizonGlow();
                sunHaloManager.updateConditionsAndPosition();
                sunHaloManager.drawHalo(cloudCtx);
                if (!reducedMotion) cloudManager.updateClouds(cloudStep);
                cloudManager.drawClouds(cloudCtx);
                lastCloudFrame = currentTime;
            }

            if (lightningManager.active && !reducedMotion) lightningManager.update(elapsed / 100);
            const skyDue = sceneDirty || currentTime - lastStarFrame >= 1000 / (shooting ? fps : profile.starFps) || lightningManager.activeBolts.length;
            if (skyDue) {
                ctx.clearRect(0, 0, canvasW, canvasH);
                const starStep = lastStarFrame ? Math.min(500, currentTime - lastStarFrame) / 100 : 1;
                lastStarFrame = currentTime;
                if (!precip) {
                    let write = 0;
                    for (const particle of particles) {
                        if (!reducedMotion && particle.update(starStep) === 'remove') continue;
                        particle.draw();
                        particles[write++] = particle;
                    }
                    particles.length = write;
                }
                // Lightning belongs in front of the cloud/sky-cover layers.
                drawStarLabels();
            }

            if (precip || sceneDirty || rainSplashes.length || lightningManager.active) {
                precipCtx.clearRect(0, 0, canvasW, canvasH);
                if (precip) for (const particle of particles) {
                    particle.update(elapsed / 100 * (reducedMotion ? 0.25 : 1));
                    particle.draw();
                }
                let write = 0;
                for (const splash of rainSplashes) {
                    if (splash.update(elapsed / 100) === 'remove') continue;
                    splash.draw();
                    rainSplashes[write++] = splash;
                }
                rainSplashes.length = write;
                precipCtx.globalAlpha = 1;
                if (!reducedMotion) lightningManager.drawLightning(precipCtx);
            }

            if (!reducedMotion && isNighttime() && currentParticleType === 'star') {
                const now = Date.now();
                if (now - lastShootingStarTime > nextShootingStarDelay) {
                    particles.push(new Particle('shootingStar'));
                    lastShootingStarTime = now;
                    nextShootingStarDelay = Math.random() * 250000 + 150000;
                }
            }
            sceneDirty = false;
            const cost = performance.now() - started;
            renderQuality.observe(cost, elapsed, nextFrameDue ? Math.max(0, currentTime - nextFrameDue) : 0);
            return Math.max(0, 1000 / fps - cost);
        }

        function resumeRendering() {
            clearTimeout(_frameTimer);
            if (_frameRequest !== null) cancelAnimationFrame(_frameRequest);
            _frameRequest = null;
            if (document.visibilityState !== 'visible' || !graphicsAvailable) return;
            resizeCanvas();
            lastFrameTime = lastCloudFrame = lastStarFrame = nextFrameDue = 0;
            renderQuality.slowMs = renderQuality.fastMs = 0;
            invalidateScene();
            _frameRequest = requestAnimationFrame(animateParticles);
        }
        document.addEventListener('visibilitychange', resumeRendering);
        if (motionPreference.addEventListener) motionPreference.addEventListener('change', () => {
            renderQuality.setLevel(renderQuality.level);
            lightningManager.activeBolts = [];
            resumeRendering();
        });
        resumeRendering();

        function restoreGraphics() {
            if (document.visibilityState !== 'visible') return;
            try {
                ctx = safeCanvasContext(canvas);
                cloudCtx = safeCanvasContext(cloudCanvas);
                precipCtx = safeCanvasContext(precipCanvas);
                graphicsAvailable = [ctx, cloudCtx, precipCtx].every(usableContext);
                if (!graphicsAvailable) return;
                _canvasSizedDpr = _canvasCloudScale = -1;
                starSpriteCache.clear(); cloudTextureCache.clear();
                for (const layer of cloudManager.layers) for (const cloud of layer) cloud.effectCacheDirty = true;
                _cachedRainWindSpeed = -999; updateRainSprite();
                spriteCache.snow = createSnowSprites();
                spriteCache.splashDroplet = createSplashDropletSprite();
                sunHaloManager._haloDirty = true;
                sunHaloManager._haloCanvas = null;
                _nightGlowGrad = null; _nightGlowGradH = -1;
                resizeCanvas(); resumeRendering();
            } catch (_) { graphicsAvailable = false; reportIssue('graphics-restore-error'); }
        }
        for (const surface of [canvas, cloudCanvas, precipCanvas]) {
            surface.addEventListener('contextlost', () => { graphicsAvailable = false; reportIssue('context-lost'); });
            surface.addEventListener('contextrestored', restoreGraphics);
        }
        setInterval(() => {
            if (document.visibilityState !== 'visible' || performance.now() < renderRepairAfter) return;
            if (![ctx, cloudCtx, precipCtx].every(usableContext)) graphicsAvailable = false;
            if (!graphicsAvailable || performance.now() - lastRenderHeartbeat > 20000) {
                renderRepairAfter = performance.now() + 30000;
                restoreGraphics();
            }
        }, 15000);

        // Update particle type based on weather and time of day
        function updateParticleType(hour) {
            // Priority 1: Weather-based particles.
            // It counts as raining if the weather CODE says so OR there is
            // measurable precipitation. Open-Meteo sometimes reports light rain
            // as "Clouds" while precipitation > 0, which previously made rain
            // vanish after a refresh even though it was still raining. Snow is
            // checked first so snowfall is never misread as rain.
            const cond = weatherState.condition;
            const precipNow = (weatherState.precipitation || 0) > 0;

            if (cond === 'Snow') {
                // Show snow particles for snowy weather (self-healing).
                if (currentParticleType !== 'snow' || particles.length === 0) {
                    createParticles('snow', 120);
                }
                return;
            }

            if (cond === 'Rain' || cond === 'Drizzle' || cond === 'Thunderstorm' || precipNow) {
                // AUDIO CONTROLS - Temporarily disabled for release
                const rainButton = document.getElementById('btn-rain');
                const rainButtonActive = rainButton ? rainButton.classList.contains('active') : false;

                // (Re)create rain when we're not already showing it, OR when the
                // particle array is empty for any reason (makes a refresh reliably
                // restore rain).
                if (!rainButtonActive) {
                    let rainCount;
                    if (weatherState.precipitation > 0) {
                        rainCount = calculateRainParticles(weatherState.precipitation);
                    } else if (cond === 'Drizzle') {
                        rainCount = 100;
                    } else if (cond === 'Thunderstorm') {
                        rainCount = 250;
                    } else {
                        rainCount = 180; // Moderate rain
                    }
                    const target = Math.round(rainCount * renderQuality.profile.particles);
                    if (currentParticleType !== 'rain' || particles.length !== target) {
                        createParticles('rain', rainCount);
                    }
                }
                return;
            }

            // Priority 2: Time-based particles (stars at night)
            // Use actual sunrise/sunset times to determine nighttime
            if (isNighttime()) {
                if (currentParticleType !== 'star') {
                    initializeCatalogStars();
                } else {
                    // Refresh catalog stars every 60 seconds to reflect Earth's rotation
                    initializeCatalogStars();
                }
            } else {
                // Daytime + non-rainy/snowy weather: clear any leftover particles
                // (including rain) so the screen matches the current conditions.
                // The old "keep rain" guard was for the now-disabled manual rain
                // button and caused rain to linger after the weather cleared.
                if (currentParticleType !== 'none') {
                    particles = [];
                    currentParticleType = 'none';
                    invalidateScene();
                }
            }
        }

        // NEW: Update weather effects (clouds and lightning)
        function updateWeatherEffects() {
            const condition = weatherState.condition;

            // Initialize cloud manager if not already done
            if (!cloudManager.initialized) {
                cloudManager.init(condition || 'Clear');
            } else {
                // Update clouds when weather changes
                cloudManager.setWeatherCondition(condition || 'Clear');
            }

            // Sky cover overlay control (for rainy weather).
            // Kept thin now that stars are suppressed during precipitation, so
            // the rain particles (drawn just beneath it) stay clearly visible.
            const skyCoverOverlay = document.getElementById('sky-cover-overlay');
            const precipNow = (weatherState.precipitation || 0) > 0;
            const rainySky = condition !== 'Snow' &&
                (condition === 'Rain' || condition === 'Drizzle' || condition === 'Thunderstorm' || precipNow);
            skyCoverOverlay.classList.toggle('rain-atmosphere', rainySky);
            skyCoverOverlay.classList.toggle('rain-night', rainySky && isNighttime());
            if (condition === 'Rain' || condition === 'Drizzle' || condition === 'Thunderstorm' || precipNow) {
                // Original overcast depth.
                skyCoverOverlay.style.opacity = condition === 'Thunderstorm' ? '0.65' : '0.42';
            } else if (condition === 'Clouds') {
                // Subtle haze for cloudy skies (original value).
                skyCoverOverlay.style.opacity = '0.12';
            } else {
                // Fade out: clear sky
                skyCoverOverlay.style.opacity = '0';
            }

            // Activate/deactivate lightning based on weather
            if (condition === 'Thunderstorm') {
                if (!lightningManager.active) {
                    lightningManager.activate();
                }
            } else {
                if (lightningManager.active) {
                    lightningManager.deactivate();
                }
            }

            // Update particles based on weather (override time-based particles)
            const now = new Date();
            updateParticleType(now.getHours());
            invalidateScene();

            // Refresh catalog stars at night — but NOT during precipitation, so
            // rain/snow isn't overwritten by stars and the sky stays starless
            // while it's raining/snowing.
            const isPrecip = (condition === 'Rain' || condition === 'Drizzle' ||
                              condition === 'Snow' || condition === 'Thunderstorm' ||
                              (weatherState.precipitation || 0) > 0);
            if (!isPrecip && isNighttime()) {
                initializeCatalogStars();
            }

            // Update rain sound based on weather (if sound control is initialized)
            if (typeof updateRainSound === 'function') {
                updateRainSound();
            }
        }

        // Extend time-of-day system
        const originalUpdateTimeOfDay = updateTimeOfDay;
        updateTimeOfDay = function(hour, minutes) {
            originalUpdateTimeOfDay(hour, minutes);
            updateParticleType(hour);
        };


        // --- 4. Audio & Settings Persistence (Local Storage) ---

        // Save settings function
        function saveSettings() {
            const settings = {
                // AUDIO CONTROLS - Temporarily disabled for release
                // bonfireVol: document.getElementById('vol-bonfire').value,
                // bonfireOn: document.getElementById('btn-bonfire').classList.contains('active'),
                // rainVol: document.getElementById('vol-rain').value,
                // rainOn: document.getElementById('btn-rain').classList.contains('active'),
                dimmer: Number(document.getElementById('dimmer-range').value),
                quality: renderQuality.mode
            };
            try { localStorage.setItem('ambientFlowSettings', JSON.stringify(settings)); } catch (_) { /* Private browsing/storage full. */ }
        }

        function setupAudio(btnId, volId, audioId, keyName) {
            const btn = document.getElementById(btnId);
            const vol = document.getElementById(volId);
            const audio = document.getElementById(audioId);

            // 音量変更
            vol.addEventListener('input', (e) => {
                audio.volume = e.target.value;
                if(audio.paused && e.target.value > 0 && btn.classList.contains('active')) {
                   audio.play(); 
                }
                saveSettings();
            });

            // 再生切り替え
            btn.addEventListener('click', () => {
                if (audio.paused) {
                    audio.play();
                    btn.classList.add('active');
                } else {
                    audio.pause();
                    btn.classList.remove('active');
                }
                saveSettings();
            });

            return { audio, vol, btn };
        }

        // AUDIO CONTROLS - Temporarily disabled for release
        /*
        const bonfire = setupAudio('btn-bonfire', 'vol-bonfire', 'audio-bonfire');
        const rain = setupAudio('btn-rain', 'vol-rain', 'audio-rain');

        // Show rain particles when rain sound is ON
        document.getElementById('btn-rain').addEventListener('click', () => {
            setTimeout(() => {
                const isRainActive = document.getElementById('btn-rain').classList.contains('active');
                if (isRainActive) {
                    createParticles('rain', 180); // Reduced for performance
                } else {
                    // When rain stops, return to time-based particles
                    const hour = new Date().getHours();
                    updateParticleType(hour);
                }
            }, 100);
        });
        */
        // END AUDIO CONTROLS


        // --- 6. Brightness Adjustment (Dimmer) ---
        const dimmerRange = document.getElementById('dimmer-range');
        const dimmerOverlay = document.getElementById('dimmer-overlay');

        let dimmerSaveTimer;
        dimmerRange.addEventListener('input', (e) => {
            // Use slider value (0-0.9) as opacity
            // 0 = transparent (bright), 0.9 = almost black
            dimmerOverlay.style.opacity = e.target.value;
            clearTimeout(dimmerSaveTimer);
            dimmerSaveTimer = setTimeout(saveSettings, 300);
        });


        // --- 7. Restore Settings on Initial Load + Fetch Weather Data ---
        window.addEventListener('DOMContentLoaded', () => {
            // Weather startup is registered before graphics initialization.

            let saved = null;
            try { saved = localStorage.getItem('ambientFlowSettings'); } catch (_) { /* Storage unavailable. */ }
            if (saved) {
                try {
                    const s = JSON.parse(saved);
                    renderQuality.setMode(s.quality);
                    document.getElementById('quality-mode').value = renderQuality.mode;

                    // AUDIO CONTROLS - Temporarily disabled for release
                    /*
                    // Bonfire
                    bonfire.vol.value = s.bonfireVol;
                    bonfire.audio.volume = s.bonfireVol;
                    if (s.bonfireOn) {
                        // Autoplay policy workaround: Just turn on UI, wait for first click
                        // Sound won't play until user clicks somewhere
                        // Best to start playback on first user click
                        bonfire.btn.classList.add('active');
                    }

                    // Rain
                    rain.vol.value = s.rainVol;
                    rain.audio.volume = s.rainVol;
                    if (s.rainOn) {
                        rain.btn.classList.add('active');
                    }
                    */

                    // Brightness
                    if (s.dimmer !== undefined && Number.isFinite(Number(s.dimmer)) && s.dimmer >= 0 && s.dimmer <= 0.9) {
                        dimmerRange.value = s.dimmer;
                        dimmerOverlay.style.opacity = s.dimmer;
                    }
                } catch (error) {
                    // Failed to parse saved settings
                    // Clear corrupted data
                    try { localStorage.removeItem('ambientFlowSettings'); } catch (_) { /* Storage unavailable. */ }
                }
            }
        });

        // AUDIO CONTROLS - Temporarily disabled for release
        // (bonfire/rain autoplay workaround removed; rain sound is handled by btn-sound below)
        /*
        document.body.addEventListener('click', () => {
            if(bonfire.btn.classList.contains('active') && bonfire.audio.paused) bonfire.audio.play();
            if(rain.btn.classList.contains('active') && rain.audio.paused) rain.audio.play();
        }, { once: true });
        */


        // --- 8. Wake Lock & Fullscreen ---
        const wakeLockBtn = document.getElementById('btn-wakelock');
        let wakeLock = null, wakeLockDesired = false, wakeLockPending = false, wakeLockAttempt = 0, wakeRetryTimer = null, wakeFailures = 0, wakePendingSince = 0;
        function showWakeLock() {
            wakeLockBtn.textContent = !('wakeLock' in navigator) ? 'Always On unavailable' : wakeLock ? 'Always On ON' : wakeLockDesired ? 'Always On waiting' : 'Always On OFF';
            wakeLockBtn.classList.toggle('active', !!wakeLock);
            wakeLockBtn.disabled = !('wakeLock' in navigator);
        }
        function retryWakeLock() {
            clearTimeout(wakeRetryTimer);
            if (!wakeLockDesired || document.visibilityState !== 'visible') return;
            wakeRetryTimer = setTimeout(() => { wakeRetryTimer = null; requestWakeLock(); }, Math.min(60000, 5000 * Math.pow(2, Math.min(4, wakeFailures++))));
        }
        async function requestWakeLock() {
            if (wakeLock && wakeLock.released) { wakeLock = null; showWakeLock(); }
            if (wakeLockPending && (Date.now() - wakePendingSince > 15000 || Date.now() < wakePendingSince)) { wakeLockAttempt++; wakeLockPending = false; }
            if (!wakeLockDesired || document.visibilityState !== 'visible' || !('wakeLock' in navigator) || wakeLock || wakeLockPending) return;
            const attempt = ++wakeLockAttempt;
            wakeLockPending = true; wakePendingSince = Date.now();
            const deadline = setTimeout(() => {
                if (attempt !== wakeLockAttempt || !wakeLockPending) return;
                wakeLockAttempt++; wakeLockPending = false; showWakeLock(); retryWakeLock();
            }, 15000);
            try {
                const lock = await navigator.wakeLock.request('screen');
                if (!wakeLockDesired || attempt !== wakeLockAttempt) { await lock.release(); return; }
                wakeLock = lock; wakeFailures = 0;
                lock.addEventListener('release', () => {
                    if (wakeLock !== lock) return;
                    wakeLock = null; showWakeLock(); retryWakeLock();
                });
                clearTimeout(wakeRetryTimer); wakeRetryTimer = null;
            } catch (_) { reportIssue('wake-lock-unavailable'); retryWakeLock(); }
            finally {
                clearTimeout(deadline);
                if (attempt === wakeLockAttempt) wakeLockPending = false;
                showWakeLock();
                if (wakeLockDesired && !wakeLock && !wakeRetryTimer && !wakeLockPending) retryWakeLock();
            }
        }
        async function toggleWakeLock() {
            wakeLockDesired = !wakeLockDesired;
            if (wakeLockDesired) { showWakeLock(); await requestWakeLock(); }
            else {
                wakeLockAttempt++; wakeLockPending = false; clearTimeout(wakeRetryTimer); wakeRetryTimer = null;
                const lock = wakeLock; wakeLock = null;
                showWakeLock();
                if (lock) { try { await lock.release(); } catch (_) { /* Already released. */ } }
            }
        }
        wakeLockBtn.addEventListener('click', toggleWakeLock);
        showWakeLock();

        // Digital/Analog clock toggle
        const clockToggleBtn = document.getElementById('btn-clock-toggle');
        const digitalTime = document.getElementById('time');
        const digitalDate = document.getElementById('date');
        const analogClock = document.getElementById('analog-clock');

        clockToggleBtn.addEventListener('click', () => {
            isAnalogClock = !isAnalogClock;

            if (isAnalogClock) {
                // Switch to analog clock
                digitalTime.style.display = 'none';
                digitalDate.style.display = 'none';
                analogClock.classList.add('visible');
                clockToggleBtn.textContent = '🔢';
                clockToggleBtn.classList.add('active');

                // Update analog clock immediately
                updateAnalogClock(new Date());
            } else {
                // Switch to digital clock
                digitalTime.style.display = '';
                digitalDate.style.display = '';
                analogClock.classList.remove('visible');
                clockToggleBtn.textContent = '🕐';
                clockToggleBtn.classList.remove('active');
            }
        });

        // Sound toggle button
        const soundBtn = document.getElementById('btn-sound');
        const rainAudio = document.getElementById('audio-rain');
        rainAudio.volume = 0.5; // デフォルト音量50%
        let soundEnabled = false;

        soundBtn.addEventListener('click', () => {
            soundEnabled = !soundEnabled;

            if (soundEnabled) {
                soundBtn.classList.add('active');
                // 雨が降っている場合は即座に再生
                if (currentParticleType === 'rain') {
                    rainAudio.play().catch(() => {});
                }
            } else {
                soundBtn.classList.remove('active');
                rainAudio.pause();
            }
        });

        // 天気が変わった時にサウンドを制御する関数
        window.updateRainSound = function() {
            if (!soundEnabled) return;

            const isRaining = currentParticleType === 'rain';

            if (isRaining && rainAudio.paused) {
                rainAudio.play().catch(() => {});
            } else if (!isRaining && !rainAudio.paused) {
                rainAudio.pause();
            }
        };

        // Star labels toggle button
        const starLabelsBtn = document.getElementById('btn-star-labels');
        starLabelsBtn.addEventListener('click', () => {
            // Only enable if stars are currently displayed
            if (currentParticleType !== 'star') {
                return;
            }

            showStarLabels = !showStarLabels;
            invalidateScene();

            if (showStarLabels) {
                starLabelsBtn.classList.add('active');
            } else {
                starLabelsBtn.classList.remove('active');
            }
        });

        // Update button state when particle type changes
        // (Disable star labels button when not showing stars)
        const originalUpdateParticleType = updateParticleType;
        updateParticleType = function(hour) {
            originalUpdateParticleType(hour);

            // If not showing stars, disable the labels and button
            if (currentParticleType !== 'star') {
                showStarLabels = false;
                starLabelsBtn.classList.remove('active');
                starLabelsBtn.style.opacity = '0.2';
                starLabelsBtn.style.cursor = 'not-allowed';
            } else {
                starLabelsBtn.style.opacity = '';
                starLabelsBtn.style.cursor = 'pointer';
            }
        };

        // Double-click to toggle fullscreen
        document.addEventListener('dblclick', (e) => {
            // Exclude double-click on control panel
            if (e.target.closest('#controls')) return;

            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => {
                    console.error('Failed to enter fullscreen:', err);
                });
            } else {
                document.exitFullscreen();
            }
        });


        function notifyUser(message) {
            document.getElementById('notification-message').textContent = message;
            document.getElementById('notification').hidden = false;
        }
        let pomodoroInterval = null, pomodoroSeconds = 25 * 60, pomodoroMode = 'work', pomodoroRunning = false, pomodoroDeadline = 0;
        let alarmEnabled = false, alarmInterval = null, alarmNextAt = 0;
        function saveTools() {
            AmbientReliability.write('ambientClockToolsV1', { version: 1, pomodoroSeconds, pomodoroMode, pomodoroRunning, pomodoroDeadline, alarmEnabled, alarmNextAt, alarmTime: document.getElementById('alarm-time').value });
        }
        function updatePomodoroDisplay() {
            document.getElementById('pomodoro-time').textContent = String(Math.floor(pomodoroSeconds / 60)).padStart(2, '0') + ':' + String(pomodoroSeconds % 60).padStart(2, '0');
            document.getElementById('pomodoro-start').textContent = pomodoroRunning ? 'Stop' : 'Start';
            document.getElementById('pomodoro-start').classList.toggle('active', pomodoroRunning);
        }
        function syncPomodoro() {
            if (pomodoroRunning) {
                pomodoroSeconds = Math.max(0, Math.ceil((pomodoroDeadline - Date.now()) / 1000));
                if (pomodoroSeconds === 0) {
                    pomodoroRunning = false;
                    clearInterval(pomodoroInterval);
                    const completedWork = pomodoroMode === 'work';
                    pomodoroMode = completedWork ? 'break' : 'work';
                    pomodoroSeconds = completedWork ? 300 : 1500;
                    document.getElementById('pomodoro-status').textContent = completedWork ? 'Break time' : 'Work time';
                    notifyUser(completedWork ? 'Work session complete. Take a 5-minute break.' : 'Break complete. Start your next work session.');
                    saveTools();
                }
            }
            updatePomodoroDisplay();
        }
        function startPomodoro() {
            if (pomodoroRunning) { syncPomodoro(); pomodoroRunning = false; clearInterval(pomodoroInterval); }
            else { pomodoroDeadline = Date.now() + pomodoroSeconds * 1000; pomodoroRunning = true; clearInterval(pomodoroInterval); pomodoroInterval = setInterval(syncPomodoro, 1000); }
            updatePomodoroDisplay(); saveTools();
        }
        function resetPomodoro() {
            clearInterval(pomodoroInterval); pomodoroRunning = false; pomodoroMode = 'work'; pomodoroSeconds = 1500; pomodoroDeadline = 0;
            document.getElementById('pomodoro-status').textContent = 'Ready'; updatePomodoroDisplay(); saveTools();
        }
        function nextAlarm(now = Date.now()) {
            const value = document.getElementById('alarm-time').value;
            if (!/^\d{2}:\d{2}$/.test(value)) return 0;
            const parts = value.split(':').map(Number);
            const date = new Date(now); date.setHours(parts[0], parts[1], 0, 0);
            if (+date <= now) date.setDate(date.getDate() + 1);
            return +date;
        }
        function checkAlarm() {
            if (!alarmEnabled || !alarmNextAt) return;
            const now = Date.now();
            if (now >= alarmNextAt) {
                if (now - alarmNextAt < 86400000) notifyUser('Alarm: the set time has been reached.');
                alarmNextAt = nextAlarm(now); saveTools();
            }
        }
        function showAlarm() {
            const button = document.getElementById('alarm-toggle');
            button.textContent = alarmEnabled ? 'OFF' : 'ON'; button.classList.toggle('active', alarmEnabled);
            clearInterval(alarmInterval);
            if (alarmEnabled) alarmInterval = setInterval(checkAlarm, 10000);
        }
        document.getElementById('pomodoro-start').addEventListener('click', startPomodoro);
        document.getElementById('pomodoro-reset').addEventListener('click', resetPomodoro);
        document.getElementById('alarm-toggle').addEventListener('click', () => {
            alarmEnabled = !alarmEnabled; alarmNextAt = alarmEnabled ? nextAlarm() : 0; showAlarm(); saveTools();
        });
        document.getElementById('alarm-time').addEventListener('change', () => { if (alarmEnabled) alarmNextAt = nextAlarm(); saveTools(); });
        document.getElementById('notification-dismiss').addEventListener('click', () => { document.getElementById('notification').hidden = true; });
        window.addEventListener('pagehide', saveTools);
        const toolsSaved = AmbientReliability.read('ambientClockToolsV1');
        if (toolsSaved && toolsSaved.version === 1) {
            pomodoroMode = toolsSaved.pomodoroMode === 'break' ? 'break' : 'work';
            document.getElementById('pomodoro-status').textContent = pomodoroMode === 'break' ? 'Break time' : 'Ready';
            pomodoroSeconds = Number.isFinite(toolsSaved.pomodoroSeconds) ? Math.max(0, Math.min(1500, Math.round(toolsSaved.pomodoroSeconds))) : 1500;
            pomodoroDeadline = Number.isFinite(toolsSaved.pomodoroDeadline) ? toolsSaved.pomodoroDeadline : 0;
            pomodoroRunning = toolsSaved.pomodoroRunning === true && pomodoroDeadline > 0;
            if (pomodoroRunning) { syncPomodoro(); if (pomodoroRunning) pomodoroInterval = setInterval(syncPomodoro, 1000); }
            if (/^([01]\d|2[0-3]):[0-5]\d$/.test(toolsSaved.alarmTime)) document.getElementById('alarm-time').value = toolsSaved.alarmTime;
            alarmEnabled = toolsSaved.alarmEnabled === true;
            alarmNextAt = Number.isFinite(toolsSaved.alarmNextAt) && toolsSaved.alarmNextAt > 0 ? toolsSaved.alarmNextAt : nextAlarm();
            showAlarm(); checkAlarm(); updatePomodoroDisplay();
        }

        // --- 11. Keyboard Shortcuts ---
        let toolsPanelVisible = false;

        function toggleToolsPanel() {
            toolsPanelVisible = !toolsPanelVisible;
            document.getElementById('tools-panel').classList.toggle('visible', toolsPanelVisible);
            const tb = document.getElementById('btn-tools');
            if (tb) tb.classList.toggle('active', toolsPanelVisible);
        }

        // Tap target so phones (no keyboard) can open Pomodoro/Alarm.
        const toolsBtn = document.getElementById('btn-tools');
        if (toolsBtn) toolsBtn.addEventListener('click', toggleToolsPanel);

        // --- Live weather-parameters panel (drivers of the visual effects) ---
        let infoPanelVisible = false;
        function compass16(deg) {
            const names = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                           'S','SSW','SW','WSW','W','WNW','NW','NNW'];
            return names[Math.round(deg / 22.5) % 16];
        }
        function fmtNum(v, digits) {
            if (v === null || v === undefined || isNaN(v)) return null;
            return digits ? Number(v).toFixed(digits) : String(Math.round(v));
        }
        function setInfo(id, text) {
            const el = document.getElementById(id);
            const value = (text === null || text === undefined) ? '—' : String(text);
            if (el && el.textContent !== value) el.textContent = value;
        }
        function updateWeatherHealth() {
            const health = previewScene ? null : weatherService.snapshot();
            if (previewScene) { setInfo('info-connection', 'Preview'); setInfo('weather-status', 'Fixed preview weather'); return; }
            const age = health.observedAt ? Math.max(0, Math.floor((Date.now() - health.observedAt) / 60000)) : null;
            setInfo('info-updated', age === null ? '—' : age + ' min ago');
            const labels = { starting: 'Starting', updating: 'Updating', live: 'Connected', cached: 'Saved weather', stale: 'Retrying', retrying: 'Retrying' };
            setInfo('info-connection', labels[health.status] || health.status);
            const wait = Math.max(1, Math.ceil((health.nextAt - Date.now()) / 60000));
            const note = health.lastError ? 'Showing last available weather. Retrying in ' + wait + ' min.' : health.status === 'cached' ? 'Saved weather; checking for an update.' : 'Updated about every 30 min from Open-Meteo.';
            setInfo('weather-status', note + (weatherState.sunEstimated ? ' Sun times are approximate.' : ''));
        }
        function updateInfoPanel() {
            updateWeatherHealth();
            const w = weatherState;
            setInfo('info-condition', w.condition || '—');
            const p = fmtNum(w.precipitation, 1);
            setInfo('info-precip', p !== null ? p + ' mm/h' : '—');
            const ws = fmtNum(w.windSpeed, 0);
            setInfo('info-wind', ws !== null ? ws + ' km/h' : '—');
            if (typeof w.windDirection === 'number') {
                setInfo('info-winddir', Math.round(w.windDirection) + '° (' + compass16(w.windDirection) + ')');
            } else {
                setInfo('info-winddir', '—');
            }
            const cc = fmtNum(w.cloudCover, 0);
            setInfo('info-cloud', cc !== null ? cc + ' %' : '—');
            const t = fmtNum(w.temp, 0);
            setInfo('info-temp', t !== null ? t + ' °C' : '—');
            const rainN = (currentParticleType === 'rain') ? particles.length : 0;
            setInfo('info-rain-count', rainN + (rainN === 1 ? ' drop' : ' drops'));
        }
        function toggleInfoPanel() {
            infoPanelVisible = !infoPanelVisible;
            document.getElementById('info-panel').classList.toggle('visible', infoPanelVisible);
            const ib = document.getElementById('btn-info');
            if (ib) ib.classList.toggle('active', infoPanelVisible);
            if (infoPanelVisible) updateInfoPanel();
        }
        const infoBtn = document.getElementById('btn-info');
        if (infoBtn) infoBtn.addEventListener('click', toggleInfoPanel);

        function toggleUI() {
            const controls = document.getElementById('controls-wrapper');
            const tools = document.getElementById('tools-panel');
            const hint = document.getElementById('shortcut-hint');

            if (controls.style.display === 'none') {
                controls.style.display = '';
                if (toolsPanelVisible) tools.style.display = '';
                hint.style.display = '';
            } else {
                controls.style.display = 'none';
                tools.style.display = 'none';
                hint.style.display = 'none';
            }
        }

        function toggleFullscreen() {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => {
                    console.error('Failed to enter fullscreen:', err);
                });
            } else {
                document.exitFullscreen();
            }
        }

        document.addEventListener('keydown', (e) => {
            // Disable shortcuts when in input fields
            if (e.target.tagName === 'INPUT') return;

            switch(e.key.toLowerCase()) {
                case 't':
                    toggleToolsPanel();
                    break;
                case ' ':
                    e.preventDefault();
                    toggleUI();
                    break;
                case 'f':
                    toggleFullscreen();
                    break;
                // AUDIO CONTROLS - Temporarily disabled for release
                /*
                case 'b':
                    document.getElementById('btn-bonfire').click();
                    break;
                case 'r':
                    document.getElementById('btn-rain').click();
                    break;
                */
            }
        });

        // Show shortcut hints initially
        setTimeout(() => {
            document.getElementById('shortcut-hint').classList.add('show');
            setTimeout(() => {
                document.getElementById('shortcut-hint').classList.remove('show');
            }, 5000);
        }, 2000);


        document.getElementById('quality-mode').addEventListener('change', (event) => {
            renderQuality.setMode(event.target.value);
            saveSettings();
        });


        rendererReady = true;
        window.ambientDiagnostics = () => ({ weather: weatherService.snapshot(), graphicsAvailable, renderFailures, lastRenderHeartbeat, issues: localIssues.slice(), starTextures: starSpriteCache.size });
        safeVisualUpdate();

