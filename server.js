// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { normalizeIngredient } from "./ingredientNormalizer.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// -----------------------------
// FATSECRET API CONFIG
// -----------------------------
const FATSECRET_KEY = process.env.FATSECRET_KEY;
const FATSECRET_SECRET = process.env.FATSECRET_SECRET;

if (!FATSECRET_KEY || !FATSECRET_SECRET) {
  console.error("Missing FatSecret API credentials in environment variables");
}

// ---------------------------------------------
// FATSECRET REQUEST FUNCTION (ONE INGREDIENT)
// ---------------------------------------------
async function queryFatSecret(ingredientString) {
  const url = `https://platform.fatsecret.com/rest/server.api`;

  const body = new URLSearchParams();
  body.append("method", "foods.search");
  body.append("search_expression", ingredientString);
  body.append("format", "json");

  const token = Buffer.from(`${FATSECRET_KEY}:${FATSECRET_SECRET}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const json = await res.json();
  return json;
}

// ---------------------------------------------
// FALLBACK SEARCH LOGIC
// ---------------------------------------------
async function resolveIngredient({ quantity, unit, name }) {
  const candidates = [
    `${quantity} ${unit} ${name}`,
    `${quantity} ${unit}`,
    name,
    name.split(" ")[0]
  ];

  for (const c of candidates) {
    const result = await queryFatSecret(c);

    if (result?.foods?.food) {
      return result.foods.food[0]; // best match
    }
  }

  return null;
}

// ---------------------------------------------
// MERGE MACROS
// ---------------------------------------------
function accumulate(result, fatsecretFood) {
  const nutrients = fatsecretFood.food_description.toLowerCase();

  let cal = 0, fat = 0, carbs = 0, protein = 0;

  const kcalMatch = nutrients.match(/(\d+)\s+kcal/);
  const fatMatch = nutrients.match(/fat:\s*(\d+(\.\d+)?)/);
  const carbsMatch = nutrients.match(/carb:\s*(\d+(\.\d+)?)/);
  const proteinMatch = nutrients.match(/protein:\s*(\d+(\.\d+)?)/);

  if (kcalMatch) cal += parseFloat(kcalMatch[1]);
  if (fatMatch) fat += parseFloat(fatMatch[1]);
  if (carbsMatch) carbs += parseFloat(carbsMatch[1]);
  if (proteinMatch) protein += parseFloat(proteinMatch[1]);

  result.calories += cal;
  result.fat += fat;
  result.carbs += carbs;
  result.protein += protein;

  return result;
}

// ---------------------------------------------
// MAIN ENDPOINT
// ---------------------------------------------
app.post("/nutrition", async (req, res) => {
  try {
    const { ingredients, servings } = req.body;

    if (!ingredients || ingredients.length === 0) {
      return res.status(400).json({ error: "Ingredients required" });
    }

    let normalized = [];
    ingredients.forEach(raw => {
      normalized.push(...normalizeIngredient(raw));
    });

    // Query each ingredient with fallback + merge nutrition
    let total = { calories: 0, fat: 0, carbs: 0, protein: 0 };

    for (const ing of normalized) {
      const fatsecretFood = await resolveIngredient(ing);

      if (!fatsecretFood) {
        console.warn(`⚠ Could not resolve: ${ing.quantity} ${ing.unit} ${ing.name}`);
        continue;
      }

      accumulate(total, fatsecretFood);
    }

    // Response format expected by Swift NutritionManager
    res.json({
      success: true,
      ingredientsAnalyzed: normalized.length,
      totalIngredients: ingredients.length,
      nutrition: {
        calories: total.calories,
        nutrients: {
          FAT: { label: "Fat", quantity: total.fat, unit: "g" },
          CHOCDF: { label: "Carbs", quantity: total.carbs, unit: "g" },
          PROCNT: { label: "Protein", quantity: total.protein, unit: "g" }
        }
      }
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------
app.listen(PORT, () => {
  console.log(`Nutrition proxy server running on port ${PORT}`);
});
