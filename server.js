import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

// =======================
// CONFIG
// =======================
const FATSECRET_ENDPOINT = "https://platform.fatsecret.com/rest/server.api";
const EDAMAM_NUTRITION = "https://api.edamam.com/api/nutrition-data";

const FS_CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const FS_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

const EDAMAM_APP_ID = process.env.EDAMAM_APP_ID;
const EDAMAM_APP_KEY = process.env.EDAMAM_APP_KEY;

// =======================
// FATSECRET TOKEN
// =======================
let fatsecretToken = null;
let tokenExpiresAt = 0;

async function getFatsecretToken() {
    if (fatsecretToken && Date.now() < tokenExpiresAt) {
        return fatsecretToken;
    }

    const resp = await fetch("https://oauth.fatsecret.com/connect/token", {
        method: "POST",
        body: new URLSearchParams({
            grant_type: "client_credentials",
            scope: "basic",
        }),
        headers: {
            Authorization:
                "Basic " +
                Buffer.from(`${FS_CLIENT_ID}:${FS_CLIENT_SECRET}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    });

    const data = await resp.json();
    fatsecretToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return fatsecretToken;
}

// =======================
// UNIT CONVERSION HELPERS
// =======================

function gramsToTsp(g) {
    return +(g * 0.175).toFixed(2); // sól & przyprawy
}

function gramsToTbsp(g) {
    return +(g / 15).toFixed(2); // mąka, cukier, suche składniki
}

function mlToCups(ml) {
    return +(ml / 240).toFixed(2);
}

function mlToTbsp(ml) {
    return +(ml / 15).toFixed(2);
}

// Smart unit auto-conversion
function convertIngredient(raw) {
    // Example input: "6 g Salt"
    const regex = /([\d.]+)\s*(g|gram|grams|ml|milliliter|milliliters)\s*(.*)/i;
    const match = raw.match(regex);

    if (!match) {
        return raw; // No conversion needed
    }

    const qty = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const name = match[3].trim().toLowerCase();

    // Decide conversion strategy
    if (unit === "g" || unit === "gram" || unit === "grams") {

        // Salt, pepper, spices → tsp
        if (name.includes("salt") || name.includes("pepper") || name.includes("spice")) {
            return `${gramsToTsp(qty)} tsp ${name}`;
        }

        // oil → tbsp
        if (name.includes("oil")) {
            return `${gramsToTbsp(qty)} tbsp ${name}`;
        }

        // default → tbsp
        return `${gramsToTbsp(qty)} tbsp ${name}`;
    }

    if (unit === "ml" || unit === "milliliter" || unit === "milliliters") {

        // milk, vinegar, soy, juice, water → cups
        if (
            name.includes("milk") ||
            name.includes("vinegar") ||
            name.includes("soy") ||
            name.includes("juice") ||
            name.includes("water")
        ) {
            return `${mlToCups(qty)} cup ${name}`;
        }

        // default → tbsp
        return `${mlToTbsp(qty)} tbsp ${name}`;
    }

    return raw;
}

// =======================
// FATSECRET LOOKUP
// =======================
async function searchFatSecret(query) {
    const token = await getFatsecretToken();

    const url = `${FATSECRET_ENDPOINT}?method=foods.search&search_expression=${encodeURIComponent(
        query
    )}&format=json`;

    const resp = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    const data = await resp.json();

    if (!data.foods) return null;
    if (!data.foods.food) return null;

    const food = Array.isArray(data.foods.food)
        ? data.foods.food[0]
        : data.foods.food;

    if (!food) return null;

    return {
        calories: parseFloat(food.food_description.match(/Calories: (\d+)/)?.[1] || 0),
        fat: parseFloat(food.food_description.match(/Fat: ([\d.]+)/)?.[1] || 0),
        carbs: parseFloat(food.food_description.match(/Carbs: ([\d.]+)/)?.[1] || 0),
        protein: parseFloat(food.food_description.match(/Protein: ([\d.]+)/)?.[1] || 0),
    };
}

// =======================
// EDAMAM FALLBACK
// =======================
async function searchEdamam(query) {
    const url = `${EDAMAM_NUTRITION}?app_id=${EDAMAM_APP_ID}&app_key=${EDAMAM_APP_KEY}&ingr=${encodeURIComponent(
        query
    )}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.totalNutrients) return null;

    return {
        calories: data.calories || 0,
        fat: data.totalNutrients.FAT?.quantity || 0,
        carbs: data.totalNutrients.CHOCDF?.quantity || 0,
        protein: data.totalNutrients.PROCNT?.quantity || 0,
    };
}

// =======================
// MAIN MERGED ENDPOINT
// =======================
app.post("/api/nutrition", async (req, res) => {
    try {
        const { ingredients, servings } = req.body;

        if (!ingredients || ingredients.length === 0) {
            return res.status(400).json({ error: "No ingredients provided." });
        }

        const converted = ingredients.map(convertIngredient);

        const results = await Promise.all(
            converted.map(async (ing, index) => {
                const fatsecret = await searchFatSecret(ing);

                if (fatsecret) return fatsecret;

                const edamam = await searchEdamam(ing);

                if (edamam) return edamam;

                console.warn(`⚠ No results for ingredient: ${ingredients[index]}`);

                return {
                    calories: 0,
                    fat: 0,
                    carbs: 0,
                    protein: 0,
                };
            })
        );

        // Merge totals
        const total = results.reduce(
            (acc, cur) => ({
                calories: acc.calories + cur.calories,
                fat: acc.fat + cur.fat,
                carbs: acc.carbs + cur.carbs,
                protein: acc.protein + cur.protein,
            }),
            { calories: 0, fat: 0, carbs: 0, protein: 0 }
        );

        // Scale per serving
        const divisor = Math.max(1, servings || 1);

        const perServing = {
            calories: total.calories / divisor,
            fats: total.fat / divisor,
            carbs: total.carbs / divisor,
            protein: total.protein / divisor,
        };

        res.json({
            success: true,
            totalIngredients: ingredients.length,
            nutrition: {
                calories: perServing.calories,
                totalWeight: null,
                nutrients: {
                    FAT: { label: "Fat", quantity: perServing.fats, unit: "g" },
                    CHOCDF: { label: "Carbs", quantity: perServing.carbs, unit: "g" },
                    PROCNT: { label: "Protein", quantity: perServing.protein, unit: "g" },
                },
            },
        });
    } catch (err) {
        console.error("❌ SERVER ERROR:", err);
        res.status(500).json({ error: "Server error", details: err.message });
    }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
    console.log(`🚀 Nutrition proxy server running on port ${PORT}`)
);
