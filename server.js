// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";
import { LRUCache } from "lru-cache";

const express = require('express');
const app = express();
app.use(cors());
app.use(express.json({ limit: "500kb" }));

// --- ADD THIS BLOCK AT THE TOP ---
app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.path}`);
  next();
});

// ---- ENV ----
const EDAMAM_APP_ID = process.env.EDAMAM_APP_ID;
const EDAMAM_APP_KEY = process.env.EDAMAM_APP_KEY;

if (!EDAMAM_APP_ID || !EDAMAM_APP_KEY) {
  console.error("❌ Missing EDAMAM_APP_ID or EDAMAM_APP_KEY");
}

// ---- Simple ingredient passthrough ----
function normalizeIngredients(ingredients) {
  return {
    normalized: ingredients.map(i => i.trim()),
    diagnostics: []
  };
}

// ---- Cache (memory only) ----
const cache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 60
});

function cacheKeyFor(ingredients, servings) {
  const key = JSON.stringify({
    ingredients: ingredients.map(s => s.trim().toLowerCase()),
    servings: Number(servings || 1)
  });
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function getCached(key) {
  return cache.get(key) || null;
}

async function setCached(key, value) {
  cache.set(key, value);
}

// ---- Edamam: nutrition-details (POST) ----
async function callEdamamNutritionDetails(ingrArray) {
  const url = `https://api.edamam.com/api/nutrition-details?app_id=${EDAMAM_APP_ID}&app_key=${EDAMAM_APP_KEY}`;

  const body = {
    title: "Recipe Analysis",
    ingr: ingrArray
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Non-JSON returned by Edamam");
  }

  if (!resp.ok) {
    throw new Error(json?.message || json?.error || `HTTP ${resp.status}`);
  }

  return json;
}

// ---- Fallback: per-ingredient ----
async function callEdamamNutritionDataForIngredient(ingredient) {
  const url = `https://api.edamam.com/api/nutrition-data?app_id=${EDAMAM_APP_ID}&app_key=${EDAMAM_APP_KEY}&nutrition-type=cooking&ingr=${encodeURIComponent(ingredient)}`;
  const resp = await fetch(url);

  if (!resp.ok) {
    return null; // fallback skip
  }

  return resp.json();
}

// ---- Utils ----
function extractTotalsFromDetails(json) {
  const calories = json?.calories ?? 0;
  const totalWeight = json?.totalWeight ?? null;
  const nutrients = json?.totalNutrients ?? {};

  const mapped = {};
  for (const [k, v] of Object.entries(nutrients)) {
    mapped[k] = { label: v.label, quantity: v.quantity, unit: v.unit };
  }

  return { calories, totalWeight, nutrients: mapped };
}

// ---- Endpoints ----
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Edamam Nutrition Proxy" });
});

app.post("/analyze", (req, res) => handleBatchAnalyze(req, res));
app.post("/batchAnalyze", (req, res) => handleBatchAnalyze(req, res));

async function handleBatchAnalyze(req, res) {
  try {
    const { ingredients: rawIngredients, servings } = req.body;

    if (!Array.isArray(rawIngredients) || rawIngredients.length === 0) {
      return res.status(400).json({ error: "ingredients must be array" });
    }

    const { normalized, diagnostics } = normalizeIngredients(rawIngredients);

    const key = cacheKeyFor(normalized, servings);
    const cached = await getCached(key);

    if (cached) {
      cached.cacheHit = true;
      return res.json(cached);
    }

    // ---------- Primary: nutrition-details ----------
    let details = null;

    try {
      details = await callEdamamNutritionDetails(normalized);
    } catch (e) {
      console.warn("Nutrition-details failed:", e.message);
    }

    let totals;
    let rawResponse;

    if (details && typeof details.calories === "number") {
      totals = extractTotalsFromDetails(details);
      rawResponse = { mode: "nutrition-details", response: details };
    } else {
      // ---------- Fallback ----------
      const per = await Promise.all(
        normalized.map(async ing => {
          return await callEdamamNutritionDataForIngredient(ing);
        })
      );

      const sum = per.reduce((acc, r) => {
        if (!r) return acc;
        acc.calories += r.calories || 0;
        acc.fat += r.totalNutrients?.FAT?.quantity || 0;
        acc.carbs += r.totalNutrients?.CHOCDF?.quantity || 0;
        acc.protein += r.totalNutrients?.PROCNT?.quantity || 0;
        return acc;
      }, { calories: 0, fat: 0, carbs: 0, protein: 0 });

      totals = {
        calories: sum.calories,
        totalWeight: null,
        nutrients: {
          FAT: { label: "Fat", quantity: sum.fat, unit: "g" },
          CHOCDF: { label: "Carbs", quantity: sum.carbs, unit: "g" },
          PROCNT: { label: "Protein", quantity: sum.protein, unit: "g" }
        }
      };

      rawResponse = { mode: "nutrition-data-fallback", items: per };
    }

    const divisor = Math.max(1, Number(servings || 1));
    const perServing = {
      calories: totals.calories / divisor,
      fat: totals.nutrients.FAT.quantity / divisor,
      carbs: totals.nutrients.CHOCDF.quantity / divisor,
      protein: totals.nutrients.PROCNT.quantity / divisor
    };

    const payload = {
      success: true,
      cacheHit: false,
      originalIngredients: rawIngredients,
      normalizedIngredients: normalized,
      diagnostics,
      nutrition: {
        calories: perServing.calories,
        nutrients: {
          FAT: { label: "Fat", quantity: perServing.fat, unit: "g" },
          CHOCDF: { label: "Carbs", quantity: perServing.carbs, unit: "g" },
          PROCNT: { label: "Protein", quantity: perServing.protein, unit: "g" }
        }
      },
      rawResponse
    };

    await setCached(key, payload);
    return res.json(payload);

  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Edamam proxy listening on port ${PORT}`);
});
