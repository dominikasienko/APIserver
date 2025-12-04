const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.FATSECRET_CLIENT_ID || process.env.FATSECRET_API_KEY;
const CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const NUTRITION_ENDPOINT_BASE = 'https://platform.fatsecret.com';
const NUTRITION_ENDPOINT_PATH = '/2.0/recipe/nutrition';
const NUTRITION_ENDPOINT_URL = NUTRITION_ENDPOINT_BASE + NUTRITION_ENDPOINT_PATH;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

let accessToken = null;
let tokenExpiryTime = 0;

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiryTime - 60000) {
        return accessToken;
    }

    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("BŁĄD: Brak kluczy API (CLIENT_ID/SECRET).");
        return null;
    }

    console.log("Pobieranie nowego tokena OAuth...");
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

        if (!response.ok) {
            const txt = await response.text();
            console.error(`Błąd Tokena: ${txt}`);
            return null;
        }

        const data = await response.json();
        accessToken = data.access_token;
        tokenExpiryTime = Date.now() + (data.expires_in * 1000);
        return accessToken;
    } catch (error) {
        console.error("Wyjątek Tokena:", error);
        return null;
    }
}

const ensureDouble = (value) => {
    if (value === null || value === undefined || value === "" || !isFinite(Number(value))) {
        return 0.0;
    }
    return Number(value);
};

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

    const recipeIngredients = ingredients.map((item) => ({
        ingredient_id: crypto.randomUUID(), 
        food_entry: item
    }));

    const payload = {
        method: "recipe.get_nutrition",
        format: "json",
        meal_id: crypto.randomUUID(),
        ingredients: recipeIngredients
    };

    console.log(`[Proxy] Żądanie dla ${ingredients.length} składników. Dzielenie przez ${servingsCount} porcji.`);

    try {
        const response = await fetch(NUTRITION_ENDPOINT_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`FatSecret Error (${response.status}): ${errText}`);
            return res.status(502).json({ error: "Błąd zewnętrznego API." });
        }

        const data = await response.json();

        if (data.result && data.result.nutrition_per_serving) {
            const raw = data.result.nutrition_per_serving;

            const totalCalories = ensureDouble(raw.calories);
            const totalFat = ensureDouble(raw.fat);
            const totalCarbs = ensureDouble(raw.carbohydrate); 
            const totalProtein = ensureDouble(raw.protein);

            const result = {
                calories: totalCalories / servingsCount,
                fat: totalFat / servingsCount,
                carbohydrates: totalCarbs / servingsCount,
                protein: totalProtein / servingsCount
            };

            console.log(`[Proxy] Sukces. Wynik na porcję: ${result.calories.toFixed(0)} kcal`);
            return res.json(result);
        } else {
            console.warn("FatSecret nie zwrócił nutrition_per_serving:", data);
            return res.json({ calories: 0, fat: 0, carbohydrates: 0, protein: 0 });
        }

    } catch (error) {
        console.error("Proxy Exception:", error);
        return res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => res.send("Proxy działa. Użyj POST /api/nutrition"));

app.listen(PORT, () => {
    console.log(`Serwer działa na porcie ${PORT}`);
    getAccessToken(); 
});