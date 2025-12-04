const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const FATSECRET_API_KEY = process.env.FATSECRET_API_KEY || '174b384c16f74a8a90d18346a1f77bb1'; 
const FATSECRET_BASE_URL = 'https://platform.fatsecret.com/rest/server.api';

app.use(cors()); // Zezwolenie na CORS
app.use(express.json()); 

const ensureDouble = (value) => {
    if (value === null || value === undefined || value === "" || !isFinite(Number(value))) {
        return 0.0;
    }
    return Number(value);
};

app.post('/api/nutrition', async (req, res) => {
    const { ingredients, servings } = req.body;
    
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Lista składników jest pusta lub nieprawidłowa.' });
    }
    
    const servingsCount = ensureDouble(servings) > 0 ? ensureDouble(servings) : 1.0;
    
    console.log(`[Proxy] Otrzymano żądanie: ${ingredients.length} składników, porcji: ${servingsCount}`);

    const fatSecretParams = new URLSearchParams();
    fatSecretParams.append('method', 'recipe_finder.get_nutrition_by_ingredients');
    fatSecretParams.append('ingredients', JSON.stringify(ingredients)); 
    fatSecretParams.append('format', 'json');
    fatSecretParams.append('recipe_finder_api_key', FATSECRET_API_KEY);
    
    try {
        // 3. Wykonanie żądania do FatSecret
        const fsResponse = await fetch(`${FATSECRET_BASE_URL}?${fatSecretParams.toString()}`, {
            method: 'GET' // Mimo dużego body, FatSecret używa GET/POST, ale dla tego endpointu dokumentacja sugeruje GET z zakodowanymi parametrami URL
        });

        const fsData = await fsResponse.json();
        
        if (fsData.error) {
            console.error('[FatSecret Error]', fsData.error);
            return res.status(502).json({ error: `Błąd API FatSecret: ${fsData.error.message || 'Nieznany błąd.'}` });
        }
        
        const nutritionData = fsData.nutrition_per_serving;

        if (!nutritionData) {
            console.warn('[Proxy Warning] FatSecret nie zwrócił danych odżywczych (nutrition_per_serving). Zwracam 0.0.');
            // Zwrócenie zerowych danych w przypadku braku wyników
            return res.json({
                calories: 0.0, fat: 0.0, carbohydrates: 0.0, protein: 0.0
            });
        }
        
        const totalNutrition = {
            // Użycie funkcji ensureDouble i pomnożenie przez servingsCount
            calories: ensureDouble(nutritionData.calories) * servingsCount,
            fat: ensureDouble(nutritionData.fat) * servingsCount,
            carbohydrates: ensureDouble(nutritionData.carbohydrate) * servingsCount, 
            protein: ensureDouble(nutritionData.protein) * servingsCount,
        };

        console.log(`[Proxy] Pomyślnie przetworzono i przeskalowano dane. Kcal (cała potrawa): ${totalNutrition.calories.toFixed(0)}`);
        res.json(totalNutrition);

    } catch (error) {
        console.error('[Proxy Critical Error]', error.message);
        res.status(500).json({ error: `Wewnętrzny błąd serwera proxy: ${error.message}` });
    }
});

app.get('/', (req, res) => {
    res.send('Serwer proxy FatSecret działa poprawnie. Użyj endpointu POST /api/nutrition.');
});

app.listen(PORT, () => {
    console.log(`Serwer proxy działa na porcie ${PORT}`);
});