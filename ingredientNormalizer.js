// ingredientNormalizer.js

// ------------------------------------
// ADJECTIVES AND DESCRIPTORS NORMALIZATION
// ------------------------------------
const REMOVE_ADJECTIVES = [
  "fresh", "raw", "organic", "smoked", "thick", "thin", "large", "small",
  "extra", "extra virgin", "virgin", "plain", "unsweetened"
];

// ------------------------------------
// UNIT NORMALIZATION
// ------------------------------------
const UNIT_MAP = {
  tbsp: "tablespoon",
  tbs: "tablespoon",
  tablespoon: "tablespoon",
  tbspn: "tablespoon",

  tsp: "teaspoon",
  tsps: "teaspoon",
  teaspoon: "teaspoon",

  g: "g",
  gram: "g",
  grams: "g",

  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",

  cup: "cup",
  cups: "cup",

  pinch: "pinch",
  handful: "handful"
};

// 1 pinch = ~0.3g nutritional approximation
const PINCH_IN_GRAMS = 0.3;

// liquids ML->G conversion (approximate density)
const LIQUIDS = ["milk", "soy milk", "vinegar", "oil", "sauce", "water"];

function mlToGramsIfLiquid(quantity, name) {
  if (!LIQUIDS.some(liq => name.includes(liq))) return quantity;
  return quantity; // density ≈1 g/ml, so 1ml = 1g
}

// ------------------------------------
// NORMALIZE TEXT
// ------------------------------------
function normalizeName(name) {
  let cleaned = name.toLowerCase().trim();

  REMOVE_ADJECTIVES.forEach(adj => {
    cleaned = cleaned.replace(new RegExp(`\\b${adj}\\b`, "gi"), "");
  });

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // SPECIAL FALLBACKS
  if (cleaned.includes("soy milk")) return "soy milk";
  if (cleaned.includes("apple cider vinegar")) return "vinegar";
  if (cleaned.includes("balsamic")) return "balsamic vinegar";
  if (cleaned.includes("smoked tofu")) return "tofu";

  return cleaned;
}

// ------------------------------------
// SPLIT COMPOSITE INGREDIENTS
// Example: "1 pinch salt and pepper" → two ingredients
// ------------------------------------
function splitCompositeIngredients(quantity, unit, name) {
  if (name.includes(" and ")) {
    const parts = name.split(" and ");

    return parts.map(n => ({
      quantity,
      unit,
      name: normalizeName(n.trim())
    }));
  }

  return [{ quantity, unit, name: normalizeName(name) }];
}

// ------------------------------------
// MAIN NORMALIZER
// Input example: "100 ml Soy milk"
// Returns array of normalized ingredient objects
// ------------------------------------
function normalizeIngredient(raw) {
  const regex = /^(\d+(\.\d+)?)\s+(\S+)\s+(.+)$/;
  const match = raw.trim().match(regex);
  if (!match) {
    return [];
  }

  let quantity = parseFloat(match[1]);
  let unit = match[3].toLowerCase();
  let name = match[4];

  // Convert units
  unit = UNIT_MAP[unit] || unit;

  // Convert pinch → grams
  if (unit === "pinch") {
    quantity = PINCH_IN_GRAMS;
    unit = "g";
  }

  // Convert ml → grams if liquid
  if (unit === "ml") {
    quantity = mlToGramsIfLiquid(quantity, name.toLowerCase());
    unit = "g";
  }

  // Split composite ingredients
  let baseList = splitCompositeIngredients(quantity, unit, name);

  return baseList.map(item => ({
    quantity: item.quantity,
    unit: item.unit,
    name: normalizeName(item.name)
  }));
}

module.exports = {
  normalizeIngredient
};

