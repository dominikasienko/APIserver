const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// Konfiguracja kluczy (bez zmian - działa poprawnie)
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID; 
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

let accessToken = null;
let tokenExpiry = 0;

/**
 * Endpoint zdrowia (bez zmian)
 */
app.get('/', (req, res) => {
    res.status(200).send("FatSecret Nutrition Proxy Server is running and healthy. Endpoint for Nutrition calculation is POST /api/nutrition.");
});

/**
 * Pobieranie tokena (bez zmian - działa poprawnie)
 */
async function getAccessToken() {
    if (!FATSECRET_CLIENT_ID || !FATSECRET_CLIENT_SECRET) {
        throw new Error("FATSECRET_CLIENT_ID lub FATSECRET_CLIENT_SECRET nie są ustawione w zmiennych środowiskowych.");
    }
    
    if (accessToken && Date.now() < tokenExpiry - 60000) {
        return accessToken;
    }

    console.log("Generowanie nowego tokena dostępu FatSecret...");
    const url = 'https://oauth.fatsecret.com/connect/token';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'basic');

    const headers = {
        'Authorization': 'Basic ' + Buffer.from(`${FATSECRET_CLIENT_ID}:${FATSECRET_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    try {
        const response = await axios.post(url, params, { headers });
        accessToken = response.data.access_token;
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        console.log("Pomyślnie uzyskano nowy token.");
        return accessToken;
    } catch (error) {
        console.error("Błąd podczas uzyskiwania tokena FatSecret:", error.response ? error.response.data : error.message);
        throw new Error("Nie można uwierzytelnić się w FatSecret. Sprawdź klucze API.");
    }
}

/**
 * Główny punkt końcowy (POPRAWIONY)
 */
app.post('/api/nutrition', async (req, res) => {
    res.setTimeout(30000, () => { 
        res.status(503).json({ error: 'Błąd serwera: Przekroczono limit czasu oczekiwania na odpowiedź (Timeout).' });
    });

    const { ingredients, servings } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Pole "ingredients" jest wymagane i musi być niepustą tablicą.' });
    }
    
    const numServings = servings || 1; 

    try {
        const token = await getAccessToken();
        
        // --- POPRAWKA ---
        // 1. Zmiana adresu URL na poprawny, stabilny endpoint
        const apiUrl = 'https://platform.fatsecret.com/rest/server.api';

        // 2. Zmiana formatu body na 'x-www-form-urlencoded' (URLSearchParams)
        const params = new URLSearchParams();
        params.append('method', 'recipe.nutrition.v1');
        params.append('format', 'json'); // Ważne: prosimy o JSON, nie XML
        params.append('number_of_servings', numServings);
        
        // 3. Składniki muszą być przekazane jako string JSON wewnątrz parametru
        const ingredientsPayload = {
            recipe_ingredients: {
                ingredient_description: ingredients
            }
        };
        params.append('recipe_ingredients', JSON.stringify(ingredientsPayload));

        // 4. Zmiana nagłówka Content-Type
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        // 5. Wysłanie żądania POST z nowymi parametrami
        const nutritionResponse = await axios.post(apiUrl, params, { headers });
        
        // 6. Parsowanie odpowiedzi (struktura jest inna)
        const nutritionData = nutritionResponse.data?.recipe_nutrition?.serving_nutrition;

        if (!nutritionData) {
            console.error("Błąd parsowania odpowiedzi FatSecret:", nutritionResponse.data);
            return res.status(404).json({ error: 'Nie można obliczyć wartości odżywczych dla podanych składników (błąd parsowania odpowiedzi).' });
        }

        // 7. Zmapowanie odpowiedzi na format oczekiwany przez Swift
        // (nazwy pól są inne: 'carbohydrate' zamiast 'carbohydrates', 'fat' zamiast 'total_fat')
        const appResponse = {
            calories: parseFloat(nutritionData.calories),
            fat: parseFloat(nutritionData.fat),
            carbohydrates: parseFloat(nutritionData.carbohydrate), // Zmiana nazwy pola
            protein: parseFloat(nutritionData.protein)
        };
        // --- KONIEC POPRAWKI ---

        return res.status(200).json(appResponse);

    } catch (error) {
        console.error("Błąd serwera proxy:", error.response?.data || error.message);
        
        if (error.response?.status === 401) {
            return res.status(401).json({ error: 'Błąd uwierzytelnienia w FatSecret. Sprawdź klucze i token.' });
        }
        
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            return res.status(504).json({ error: 'Błąd serwera: Żądanie do zewnętrznego API FatSecret przekroczyło limit czasu (Gateway Timeout).' });
        }

        return res.status(500).json({ error: 'Wewnętrzny błąd serwera podczas przetwarzania żądania.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serwer proxy FatSecret działa na porcie ${PORT}`);
});
