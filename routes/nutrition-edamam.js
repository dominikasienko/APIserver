import express from "express";
import axios from "axios";

const router = express.Router();

function smartSplit(ingredient) {
  if (ingredient.toLowerCase().includes("salt and pepper")) {
    const qty = ingredient.match(/^\d+(\.\d+)?/); 
    const num = qty ? qty[0] : "1";
    const unit = ingredient.replace(num, "").trim().split(" ")[0];

    return [
      `${num} ${unit} salt`,
      `${num} ${unit} pepper`,
    ];
  }

  return [ingredient];
}

unction mergeNutrition(results) {
  let totalCalories = 0;
  const nutrients = {};

  for (const item of results) {
    totalCalories += item.calories || 0;

    if (item.totalNutrients) {
      for (const [code, nut] of Object.entries(item.totalNutrients)) {
        if (!nutrients[code]) {
          nutrients[code] = {
            label: nut.label,
            quantity: 0,
            unit: nut.unit,
          };
        }
        nutrients[code].quantity += nut.quantity || 0;
      }
    }
  }

  return {
    calories: totalCalories,
    nutrients,
    totalWeight: results.reduce((a, b) => a + (b.totalWeight || 0), 0),
  };
}


router.post("/", async (req, res) => {
  try {
    const { ingredients, servings } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ success: false, error: "No ingredients provided." });
    }

    const apiID = process.env.EDAMAM_APP_ID;
    const apiKey = process.env.EDAMAM_APP_KEY;

    if (!apiID || !apiKey) {
      return res.status(500).json({
        success: false,
        error: "Edamam API keys are missing on server.",
      });
    }

    const normalizedIngredients = ingredients.flatMap(smartSplit);
    const results = [];
    const notFound = [];

    for (const ing of normalizedIngredients) {
      try {
        const response = await axios.post(
          `https://api.edamam.com/api/nutrition-details?app_id=${apiID}&app_key=${apiKey}`,
          { ingr: [ing] },
          { timeout: 5000 }
        );

        results.push(response.data);

      } catch (err) {
        console.log(`Ingredient not found: ${ing}`);
        notFound.push(ing);
        continue; 
      }
    }

    if (results.length === 0) {
      return res.status(200).json({
        success: true,
        totalIngredients: ingredients.length,
        nutrition: {
          calories: 0,
          nutrients: {},
          totalWeight: 0
        },
        notFound,
      });
    }

    const merged = mergeNutrition(results);

    res.json({
      success: true,
      totalIngredients: ingredients.length,
      nutrition: merged,
      notFound,
    });

  } catch (error) {
    console.error("SERVER ERROR in nutrition-edamam:", error.message);
    res.status(500).json({
      success: false,
      error: "Server error: " + error.message,
    });
  }
});

export default router;

