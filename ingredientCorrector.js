// ingredientCorrector.js
// Smart ingredient normalizer / corrector
// Exports: normalizeIngredients(rawIngredients: string[]) => { normalized: string[], diagnostics: [] }

const SYNONYMS = {
  "apple cider vinegar": "vinegar",
  "acv": "vinegar",
  "balsamic glaze": "balsamic vinegar",
  "olive oil extra virgin": "olive oil",
  "extra virgin olive oil": "olive oil",
  "soy milk": "soy milk",
  "soya milk": "soy milk",
  "maple syrup": "maple syrup",
  "nutritional yeast": "nutritional yeast",
  "smoked tofu": "tofu",
  "brussels sprouts": "brussels sprouts",
  "salt and pepper": ["salt","pepper"]
};

const REMOVE_ADJECTIVES = [
  "fresh","raw","organic","smoked","thick","thin","large","small","extra","plain","unsweetened","chopped","sliced","diced","minced","shredded","grated"
];

// unit maps (preserve mainly common cooking units)
const UNIT_MAP = {
  "tbs": "tbsp",
  "tbspn": "tbsp",
  "tbsp": "tbsp",
  "tablespoon": "tbsp",
  "tablespoons": "tbsp",
  "tsp": "tsp",
  "teaspoon": "tsp",
  "teaspoons": "tsp",
  "g": "g",
  "gram": "g",
  "grams": "g",
  "kg": "kg",
  "ml": "ml",
  "milliliter": "ml",
  "l": "l",
  "cup": "cup",
  "cups": "cup",
  "pinch": "pinch",
  "dash": "dash",
  "clove": "clove",
  "slice": "slice",
  "pkg": "package",
  "package": "package",
  "oz": "oz",
  "lb": "lb",
};

// heuristics to choose unit that Edamam understands well
function heuristicsForName(name) {
  const n = name.toLowerCase();
  if (n.includes("salt")||n.includes("pepper")||n.includes("spice")) return "tsp";
  if (n.includes("oil")||n.includes("vinegar")||n.includes("sauce")) return "tbsp";
  if (n.includes("milk")||n.includes("water")||n.includes("juice")) return "cup";
  return null;
}

function cleanupName(rawName) {
  let s = rawName.toLowerCase().trim();
  REMOVE_ADJECTIVES.forEach(adj => {
    s = s.replace(new RegExp(`\\b${adj}\\b`, "gi"), "");
  });
  s = s.replace(/\s+/g, " ").trim();

  // synonyms
  for (const [k,v] of Object.entries(SYNONYMS)) {
    if (s.includes(k)) {
      if (Array.isArray(v)) return v; // split into multiple
      return v;
    }
  }

  return s;
}

function parseRawIngredient(raw) {
  // Try patterns:
  // "100 g soy milk", "1 cup rice", "1 tsp salt and pepper", "salt"
  raw = (raw ?? "").toString().trim();
  if (!raw) return null;

  // handle "and" composite early: "1 pinch salt and pepper"
  if (/ and /i.test(raw)) {
    // fallback: split on " and " but keep quantities for first only
    const firstMatch = raw.match(/^([\d./]+\s*\w*)\s+(.*)/);
    if (firstMatch) {
      const qtyToken = firstMatch[1];
      const namesPart = firstMatch[2];
      const parts = namesPart.split(/\s+and\s+/i);
      return parts.map((p, idx) => {
        if (idx === 0) return `${qtyToken} ${p.trim()}`;
        // for subsequent parts assume same small amount: use "1 ${heuristicUnit}" - but simpler: "1 ${heuristics}"
        const heuristicUnit = heuristicsForName(p) || "tsp";
        return `1 ${heuristicUnit} ${p.trim()}`;
      });
    } else {
      // fallback split
      return raw.split(/\s+and\s+/i).map(p=>p.trim());
    }
  }

  // numeric quantity + unit + name
  const fullMatch = raw.match(/^([\d./]+)\s*([a-zA-Z]+)?\s*(.+)$/);
  if (fullMatch) {
    const qty = fullMatch[1];
    const unitRaw = (fullMatch[2] || "").toLowerCase();
    const nameRaw = fullMatch[3];
    const unit = UNIT_MAP[unitRaw] || unitRaw || heuristicsForName(nameRaw) || "";
    return [`${qty} ${unit} ${nameRaw}`.trim()];
  }

  // just word(s)
  return [raw];
}

export function normalizeIngredients(rawIngredients) {
  // returns { normalized: string[], diagnostics: {original, normalized, reason}[] }
  const normalized = [];
  const diagnostics = [];

  for (const raw of rawIngredients) {
    // parse into one or multiple strings first
    const parsed = parseRawIngredient(raw);
    if (!parsed || parsed.length === 0) {
      diagnostics.push({ original: raw, normalized: null, reason: "unparsed" });
      continue;
    }

    for (const p of parsed) {
      // split into tokens to find name part
      const m = p.match(/^([\d./]+)?\s*([a-zA-Z]+)?\s*(.+)$/);
      let namePart = p;
      if (m) {
        namePart = m[3] || "";
      }

      // cleanup / synonyms / remove adjectives
      const cleaned = cleanupName(namePart);

      // If cleanup returned an array (split synonyms), handle
      if (Array.isArray(cleaned)) {
        for (const c of cleaned) {
          const rebuilt = p.replace(namePart, c);
          normalized.push(rebuilt);
          diagnostics.push({ original: raw, normalized: rebuilt, reason: "synonym-split" });
        }
        continue;
      }

      const rebuilt = p.replace(namePart, cleaned);
      normalized.push(rebuilt);
      diagnostics.push({ original: raw, normalized: rebuilt, reason: "normalized" });
    }
  }

  // dedupe and preserve order
  const unique = [];
  const seen = new Set();
  for (const s of normalized) {
    const key = s.toLowerCase();
    if (!seen.has(key)) {
      unique.push(s);
      seen.add(key);
    }
  }

  return { normalized: unique, diagnostics };
}

