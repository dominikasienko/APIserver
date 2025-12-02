const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios'); // Odkomentowane - teraz potrzebujemy axios
const qs = require('qs'); // qs jest przydatny, ale dla tej metody wystarczy URLSearchParams

// Wczytanie zmiennych środowiskowych (np. z pliku .env lub z Render.com)
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Konfiguracja CORS
app.use(cors());
// Middleware do parsowania JSON (ponieważ Swift wysyła POST z JSON)
app.use(express.json());

// --- Konfiguracja FatSecret ---
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;
const FATSECRET_TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const FATSECRET_API_URL = 'https://platform.fatsecret.com/rest/server.api';

// Zmienne do przechowywania tokena w pamięci
let accessToken = null;
let tokenExpiry = 0;

/**
 * Funkcja pomocnicza: Pobiera (lub odświeża) token dostępu OAuth 2.0
 */
async function getAccessToken() {
    // Sprawdź, czy token istnieje i jest ważny (z 60-sekundowym buforem)
    if (accessToken && Date.now() < tokenExpiry - 60000) {
        return accessToken;
    }

    if (!FATSECRET_CLIENT_ID || !FATSECRET_CLIENT_SECRET) {
        console.error("BŁĄD KRYTYCZNY: Brak FATSECRET_CLIENT_ID lub FATSECRET_CLIENT_SECRET w zmiennych środowiskowych.");
        throw new Error("Brak konfiguracji API po stronie serwera.");
    }

    console.log("Pobieranie nowego tokena dostępu FatSecret...");

    // Używamy URLSearchParams do formatu x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'basic'); // 'basic' wystarczy do metody recipe.nutrition.v1

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
 * Metoda: POST (zgodnie z wywołaniem Swift)
 * Oczekuje: { "ingredients": ["...", "..."], "servings": X }
 */
app.post('/api/nutrition', async (req, res) => {
    
    // POPRAWKA: Zmiana z req.query na req.body
    const { ingredients, servings } = req.body; 
    
    console.log(`Odebrano zapytanie dla: ${ingredients ? ingredients.length : 0} składników.`);

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "Brak 'ingredients' w ciele (body) żądania." });
    }
    
    // Ustawienie domyślnej liczby porcji na 1, jeśli nie podano
    const numServings = servings || 1;

    try {
        // Krok 1: Zdobądź token dostępu
        const token = await getAccessToken();

        // Krok 2: Przygotuj parametry dla API FatSecret
        // FatSecret oczekuje formatu x-www-form-urlencoded
        const apiParams = new URLSearchParams();
        apiParams.append('method', 'recipe.nutrition.v1');
        apiParams.append('format', 'json');
        apiParams.append('number_of_servings', numServings);

        // FatSecret wymaga, aby tablica składników była stringiem JSON wewnątrz parametru 'recipe_ingredients'
        const ingredientsPayload = JSON.stringify({
            recipe_ingredients: {
                // Używamy tablicy stringów 'ingredients' otrzymanej od Swift
                ingredient_description: ingredients 
            }
        });
        apiParams.append('recipe_ingredients', ingredientsPayload);

        const apiHeaders = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        // Krok 3: Wywołaj API FatSecret
        const nutritionResponse = await axios.post(FATSECRET_API_URL, apiParams.toString(), { headers: apiHeaders });

        // Krok 4: Sparsuj odpowiedź z FatSecret
        const nutritionData = nutritionResponse.data?.recipe_nutrition?.serving_nutrition;

        if (!nutritionData) {
            // Dzieje się tak, gdy FatSecret nie może znaleźć składników lub zwraca błąd
            console.error("Błąd parsowania odpowiedzi FatSecret lub brak danych:", nutritionResponse.data);
            return res.status(404).json({ error: 'Nie można obliczyć wartości odżywczych. Sprawdź składniki lub jednostki.' });
        }

        // Krok 5: Zmapuj odpowiedź FatSecret na format oczekiwany przez Swift
        // (Ważne: FatSecret zwraca 'carbohydrate', a Swift oczekuje 'carbohydrates')
        const appResponse = {
            calories: parseFloat(nutritionData.calories) || 0,
            fat: parseFloat(nutritionData.fat) || 0,
            carbohydrates: parseFloat(nutritionData.carbohydrate) || 0, // Mapowanie
            protein: parseFloat(nutritionData.protein) || 0
        };

        // Krok 6: Wyślij poprawną odpowiedź do aplikacji Swift
        res.json(appResponse); 

    } catch (error) {
        console.error("Błąd podczas pobierania danych odżywczych:", error.response?.data || error.message);
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