// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";
import { LRUCache } from "lru-cache"; // add to package.json deps
import Redis from "ioredis"; // optional - only used if REDIS_URL is set
import { normalizeIngredients } from "./ingredientCorrector.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "500kb" }));

// ENV
const EDAMAM_APP_ID = process.env.EDAMAM_APP_ID;
const EDAMAM_APP_KEY = process.env.EDAMAM_APP_KEY;
const REDIS_URL = process.env.REDIS_URL; // optional

if (!EDAMAM_APP_ID || !EDAMAM_APP_KEY) {
  console.error("❌ EDAMAM_APP_ID / EDAMAM_APP_KEY must be set in env!");
  // do not exit — we'll fail at runtime, but warn
}

// ---------- CACHE: in-memory LRU + optional Redis ----------
const cache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 60, // 1h cache
});

let redisClient = null;
if (REDIS_URL) {
  try {
    redisClient = new Redis(REDIS_URL);
    redisClient.on("error", (e) => console.warn("Redis error:", e.message));
    console.log("🔁 Redis cache enabled.");
  } catch (e) {
    console.warn("⚠ Failed to initialize Redis, falling back to memory cache.", e.message);
    redisClient = null;
  }
}

// helper to compute cache key
function cacheKeyFor(ingredients, servings) {
  // canonicalize: lower-case, trimmed, stable order
  const key = JSON.stringify({
    ingredients: ingredients.map(s => s.trim().toLowerCase()),
    servings: Number(servings || 1)
  });
  return crypto.createHash("sha256").update(key).digest("hex");
}

// try get from caches
async function getCached(key) {
  const mem = memoryCache.get(key);
  if (mem) return mem;
  if (redisClient) {
    try {
      const v = await redisClient.get(key);
      if (v) {
        const parsed = JSON.parse(v);
        // refresh memory cache
        memoryCache.set(key, parsed);
        return parsed;
      }
    } catch (e) {
      console.warn("Redis GET failed:", e.message);
    }
  }
  return null;
}

// set caches
async function setCached(key, value, ttlSeconds = 3600) {
  memoryCache.set(key, value);
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch (e) {
      console.warn("Redis SET failed:", e.message);
    }
  }
}

// ---------- EDAMAM API CALL (nutrition-details POST) ----------
// Uses /api/nutrition-details to analyze whole recipe in single request
async function callEdamamNutritionDetails(ingrArray) {
  // Build url with creds (app_id & app_key) as query params
  const url = `https://api.edamam.com/api/nutrition-details?app_id=${EDAMAM_APP_ID}&app_key=${EDAMAM_APP_KEY}`;
  // Request body: { title: "Recipe", ingr: [ ... ] }
  const body = {
    title: "Recipe Analysis",
    ingr: ingrArray
  };

  // retry with exponential backoff for transient errors
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeout: 15000
      });

      const text = await resp.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        // Edamam occasionally returns HTML or text on errors
        throw new Error(`Edamam returned non-JSON: ${text.slice(0,200)}`);
      }

      if (!resp.ok) {
        // Edamam: check error
        const errMsg = json?.message || json?.error || `HTTP ${resp.status}`;
        throw new Error(`Edamam error: ${errMsg}`);
      }

      return json;
    } catch (err) {
      const isLast = attempt === maxRetries;
      console.warn(`Edamam attempt ${attempt} failed: ${err.message}`);
      if (isLast) throw err;
      // backoff
      await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
    }
  }
}

// fallback: per-ingredient nutrition-data endpoint (GET). Used rarely.
async function callEdamamNutritionDataForIngredient(ingredient) {
  const url = `https://api.edamam.com/api/nutrition-data?app_id=${EDAMAM_APP_ID}&app_key=${EDAMAM_APP_KEY}&nutrition-type=cooking&ingr=${encodeURIComponent(ingredient)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Edamam nutrition-data error: ${txt}`);
  }
  return resp.json();
}

// ---------- Utilities ----------
function extractTotalsFromDetails(detailsJson) {
  // Edamam nutrition-details returns:
  // { calories, totalWeight, totalNutrients: { FAT: {quantity, unit, label}, ... }, totalDaily: {...} }
  const calories = detailsJson?.calories || 0;
  const totalWeight = detailsJson?.totalWeight || null;
  const nutrients = detailsJson?.totalNutrients || {};
  // Map to our structure
  const mapped = {};
  for (const [k, v] of Object.entries(nutrients)) {
    mapped[k] = { label: v.label, quantity: v.quantity, unit: v.unit };
  }
  return { calories, totalWeight, nutrients: mapped, raw: detailsJson };
}

// ---------- Endpoints ----------

// Health
app.get("/", (req, res) => {
  res.json({ ok: true, note: "Edamam Nutrition Proxy" });
});

// Single analyze (supports receiving ingredients array) — convenience wrapper
app.post("/analyze", async (req, res) => {
  // keep for backwards-compatibility
  const { ingredients, servings } = req.body;
  return handleBatchAnalyze(req, res, ingredients, servings);
});

// Main powerful batch endpoint
app.post("/batchAnalyze", async (req, res) => {
  const { ingredients: rawIngredients, servings } = req.body;
  return handleBatchAnalyze(req, res, rawIngredients, servings);
});

async function handleBatchAnalyze(req, res, rawIngredients, servings) {
  try {
    const ingredientsInput = Array.isArray(rawIngredients) ? rawIngredients : [];
    if (ingredientsInput.length === 0) {
      return res.status(400).json({ error: "ingredients must be a non-empty array" });
    }
    const normalizedResult = normalizeIngredients(ingredientsInput);
    const normalized = normalizedResult.normalized;
    const diagnostics = normalizedResult.diagnostics || [];

    // cache key
    const key = cacheKeyFor(normalized, servings);
    const cached = await getCached(key);
    if (cached) {
      cached.cacheHit = true;
      cached.diagnostics = diagnostics;
      return res.json(cached);
    }

    // Primary: attempt to call nutrition-details once for the whole list
    let edamamDetails = null;
    try {
      edamamDetails = await callEdamamNutritionDetails(normalized);
    } catch (err) {
      console.warn("Primary nutrition-details failed:", err.message);
    }

    // If details succeeded and has calories, use it
    let totals = null;
    let rawResponse = null;
    if (edamamDetails && (typeof edamamDetails.calories === "number")) {
      const extracted = extractTotalsFromDetails(edamamDetails);
      totals = extracted;
      rawResponse = { mode: "nutrition-details", response: edamamDetails };
    } else {
      // fallback: call per-ingredient nutrition-data, sum results
      const perPromises = normalized.map(async ing => {
        try {
          const r = await callEdamamNutritionDataForIngredient(ing);
          // Note: r.totalNutrients may exist in nutrition-data too
          return r;
        } catch (e) {
          console.warn("Per-ingredient fallback failed for", ing, e.message);
          return null;
        }
      });
      const perResults = await Promise.all(perPromises);
      // sum
      const summed = perResults.reduce((acc, r) => {
        if (!r) return acc;
        acc.calories += r.calories || 0;
        const tn = r.totalNutrients || {};
        acc.fat += tn.FAT?.quantity || 0;
        acc.carbs += tn.CHOCDF?.quantity || 0;
        acc.protein += tn.PROCNT?.quantity || 0;
        return acc;
      }, { calories: 0, fat: 0, carbs: 0, protein: 0 });

      totals = { calories: summed.calories, totalWeight: null, nutrients: {
        FAT: { label: "Fat", quantity: summed.fat, unit: "g" },
        CHOCDF: { label: "Carbs", quantity: summed.carbs, unit: "g" },
        PROCNT: { label: "Protein", quantity: summed.protein, unit: "g" }
      }};
      rawResponse = { mode: "nutrition-data-fallback", items: perResults };
    }

    // Compute per-serving
    const divisor = Math.max(1, Number(servings || 1));
    const perServing = {
      calories: (totals.calories || 0) / divisor,
      fat: (totals.nutrients?.FAT?.quantity || 0) / divisor,
      carbohydrates: (totals.nutrients?.CHOCDF?.quantity || 0) / divisor,
      protein: (totals.nutrients?.PROCNT?.quantity || 0) / divisor
    };

    const payload = {
      success: true,
      cacheHit: false,
      totalIngredients: normalized.length,
      originalIngredients: ingredientsInput,
      normalizedIngredients: normalized,
      diagnostics,
      nutrition: {
        calories: perServing.calories,
        totalWeight: totals.totalWeight || null,
        nutrients: {
          FAT: { label: totals.nutrients?.FAT?.label || "Fat", quantity: perServing.fat, unit: "g" },
          CHOCDF: { label: totals.nutrients?.CHOCDF?.label || "Carbs", quantity: perServing.carbohydrates, unit: "g" },
          PROCNT: { label: totals.nutrients?.PROCNT?.label || "Protein", quantity: perServing.protein, unit: "g" }
        }
      },
      rawResponse
    };

    // set cache (TTL 1 hour)
    await setCached(key, payload, 3600);

    return res.json(payload);
  } catch (err) {
    console.error("Batch analyze error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Edamam proxy listening on port ${PORT}`);
});
