# Ambient Clock

A beautiful, immersive ambient clock that visualizes real-time weather conditions and celestial movements. Experience the passage of time through dynamic skies, weather effects, and accurate astronomical displays.

## Features

### 🌤️ Real-Time Weather Integration
- Automatic location detection via browser geolocation
- Live weather data from Open-Meteo API
- Weather conditions: Clear, Cloudy, Rain, Snow, Thunderstorm, Mist
- Dynamic cloud rendering with 3-layer parallax system
- Realistic rain and snow particle effects
- Lightning system for thunderstorms

### ☀️ Celestial Bodies
- Accurate sun position based on sunrise/sunset times
- Realistic sun appearance changes throughout the day
- Moon phase visualization with SVG rendering
- Sun halo effects under specific atmospheric conditions

### 🌙 Time-Based Atmosphere
- Dynamic background gradients that change with time of day
- Star field with accurate positions from the HIPPARCOS catalog
- Smooth transitions between day and night
- Automatic particle type switching (stars → rain/snow)

### ⚙️ User Controls
- **Screen Dimmer**: Adjust brightness from 0-90%
- **Rain Sound**: Toggle rain audio for immersive experience
- **Clock Toggle**: Switch between digital and analog clock
- **Star Labels**: Display star names in night mode
- **Always On**: Prevent screen from sleeping
- **Pomodoro Timer**: Built-in 25-minute work timer
- **Alarm**: Set custom wake-up time

### 📱 Responsive Design
- Fully responsive across desktop, tablet, and mobile devices
- Optimized touch controls for mobile
- Adaptive UI scaling based on screen size

## Performance Optimizations

- **Adaptive quality**: Auto, High, and Eco modes in the tools panel. Auto adjusts after sustained rendering load, with a slower recovery to avoid quality flicker.
- **Independent layers**: Rain/snow target 15–30fps; clouds update at 3–8fps; stars at 4–8fps. Movement uses elapsed time, so changing quality does not change its speed.
- **Rain depth**: Three tiny shared streak sprites provide fine distant rain, faster midground streaks, and a few soft foreground drops. A silver/slate sky and broad light field provide illumination without per-frame blur. Drops recycle from outside the viewport and follow the real wind; dense overcast veils the sun/moon.
- **Cloud System**: Three shared, bounded cloud textures (about 2.2 MiB of RGBA pixels in total), a lower-resolution cloud canvas, and profile-based cloud counts including storms.
- **Efficient Rendering**: Canvas-based rendering with layer separation
- **Smart Caching**: Halo calculations cached for 10 minutes
- **Lazy Loading**: Resources loaded on demand
- **Background behavior**: Rendering stops while hidden and resumes with fresh viewport dimensions. Reduced-motion preferences limit movement and disable lightning flashes and shooting stars.
- **Weather refresh**: About 30 minutes, with jitter and retry/backoff. Concurrent refresh triggers share a single in-flight update.

### Visual previews and verification

Add `?preview=day`, `?preview=sunset`, `?preview=night`, `?preview=rain`, `?preview=snow`, or `?preview=storm` to the app URL. Previews use fixed local scene times and weather without location/API requests; the location label explicitly says Preview. Open the URL without this parameter for live conditions.

An optional browser smoke check covers all six scenes, cloud cache bounds, quality controls/adaptation, dimmer persistence, clock switching, frame-independent rain motion, background/resume, reduced motion, and rotation. It requires Node.js, Playwright, and an installed Google Chrome; these are development tools only, not app dependencies.

From the repository root, serve it with `python3 -m http.server 8765 --bind 127.0.0.1`, then run `node Ambient_clock/tests/browser-smoke.cjs` in another terminal with Playwright available to Node. `PLAYWRIGHT_MODULE` may point to an existing Playwright module, and `BROWSER_BASE_URL` may override the app URL. Screenshots are saved to a temporary directory printed by the check.

The checks do not establish battery use or performance on an actual older phone. Verify sustained use, temperature, and visual quality on target iOS/Android devices before treating those as release guarantees.

## Technologies Used

- **HTML5 Canvas**: For rendering clouds, particles, and effects
- **CSS3**: Modern animations and responsive design
- **Vanilla JavaScript**: No framework dependencies
- **Web APIs**:
  - Geolocation API
  - Wake Lock API
  - Fullscreen API

## APIs & Data Sources

- **Weather Data**: [Open-Meteo](https://open-meteo.com/) - Free weather forecast API
- **Geocoding**: [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/) - Reverse geocoding for location names
- **Star Data**: HIPPARCOS Catalog - Accurate star positions

## Installation

1. Clone or download this repository
2. Ensure all files are in the same directory:
   - `index.html`
   - `stars.js`
   - `cloud_far_1.png`
   - `cloud_main_1.png`
   - `cloud_near_1.png`
   - `moon.jpg`
   - `rain.mp3`
   - `favicon.ico`
   - `apple-touch-icon.png`

3. Open `index.html` in a modern web browser

**Note**: For full functionality, serve the files via a web server (not `file://` protocol) to avoid CORS restrictions.

## Browser Compatibility

- ✅ Chrome/Edge (Chromium-based) - Latest versions
- ✅ Firefox - Latest versions
- ✅ Safari - Latest versions (macOS/iOS)
- ⚠️ Internet Explorer - Not supported

## Usage

### First Launch
1. Allow location access when prompted (or it will default to Tokyo)
2. Wait for weather data to load
3. Enjoy the ambient experience!

### Keyboard Shortcuts
- **Space**: Toggle UI visibility
- **F**: Enter fullscreen mode
- **T**: Toggle tools panel (Pomodoro/Alarm)

### Controls
- **Speaker Icon** (🔊): Enable/disable rain sound
- **Light Bulb** (💡): Adjust screen brightness
- **Clock Icon** (🕐): Switch between digital/analog clock
- **Star Icon** (⭐): Show/hide star labels (night mode only)
- **Always On OFF/ON**: Toggle screen wake lock

## File Structure

```
Ambient_clock/
├── index.html           # Main application (176KB)
├── stars.js            # HIPPARCOS star catalog data (12KB)
├── cloud_far_1.png     # Background cloud layer (800KB)
├── cloud_main_1.png    # Middle cloud layer (512KB)
├── cloud_near_1.png    # Foreground cloud layer (512KB)
├── moon.jpg            # Moon texture (16KB)
├── rain.mp3            # Rain sound effect (1.4MB)
├── favicon.ico         # Browser favicon (15KB)
├── apple-touch-icon.png # iOS home screen icon (72KB)
└── README.md           # This file
```

**Total Size**: ~3.5MB

## Credits

### APIs & Services
- Weather data provided by [Open-Meteo](https://open-meteo.com/)
- Geocoding by [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/)
- Google Fonts: [Inter](https://fonts.google.com/specimen/Inter)

### Resources
- Star data from the HIPPARCOS Catalog (ESA)
- Cloud images: Custom generated
- Rain sound: Ambient rain recording

## License

MIT License

Copyright (c) 2025 Ambient Clock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Privacy

This application:
- Uses your location only to fetch weather data
- Does not store or transmit personal data
- Makes API requests to Open-Meteo and Nominatim
- Runs entirely in your browser
- No cookies or tracking

## Changelog

### Version 1.0.0 (2025-01-11)
- Initial release
- Real-time weather visualization
- Celestial body tracking
- 3-layer cloud system
- Performance optimizations
- User controls and customization

## Contributing

This is a personal project. If you'd like to suggest improvements or report issues, please feel free to fork and experiment!

## Acknowledgments

Special thanks to:
- Open-Meteo for providing free weather data
- OpenStreetMap contributors
- ESA for the HIPPARCOS star catalog
- The open-source community

---

**Enjoy the ambient experience!** 🌤️✨
