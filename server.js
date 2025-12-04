// server.js — Full rewritten version with:
// - Parallel ingredient lookups
// - Combined nutrient merging
// - Auto-scaling for servings
// - FatSecret OAuth token caching
// - Full error reporting
// - Clean async/await pipeline

import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

if (!FATSECRET_CLIENT_ID || !FATSECRET_CLIENT_SECRET) {
  console.error("❌ Missing FatSecret API credentials.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// OAUTH TOKEN CACHE
// ---------------------------------------------------------------------------
let fatSecretToken = null;
let fatSecretTokenExpiresAt = 0;

// Fetch OAuth2 token
async function getFatSecretToken() {
  const now = Date.now();

  // If token valid => reuse
  if (fatSecretToken && now < fatSecretTokenExpiresAt) {
    return fatSecretToken;
  }

  const credentials = Buffer.from(
    `${FATSECRET_CLIENT_ID}:${FATSECRET_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://oauth.fatsecret.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=basic",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed: ${text}`);
  }

  const data = await res.json();
  fatSecretToken = data.access_token;
  fatSecretTokenExpiresAt = now + data.expires_in * 1000;

  return fatSecretToken;
}

// ---------------------------------------------------------------------------
// FATSECRET — SEARCH + GET NUTRITION
// ---------------------------------------------------------------------------
async function fetchIngredientNutrition(query) {
  const token = await getFatSecretToken();

  // 1) Search for food ID
  const searchRes = await fetch(
    `https://platform.fatsecret.com/rest/server.api?method=foods.search&search_expression=${encodeURIComponent(
      query
    )}&format=json`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const searchJson = await tryParseJSON(searchRes);
  if (!searchJson?.foods?.food?.length) {
    throw new Error(`No results for ingredient: ${query}`);
  }

  const foodId = searchJson.foods.food[0].food_id;

  // 2) Fetch nutrition details
  const detailRes = await fetch(
    `https://platform.fatsecret.com/rest/server.api?method=food.get.v4&food_id=${foodId}&format=json`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const detailJson = await tryParseJSON(detailRes);
  if (!detailJson.food) {
    throw new Error(`FatSecret returned invalid data for: ${query}`);
  }

  return extractNutrition(detailJson.food);
}

// ---------------------------------------------------------------------------
// SAFE JSON PARSER — avoids "Unexpected token '<' (HTML 500 errors)"
// ---------------------------------------------------------------------------
async function tryParseJSON(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    console.error("❌ FatSecret returned non-JSON response:");
    console.error(text);
    throw new Error("FatSecret API returned invalid JSON (likely HTML error page)");
  }
}

// ---------------------------------------------------------------------------
// EXTRACT NUTRITION (Normalized format)
// ---------------------------------------------------------------------------
function extractNutrition(food) {
  const nutrients = food.servings.serving[0];

  return {
    name: food.food_name,
    calories: Number(nutrients.calories ?? 0),
    protein: Number(nutrients.protein ?? 0),
    carbs: Number(nutrients.carbohydrate ?? 0),
    fat: Number(nutrients.fat ?? 0),
  };
}

// ---------------------------------------------------------------------------
// MERGE MULTIPLE INGREDIENTS
// ---------------------------------------------------------------------------
function mergeNutrients(ingredients) {
  return ingredients.reduce(
    (sum, item) => ({
      calories: sum.calories + item.calories,
      protein: sum.protein + item.protein,
      carbs: sum.carbs + item.carbs,
      fat: sum.fat + item.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

// ---------------------------------------------------------------------------
// SERVING CALCULATOR
// ---------------------------------------------------------------------------
function scaleByServings(nutrients, servings) {
  return {
    calories: nutrients.calories / servings,
    protein: nutrients.protein / servings,
    carbs: nutrients.carbs / servings,
    fat: nutrients.fat / servings,
  };
}

// ---------------------------------------------------------------------------
// MAIN ENDPOINT — Parallel ingredients
// ---------------------------------------------------------------------------
app.post("/nutrition", async (req, res) => {
  try {
    const { ingredients, servings } = req.body;

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "Provide ingredients: string[]" });
    }

    const servingsCount = Number(servings || 1);

    // Fetch all ingredients in parallel
    const results = await Promise.all(
      ingredients.map(async (item) => ({
        name: item,
        nutrients: await fetchIngredientNutrition(item),
      }))
    );

    // Merge all nutrients
    const combined = mergeNutrients(results.map((r) => r.nutrients));

    // Auto-scale
    const perServing = scaleByServings(combined, servingsCount);

    res.json({
      servings: servingsCount,
      ingredients: results,
      total: combined,
      perServing: perServing,
    });
  } catch (err) {
    console.error("❌ SERVER ERROR:", err.message);

    res.status(500).json({
      error: "Nutrition fetch failed",
      message: err.message,
    });
  }
});

// ---------------------------------------------------------------------------
// SERVER START
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Nutrition proxy server running on port ${PORT}`);
});
