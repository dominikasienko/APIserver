const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// === ZMIENNE ŚRODOWISKOWE ===
const CLIENT_ID = process.env.FATSECRET_CLIENT_ID || process.env.FATSECRET_API_KEY;
const CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const NUTRITION_ENDPOINT_URL = 'https://platform.fatsecret.com/2.0/recipe/nutrition';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// === TOKEN OAUTH 2.0 ===
let accessToken = null;
let tokenExpiryTime = 0;

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiryTime - 60000) {
        return accessToken;
    }

    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("❌ BRAK API KEYS (CLIENT_ID / CLIENT_SECRET)");
        return null;
    }

    console.log("🔐 Pobieranie nowego tokena OAuth...");
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    try {
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials&scope=basic'
        });

        const text = await response.text();

        if (!response.ok) {
            console.error("❌ Błąd pobierania tokena:", text);
            return null;
        }

        const data = JSON.parse(text);
        accessToken = data.access_token;
        tokenExpiryTime = Date.now() + data.expires_in * 1000;

        console.log("✅ Token pobrany.");
        return accessToken;

    } catch (err) {
        console.error("❌ Wyjątek tokena:", err);
        return null;
    }
}

// === POMOCNICZA KONWERSJA LICZB ===
const ensureDouble = (val) =>
    !val || isNaN(Number(val)) ? 0.0 : Number(val);

// === FUNKCJA: REQUEST DO FATSECRET Z RETRY ===
async function fetchWithRetry(ingredient, token, retries = 3) {
    const payload = {
        ingredients: [
            { ingredient_description: ingredient }
        ]
    };

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(NUTRITION_ENDPOINT_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const text = await response.text();

            if (!response.ok) {
                console.error(`❌ FatSecret error ${response.status}:`, text);

                // Retry only for server errors
                if (response.status >= 500) {
                    console.log("⏳ Retry za 500ms...");
                    await new Promise((r) => setTimeout(r, 500));
                    continue;
                }
                return null;
            }

            return JSON.parse(text);

        } catch (err) {
            console.error("❌ Błąd połączenia:", err);
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    return null;
}

// === GŁÓWNY ENDPOINT ===
app.post('/api/nutrition', async (req, res) => {
    const { ingredients, servings } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "Brak składników." });
    }

    const servingsCount = ensureDouble(servings) > 0 ? ensureDouble(servings) : 1.0;

    const token = await getAccessToken();
    if (!token) {
        return res.status(500).json({ error: "Błąd autoryzacji serwera proxy." });
    }

    console.log(`🍲 Otrzymano składniki: ${ingredients.length} szt. / porcje ${servingsCount}`);
    console.log("📦 Składniki:", ingredients);

    // === 🚀 RÓWNOLEGŁE REQUESTY WSZYSTKICH SKŁADNIKÓW ===
    const results = await Promise.all(
        ingredients.map(ing => fetchWithRetry(ing, token))
    );

    // === SUMOWANIE WYNIKÓW ===
    let sum = { calories: 0, fat: 0, carbohydrates: 0, protein: 0 };

    results.forEach((r, idx) => {
        if (!r || !r.result || !r.result.nutrition_per_serving) {
            console.warn(`⚠️ Brak danych dla składnika: ${ingredients[idx]}`);
            return;
        }

        const n = r.result.nutrition_per_serving;
        sum.calories += ensureDouble(n.calories);
        sum.fat += ensureDouble(n.fat);
        sum.carbohydrates += ensureDouble(n.carbohydrate);
        sum.protein += ensureDouble(n.protein);
    });

    // === PRZELICZENIE NA PORCJĘ ===
    const perServing = {
        calories: sum.calories / servingsCount,
        fat: sum.fat / servingsCount,
        carbohydrates: sum.carbohydrates / servingsCount,
        protein: sum.protein / servingsCount
    };

    console.log(`✅ Zwracam: ${perServing.calories.toFixed(0)} kcal / porcję`);

    res.json(perServing);
});

// === ROOT ===
app.get('/', (req, res) =>
    res.send("Proxy działa. Użyj POST /api/nutrition")
);

// === START SERWERA ===
app.listen(PORT, () => {
    console.log(`🚀 Proxy działa na porcie ${PORT}`);
    getAccessToken();
});
