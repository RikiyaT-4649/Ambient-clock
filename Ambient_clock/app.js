        // --- 1. Weather System ---
        const weatherState = {
            condition: null,        // 'Clear', 'Clouds', 'Rain', 'Snow', 'Thunderstorm', 'Mist'
            temp: null,
            windSpeed: 0,
            cloudCover: 0,          // Cloud coverage (0-100%)
            precipitation: 0,       // Precipitation rate (mm/h)
            moonPhase: 0.5,
            sunrise: null,          // Sunrise time
            sunset: null,           // Sunset time
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

        // Get user's geolocation
        function fetchUserLocation() {
            return new Promise((resolve) => {
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (position) => {
                            resolve({
                                lat: position.coords.latitude,
                                lon: position.coords.longitude
                            });
                        },
                        (error) => {
                            resolve(weatherState.coords); // Fallback to Tokyo
                        },
                        { timeout: 10000 }
                    );
                } else {
                    resolve(weatherState.coords); // Fallback to Tokyo
                }
            });
        }

        // Get city name from coordinates using reverse geocoding
        async function getCityName(lat, lon) {
            // Validate input coordinates
            if (!validateCoordinates(lat, lon)) {
                // Invalid coordinates (details hidden for security)
                return 'Unknown Location';
            }

            const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=en`;

            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`Geocoding API returned ${response.status}`);
                }
                const data = await response.json();

                // Validate response structure
                if (!data || typeof data !== 'object' || !data.address || typeof data.address !== 'object') {
                    // Invalid API response structure
                    return 'Unknown Location';
                }

                // Try to get city name from various fields (city, town, village, or state)
                return data.address.city ||
                       data.address.town ||
                       data.address.village ||
                       data.address.state ||
                       data.address.country ||
                       'Unknown Location';
            } catch (error) {
                // Failed to fetch city name
                return 'Unknown Location';
            }
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
            const multiplier = 330;
            const offset = 0.1;  // Prevents log of very small values
            const factor = 10;

            const particles = baseCount + multiplier * Math.log10((precipitationRate + offset) * factor);

            // Clamp between minimum and maximum values
            return Math.max(10, Math.min(1000, Math.round(particles)));
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

        // Fetch weather data from Open-Meteo API (No API key required)
        async function fetchWeatherData(lat, lon) {
            // Validate input coordinates
            if (!validateCoordinates(lat, lon)) {
                // Invalid coordinates (details hidden for security)
                return null;
            }

            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,cloud_cover,weathercode,windspeed_10m,precipitation&daily=sunrise,sunset&timezone=auto&temperature_unit=celsius&windspeed_unit=kmh`;

            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`Weather API returned ${response.status}`);
                }
                const data = await response.json();

                // Validate response structure
                if (!data || typeof data !== 'object') {
                    throw new Error('Invalid weather API response structure');
                }
                if (!data.current || typeof data.current !== 'object') {
                    throw new Error('Missing current weather data');
                }
                if (!data.daily || !Array.isArray(data.daily.sunrise) || !Array.isArray(data.daily.sunset)) {
                    throw new Error('Missing daily weather data');
                }

                // Extract cloud cover from current object
                let cloudCover = 0;
                if (data.current.cloud_cover !== undefined) {
                    cloudCover = data.current.cloud_cover;
                }

                return {
                    condition: mapWeatherCode(data.current.weathercode),
                    temp: data.current.temperature_2m,
                    windSpeed: data.current.windspeed_10m, // 風速 (km/h)
                    cloudCover: cloudCover, // 雲量 (0-100%)
                    precipitation: data.current.precipitation || 0, // 降水量 (mm/h)
                    sunrise: data.daily.sunrise[0],
                    sunset: data.daily.sunset[0],
                    moonPhase: calculateMoonPhase() // ユリウス日を使った計算 (0.00:新月 -> 0.50:満月 -> 1.00:新月)
                };
            } catch (error) {
                // Failed to fetch weather data
                return null;
            }
        }

        // Format time from ISO string (e.g., "2025-12-20T06:30" -> "06:30")
        function formatTime(isoString) {
            if (!isoString) return '--:--';
            const date = new Date(isoString);
            return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
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

        // Initialize weather system
        // Track last weather update to prevent duplicate updates
        let lastWeatherUpdate = { date: null, hour: null };

        async function initWeather() {
            try {
                const coords = await fetchUserLocation();
                weatherState.coords = coords;

                // Get city name and weather data in parallel
                const [cityName, weather] = await Promise.all([
                    getCityName(coords.lat, coords.lon),
                    fetchWeatherData(coords.lat, coords.lon)
                ]);

                weatherState.city = cityName;

                if (weather) {
                    weatherState.condition = weather.condition;
                    weatherState.temp = weather.temp;
                    weatherState.windSpeed = weather.windSpeed;
                    weatherState.cloudCover = weather.cloudCover;
                    weatherState.precipitation = weather.precipitation;
                    weatherState.moonPhase = weather.moonPhase;
                    weatherState.sunrise = weather.sunrise;
                    weatherState.sunset = weather.sunset;


                    // Update UI
                    document.getElementById('weather-location').textContent = cityName.toUpperCase();
                    document.getElementById('weather-temp').textContent = `${Math.round(weather.temp)}°C`;
                    document.getElementById('weather-desc').textContent = weather.condition;
                    document.getElementById('sun-times').textContent = `☀️ ${formatTime(weather.sunrise)} | 🌙 ${formatTime(weather.sunset)}`;

                    // Fade in weather display
                    document.getElementById('weather-display').style.opacity = '1';

                    // Update background immediately
                    const now = new Date();
                    updateTimeOfDay(now.getHours(), now.getMinutes());

                    // NEW: Initialize weather effects (clouds, lightning, and particles)
                    updateWeatherEffects();

                    // Record initial update time
                    lastWeatherUpdate = { date: now.toDateString(), hour: now.getHours() };
                }
            } catch (error) {
                // Weather initialization failed
            }
        }

        // Update weather data (for scheduled updates)
        async function updateWeather() {
            try {
                const coords = weatherState.coords;
                const weather = await fetchWeatherData(coords.lat, coords.lon);

                if (weather) {
                    weatherState.condition = weather.condition;
                    weatherState.temp = weather.temp;
                    weatherState.windSpeed = weather.windSpeed;
                    weatherState.cloudCover = weather.cloudCover;
                    weatherState.precipitation = weather.precipitation;
                    weatherState.moonPhase = weather.moonPhase;
                    weatherState.sunrise = weather.sunrise;
                    weatherState.sunset = weather.sunset;


                    // Update UI
                    document.getElementById('weather-temp').textContent = `${Math.round(weather.temp)}°C`;
                    document.getElementById('weather-desc').textContent = weather.condition;
                    document.getElementById('sun-times').textContent = `☀️ ${formatTime(weather.sunrise)} | 🌙 ${formatTime(weather.sunset)}`;

                    // Update weather-dependent visuals
                    updateWeatherEffects();

                    // Record update time
                    const now = new Date();
                    lastWeatherUpdate.date = now.toDateString();
                    lastWeatherUpdate.hour = now.getHours();
                }
            } catch (error) {
                // Failed to update weather
            }
        }

        // Check if weather should be updated (at 7:00 and 18:00)
        function checkWeatherUpdate() {
            const now = new Date();
            const currentHour = now.getHours();
            const currentDate = now.toDateString();

            // Update at 7:00 and 18:00
            if ((currentHour === 7 || currentHour === 18)) {
                // Prevent duplicate updates within the same hour
                if (lastWeatherUpdate.date !== currentDate || lastWeatherUpdate.hour !== currentHour) {
                    updateWeather();
                }
            }
        }

        // Start weather update checker (runs every minute)
        setInterval(checkWeatherUpdate, 60000); // Check every 60 seconds


        // --- 2. Clock Logic + Time of Day System ---
        let isAnalogClock = false;

        function updateClock() {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
            const dateOptions = { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' };
            const dateStr = now.toLocaleDateString('en-US', dateOptions);

            document.getElementById('time').textContent = timeStr;
            document.getElementById('date').textContent = dateStr;

            // アナログ時計の針を更新
            if (isAnalogClock) {
                updateAnalogClock(now);
            }

            // 時間帯に応じた背景を更新
            updateTimeOfDay(now.getHours(), now.getMinutes());
            // 太陽・月の位置を更新
            updateCelestialBody(now.getHours(), now.getMinutes());
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
                    // Blue tint and reduce brightness
                    adjusted1 = applyTint(rgb1, {r: -20, g: -10, b: 20}, 0.85);
                    adjusted2 = applyTint(rgb2, {r: -20, g: -10, b: 20}, 0.85);
                    adjusted3 = applyTint(rgb3, {r: -20, g: -10, b: 20}, 0.85);
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
            const totalMinutes = hour * 60 + minute;

            // 実際の日の出・日の入り時刻から時間帯を計算
            let timeGradients;

            if (weatherState.sunrise && weatherState.sunset) {
                // 実際のデータがある場合、日の出・日の入り時刻を基準に計算
                const sunriseTime = new Date(weatherState.sunrise);
                const sunsetTime = new Date(weatherState.sunset);
                const sunriseMinutes = sunriseTime.getHours() * 60 + sunriseTime.getMinutes();
                const sunsetMinutes = sunsetTime.getHours() * 60 + sunsetTime.getMinutes();

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
                    { time: sunsetMinutes + 30, colors: ['#4c1d95', '#b91c1c', '#6b21a8'] },               // 日没 - 燃え尽きる情熱
                    { time: sunsetMinutes + 60, colors: ['#312e81', '#581c87', '#3b0764'] },               // 宵 - 深い紫の世界
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
                    { time: 19 * 60, colors: ['#4c1d95', '#b91c1c', '#6b21a8'] }, // 日没 - 燃え尽きる情熱
                    { time: 20 * 60, colors: ['#312e81', '#581c87', '#3b0764'] },    // 宵 - 深い紫の世界
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
                const screenHeight = window.innerHeight;
                const celestialRelativePos = celestialTop / screenHeight;

                // If celestial body is in the middle gradient zone (60%-80% from top), boost saturation
                if (celestialRelativePos >= 0.6 && celestialRelativePos <= 0.8) {
                    const rgb2 = parseRgb(color2);
                    const boostedRgb2 = adjustSaturation(rgb2, 1.1); // +10% saturation
                    color2 = `rgb(${Math.round(boostedRgb2[0])}, ${Math.round(boostedRgb2[1])}, ${Math.round(boostedRgb2[2])})`;
                }
            }

            // Apply weather color blending if available
            if (weatherState.condition) {
                [color1, color2, color3] = blendWeatherColors(color1, color2, color3, weatherState.condition);
            }

            // 演出1: グラデーションの比率を崩す - Gradient ratio adjustment (70% instead of 50%)
            const gradient = `linear-gradient(to bottom, ${color1} 0%, ${color2} 70%, ${color3} 100%)`;
            bgContainer.style.background = gradient;
        }

        // Calculate solar progress (0.0 = sunrise, 1.0 = sunset, -1 = night)
        function getSolarProgress() {
            const now = Date.now();
            const { sunrise, sunset } = weatherState;

            // If no data available yet, estimate based on time (6:00-18:00)
            if (!sunrise || !sunset) {
                const currentHour = new Date().getHours();
                const currentMinute = new Date().getMinutes();
                const timeInMinutes = currentHour * 60 + currentMinute;
                const sunriseMinutes = 6 * 60; // 6:00 AM
                const sunsetMinutes = 18 * 60; // 6:00 PM

                if (timeInMinutes >= sunriseMinutes && timeInMinutes <= sunsetMinutes) {
                    return (timeInMinutes - sunriseMinutes) / (sunsetMinutes - sunriseMinutes);
                } else {
                    return -1;
                }
            }

            const sunriseTime = new Date(sunrise).getTime();
            const sunsetTime = new Date(sunset).getTime();

            if (now >= sunriseTime && now <= sunsetTime) {
                // Daytime: 0.0 (sunrise) to 1.0 (sunset)
                return (now - sunriseTime) / (sunsetTime - sunriseTime);
            } else {
                // Night time
                return -1;
            }
        }

        // Check if it's nighttime based on actual sunrise/sunset times
        function isNighttime() {
            const { sunrise, sunset } = weatherState;

            // If no data available yet, use fixed time (20:00-05:00)
            if (!sunrise || !sunset) {
                const hour = new Date().getHours();
                return hour >= 20 || hour < 5;
            }

            const now = Date.now();
            const sunriseTime = new Date(sunrise).getTime();
            const sunsetTime = new Date(sunset).getTime();

            // Night is after sunset or before sunrise
            return now < sunriseTime || now > sunsetTime;
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
            const centerX = window.innerWidth / 2;
            const radiusX = window.innerWidth * 0.4;
            const radiusY = window.innerHeight * 0.5; // Large arc for high peak (30% from top at noon)

            if (solarProgress >= 0 && solarProgress <= 1.0) {
                // Daytime: Show sun (日中は常に太陽を表示)
                celestialBody.className = 'sun';

                // Sun movement: sunrise (left) → noon (top ~30% from top) → sunset (right)
                const angle = Math.PI * solarProgress; // 0 → π
                const x = centerX + Math.cos(Math.PI - angle) * radiusX - 40;
                const y = window.innerHeight * 0.8 - Math.sin(angle) * radiusY - 40; // Peak at 30% from top

                celestialBody.style.left = x + 'px';
                celestialBody.style.top = y + 'px';
                celestialBody.style.opacity = '1';
                celestialBody.innerHTML = ''; // 太陽は背景グラデーションとbox-shadowのみ

                // 時間帯による太陽の性格変化
                let sunSize, sunGradient, sunShadow, sunFilter, sunClipPath;
                const baseSize = 80; // デフォルトサイズ

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
                        sunClipPath = `inset(0 0 ${fadeProgress * 100}% 0 round 50%)`;
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
                celestialBody.style.boxShadow = sunShadow;
                celestialBody.style.filter = sunFilter;
                celestialBody.style.clipPath = sunClipPath;

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

                // Calculate moon progress based on time between sunset and next sunrise
                const now = Date.now();
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
                const y = window.innerHeight * 0.8 - Math.sin(angle) * radiusY - 40; // Peak at 30% from top

                celestialBody.style.left = x + 'px';
                celestialBody.style.top = y + 'px';
                celestialBody.style.opacity = '1';

                const phase = weatherState.moonPhase || 0.5;
    
                // 月の見た目を生成する関数
                celestialBody.innerHTML = getMoonSVG(phase);
                
                // 背景色と影をリセット（SVGで描くため、CSSの円は透明にする）
                celestialBody.style.background = 'transparent';
                celestialBody.style.boxShadow = 'none'; // CSSの影は消してSVGのglowを使う
            }
        }


        function getMoonSVG(phase) {
    // 数学的に正確な満ち欠け計算
    // 外側の半円と内側の半楕円を組み合わせる方法
    // phase: 0 = 新月, 0.5 = 満月, 1.0 = 新月

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
        return `<div style="width:80px; height:80px; border-radius:50%; border:1px solid rgba(255,255,255,0.1);"></div>`;
    }

    // 満月の場合（完全な円）
    if (Math.abs(phase - 0.5) < 0.02) {
        return `
        <div style="
            width: 80px;
            height: 80px;
            border-radius: 50%;
            overflow: hidden;
            box-shadow: 0 0 15px rgba(255, 255, 255, 0.3), 0 0 40px rgba(255, 255, 255, 0.15);
        ">
            <img src="moon.jpg" style="
                width: 100%;
                height: 100%;
                object-fit: cover;
            " />
        </div>`;
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

    return `
    <svg width="80" height="80" viewBox="0 0 80 80" style="filter: drop-shadow(0 0 8px rgba(255, 255, 255, 0.25)) drop-shadow(0 0 25px rgba(255, 255, 255, 0.12));">
        <defs>
            <clipPath id="${clipId}">
                <path d="${clipPath}" />
            </clipPath>
        </defs>
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
        resetIdleTimer();


        // --- 3. Particle System (Canvas) ---
        const canvas = document.getElementById('particle-canvas');
        const ctx = canvas.getContext('2d');

        // Cloud canvas (separate layer)
        const cloudCanvas = document.getElementById('cloud-canvas');
        const cloudCtx = cloudCanvas.getContext('2d');

        // Canvas size settings
        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            cloudCanvas.width = window.innerWidth;
            cloudCanvas.height = window.innerHeight;
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

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

            const centerX = canvas.width / 2;
            const canvasHeight = canvas.height;

            // Field of View settings
            // Vertical FOV: 0° (horizon/bottom) to 90° (zenith/top)
            const verticalFOV = 90;

            // Use a single scale for both axes to preserve aspect ratio
            // Scale is based on height to ensure bottom = horizon, top = zenith
            const scale = canvasHeight / verticalFOV;

            // Calculate horizontal FOV based on canvas width and same scale
            const horizontalFOV = canvas.width / scale;

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
            // Altitude 0° (horizon) → bottom of screen (canvasHeight)
            // Altitude 90° (zenith) → top of screen (0)
            const y = canvasHeight - (alt * scale);

            // Check if y is within canvas bounds (with small margin)
            if (y < -50 || y > canvasHeight + 50) {
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
                this.x = Math.random() * canvas.width;
                this.y = this.type === 'star' ? Math.random() * canvas.height : -10;
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

                    // Multi-layered twinkling speeds for complex patterns (same for all stars)
                    this.twinkleSpeed1 = Math.random() * 0.015 + 0.005; // Slow wave
                    this.twinkleSpeed2 = Math.random() * 0.03 + 0.01;   // Medium wave
                    this.twinkleSpeed3 = Math.random() * 0.05 + 0.02;   // Fast wave
                    this.twinklePhase1 = Math.random() * Math.PI * 2;
                    this.twinklePhase2 = Math.random() * Math.PI * 2;
                    this.twinklePhase3 = Math.random() * Math.PI * 2;

                    // Pulse effect (occasional bright flash)
                    this.pulseTimer = Math.random() * 500 + 300; // Next pulse in 3-8 seconds
                    this.isPulsing = false;
                    this.pulsePhase = 0;

                    // Shimmer effect
                    this.shimmerOffset = Math.random() * Math.PI * 2;
                    this.shimmerSpeed = Math.random() * 0.02 + 0.01;
                } else {
                    this.twinkleSpeed = Math.random() * 0.02 + 0.01;
                    this.twinklePhase = Math.random() * Math.PI * 2;
                }

                // Shooting star initialization
                if (this.type === 'shootingStar') {
                    this.x = Math.random() * canvas.width * 0.8 + canvas.width * 0.2;
                    this.y = Math.random() * canvas.height * 0.3;
                    this.speedX = -(Math.random() * 8 + 6);
                    this.speedY = Math.random() * 4 + 3;
                    this.size = Math.random() * 1.5 + 1;
                    this.opacity = 1;
                    this.tailLength = Math.random() * 60 + 40;
                    this.life = 1;
                }

                // Rain initialization - wider distribution and faster fall
                if (this.type === 'rain') {
                    // Wider spawn area (beyond screen edges for wind effect)
                    this.x = Math.random() * (canvas.width + 400) - 200; // -200 to width+200
                    this.y = Math.random() * canvas.height - canvas.height * 0.3; // Staggered start positions
                    this.speedY = Math.random() * 8 + 12; // Much faster fall (12-20)
                    this.speedX = Math.random() * 2 - 1; // Wider horizontal range (-1 to 1)
                    this.size = Math.random() * 1.5 + 0.5; // Thin rain streaks
                    this.opacity = Math.random() * 0.4 + 0.4; // 0.4-0.8
                    this.length = Math.random() * 15 + 10; // Rain streak length
                }

                // Snow initialization
                if (this.type === 'snow') {
                    this.speedY = Math.random() * 0.8 + 0.3; // Slower fall
                    this.speedX = Math.random() * 0.3 - 0.15; // Gentle horizontal drift
                    this.size = Math.random() * 3 + 2; // Slightly larger
                    this.opacity = Math.random() * 0.6 + 0.4;
                    this.driftOffset = Math.random() * Math.PI * 2; // For sine wave
                    this.driftSpeed = Math.random() * 0.02 + 0.01;
                }
            }

            update() {
                if (this.type === 'star') {
                    // Multi-layered twinkling for realistic effect
                    this.twinklePhase1 += this.twinkleSpeed1;
                    this.twinklePhase2 += this.twinkleSpeed2;
                    this.twinklePhase3 += this.twinkleSpeed3;
                    this.shimmerOffset += this.shimmerSpeed;

                    // Reduce twinkle amplitude for bright stars to prevent excessive brightness
                    const brightnessAdjustment = this.baseBrightness > 0.8 ? 0.6 : 1.0;

                    // Combine multiple sine waves for complex twinkling pattern
                    const wave1 = Math.sin(this.twinklePhase1) * 0.3 * brightnessAdjustment;
                    const wave2 = Math.sin(this.twinklePhase2) * 0.2 * brightnessAdjustment;
                    const wave3 = Math.sin(this.twinklePhase3) * 0.15 * brightnessAdjustment;
                    const shimmer = Math.sin(this.shimmerOffset) * 0.1 * brightnessAdjustment;

                    // Base opacity with multi-wave modulation
                    let brightness = this.baseBrightness + wave1 + wave2 + wave3 + shimmer;

                    // Pulse effect (occasional bright flash) - also reduced for bright stars
                    this.pulseTimer--;
                    if (this.pulseTimer <= 0 && !this.isPulsing) {
                        this.isPulsing = true;
                        this.pulsePhase = 0;
                        this.pulseTimer = Math.random() * 500 + 300; // Reset timer for next pulse
                    }

                    if (this.isPulsing) {
                        this.pulsePhase += 0.08;
                        const pulseBrightness = Math.sin(this.pulsePhase) * 0.6 * brightnessAdjustment;
                        brightness += pulseBrightness;

                        if (this.pulsePhase >= Math.PI) {
                            this.isPulsing = false;
                        }
                    }

                    // Clamp brightness - slightly lower max for bright stars
                    const maxBrightness = this.baseBrightness > 0.85 ? 0.92 : 1.0;
                    this.opacity = Math.max(0.2, Math.min(maxBrightness, brightness));

                    // Size variation with twinkling (stars appear to pulsate)
                    this.currentSize = this.baseSize * (0.8 + this.opacity * 0.4);

                } else if (this.type === 'shootingStar') {
                    // Shooting star movement
                    this.x += this.speedX;
                    this.y += this.speedY;
                    this.life -= 0.008;
                    this.opacity = this.life;

                    // Remove when off-screen
                    if (this.life <= 0 || this.x < -100 || this.y > canvas.height + 100) {
                        return 'remove';
                    }
                } else if (this.type === 'snow') {
                    // Snow movement with drift
                    const windDrift = (weatherState.windSpeed || 0) * 0.05;

                    this.driftOffset += this.driftSpeed;
                    this.y += this.speedY;
                    
                    this.x += this.speedX + Math.sin(this.driftOffset) * 0.5 + windDrift;

                    if (this.y > canvas.height) this.reset();
                } else {
                    // Rain falling with wind effect
                    const windDrift = (weatherState.windSpeed || 0) * 0.3; // Increased wind influence

                    this.y += this.speedY;
                    this.x += this.speedX + windDrift;

                    // Reset if out of bounds (bottom or sides due to wind)
                    if (this.y > canvas.height || this.x < -300 || this.x > canvas.width + 300) {
                        // Create splash effect when hitting ground (not when blown off-screen)
                        if (this.y > canvas.height && Math.random() < 0.3) { // 30% chance to create splash
                            rainSplashes.push(new RainSplash(this.x, canvas.height - 5));
                        }
                        this.reset();
                    }
                }
            }

            draw() {
                ctx.save();

                // Apply cloud cover effect to star visibility
                if (this.type === 'star') {
                    // Calculate star visibility based on cloud cover
                    // 0% cloud = 100% visible, 100% cloud = 0-10% visible
                    const cloudCover = weatherState.cloudCover || 0;
                    const cloudCoverFactor = 1 - (cloudCover / 100) * 0.9; // Max 90% reduction
                    ctx.globalAlpha = this.opacity * Math.max(0.1, cloudCoverFactor);
                } else {
                    ctx.globalAlpha = this.opacity;
                }

                if (this.type === 'star') {
                    const { r, g, b } = this.starColor;
                    const size = this.currentSize || this.baseSize;

                    // Calculate glow multiplier based on magnitude (brighter stars = larger glow)
                    let glowMultiplier = 4; // Default glow size
                    if (this.magnitude !== undefined) {
                        // Bright stars (mag < 2) get enhanced glow
                        if (this.magnitude < 2) {
                            glowMultiplier = 6 + (2 - this.magnitude) * 1.5; // 6-10.5x for very bright stars
                        } else if (this.magnitude < 3) {
                            glowMultiplier = 5; // 5x for moderately bright stars
                        }
                    }

                    // Outer glow (larger, softer) - enhanced for bright stars
                    const glowGradient = ctx.createRadialGradient(
                        this.x, this.y, 0,
                        this.x, this.y, size * glowMultiplier
                    );
                    glowGradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${this.opacity * 0.9})`);
                    glowGradient.addColorStop(0.2, `rgba(${r}, ${g}, ${b}, ${this.opacity * 0.5})`);
                    glowGradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${this.opacity * 0.2})`);
                    glowGradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

                    ctx.fillStyle = glowGradient;
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, size * glowMultiplier, 0, Math.PI * 2);
                    ctx.fill();

                    // Core star (bright center)
                    const coreGradient = ctx.createRadialGradient(
                        this.x, this.y, 0,
                        this.x, this.y, size * 1.5
                    );
                    coreGradient.addColorStop(0, `rgba(255, 255, 255, ${this.opacity})`);
                    coreGradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${this.opacity * 0.9})`);
                    coreGradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${this.opacity * 0.4})`);

                    ctx.fillStyle = coreGradient;
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, size * 1.5, 0, Math.PI * 2);
                    ctx.fill();

                    // Bright center point
                    ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity * 0.9})`;
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, size * 0.5, 0, Math.PI * 2);
                    ctx.fill();

                    // Cross sparkle effect (for bright stars)
                    if (this.opacity > 0.7) {
                        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(this.opacity - 0.7) * 2})`;
                        ctx.lineWidth = 0.5;
                        ctx.beginPath();
                        // Vertical line
                        ctx.moveTo(this.x, this.y - size * 2);
                        ctx.lineTo(this.x, this.y + size * 2);
                        // Horizontal line
                        ctx.moveTo(this.x - size * 2, this.y);
                        ctx.lineTo(this.x + size * 2, this.y);
                        ctx.stroke();
                    }

                } else if (this.type === 'shootingStar') {
                    // Shooting star tail (gradient)
                    const gradient = ctx.createLinearGradient(
                        this.x, this.y,
                        this.x - this.speedX * 0.3, this.y - this.speedY * 0.3
                    );
                    gradient.addColorStop(0, 'rgba(255, 255, 255, ' + this.opacity + ')');
                    gradient.addColorStop(0.5, 'rgba(200, 220, 255, ' + (this.opacity * 0.5) + ')');
                    gradient.addColorStop(1, 'rgba(100, 150, 255, 0)');

                    // Draw tail
                    ctx.strokeStyle = gradient;
                    ctx.lineWidth = this.size * 2;
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.moveTo(this.x, this.y);
                    ctx.lineTo(this.x - this.speedX * 0.3, this.y - this.speedY * 0.3);
                    ctx.stroke();

                    // Draw head (bright dot)
                    ctx.shadowBlur = 15;
                    ctx.shadowColor = 'rgba(255, 255, 255, ' + this.opacity + ')';
                    ctx.fillStyle = '#ffffff';
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, this.size * 1.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                } else if (this.type === 'snow') {
                    // Snow - white circle with glow
                    ctx.shadowBlur = 8;
                    ctx.shadowColor = 'rgba(255, 255, 255, ' + (this.opacity * 0.8) + ')';
                    ctx.fillStyle = '#ffffff';
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                } else if (this.type === 'rain') {
                    // Teardrop shape (realistic falling droplet)
                    const windDrift = (weatherState.windSpeed || 0) * 0.3;
                    const dropletLength = (this.speedY * 0.6) + 3; // Length of teardrop
                    const dropletWidth = this.size * 1.8; // Width at widest point

                    // Calculate end point with wind effect
                    const endX = this.x + this.speedX * 0.3 + windDrift;
                    const endY = this.y + dropletLength;

                    // Create teardrop shape using bezier curves
                    ctx.beginPath();

                    // Start at top (pointed tip)
                    ctx.moveTo(this.x, this.y);

                    // Right curve (top to widest point)
                    const rightControlX1 = this.x + dropletWidth * 0.4;
                    const rightControlY1 = this.y + dropletLength * 0.2;
                    const rightControlX2 = endX + dropletWidth * 0.5;
                    const rightControlY2 = endY - dropletLength * 0.3;
                    ctx.bezierCurveTo(rightControlX1, rightControlY1, rightControlX2, rightControlY2, endX + dropletWidth * 0.4, endY);

                    // Bottom curve (rounded bottom)
                    ctx.quadraticCurveTo(endX, endY + dropletLength * 0.05, endX - dropletWidth * 0.4, endY);

                    // Left curve (widest point back to top)
                    const leftControlX1 = endX - dropletWidth * 0.5;
                    const leftControlY1 = endY - dropletLength * 0.3;
                    const leftControlX2 = this.x - dropletWidth * 0.4;
                    const leftControlY2 = this.y + dropletLength * 0.2;
                    ctx.bezierCurveTo(leftControlX1, leftControlY1, leftControlX2, leftControlY2, this.x, this.y);

                    // Fill with gradient
                    const gradient = ctx.createLinearGradient(this.x, this.y, endX, endY);
                    gradient.addColorStop(0, 'rgba(136, 192, 208, 0.15)');   // Transparent top
                    gradient.addColorStop(0.3, 'rgba(136, 192, 208, 0.35)'); // Semi-transparent middle
                    gradient.addColorStop(1, 'rgba(136, 192, 208, 0.55)');   // More opaque bottom

                    ctx.fillStyle = gradient;
                    ctx.fill();

                    // Add subtle outline for definition
                    ctx.strokeStyle = 'rgba(136, 192, 208, 0.25)';
                    ctx.lineWidth = 0.3;
                    ctx.stroke();

                    // Add highlight for more realism (light reflection)
                    const highlightGradient = ctx.createRadialGradient(
                        this.x + dropletWidth * 0.15, this.y + dropletLength * 0.4, 0,
                        this.x + dropletWidth * 0.15, this.y + dropletLength * 0.4, dropletWidth * 0.6
                    );
                    highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
                    highlightGradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.1)');
                    highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

                    ctx.fillStyle = highlightGradient;
                    ctx.beginPath();
                    ctx.ellipse(
                        this.x + dropletWidth * 0.15,
                        this.y + dropletLength * 0.4,
                        dropletWidth * 0.3,
                        dropletLength * 0.25,
                        Math.PI * 0.1,
                        0,
                        Math.PI * 2
                    );
                    ctx.fill();
                }

                ctx.restore();
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

            update() {
                this.lifetime++;

                // Physics: Projectile motion with gravity
                // x(t) = x₀ + vₓ * t
                // y(t) = y₀ + vᵧ * t + 0.5 * g * t²
                this.x += this.vx;
                this.y += this.vy;

                // Apply gravity to vertical velocity
                // vᵧ(t) = v₀ᵧ + g * t
                this.vy += this.gravity;

                // Apply air resistance (damping)
                this.vx *= this.damping;
                this.vy *= this.damping;

                // Ground collision detection and bounce
                if (this.y >= canvas.height - 5) {
                    this.y = canvas.height - 5;

                    if (this.bounces < this.maxBounces && Math.abs(this.vy) > 0.5) {
                        // Bounce: reverse vertical velocity with energy loss
                        this.vy *= -this.restitution;
                        this.bounces++;
                    } else {
                        // Stop bouncing, slide to halt
                        this.vy = 0;
                        this.vx *= 0.9; // Friction
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
                ctx.save();
                ctx.globalAlpha = this.opacity;

                // Draw droplet with motion blur
                const gradient = ctx.createRadialGradient(
                    this.x, this.y, 0,
                    this.x, this.y, this.size * 2
                );
                gradient.addColorStop(0, 'rgba(136, 192, 208, 1)');
                gradient.addColorStop(0.5, 'rgba(136, 192, 208, 0.6)');
                gradient.addColorStop(1, 'rgba(136, 192, 208, 0)');

                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.size * 2, 0, Math.PI * 2);
                ctx.fill();

                ctx.restore();
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
                const dropletCount = Math.floor(Math.random() * 5) + 4; // 4-8 droplets

                for (let i = 0; i < dropletCount; i++) {
                    // Angle: mostly upward and outward (60-120 degrees)
                    const angle = -Math.PI * 0.7 + (Math.random() - 0.5) * Math.PI * 0.6;
                    // Speed: random initial velocity
                    const speed = Math.random() * 3 + 2; // 2-5 px/frame

                    this.droplets.push(new SplashDroplet(x, y, angle, speed));
                }
            }

            update() {
                this.lifetime++;

                // Expand ripple with easing (fast start, slow end)
                const progress = this.lifetime / this.maxLifetime;
                const easeOut = 1 - Math.pow(1 - progress, 3); // Cubic ease-out
                this.radius = this.maxRadius * easeOut;
                this.opacity = 0.9 * (1 - progress);

                // Update splash droplets
                this.droplets = this.droplets.filter(droplet => droplet.update() !== 'remove');

                return this.lifetime >= this.maxLifetime ? 'remove' : null;
            }

            draw() {
                ctx.save();

                // Draw expanding ripple
                ctx.globalAlpha = this.opacity;
                ctx.strokeStyle = '#aaddff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                ctx.stroke();

                // Inner ripple (secondary wave)
                if (this.lifetime > 3) {
                    ctx.globalAlpha = this.opacity * 0.6;
                    ctx.strokeStyle = '#88c0d0';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, this.radius * 0.6, 0, Math.PI * 2);
                    ctx.stroke();
                }

                ctx.restore();

                // Draw splash droplets
                this.droplets.forEach(droplet => droplet.draw());
            }
        }

        // Splash particles array
        let rainSplashes = [];

        // --- リアルな雲の「素材（ノイズテクスチャ）」を生成する関数 ---
        const cloudBrushCanvas = document.createElement('canvas');
        const cloudBrushCtx = cloudBrushCanvas.getContext('2d');
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
                this.x = Math.random() * (canvas.width * 2.5) - (canvas.width * 0.5);
                this.y = Math.random() * (canvas.height * 0.7); // Y軸範囲を拡大

                // パララックス速度（3層構造）
                if (layer === 0) {
                    this.speed = 0.05; // 遠景 - 遅い
                } else if (layer === 1) {
                    this.speed = 0.13; // 中景 - 中間（元のLayer 2の速度）
                } else if (layer === 2) {
                    this.speed = 0.40; // 近景 - 速い
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
                this.offscreenCanvas = document.createElement('canvas');
                this.offscreenCtx = this.offscreenCanvas.getContext('2d');

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
            }

            update() {
                const windEffect = (weatherState.windSpeed || 0) * 0.05;
                this.x += this.speed + windEffect;

                // 画面右端から出たら左端へ戻す（シームレスループ）
                if (this.x > canvas.width + 400) {
                    this.x = -400;
                    this.y = Math.random() * (canvas.height * 0.7);
                    // ランダムにミラーリングを変更
                    this.mirrored = Math.random() > 0.5;
                }
            }

            draw(ctx) {
                if (!this.image || !this.image.complete) return;

                // 画像サイズの検証
                if (!this.image.width || !this.image.height) return;

                // フィルター文字列を先に準備
                let filterStr = `brightness(${this.brightness}) contrast(${this.contrast}) saturate(${this.saturation || 1})`;
                if (this.blur) {
                    filterStr += ` blur(${this.blur}px)`;
                }

                // ブレンドモード決定（3層構造）
                let blendMode = 'screen';
                if (this.layer === 0) {
                    blendMode = 'screen'; // 遠景も光の反射として表現
                } else if (this.layer === 2) {
                    blendMode = 'soft-light'; // 近景
                }

                // 画像サイズ計算（ぼかし時のエッジ問題対策）
                let scaleAdjustment = 1.0;
                if (this.blur && this.blur > 0) {
                    scaleAdjustment = 1.0 + (this.blur * 0.01);
                }
                const imgWidth = this.image.width * this.scale * scaleAdjustment;
                const imgHeight = this.image.height * this.scale * scaleAdjustment;

                // === 通常の描画（1枚のみ） ===
                this.drawCloudWithEffects(ctx, this.x, this.y, imgWidth, imgHeight,
                    this.baseOpacity, blendMode, filterStr, this.rotation);
            }

            // 雲を各種エフェクト付きで描画するヘルパーメソッド
            drawCloudWithEffects(ctx, x, y, imgWidth, imgHeight, opacity, blendMode, filterStr, rotation) {
                ctx.save();

                // オフスクリーンキャンバスを再利用（パフォーマンス改善）
                const offscreen = this.offscreenCanvas;
                const offCtx = this.offscreenCtx;

                // 必要なサイズに調整
                offscreen.width = imgWidth * 2; // シームレス用に2倍
                offscreen.height = imgHeight;

                // キャンバスの状態をリセット（念のため）
                offCtx.globalCompositeOperation = 'source-over';
                offCtx.globalAlpha = 1.0;

                // === 1. 雲画像を描画 ===
                offCtx.filter = filterStr;
                offCtx.drawImage(this.image, 0, 0, imgWidth, imgHeight);
                offCtx.drawImage(this.image, imgWidth, 0, imgWidth, imgHeight); // シームレス用

                // === 2. 垂直方向の色調グラデーション（厚み表現） ===
                offCtx.globalCompositeOperation = 'overlay';
                const verticalGradient = offCtx.createLinearGradient(0, 0, 0, imgHeight);
                verticalGradient.addColorStop(0, 'rgba(200, 220, 255, 0.2)'); // 上部：ごく薄い青（夜空の環境光）
                verticalGradient.addColorStop(0.5, 'rgba(128, 128, 128, 0)'); // 中央：変化なし
                verticalGradient.addColorStop(1, 'rgba(15, 20, 40, 0.4)'); // 下部：深い紺（夜空に馴染む）
                offCtx.fillStyle = verticalGradient;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);

                // === 3. ソフトエッジ・マスク（放射状透過） ===
                // 雲の外側を緩やかに透過させて背景に自然に馴染ませる - 境界線を完全に消す
                offCtx.globalCompositeOperation = 'destination-in';
                const radialMask = offCtx.createRadialGradient(
                    imgWidth, imgHeight / 2, 0,
                    imgWidth, imgHeight / 2, imgWidth * 1.5  // 半径を大幅に拡大して柔らかく
                );
                radialMask.addColorStop(0, 'rgba(0, 0, 0, 1)');      // 中心：完全不透明
                radialMask.addColorStop(0.4, 'rgba(0, 0, 0, 0.7)');  // 40%地点から透明度を下げる
                radialMask.addColorStop(0.7, 'rgba(0, 0, 0, 0.2)');  // 70%地点：かなり薄く
                radialMask.addColorStop(1, 'rgba(0, 0, 0, 0)');      // 外側：完全透明
                offCtx.fillStyle = radialMask;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);

                // === 4. 矩形エッジの強制透過（画像の外枠を完全に消す） ===
                // 上下左右の端を強制的に透明にして矩形の境界を消す
                offCtx.globalCompositeOperation = 'destination-in';

                // 水平方向のマスク（左右の端を透明に）- 少し弱める
                const horizontalMask = offCtx.createLinearGradient(0, 0, imgWidth * 2, 0);
                horizontalMask.addColorStop(0, 'rgba(0, 0, 0, 0)');      // 左端：完全透明
                horizontalMask.addColorStop(0.28, 'rgba(0, 0, 0, 1)');   // 28%地点：不透明
                horizontalMask.addColorStop(0.72, 'rgba(0, 0, 0, 1)');   // 72%地点：不透明
                horizontalMask.addColorStop(1, 'rgba(0, 0, 0, 0)');      // 右端：完全透明
                offCtx.fillStyle = horizontalMask;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);

                // 垂直方向のマスク（上下の端を透明に）- 少し弱める
                const verticalMask = offCtx.createLinearGradient(0, 0, 0, imgHeight);
                verticalMask.addColorStop(0, 'rgba(0, 0, 0, 0)');        // 上端：完全透明
                verticalMask.addColorStop(0.32, 'rgba(0, 0, 0, 1)');     // 32%地点：不透明
                verticalMask.addColorStop(0.68, 'rgba(0, 0, 0, 1)');     // 68%地点：不透明
                verticalMask.addColorStop(1, 'rgba(0, 0, 0, 0)');        // 下端：完全透明
                offCtx.fillStyle = verticalMask;
                offCtx.fillRect(0, 0, imgWidth * 2, imgHeight);

                // === 5. メインキャンバスに合成 ===
                ctx.globalAlpha = opacity;
                ctx.globalCompositeOperation = blendMode;
                ctx.translate(x, y);

                // ランダムな回転を適用
                ctx.rotate(rotation);

                if (this.mirrored) {
                    ctx.scale(-1, 1);
                }
                ctx.drawImage(offscreen, -imgWidth, -imgHeight / 2);

                ctx.restore();
            }
        }

        // Sun Halo Manager - 日暈（太陽の周りの光の輪）
        const sunHaloManager = {
            active: false,
            sunX: 0,
            sunY: 0,
            sunRadius: 40, // 太陽のサイズ（CSS変数 --celestial-body-size の半分）
            lastCloudCheckTime: 0, // 最後に雲チェックした時間（ミリ秒）
            cachedCloudOverlapBonus: 0, // キャッシュされた雲のボーナス値
            cloudCheckInterval: 600000, // 10分 = 600,000ミリ秒

            // 日暈の出現条件をチェック
            checkConditions() {
                const solarProgress = getSolarProgress();
                const cloudCover = weatherState.cloudCover || 0;
                const condition = weatherState.condition || '';

                // 条件1: 日中である（太陽が出ている）
                const isDaytime = solarProgress >= 0.1 && solarProgress <= 0.9;

                // 条件2: 天候が適切（晴れまたは曇り）
                const isValidWeather = condition === 'Clear' || condition === 'Clouds';

                // 条件3: 雲量が適切（20-50%）
                const isValidCloudCover = cloudCover >= 20 && cloudCover <= 50;

                this.active = isDaytime && isValidWeather && isValidCloudCover;
                return this.active;
            },

            // 太陽の位置を更新
            updateSunPosition() {
                const solarProgress = getSolarProgress();
                if (solarProgress >= 0 && solarProgress <= 1) {
                    const centerX = window.innerWidth / 2;
                    const radiusX = window.innerWidth * 0.4;
                    const radiusY = window.innerHeight * 0.5;

                    const angle = Math.PI * solarProgress;
                    this.sunX = centerX + Math.cos(Math.PI - angle) * radiusX;
                    this.sunY = window.innerHeight * 0.8 - Math.sin(angle) * radiusY;
                }
            },

            // 日暈を描画
            drawHalo(ctx) {
                if (!this.active) return;

                ctx.save();

                // 高度な演出1: 時間による色の強調（朝夕は少し濃く）
                const solarProgress = getSolarProgress();
                let intensityMultiplier = 1.0;

                // 朝（0.1-0.3）と夕方（0.7-0.9）で色を強調
                if (solarProgress < 0.3) {
                    intensityMultiplier = 1.3;
                } else if (solarProgress > 0.7) {
                    intensityMultiplier = 1.3;
                }

                // 高度な演出2: 雲との重なりをチェック（個々の雲の位置を確認）
                // 軽量化: 10分に1回だけチェック、それ以外はキャッシュを使用
                let cloudOverlapBonus = 0;
                const currentTime = Date.now();
                const timeSinceLastCheck = currentTime - this.lastCloudCheckTime;

                if (timeSinceLastCheck >= this.cloudCheckInterval) {
                    // 10分経過したので雲チェックを実行
                    let nearbyCloudCount = 0;
                    const detectionRadius = this.sunRadius * 6; // 日暈の範囲内

                    // 雲レイヤーをチェック（軽量化: Layer 0スキップ、1つおきにサンプリング）
                    // Layer 0（遠景）は日暈への影響が少ないためスキップ
                    for (let layerIndex = 1; layerIndex < cloudManager.layers.length; layerIndex++) {
                        const layer = cloudManager.layers[layerIndex];
                        // 1つおきにチェック（サンプリング）
                        for (let i = 0; i < layer.length; i += 2) {
                            const cloud = layer[i];
                            const dx = cloud.x - this.sunX;
                            const dy = cloud.y - this.sunY;
                            const distance = Math.sqrt(dx * dx + dy * dy);

                            // 太陽の近くに雲がある場合
                            if (distance < detectionRadius) {
                                nearbyCloudCount++;
                            }
                        }
                    }

                    // 近くの雲の数に応じてボーナス（最大0.1まで）
                    cloudOverlapBonus = Math.min(0.1, nearbyCloudCount * 0.02);

                    // キャッシュを更新
                    this.cachedCloudOverlapBonus = cloudOverlapBonus;
                    this.lastCloudCheckTime = currentTime;
                } else {
                    // 10分経過していないのでキャッシュを使用
                    cloudOverlapBonus = this.cachedCloudOverlapBonus;
                }

                // 基本の透明度 15% + ボーナス
                const baseOpacity = (0.15 + cloudOverlapBonus) * intensityMultiplier;

                // 日暈の半径（太陽の5倍）
                const haloRadius = this.sunRadius * 5;
                const ringWidth = this.sunRadius * 1.5; // リングの幅

                // === ドラマチック演出1: 内側の暗闇 ===
                // 日暈の内側（太陽と虹色の輪の間）を暗く設定
                const innerDarkness = ctx.createRadialGradient(
                    this.sunX, this.sunY, this.sunRadius * 1.2,
                    this.sunX, this.sunY, haloRadius - ringWidth * 0.5
                );
                innerDarkness.addColorStop(0, 'rgba(0, 0, 30, 0)');         // 中心は透明
                innerDarkness.addColorStop(0.3, 'rgba(0, 0, 40, 0.15)');    // 暗い紺色
                innerDarkness.addColorStop(0.7, 'rgba(0, 0, 50, 0.25)');    // さらに暗く
                innerDarkness.addColorStop(1, 'rgba(0, 0, 60, 0.1)');       // 外側は薄く

                ctx.globalCompositeOperation = 'multiply';
                ctx.filter = 'blur(30px)';
                ctx.fillStyle = innerDarkness;
                ctx.beginPath();
                ctx.arc(this.sunX, this.sunY, haloRadius - ringWidth * 0.5, 0, Math.PI * 2);
                ctx.fill();

                // === ドラマチック演出2: 虹色の輪（不規則な輝き） ===
                // 虹色のグラデーション（内側が赤、外側が青）
                const gradient = ctx.createRadialGradient(
                    this.sunX, this.sunY, haloRadius - ringWidth,
                    this.sunX, this.sunY, haloRadius + ringWidth
                );

                // 雲と重なった部分の輝きを表現（ベースの透明度を調整）
                const brightnessBoost = 1.0 + cloudOverlapBonus * 2; // 雲が近いと最大1.2倍の輝き

                // 内側から外側への虹色グラデーション
                gradient.addColorStop(0, `rgba(255, 100, 100, 0)`);           // 透明
                gradient.addColorStop(0.3, `rgba(255, 150, 100, ${baseOpacity * 0.8 * brightnessBoost})`); // 赤っぽい
                gradient.addColorStop(0.4, `rgba(255, 220, 150, ${baseOpacity * brightnessBoost})`);       // オレンジ
                gradient.addColorStop(0.5, `rgba(255, 255, 200, ${baseOpacity * brightnessBoost})`);       // 黄色
                gradient.addColorStop(0.6, `rgba(200, 255, 200, ${baseOpacity * brightnessBoost})`);       // 緑
                gradient.addColorStop(0.7, `rgba(150, 200, 255, ${baseOpacity * 0.8 * brightnessBoost})`); // 青っぽい
                gradient.addColorStop(1, `rgba(150, 150, 255, 0)`);           // 透明

                // 合成モード: 光を足し合わせる
                ctx.globalCompositeOperation = 'screen';

                // ぼかし効果で境界を曖昧に
                ctx.filter = 'blur(20px)';

                // 日暈を描画
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(this.sunX, this.sunY, haloRadius + ringWidth, 0, Math.PI * 2);
                ctx.fill();

                ctx.restore();
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

                // Determine cloud count based on actual cloud cover data
                const cloudCover = weatherState.cloudCover || 0; // 0-100%
                let cloudCount;

                // Special cases for specific weather conditions
                if (weatherCondition === 'Mist' || weatherCondition === 'Fog') {
                    cloudCount = [0, 0, 0]; // No high clouds for fog
                } else if (weatherCondition === 'Thunderstorm') {
                    // Thunderstorm: dense, dark clouds (boost cloud count)
                    const baseCount = Math.floor(cloudCover * 0.08); // 軽量化のため削減
                    cloudCount = [
                        Math.max(5, baseCount),
                        Math.max(8, baseCount + 3),
                        Math.max(4, baseCount - 1)
                    ];
                } else {
                    // Use actual cloud cover percentage to determine count
                    // 0% = minimal clouds, 100% = maximum clouds
                    const totalClouds = Math.floor(cloudCover * 0.3); // 0-30 clouds max (軽量化)

                    // Layer distribution: 3層に分散（Layer 0, 2, 4相当）
                    cloudCount = [
                        Math.max(1, Math.floor(totalClouds * 0.30)), // Layer 0 (最奥・遠景) - 30%
                        Math.max(1, Math.floor(totalClouds * 0.40)), // Layer 2 (中央) - 40%
                        Math.max(1, Math.floor(totalClouds * 0.30))  // Layer 4 (最前・近景) - 30%
                    ];
                }

                // Create clouds for each layer
                for (let layer = 0; layer < 5; layer++) {
                    for (let i = 0; i < cloudCount[layer]; i++) {
                        this.layers[layer].push(new CloudParticle(layer, weatherCondition, this.forceCloudType));
                    }
                }

                this.initialized = true;
                const totalCloudCount = cloudCount.reduce((a, b) => a + b, 0);
                const typeInfo = this.forceCloudType ? ` (forced type: ${this.forceCloudType})` : '';
            },

            updateClouds() {
                if (!this.initialized) return;

                // Update all clouds in all layers
                for (let layer of this.layers) {
                    for (let cloud of layer) {
                        cloud.update();
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
                this.flashIntensity = 0.15; // Subtle flash

                // Generate lightning path
                if (type === 'ground') {
                    // Cloud-to-ground lightning
                    const startX = Math.random() * canvas.width;
                    const startY = Math.random() * canvas.height * 0.3;
                    const endX = startX + (Math.random() - 0.5) * 200;
                    const endY = canvas.height;
                    this.generateFractalPath(startX, startY, endX, endY, 0);
                } else {
                    // Cloud-to-cloud lightning
                    const startX = Math.random() * canvas.width * 0.5;
                    const startY = Math.random() * canvas.height * 0.2 + canvas.height * 0.1;
                    const endX = startX + 200 + Math.random() * 400;
                    const endY = startY + (Math.random() - 0.5) * 100;
                    this.generateFractalPath(startX, startY, endX, endY, 0);
                }
            }

            generateFractalPath(x1, y1, x2, y2, depth) {
                const maxDepth = 4; // Recursion depth

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

            update() {
                this.lifetime++;

                // Fade flash intensity
                if (this.lifetime > 2) {
                    this.flashIntensity *= 0.7;
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
                this.nextStrikeTime = Date.now() + (Math.random() * 600000 + 400000); // 400-1000s (6.7-16.7 min)
            },

            deactivate() {
                this.active = false;
                this.activeBolts = [];
            },

            update() {
                if (!this.active) return;

                const now = Date.now();

                // Check if time for new strike
                if (now >= this.nextStrikeTime && this.activeBolts.length === 0) {
                    this.createLightning();
                    this.nextStrikeTime = now + (Math.random() * 600000 + 400000); // 400-1000s (6.7-16.7 min)
                }

                // Update existing bolts
                for (let bolt of this.activeBolts) {
                    bolt.update();
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
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
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

        // Draw star labels for bright stars (mag ≤ 1.5)
        function drawStarLabels() {
            if (!showStarLabels || currentParticleType !== 'star' || catalogStars.length === 0) {
                return;
            }

            // Filter for bright stars with names (mag ≤ 1.5)
            const brightStars = catalogStars.filter(star => star.name && star.mag <= 1.5);

            ctx.save();
            ctx.font = '14px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
            ctx.shadowBlur = 8;

            for (const star of brightStars) {
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
        function createCatalogStars() {
            if (typeof HIPPARCOS_STARS === 'undefined' || !HIPPARCOS_STARS || HIPPARCOS_STARS.length === 0) {
                console.warn('HIPPARCOS_STARS not loaded. Falling back to random stars.');
                return null;
            }

            const now = new Date();
            const { lat, lon } = weatherState.coords;
            const lst = calculateLST(now, lon);

            const visibleStars = [];

            for (const starEntry of HIPPARCOS_STARS) {
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

            return visibleStars;
        }

        // Load and display catalog stars on night scenes
        function initializeCatalogStars() {
            const isNight = (() => {
                const hour = new Date().getHours();
                return hour >= 20 || hour < 5;
            })();

            if (!isNight) return;

            const now = Date.now();

            // Update star field every 60 seconds (Earth rotation is slow)
            if (now - lastStarUpdateTime < STAR_UPDATE_INTERVAL && catalogStars.length > 0) {
                return;
            }


            catalogStars = createCatalogStars();
            lastStarUpdateTime = now;

            if (catalogStars && catalogStars.length > 0) {

                // Clear existing particles and replace with catalog stars
                particles = [];
                currentParticleType = 'star';

                // Create Particle objects from catalog data
                for (const starData of catalogStars) {
                    const particle = new Particle('star');
                    particle.reset(starData);
                    particles.push(particle);
                }

            } else {
                // Fallback to random stars if catalog fails
                console.warn('No visible catalog stars. Using random stars.');
                createParticles('star', 800);
            }
        }

        function createParticles(type, count) {
            particles = [];
            currentParticleType = type;
            for (let i = 0; i < count; i++) {
                particles.push(new Particle(type));
            }
        }

        // Create initial particles - full starry sky
        createParticles('star', 800);

        // Shooting star management
        let lastShootingStarTime = Date.now();
        let nextShootingStarDelay = Math.random() * 200000 + 150000; // 150-350 seconds (2.5-6 minutes)

        // Animation loop - 15fps target (66.67ms per frame)
        let frameCount = 0;
        let lastFrameTime = performance.now();
        const targetFrameTime = 1000 / 15; // 15fps = 66.67ms per frame

        function animateParticles(currentTime) {
            requestAnimationFrame(animateParticles);

            // Calculate time since last frame
            const deltaTime = currentTime - lastFrameTime;

            // Skip frame if not enough time has passed (throttle to 15fps)
            if (deltaTime < targetFrameTime) {
                return;
            }

            // Update lastFrameTime (accounting for any extra time)
            lastFrameTime = currentTime - (deltaTime % targetFrameTime);

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            cloudCtx.clearRect(0, 0, cloudCanvas.width, cloudCanvas.height);

            // NEW: Update and draw sun halo (日暈) - before clouds so clouds pass over it
            sunHaloManager.checkConditions();
            sunHaloManager.updateSunPosition();
            sunHaloManager.drawHalo(cloudCtx);

            // NEW: Update cloud positions
            cloudManager.updateClouds();

            // NEW: Draw clouds on separate canvas (z-index 4, above moon/sun)
            cloudManager.drawClouds(cloudCtx);

            // EXISTING: Update and draw particles (filter out those that need removal)
            particles = particles.filter(particle => {
                const result = particle.update();
                if (result !== 'remove') {
                    particle.draw();
                    return true;
                }
                return false;
            });

            // Track frame count (for shooting star timing, etc.)
            frameCount++;

            // EXISTING: Add shooting stars randomly at night
            // Use actual sunrise/sunset times to determine nighttime
            if (isNighttime() && currentParticleType === 'star') {
                const now = Date.now();
                if (now - lastShootingStarTime > nextShootingStarDelay) {
                    particles.push(new Particle('shootingStar'));
                    lastShootingStarTime = now;
                    nextShootingStarDelay = Math.random() * 250000 + 150000; // Next: 150-400 seconds (2.5-6.5 minutes)
                }
            }

            // NEW: Update and draw rain splashes
            rainSplashes = rainSplashes.filter(splash => {
                const result = splash.update();
                if (result !== 'remove') {
                    splash.draw();
                    return true;
                }
                return false;
            });

            // NEW: Update and draw lightning (ON TOP of everything)
            if (lightningManager.active) {
                lightningManager.update();
                lightningManager.drawLightning(ctx);
            }

            // Draw star labels if enabled
            drawStarLabels();
        }

        // Start the animation loop
        animateParticles(performance.now());

        // Update particle type based on weather and time of day
        function updateParticleType(hour) {
            // Priority 1: Weather-based particles (if weather is available)
            if (weatherState.condition) {
                if (weatherState.condition === 'Rain' || weatherState.condition === 'Drizzle' || weatherState.condition === 'Thunderstorm') {
                    // Show rain particles for rainy weather (unless manual rain button overrides)
                    // AUDIO CONTROLS - Temporarily disabled for release
                    const rainButton = document.getElementById('btn-rain');
                    const rainButtonActive = rainButton ? rainButton.classList.contains('active') : false;

                    if (currentParticleType !== 'rain' && !rainButtonActive) {
                        // Calculate rain intensity based on actual precipitation rate (logarithmic scale)
                        let rainCount;

                        // If we have precipitation data, use it for realistic particle count
                        if (weatherState.precipitation > 0) {
                            rainCount = calculateRainParticles(weatherState.precipitation);
                        } else {
                            // Fallback: use weather condition if precipitation data unavailable
                            if (weatherState.condition === 'Drizzle') {
                                rainCount = 200; // Light drizzle
                            } else if (weatherState.condition === 'Thunderstorm') {
                                rainCount = 450; // Heavy rain during storm
                            } else {
                                rainCount = 350; // Moderate rain
                            }
                        }

                        createParticles('rain', rainCount);
                    }
                    return;
                } else if (weatherState.condition === 'Snow') {
                    // Show snow particles for snowy weather
                    if (currentParticleType !== 'snow') {
                        createParticles('snow', 120);
                    }
                    return;
                }
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
                if (currentParticleType !== 'none' && particles.length > 0 && currentParticleType !== 'rain') {
                    // Keep rain if manually activated (audio controls disabled for now)
                    // AUDIO CONTROLS - Temporarily disabled for release
                    // if (!document.getElementById('btn-rain').classList.contains('active')) {
                        particles = [];
                        currentParticleType = 'none';
                    // }
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

            // Sky cover overlay control (for rainy weather)
            const skyCoverOverlay = document.getElementById('sky-cover-overlay');
            if (condition === 'Rain' || condition === 'Drizzle' || condition === 'Thunderstorm') {
                // Fade in: thick clouds block the stars
                skyCoverOverlay.style.opacity = '0.9';
            } else if (condition === 'Clouds') {
                // Partially block the stars
                skyCoverOverlay.style.opacity = '0.3';
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

            // Update catalog stars if in night mode (refresh every 60 seconds)
            if (now.getHours() >= 20 || now.getHours() < 5) {
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
                dimmer: document.getElementById('dimmer-range').value
            };
            localStorage.setItem('ambientFlowSettings', JSON.stringify(settings));
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
                    createParticles('rain', 350); // Increased for continuous effect
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

        dimmerRange.addEventListener('input', (e) => {
            // Use slider value (0-0.9) as opacity
            // 0 = transparent (bright), 0.9 = almost black
            dimmerOverlay.style.opacity = e.target.value;
            saveSettings();
        });


        // --- 7. Restore Settings on Initial Load + Fetch Weather Data ---
        window.addEventListener('DOMContentLoaded', () => {
            // Initialize weather system
            initWeather();

            const saved = localStorage.getItem('ambientFlowSettings');
            if (saved) {
                try {
                    const s = JSON.parse(saved);

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
                    if (s.dimmer !== undefined && typeof s.dimmer === 'number' && s.dimmer >= 0 && s.dimmer <= 0.9) {
                        dimmerRange.value = s.dimmer;
                        dimmerOverlay.style.opacity = s.dimmer;
                    }
                } catch (error) {
                    // Failed to parse saved settings
                    // Clear corrupted data
                    localStorage.removeItem('ambientFlowSettings');
                }
            }
        });

        // Browser autoplay block workaround: Start active sounds on first click anywhere
        document.body.addEventListener('click', () => {
            if(bonfire.btn.classList.contains('active') && bonfire.audio.paused) bonfire.audio.play();
            if(rain.btn.classList.contains('active') && rain.audio.paused) rain.audio.play();
        }, { once: true });


        // --- 8. Wake Lock & Fullscreen ---
        const wakeLockBtn = document.getElementById('btn-wakelock');
        let wakeLock = null;

        async function toggleWakeLock() {
            if ('wakeLock' in navigator) {
                if (!wakeLock) {
                    try {
                        wakeLock = await navigator.wakeLock.request('screen');
                        wakeLockBtn.textContent = "Always On ON";
                        wakeLockBtn.classList.add('active');
                        wakeLock.addEventListener('release', () => {
                            wakeLock = null;
                            wakeLockBtn.textContent = "Always On OFF";
                            wakeLockBtn.classList.remove('active');
                        });
                    } catch (err) { /* WakeLock not supported or failed */ }
                } else {
                    wakeLock.release();
                    wakeLock = null;
                }
            }
        }
        wakeLockBtn.addEventListener('click', toggleWakeLock);

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
                if (weatherState.condition === 'Rain' || weatherState.condition === 'Drizzle') {
                }
            } else {
                soundBtn.classList.remove('active');
                rainAudio.pause();
            }
        });

        // 天気が変わった時にサウンドを制御する関数
        window.updateRainSound = function() {
            if (!soundEnabled) return;

            const isRaining = weatherState.condition === 'Rain' || weatherState.condition === 'Drizzle';

            if (isRaining && rainAudio.paused) {
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


        // --- 9. Pomodoro Timer ---
        let pomodoroInterval = null;
        let pomodoroSeconds = 25 * 60; // 25 minutes
        let pomodoroMode = 'work'; // 'work' or 'break'
        let pomodoroRunning = false;

        function updatePomodoroDisplay() {
            const minutes = Math.floor(pomodoroSeconds / 60);
            const seconds = pomodoroSeconds % 60;
            document.getElementById('pomodoro-time').textContent =
                `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        function startPomodoro() {
            if (pomodoroRunning) {
                // Stop
                clearInterval(pomodoroInterval);
                pomodoroRunning = false;
                document.getElementById('pomodoro-start').textContent = 'Start';
                document.getElementById('pomodoro-start').classList.remove('active');
            } else {
                // Start
                pomodoroRunning = true;
                document.getElementById('pomodoro-start').textContent = 'Stop';
                document.getElementById('pomodoro-start').classList.add('active');

                pomodoroInterval = setInterval(() => {
                    pomodoroSeconds--;
                    updatePomodoroDisplay();

                    if (pomodoroSeconds <= 0) {
                        // Timer complete
                        clearInterval(pomodoroInterval);
                        pomodoroRunning = false;
                        document.getElementById('pomodoro-start').textContent = 'Start';
                        document.getElementById('pomodoro-start').classList.remove('active');

                        // Notification
                        if (pomodoroMode === 'work') {
                            alert('Work session complete! Take a 5-minute break.');
                            pomodoroMode = 'break';
                            pomodoroSeconds = 5 * 60;
                            document.getElementById('pomodoro-status').textContent = 'Break time';
                        } else {
                            alert('Break complete! Start your next work session.');
                            pomodoroMode = 'work';
                            pomodoroSeconds = 25 * 60;
                            document.getElementById('pomodoro-status').textContent = 'Work time';
                        }
                        updatePomodoroDisplay();
                    }
                }, 1000);
            }
        }

        function resetPomodoro() {
            clearInterval(pomodoroInterval);
            pomodoroRunning = false;
            pomodoroMode = 'work';
            pomodoroSeconds = 25 * 60;
            document.getElementById('pomodoro-start').textContent = 'Start';
            document.getElementById('pomodoro-start').classList.remove('active');
            document.getElementById('pomodoro-status').textContent = 'Ready';
            updatePomodoroDisplay();
        }

        document.getElementById('pomodoro-start').addEventListener('click', startPomodoro);
        document.getElementById('pomodoro-reset').addEventListener('click', resetPomodoro);


        // --- 10. Alarm Function ---
        let alarmEnabled = false;
        let alarmChecked = false;
        let alarmInterval = null;

        function checkAlarm() {
            if (!alarmEnabled) return;

            const now = new Date();
            const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const alarmTime = document.getElementById('alarm-time').value;

            if (currentTime === alarmTime && !alarmChecked) {
                alarmChecked = true;
                alert('Alarm: The set time has been reached!');
                // Reset check after 1 minute
                setTimeout(() => { alarmChecked = false; }, 60000);
            }
        }

        document.getElementById('alarm-toggle').addEventListener('click', (e) => {
            alarmEnabled = !alarmEnabled;
            e.target.textContent = alarmEnabled ? 'OFF' : 'ON';
            e.target.classList.toggle('active', alarmEnabled);

            if (alarmEnabled) {
                // Clear existing interval before creating new one
                if (alarmInterval) {
                    clearInterval(alarmInterval);
                }
                alarmInterval = setInterval(checkAlarm, 10000); // 10秒ごとにチェック
            } else {
                // Clear interval when disabled
                if (alarmInterval) {
                    clearInterval(alarmInterval);
                    alarmInterval = null;
                }
            }
        });


        // --- 11. Keyboard Shortcuts ---
        let toolsPanelVisible = false;

        function toggleToolsPanel() {
            toolsPanelVisible = !toolsPanelVisible;
            document.getElementById('tools-panel').classList.toggle('visible', toolsPanelVisible);
        }

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


        // --- Developer Test Mode (Override System) ---

        // Override variables
        let weatherOverride = null;
        let timeOverride = null;
        let clockInterval = null;

        // Original Date object
        const OriginalDate = Date;

        // Override Date constructor for time simulation
        function createDateOverride() {
            return class extends OriginalDate {
                constructor(...args) {
                    if (args.length === 0 && timeOverride) {
                        // No arguments: return overridden time
                        super();
                        const base = new OriginalDate();
                        base.setHours(timeOverride.hours);
                        base.setMinutes(timeOverride.minutes);
                        base.setSeconds(timeOverride.seconds || 0);
                        return base;
                    }
                    super(...args);
                }

                static now() {
                    if (timeOverride) {
                        const base = new OriginalDate();
                        base.setHours(timeOverride.hours);
                        base.setMinutes(timeOverride.minutes);
                        base.setSeconds(timeOverride.seconds || 0);
                        return base.getTime();
                    }
                    return OriginalDate.now();
                }
            };
        }

