/**
 * Ambient Flow - Star Database
 * Based on Hipparcos Catalog (J2000.0 Epoch)
 * * Data Format: [RA(deg), Dec(deg), Mag, ColorHex]
 * RA: Right Ascension (0-360)
 * Dec: Declination (-90 to +90)
 * Mag: Apparent Magnitude (lower is brighter)
 * ColorHex: Spectral color approximation
 */

const HIPPARCOS_STARS = [
    // --- 1. First Magnitude Stars (The brightest beacons) ---
    [101.29, -16.72, -1.44, "#aabfff", "Sirius"], // Sirius (α CMa)
    [279.23, 38.78, 0.03, "#aabfff", "Vega"],   // Vega (α Lyr)
    [79.17, 45.99, 0.08, "#ffd2a1", "Capella"],    // Capella (α Aur)
    [213.92, 19.11, -0.05, "#ffcc6f", "Arcturus"],  // Arcturus (α Boo)
    [78.63, -8.20, 0.18, "#9bb0ff", "Rigel"],    // Rigel (β Ori)
    [114.83, 5.22, 0.40, "#fff4ea", "Procyon"],    // Procyon (α CMi)
    [88.79, 7.41, 0.45, "#ff9d9d", "Betelgeuse"],     // Betelgeuse (α Ori)
    [297.70, 8.87, 0.77, "#ffffff", "Altair"],    // Altair (α Aql)
    [68.98, 16.51, 0.87, "#ffcc6f", "Aldebaran"],    // Aldebaran (α Tau)
    [247.35, -26.43, 0.96, "#ff9d9d", "Antares"],  // Antares (α Sco)
    [201.30, -11.16, 0.98, "#aabfff", "Spica"],  // Spica (α Vir)
    [116.33, 28.03, 1.16, "#ffd2a1", "Pollux"],   // Pollux (β Gem)
    [344.41, -29.62, 1.17, "#ffffff", "Fomalhaut"],  // Fomalhaut (α PsA)
    [310.36, 45.28, 1.25, "#ffffff", "Deneb"],   // Deneb (α Cyg)
    [152.10, 11.97, 1.40, "#9bb0ff", "Regulus"],   // Regulus (α Leo)
    [154.99, 19.92, 2.0, "#ffd2a1"],    // Algieba (γ Leo)

    // --- 2. Second Magnitude Stars (Major Constellation Makers) ---
    // Ursa Minor (Little Dipper)
    [37.95, 89.26, 1.97, "#fff4ea"],    // Polaris (α UMi)
    [227.42, 74.15, 2.07, "#ffcc6f"],   // Kochab (β UMi)
    
    // Ursa Major (Big Dipper)
    [165.93, 61.75, 1.81, "#ffd2a1"],   // Dubhe
    [165.46, 56.38, 2.34, "#ffffff"],   // Merak
    [178.46, 53.69, 2.41, "#ffffff"],   // Phecda
    [183.86, 57.03, 3.32, "#ffffff"],   // Megrez
    [193.51, 55.96, 1.76, "#ffffff"],   // Alioth
    [200.98, 54.93, 2.23, "#ffffff"],   // Mizar
    [206.89, 49.31, 1.85, "#9bb0ff"],   // Alkaid

    // Cassiopeia
    [10.13, 56.54, 2.24, "#ffd2a1"],    // Schedar
    [2.30, 59.15, 2.28, "#f8f7ff"],     // Caph
    [14.18, 60.72, 2.15, "#9bb0ff"],    // Gamma Cas
    [21.45, 60.24, 2.68, "#aabfff"],    // Ruchbah
    [28.60, 63.67, 3.35, "#9bb0ff"],    // Segin

    // Orion
    [81.28, 6.35, 1.64, "#9bb0ff"],     // Bellatrix
    [84.05, -1.20, 1.69, "#9bb0ff"],    // Alnilam
    [85.19, -1.94, 1.74, "#9bb0ff"],    // Alnitak
    [83.00, -0.30, 2.25, "#9bb0ff"],    // Mintaka
    [86.94, -9.67, 2.07, "#9bb0ff"],    // Saiph

    // Gemini
    [113.65, 31.89, 1.58, "#ffffff"],   // Castor
    [98.10, 16.40, 1.93, "#ffffff"],    // Alhena

    // Taurus
    [81.57, 28.61, 1.65, "#9bb0ff"],    // Elnath

    // Andromeda / Pegasus (Great Square)
    [2.10, 29.09, 2.07, "#9bb0ff"],     // Alpheratz
    [17.43, 35.62, 2.07, "#ffcc6f"],    // Mirach
    [30.97, 42.33, 2.10, "#ffd2a1"],    // Almach
    [345.94, 28.08, 2.44, "#ff9d9d"],   // Scheat
    [346.19, 15.21, 2.49, "#9bb0ff"],   // Markab
    [2.87, 15.18, 2.83, "#9bb0ff"],     // Algenib
    [326.05, 9.88, 2.38, "#ffd2a1"],    // Enif

    // Cygnus / Lyra / Aquila
    [291.6, 51.7, 2.23, "#fff4ea"],     // Sadr
    [306.9, 49.8, 2.48, "#ffd2a1"],     // Gienah
    [293.1, 27.9, 3.05, "#ffd2a1"],     // Albireo
    [295.4, 10.6, 2.72, "#ffd2a1"],     // Tarazed

    // Others
    [226.95, 26.71, 2.22, "#ffffff"],   // Alphecca (Corona Borealis)
    [261.22, 52.31, 2.24, "#ffd2a1"],   // Eltanin (Draco)
    [262.69, 12.56, 2.07, "#ffffff"],   // Rasalhague (Ophiuchus)
    [177.26, 14.57, 2.14, "#ffffff"],   // Denebola (Leo)
    [31.79, 23.46, 2.01, "#ffd2a1"],    // Hamal (Aries)
    [47.04, 40.96, 2.09, "#9bb0ff"],    // Algol (Perseus)
    [51.08, 49.86, 1.79, "#fff4ea"],    // Mirfak (Perseus)
    [141.90, -8.66, 1.99, "#ffcc6f"],   // Alphard (Hydra)
    [192.90, 2.40, 2.80, "#fff4ea"],    // Porrima (Virgo)

    // --- 3. Third Magnitude Stars (Filling the Constellations) ---
    [108.7, 22.5, 3.50, "#ffd2a1"],     // Wasat
    [111.2, 24.4, 3.06, "#fff4ea"],     // Mebsuta
    [168.5, 15.4, 2.56, "#ffffff"],     // Zosma
    [190.2, 1.8, 2.85, "#ffd2a1"],      // Vindemiatrix
    [44.5, -40.3, 2.9, "#9bb0ff"],      // Mira
    [89.6, 37.2, 2.69, "#aabfff"],      // Menkalinan
    [86.4, 41.2, 3.19, "#ffd2a1"],      // Theta Aur
    [219.0, 27.0, 2.7, "#fff4ea"],      // Izar
    [319.6, 70.5, 2.45, "#ffffff"],     // Alderamin
    [334.6, 57.8, 3.23, "#9bb0ff"],     // Delta Cep
    [272.1, 51.5, 2.73, "#ffd2a1"],     // Rastaban
    [252.0, 14.3, 2.78, "#ffd2a1"],     // Kornephoros
    [248.1, 21.5, 3.14, "#aabfff"],     // Sarin
    [57.0, 55.9, 2.9, "#ffffff"],       // Gamma Per
    [58.0, 48.0, 3.0, "#9bb0ff"],       // Delta Per
    [185.0, -15.0, 2.58, "#9bb0ff"],    // Gienah (Corvus)
    [188.0, -20.0, 2.98, "#ffd2a1"],    // Kraz
    [282.5, 32.6, 3.25, "#9bb0ff"],     // Sheliak
    [284.2, 32.5, 3.25, "#aabfff"],     // Sulafat

    // Pleiades Cluster (M45) - Distinctive Cluster
    [56.8, 24.1, 2.85, "#9bb0ff"],      // Alcyone
    [56.0, 24.0, 3.62, "#9bb0ff"],      // Atlas
    [56.5, 23.9, 3.72, "#9bb0ff"],      // Electra
    [55.9, 23.8, 3.87, "#9bb0ff"],      // Maia
    [56.2, 23.8, 4.17, "#9bb0ff"],      // Merope
    [56.1, 24.2, 4.29, "#9bb0ff"],      // Taygeta

    // Hyades Cluster (Taurus Head)
    [65.4, 15.8, 3.6, "#ffd2a1"],
    [64.5, 15.6, 3.7, "#fff4ea"],
    [66.0, 15.4, 3.9, "#ffd2a1"],

    // --- 4. Fourth Magnitude Stars (Detailing) ---
    [347.0, 62.2, 3.4, "#ffcc6f"],      // Zeta Cep
    [221.2, 18.4, 3.5, "#ffffff"],      // Muphrid
    [170.0, 35.0, 3.7, "#ffd2a1"],      // Leo Minor
    [140.0, 15.0, 3.8, "#9bb0ff"],      // Cancer
    [10.0, 42.0, 3.6, "#ffd2a1"],       // Andromeda
    [15.0, 45.0, 3.8, "#ffffff"],       // Andromeda
    [273.1, -21.0, 2.82, "#ffd2a1"],    // Kaus Borealis
    [298.8, 6.4, 3.71, "#fff4ea"],      // Alshain
    [153.1, 19.8, 3.4, "#f8f7ff"],      // Leo shape
    [320.0, 5.0, 4.0, "#aabfff"],       // Aquarius
    [330.0, 35.0, 3.9, "#ffd2a1"],      // Lacerta

    // RA 0h-6h Fillers
    [5.0, 10.0, 4.2, "#ffffff"], [12.0, 60.0, 3.9, "#aabfff"], [18.0, 30.0, 4.1, "#ffd2a1"],
    [25.0, -5.0, 4.5, "#9bb0ff"], [33.0, 50.0, 4.0, "#fff4ea"], [40.0, 20.0, 4.3, "#ffffff"],
    [48.0, 70.0, 3.8, "#aabfff"], [55.0, 10.0, 4.4, "#ffd2a1"], [62.0, 40.0, 4.1, "#9bb0ff"],
    [70.0, -10.0, 4.5, "#fff4ea"], [75.0, 65.0, 3.7, "#ffffff"], [85.0, 30.0, 4.2, "#aabfff"],
    [92.0, 15.0, 4.0, "#ffd2a1"], [350.0, 55.0, 4.3, "#9bb0ff"], [358.0, 5.0, 4.1, "#fff4ea"],
    
    // RA 6h-12h Fillers
    [95.0, 50.0, 4.4, "#ffffff"], [105.0, 25.0, 4.2, "#aabfff"], [115.0, 60.0, 3.9, "#ffd2a1"],
    [125.0, 10.0, 4.5, "#9bb0ff"], [135.0, 40.0, 4.1, "#fff4ea"], [145.0, 75.0, 3.8, "#ffffff"],
    [155.0, 20.0, 4.3, "#aabfff"], [165.0, 55.0, 4.0, "#ffd2a1"], [175.0, 5.0, 4.4, "#9bb0ff"],
    [100.0, 80.0, 4.2, "#fff4ea"], [110.0, 35.0, 4.5, "#ffffff"], [120.0, 65.0, 3.9, "#aabfff"],
    [130.0, 15.0, 4.3, "#ffd2a1"], [140.0, 45.0, 4.1, "#9bb0ff"], [150.0, 85.0, 4.4, "#fff4ea"],
    
    // RA 12h-18h Fillers
    [185.0, 30.0, 4.2, "#ffffff"], [195.0, 60.0, 3.9, "#aabfff"], [205.0, 10.0, 4.5, "#ffd2a1"],
    [215.0, 40.0, 4.1, "#9bb0ff"], [225.0, 70.0, 3.8, "#fff4ea"], [235.0, 20.0, 4.3, "#ffffff"],
    [245.0, 50.0, 4.0, "#aabfff"], [255.0, 5.0, 4.4, "#ffd2a1"], [265.0, 35.0, 4.2, "#9bb0ff"],
    [190.0, 25.0, 4.5, "#fff4ea"], [200.0, 55.0, 4.1, "#ffffff"], [210.0, 80.0, 3.9, "#aabfff"],
    [220.0, 15.0, 4.3, "#ffd2a1"], [230.0, 45.0, 4.0, "#9bb0ff"], [240.0, 75.0, 4.4, "#fff4ea"],
    
    // RA 18h-24h Fillers
    [275.0, 20.0, 4.2, "#ffffff"], [285.0, 60.0, 3.8, "#aabfff"], [295.0, 10.0, 4.5, "#ffd2a1"],
    [305.0, 40.0, 4.1, "#9bb0ff"], [315.0, 70.0, 3.9, "#fff4ea"], [325.0, 25.0, 4.3, "#ffffff"],
    [335.0, 50.0, 4.0, "#aabfff"], [345.0, 5.0, 4.4, "#ffd2a1"], [355.0, 35.0, 4.2, "#9bb0ff"],
    [280.0, 30.0, 4.5, "#fff4ea"], [290.0, 65.0, 4.1, "#ffffff"], [300.0, 15.0, 3.9, "#aabfff"],
    [310.0, 55.0, 4.3, "#ffd2a1"], [320.0, 85.0, 4.0, "#9bb0ff"], [330.0, 10.0, 4.4, "#fff4ea"],

    // ペルセウス座二重星団 (Double Cluster - h & chi Persei)
    // 非常に星密度が高い美しいエリア (RA: ~35deg, Dec: ~57deg)
    [33.0, 56.5, 4.3, "#aabfff"], [33.2, 56.8, 4.4, "#ffffff"], [33.5, 56.6, 4.2, "#aabfff"],
    [34.8, 57.1, 4.3, "#ffffff"], [35.0, 57.3, 4.1, "#aabfff"], [35.2, 57.0, 4.5, "#9bb0ff"],
    [32.8, 56.3, 4.8, "#ffffff"], [33.8, 56.9, 4.9, "#aabfff"], [35.5, 57.5, 4.7, "#ffffff"],

    // かに座 プレセペ星団 (Beehive Cluster - M44)
    // (RA: ~130deg, Dec: ~19deg)
    [130.1, 19.6, 6.3, "#ffcc6f"], [130.0, 19.8, 6.4, "#ffffff"], [130.3, 19.5, 6.2, "#aabfff"],
    [129.8, 19.7, 6.5, "#ffd2a1"], [130.5, 19.9, 6.3, "#ffffff"], [129.5, 20.0, 6.6, "#aabfff"],
    
    // かみのけ座散開星団 (Coma Star Cluster - Mel 111)
    // (RA: ~186deg, Dec: ~26deg) - まばらだが明るい星団
    [185.0, 26.0, 4.8, "#ffffff"], [186.5, 25.5, 4.7, "#aabfff"], [187.0, 26.8, 4.9, "#ffffff"],
    [184.5, 26.5, 5.0, "#aabfff"], [183.0, 25.0, 4.6, "#ffd2a1"], [188.0, 27.0, 5.1, "#9bb0ff"],

    // さそり座 トレミー星団 (M7) & 蝶々星団 (M6) - 夏の南の低い空
    // (RA: ~265-270deg, Dec: ~-32deg)
    [268.5, -34.8, 3.3, "#ffffff"], [268.0, -34.5, 4.0, "#aabfff"], [269.0, -35.0, 4.5, "#ffffff"],
    [263.5, -32.2, 4.2, "#aabfff"], [264.0, -32.5, 4.5, "#ffffff"], [263.0, -32.0, 4.8, "#9bb0ff"]
];

/**
 * GENERATE MILKY WAY & FAINT STARS
 * This function creates ~600 faint stars (Mag 4.5 - 6.0) concentrated along the Galactic Plane.
 */
/**
 * GENERATE MILKY WAY & FAINT STARS (High Density)
 * 肉眼で見える限界の星（5〜6等星）を約2500個生成し、
 * 天の川に沿った高密度エリアと、空全体のランダムな星を組み合わせて配置します。
 */
(function generateRichStarField() {
    const totalFaintStars = 800; // 星の総数（描画時に200個に制限）
    
    // 星の色（スペクトル型に基づくリアルな色分布）
    const spectralColors = [
        "#aabfff", // O/B型 - 青白
        "#cad7ff", // A型 - 白青
        "#f8f7ff", // F型 - 白
        "#fff4ea", // G型 - 黄白
        "#ffd2a1", // K型 - 橙
        "#ffcc6f"  // M型 - 赤橙
    ];
    
    for (let i = 0; i < totalFaintStars; i++) {
        let ra, dec;
        
        // ★ここがポイント：確率で「天の川」か「普通の空」かを振り分ける
        
        if (Math.random() < 0.40) {
            // 【パターンA：天の川】 (全生成数の40%)
            // 特定のライン（銀河面）に沿って集中的に星を配置する
            ra = Math.random() * 360;
            // 銀河面のカーブを計算
            const galacticCenterDec = 62.6 * Math.cos((ra - 280) * Math.PI / 180) + 20;
            // 幅を持たせる
            const spread = (Math.random() + Math.random() - 1) * 25; 
            dec = galacticCenterDec + spread;
            
        } else {
            // 【パターンB：背景の星】 (残りの60%)
            // 空いている場所が寂しくならないよう、空全体に均等に散らす
            ra = Math.random() * 360;
            // 球面上に均等になる計算 (asin使用)
            dec = Math.asin(2 * Math.random() - 1) * (180 / Math.PI);
        }

        // 座標が範囲外に出ないように補正
        if (dec > 90) dec = 90;
        if (dec < -90) dec = -90;

        // 等級（明るさ）: 4.5等星 〜 6.5等星
        // Math.powを使うことで「暗い星」の方が出る確率を高くしてリアルにする
        const mag = 4.5 + Math.pow(Math.random(), 0.8) * 2.0;
        
        // 色をランダムに選択
        const color = spectralColors[Math.floor(Math.random() * spectralColors.length)];

        // 配列に追加
        HIPPARCOS_STARS.push([ra, dec, mag, color]);
    }
})();