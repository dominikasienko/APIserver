const express = require('express');
const axios = require('axios');
const app = express();
// Używamy express.json() do parsowania przychodzącego JSON od aplikacji Swift
app.use(express.json());

// --- Konfiguracja ---
// Pamiętaj, aby ustawić te zmienne środowiskowe, aby proxy działał!
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID; 
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;
// --- Zmienne globalne do zarządzania tokenem ---
let accessToken = null;
let tokenExpiry = 0;

/**
 * Endpoint zdrowia
 */
app.get('/', (req, res) => {
    res.status(200).send("FatSecret Nutrition Proxy Server is running and healthy. Endpoint for Nutrition calculation is POST /api/nutrition.");
});

/**
 * Funkcja pobierająca token dostępu OAuth 2.0 (Client Credentials Flow).
 * Działa poprawnie i używa buforowania, aby nie pobierać nowego tokena przy każdym zapytaniu.
 */
async function getAccessToken() {
    if (!FATSECRET_CLIENT_ID || !FATSECRET_CLIENT_SECRET) {
        throw new Error("FATSECRET_CLIENT_ID lub FATSECRET_CLIENT_SECRET nie są ustawione w zmiennych środowiskowych.");
    }
    
    // Odśwież token, jeśli wygaśnie w ciągu najbliższej minuty
    if (accessToken && Date.now() < tokenExpiry - 60000) {
        return accessToken;
    }

    console.log("Generowanie nowego tokena dostępu FatSecret...");
    const url = 'https://oauth.fatsecret.com/connect/token';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'basic');

    const headers = {
        // Autoryzacja Basic Base64(ID:SECRET)
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
 * Główny punkt końcowy API
 * Przyjmuje: 
 * - POST Body (JSON): { "ingredients": ["1 cup chicken breast", "50g onion"], "servings": 2 }
 * Wysyła żądanie do metody 'recipe.nutrition.v1' API FatSecret.
 */
app.post('/api/nutrition', async (req, res) => {
    // Ustawienie timeoutu na 30 sekund na wypadek uśpienia serwera Render.com
    res.setTimeout(30000, () => { 
        res.status(503).json({ error: 'Błąd serwera: Przekroczono limit czasu oczekiwania na odpowiedź (Timeout).' });
    });

    // Pobieramy dane z body żądania Swift
    const { ingredients, servings } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Pole "ingredients" jest wymagane i musi być niepustą tablicą.' });
    }
    
    // Używamy 1 jako domyślnej liczby porcji
    const numServings = servings || 1; 

    try {
        const token = await getAccessToken();
        
        // --- KLUCZOWA POPRAWKA: WYSYŁANIE PRAWIDŁOWEGO ŻĄDANIA DO FATSECRET ---
        const apiUrl = 'https://platform.fatsecret.com/rest/server.api';

        // FatSecret oczekuje formatu x-www-form-urlencoded dla wszystkich parametrów
        const params = new URLSearchParams();
        
        // 1. Ustawienie metody (co było powodem błędu "Unknown method")
        params.append('method', 'recipe.nutrition.v1');
        
        // 2. Ustawienie formatu odpowiedzi na JSON
        params.append('format', 'json'); 
        
        // 3. Ustawienie liczby porcji
        params.append('number_of_servings', numServings);
        
        // 4. Składniki muszą być przekazane jako string JSON wewnątrz parametru 'recipe_ingredients'
        // FatSecret wymaga specyficznej struktury:
        const ingredientsPayload = JSON.stringify({
            recipe_ingredients: {
                ingredient_description: ingredients
            }
        });
        
        params.append('recipe_ingredients', ingredientsPayload);

        // 5. Ustawienie nagłówków (Bearer Token)
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded' // Wymagany dla body jako URLSearchParams
        };

        console.log(`Wysyłanie zapytania do FatSecret dla ${ingredients.length} składników...`);
        
        // Wysłanie żądania POST z URLSearchParams jako body
        const nutritionResponse = await axios.post(apiUrl, params.toString(), { headers });
        
        // --- OBRÓBKA ODPOWIEDZI ---
        // Odpowiedź API FatSecret jest zagnieżdżona pod `recipe_nutrition.serving_nutrition`
        const nutritionData = nutritionResponse.data?.recipe_nutrition?.serving_nutrition;

        if (!nutritionData) {
            console.error("Błąd parsowania odpowiedzi FatSecret (brak 'serving_nutrition'):", nutritionResponse.data);
            // Zwracamy błąd 404, jeśli API nie znalazło danych dla składników
            if (nutritionResponse.data?.error?.code === 1) { // Kod błędu dla braku wyników w FatSecret
                return res.status(404).json({ error: 'Brak danych odżywczych dla podanych składników.' });
            }
            return res.status(500).json({ error: 'Nie można obliczyć wartości odżywczych (błąd parsowania struktury odpowiedzi).' });
        }

        // Nazwy pól w odpowiedzi FatSecret to `carbohydrate` i `fat`.
        // Mapujemy je na nazwy oczekiwane przez Twoją strukturę Swift (`carbohydrates` i `fat`).
        const appResponse = {
            calories: parseFloat(nutritionData.calories) || 0,
            // Nazwa w FatSecret to 'fat', co odpowiada Twojemu polu 'fat'
            fat: parseFloat(nutritionData.fat) || 0,
            // Nazwa w FatSecret to 'carbohydrate', a w Twoim Swift 'carbohydrates'
            carbohydrates: parseFloat(nutritionData.carbohydrate) || 0, 
            protein: parseFloat(nutritionData.protein) || 0
        };

        return res.status(200).json(appResponse);

    } catch (error) {
        // Obsługa błędów, w tym błędów 401/403 z FatSecret, gdy token jest nieprawidłowy
        const errorMessage = error.response?.data?.error?.message || error.response?.data?.error || error.message;
        const statusCode = error.response?.status || 500;
        
        console.error(`Błąd serwera proxy (HTTP ${statusCode}):`, errorMessage);
        
        // Obsługa specyficznych kodów HTTP
        if (statusCode === 401 || statusCode === 403) {
            return res.status(401).json({ error: 'Błąd uwierzytelnienia (401/403) w FatSecret. Sprawdź klucze i token.' });
        }
        
        // Obsługa timeoutu
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            return res.status(504).json({ error: 'Błąd serwera: Żądanie do zewnętrznego API FatSecret przekroczyło limit czasu (Gateway Timeout).' });
        }

        return res.status(statusCode).json({ error: `Wewnętrzny błąd serwera: ${errorMessage}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serwer proxy FatSecret działa na porcie ${PORT}`);
});
