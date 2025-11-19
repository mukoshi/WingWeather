const express = require('express');
const fetch = require('node-fetch');
const ss = require('simple-statistics');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
}

// =================================================================
// 1. CONFIGURATION OBJECT
// =================================================================
const CONFIG = {
    api: {
        parameters: "T2M,PRECTOTCORR,WS2M,RH2M,SNODP",
        startDate: "20000101",
        endDate: "20241231"
    },
    analysis: {
        dayWindow: 2,
        weights: {
            targetDay: 4,
            neighborDay: 1
        }
    }
};

// =================================================================
// 2. HELPER FUNCTIONS (YARDIMCI FONKSİYONLAR) - Değişiklik yok
// =================================================================
function predictFutureValue(historicalPoints, targetYear) {
    if (!historicalPoints || historicalPoints.length < 2) return null;
    const line = ss.linearRegression(historicalPoints);
    const predictionFunction = ss.linearRegressionLine(line);
    return predictionFunction(targetYear);
}
function getHistoricalAverage(dataPoints) {
    if (!dataPoints || dataPoints.length === 0) return 0;
    return ss.mean(dataPoints);
}
function calculateClimateTrend(apiParams) {
    const yearlyAverages = {};
    for (const dateKey in apiParams.T2M) {
        const year = dateKey.substring(0, 4);
        if (!yearlyAverages[year]) {
            yearlyAverages[year] = [];
        }
        yearlyAverages[year].push(apiParams.T2M[dateKey]);
    }
    const annualAveragePoints = Object.keys(yearlyAverages).map(year => [parseInt(year), ss.mean(yearlyAverages[year])]);
    if (annualAveragePoints.length < 2) return null;
    const line = ss.linearRegression(annualAveragePoints);
    return line.m;
}
// --- GÜNCELLENEN FONKSİYON ---
function calculateDailyMetrics(apiParams, dateStr, targetYear) {
    const historical = { temp: [], wind: [], precip: [], humidity: [], snow: [] };
    
    // YENİ EKLENEN KISIM: Yağışlı günleri saymak için bir sayaç
    let rainyDayCount = 0;

    for (const dateKey in apiParams.T2M) {
        if (dateKey.substring(4, 8) === dateStr) {
            const year = parseInt(dateKey.substring(0, 4));
            
            const tempValue = apiParams.T2M[dateKey];
            if (tempValue > -999) historical.temp.push([year, tempValue]);

            const windValue = apiParams.WS2M[dateKey];
            if (windValue > -999) historical.wind.push([year, windValue]);

            const precipValue = apiParams.PRECTOTCORR[dateKey];
            if (precipValue > -999) {
                historical.precip.push(precipValue);
                // YENİ EKLENEN KISIM: Eğer yağış miktarı 0.1 mm'den fazlaysa, bunu yağışlı bir gün olarak say.
                // Bu küçük eşik değeri, çiseleme gibi önemsiz yağışları filtrelemek için kullanılabilir.
                if (precipValue > 0.1) {
                    rainyDayCount++;
                }
            }

            const humidityValue = apiParams.RH2M[dateKey];
            if (humidityValue > -999) historical.humidity.push(humidityValue);

            const snowValue = apiParams.SNODP[dateKey];
            if (snowValue > -999) historical.snow.push(snowValue);
        }
    }
    
    // YENİ EKLENEN KISIM: Yağış olasılığını hesapla
    // Toplam geçerli gün sayısı 0'dan fazlaysa, yağışlı gün sayısını toplam gün sayısına böl.
    const totalValidDays = historical.precip.length;
    const precipProbability = totalValidDays > 0 ? (rainyDayCount / totalValidDays) : 0;

    return {
        temp: predictFutureValue(historical.temp, targetYear),
        wind: predictFutureValue(historical.wind, targetYear),
        precipAmount: getHistoricalAverage(historical.precip),
        humidity: getHistoricalAverage(historical.humidity),
        snowDepth: getHistoricalAverage(historical.snow),
        precipProbability: precipProbability // Yeni olasılık verisini döndür
    };
}

// =================================================================
// 3. MAIN LOGIC (ANA İŞ MANTIĞI)
// =================================================================
app.post('/analyze-weather', async (req, res) => {
    try {
        const { latitude, longitude, month, day, targetYear } = req.body;

        // --- YENİ EKLENEN KONTROL BLOGU ---
        if (!latitude || !longitude || !month || !day || !targetYear) {
            return res.status(400).json({ error: 'Eksik parametreler: latitude, longitude, month, day ve targetYear gereklidir.' });
        }

        const lastDataYear = parseInt(CONFIG.api.endDate.substring(0, 4));
        if (targetYear <= lastDataYear) {
            return res.status(400).json({ error: `Geçersiz hedef yıl. Lütfen ${lastDataYear} yılından sonraki bir tarih seçin.` });
        }
        // --- KONTROL BLOGU SONU ---


        const lat_str = latitude.toFixed(2).replace('.', '_');
        const lon_str = longitude.toFixed(2).replace('.', '_');
        const cacheFileName = `data-${lat_str}_${lon_str}.json`;
        const cacheFilePath = path.join(cacheDir, cacheFileName);

        let nasaData;
        if (fs.existsSync(cacheFilePath)) {
            console.log(`[Cache Hit] ${cacheFileName} önbellekten okunuyor.`);
            const cachedData = fs.readFileSync(cacheFilePath, 'utf-8');
            nasaData = JSON.parse(cachedData);
        } else {
            console.log(`[Cache Miss] ${cacheFileName} için NASA API'sine istek atılıyor.`);
            const apiUrl = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=${CONFIG.api.parameters}&community=RE&longitude=${longitude}&latitude=${latitude}&start=${CONFIG.api.startDate}&end=${CONFIG.api.endDate}&format=JSON`;
            const nasaResponse = await fetch(apiUrl);
            if (!nasaResponse.ok) throw new Error(`NASA API hatası: ${nasaResponse.statusText}`);
            nasaData = await nasaResponse.json();
            fs.writeFileSync(cacheFilePath, JSON.stringify(nasaData, null, 2));
            console.log(`${cacheFileName} önbelleğe kaydedildi.`);
        }

        const apiParams = nasaData.properties.parameter;
        const targetDate = new Date(2000, month - 1, day);
        const dailyMetrics = {};

        for (let i = -CONFIG.analysis.dayWindow; i <= CONFIG.analysis.dayWindow; i++) {
            const currentDate = new Date(targetDate);
            currentDate.setDate(targetDate.getDate() + i);
            const dateStr = `${(currentDate.getMonth() + 1).toString().padStart(2, '0')}${currentDate.getDate().toString().padStart(2, '0')}`;
            dailyMetrics[i] = calculateDailyMetrics(apiParams, dateStr, targetYear);
        }

        const finalResults = {};
        const paramKeys = Object.keys(dailyMetrics[0] || {});
        paramKeys.forEach(key => finalResults[key] = 0);
        let totalDivisor = 0;

        for (const dayIndex in dailyMetrics) {
            const weight = (dayIndex === '0') ? CONFIG.analysis.weights.targetDay : CONFIG.analysis.weights.neighborDay;
            paramKeys.forEach(paramKey => {
                const value = dailyMetrics[dayIndex][paramKey];
                if (value !== null) { finalResults[paramKey] += value * weight; }
            });
            totalDivisor += weight;
        }

        if (totalDivisor > 0) {
            paramKeys.forEach(key => finalResults[key] /= totalDivisor);
        }

        const annualTrend = calculateClimateTrend(apiParams);

        const trendDirection = annualTrend > 0.005 ? 'artış' : (annualTrend < -0.005 ? 'azalış' : 'sabit');
        const trendNarrative = `Bu bölgede ${CONFIG.api.startDate.substring(0, 4)}-${CONFIG.api.endDate.substring(0, 4)} yılları arasında yapılan analize göre, yıllık ortalama sıcaklık her yıl yaklaşık <strong>${annualTrend.toFixed(3)}°C</strong> ${trendDirection === 'artış' ? 'artış göstermiştir' : (trendDirection === 'azalış' ? 'azalış göstermiştir' : 'değişim göstermemiştir')}. Bu, bölgedeki uzun vadeli iklim trendini yansıtmaktadır.`;

        const snowDepthInCm = (finalResults.snowDepth * 1000).toFixed(1);

        // YENİ EKLENEN KISIM: Olasılığı yüzde formatına çevir
        const precipProbabilityPercent = (finalResults.precipProbability * 100).toFixed(0);

        const assessment = {
            temperature_celsius: parseFloat(finalResults.temp.toFixed(1)),
            wind_speed_mps: parseFloat(finalResults.wind.toFixed(1)),
            relative_humidity_percent: parseFloat(finalResults.humidity.toFixed(0)),
            precipitation_mm_per_day: parseFloat(finalResults.precipAmount.toFixed(1)),
            precipitation_probability_percent: parseInt(precipProbabilityPercent), // Yeni veriyi ekle

            // Anlatım metnini güncelle
            full_narrative: `Seçtiğiniz tarih için <strong>${targetYear}</strong> yılına yönelik öngörüler şöyledir: Tahmini sıcaklık <strong>${finalResults.temp.toFixed(1)}°C</strong>, ortalama rüzgar hızı <strong>${finalResults.wind.toFixed(1)} m/s</strong>, bağıl nem oranı <strong>%${finalResults.humidity.toFixed(0)}</strong> ve günlük yağış ortalaması <strong>${finalResults.precipAmount.toFixed(1)} mm</strong> olarak hesaplanmıştır. Geçmiş verilere dayanarak, bu günde <strong>%${precipProbabilityPercent}</strong> ihtimalle yağış beklenmektedir.`
        };

        res.json({
            target_year: targetYear,
            assessment: assessment,
            climate_trend: {
                period_start: parseInt(CONFIG.api.startDate.substring(0, 4)),
                period_end: parseInt(CONFIG.api.endDate.substring(0, 4)),
                annual_temp_change_celsius: parseFloat(annualTrend.toFixed(4)),
                change_direction: trendDirection,
                full_narrative: trendNarrative
            },
            confidence_notice: "Bu, geçmiş 24 yıllık verinin trend analizine ve komşu günlerin ağırlıklı ortalamasına dayanan istatistiksel bir öngörüdür, anlık bir hava durumu raporu değildir."
        });

    } catch (error) {
        console.error('Hata:', error);
        res.status(500).json({ error: 'Veri analizi sırasında bir hata oluştu.' });
    }
});

app.listen(port, () => {
    console.log(`Hava durumu analiz sunucusu http://localhost:${port} adresinde çalışıyor`);
});

