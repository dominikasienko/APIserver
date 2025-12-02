const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Konfiguracja FatSecret ---
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;
const FATSECRET_TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';

// BŁĄD BYŁ TUTAJ: Używałeś starego adresu URL API (rest/server.api)
// const FATSECRET_API_URL = 'https://platform.fatsecret.com/rest/server.api';

// POPRAWKA: To jest poprawny adres URL dla metody recipe.nutrition w OAuth 2.0
const FATSECRET_NUTRITION_ENDPOINT = 'https://platform.fatsecret.com/2.0/recipe/nutrition';

let accessToken = null;
let tokenExpiry = 0;

/**
 * Funkcja pomocnicza: Pobiera (lub odświeża) token dostępu OAuth 2.0
 * (Ta funkcja jest poprawna i pozostaje bez zmian)
 */
async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiry - 60000) {
        return accessToken;
    }

    if (!FATSECRET_CLIENT_ID || !FATSECRET_CLIENT_SECRET) {
        console.error("BŁĄD KRYTYCZNY: Brak FATSECRET_CLIENT_ID lub FATSECRET_CLIENT_SECRET w zmiennych środowiskowych.");
        throw new Error("Brak konfiguracji API po stronie serwera.");
    }

    console.log("Pobieranie nowego tokena dostępu FatSecret...");
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'basic');

    const headers = {
        'Authorization': 'Basic ' + Buffer.from(`${FATSECRET_CLIENT_ID}:${FATSECRET_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    try {
        const response = await axios.post(FATSECRET_TOKEN_URL, params, { headers });
        accessToken = response.data.access_token;
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        console.log("Pomyślnie uzyskano nowy token.");
        return accessToken;
    } catch (error) {
        console.error("Błąd podczas uzyskiwania tokena FatSecret:", error.response?.data || error.message);
        throw new Error("Nie można uwierzytelnić się w FatSecret.");
    }
}


/**
 * Główny Endpoint: /api/nutrition
 * (Ta funkcja została poprawiona, aby używać poprawnego API OAuth 2.0)
 */
app.post('/api/nutrition', async (req, res) => {
    
    const { ingredients, servings } = req.body; 
    
    console.log(`Odebrano zapytanie dla: ${ingredients ? ingredients.length : 0} składników.`);

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "Brak 'ingredients' w ciele (body) żądania." });
    }
    
    const numServings = servings || 1;

    try {
        const token = await getAccessToken();

        // --- POPRAWKA: ZMIANA SPOSOBU WYWOŁANIA API FATSECRET ---

        // Krok 2: Przygotuj CIAŁO (body) JSON dla punktu końcowego OAuth 2.0
        // Ten endpoint oczekuje 'application/json', a nie 'x-www-form-urlencoded'
        // i nie używa parametru 'method' ani 'format'.
        const apiBody = {
            number_of_servings: numServings,
            recipe_ingredients: {
                ingredient_description: ingredients 
            }
        };

        // Krok 3: Przygotuj nagłówki OAuth 2.0
        const apiHeaders = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json' // <-- ZMIANA
        };

        // Krok 4: Wywołaj poprawny punkt końcowy (FATSECRET_NUTRITION_ENDPOINT)
        // wysyłając apiBody bezpośrednio jako JSON.
        console.log("Wysyłanie żądania do /2.0/recipe/nutrition...");
        const nutritionResponse = await axios.post(FATSECRET_NUTRITION_ENDPOINT, apiBody, { headers: apiHeaders });

        // Krok 5: Sparsuj odpowiedź
        // Odpowiedź OAuth 2.0 /2.0/recipe/nutrition wygląda tak samo jak stara:
        const nutritionData = nutritionResponse.data?.recipe_nutrition?.serving_nutrition;

        if (!nutritionData) {
            console.error("Błąd parsowania odpowiedzi FatSecret lub brak danych:", nutritionResponse.data);
            return res.status(404).json({ error: 'Nie można obliczyć wartości odżywczych. Sprawdź składniki lub jednostki.' });
        }

        // Krok 6: Zmapuj odpowiedź (bez zmian)
        const appResponse = {
            calories: parseFloat(nutritionData.calories) || 0,
            fat: parseFloat(nutritionData.fat) || 0,
            carbohydrates: parseFloat(nutritionData.carbohydrate) || 0, // Mapowanie
            protein: parseFloat(nutritionData.protein) || 0
        };

        // Krok 7: Wyślij poprawną odpowiedź do aplikacji Swift
        console.log("Pomyślnie pobrano dane odżywcze.");
        res.json(appResponse); 

    } catch (error) {
        // Obsługa błędów (bez zmian)
        console.error("Błąd podczas pobierania danych odżywczych:", error.response?.data?.error?.message || error.response?.data || error.message);
        res.status(500).json({ error: "Wewnętrzny błąd serwera podczas przetwarzania żądania." });
    }
});

// Nasłuchiwanie na porcie
app.listen(PORT, () => {
  console.log(`Serwer proxy działa na porcie ${PORT}`);
});

// Opcjonalnie: Uproszczony endpoint testowy (GET)
app.get('/', (req, res) => {
    res.send('Serwer proxy działa. Użyj [POST] /api/nutrition');
});