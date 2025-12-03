const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Używamy zmiennych ŚRODOWISKOWYCH ustawionych w panelu Render ---
const CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const NUTRITION_ENDPOINT_BASE = 'https://platform.fatsecret.com';
const NUTRITION_ENDPOINT_PATH = '/2.0/recipe/nutrition';
const NUTRITION_ENDPOINT_URL = NUTRITION_ENDPOINT_BASE + NUTRITION_ENDPOINT_PATH;

// Sprawdzanie kluczy
if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("BŁĄD KONFIGURACJI: FATSECRET_CLIENT_ID lub FATSECRET_CLIENT_SECRET jest nieustawiony jako zmienna środowiskowa w Render.com.");
    // Nie wychodzimy z błędem, aby serwer się podniósł i log był widoczny.
}


// Global variable for the access token and its expiry time
let accessToken = null;
let tokenExpiryTime = 0; // Timestamp (in ms) when the token expires

// Middleware
// Ustawienie większego limitu ciała żądania (dla żądań z 26 składnikami)
app.use(cors());
app.use(express.json({ limit: '5mb' }));


// -------------------------------------------------------------------
// 1. ZARZĄDZANIE AUTORYZACJĄ (OAuth 2.0)
// -------------------------------------------------------------------

async function getAccessToken() {
    // Zapas 60s
    if (accessToken && Date.now() < tokenExpiryTime - 60000) { 
        console.log("Używam istniejącego, ważnego tokenu.");
        return accessToken;
    }

    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("Token nie może być pobrany: Klucze API są puste.");
        return null;
    }

    console.log("Pobieram/odświeżam nowy token dostępu...");
    
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    try {
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Błąd FatSecret OAuth (${response.status}): ${errorText}`);
            return null;
        }

        const data = await response.json();
        
        accessToken = data.access_token;
        // Ustawienie wygaśnięcia
        tokenExpiryTime = Date.now() + (data.expires_in * 1000); 

        console.log("Token dostępu pomyślnie odświeżony.");
        return accessToken;

    } catch (error) {
        console.error("Krytyczny błąd podczas pobierania tokenu dostępu:", error.message);
        accessToken = null;
        tokenExpiryTime = 0;
        return null;
    }
}

// -------------------------------------------------------------------
// 2. FUNKCJA API I LOGIKA BŁĘDÓW
// -------------------------------------------------------------------

async function callFatSecretApi(payload, isRetry = false) {
    let token = await getAccessToken();

    if (!token) {
        throw new Error("Błąd autoryzacji: Nie można uzyskać tokenu z FatSecret.");
    }

    try {
        const response = await fetch(NUTRITION_ENDPOINT_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json' 
            },
            body: JSON.stringify(payload)
        });

        console.log(`FatSecret API zwróciło status: ${response.status}`); 

        if (response.ok) {
            return await response.json();
        } 
        
        const status = response.status;
        const responseBodyText = await response.text();
        
        // Ponowna próba w przypadku błędu autoryzacji (401) lub błędu serwera (500)
        if ((status === 401 || status === 500) && !isRetry) {
            console.log(`Odebrano błąd ${status}. Resetuję token i ponawiam próbę...`);
            accessToken = null;
            tokenExpiryTime = 0;
            // Ponowienie próby
            return callFatSecretApi(payload, true);
        }

        // Obsługa błędów, które nie są rozwiązywane przez ponowienie
        try {
            const errorJson = JSON.parse(responseBodyText);
            throw new Error(`FatSecret API Błąd (${status}): ${JSON.stringify(errorJson)}`);
        } catch (e) {
            throw new Error(`Błąd FatSecret API (${status}): Otrzymano nieoczekiwaną odpowiedź (nie JSON).`);
        }

    } catch (error) {
        // Błędy sieciowe (np. FetchError: invalid json response body)
        throw error;
    }
}


// -------------------------------------------------------------------
// 3. ROUTING
// -------------------------------------------------------------------

// Endpoint testowy (GET)
app.get('/', (req, res) => {
    res.send('Serwer proxy działa. Użyj [POST] /api/nutrition');
});

// Główny endpoint proxy (POST)
app.post('/api/nutrition', async (req, res) => {
    const ingredients = req.body.ingredients;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "Wymagana tablica 'ingredients' w ciele żądania." });
    }

    // 1. Stworzenie listy składników w formacie FatSecret
    const recipeIngredients = ingredients.map((item) => ({
        ingredient_id: crypto.randomUUID(), 
        food_entry: item
    }));

    // 2. Generowanie unikalnego ID dla posiłku
    const mealId = crypto.randomUUID(); 

    // 3. Konstruowanie ładunku do wysłania
    const fatSecretPayload = {
        method: "recipe.get_nutrition",
        format: "json", 
        meal_id: mealId, 
        recipe_type: "any", 
        ingredients: recipeIngredients
    };

    console.log(`Odebrano zapytanie dla: ${ingredients.length} składników. Wysyłanie żądania do ${NUTRITION_ENDPOINT_URL}...`);

    try {
        const data = await callFatSecretApi(fatSecretPayload);
        
        // 4. Przetwarzanie i walidacja odpowiedzi FatSecret
        if (data.result && data.result.nutrition_per_serving) {
            const nutrition = data.result.nutrition_per_serving;

            // Zabezpieczenie: konwertujemy każdą wartość na liczbę zmiennoprzecinkową (Double)
            // Używamy parseFloat() i zwracamy 0.0 w przypadku null/undefined/braku
            const safeParse = (value) => {
                const num = parseFloat(value);
                return isNaN(num) ? 0.0 : num;
            };

            const nutritionInfo = {
                // Konieczne jest użycie bezpiecznego parsowania, aby upewnić się, że Swift dostanie liczbę.
                calories: safeParse(nutrition.calories),
                fat: safeParse(nutrition.fat),
                carbohydrates: safeParse(nutrition.carbohydrate), // Poprawna nazwa pola w FatSecret
                protein: safeParse(nutrition.protein)
            };

            // 5. Odesłanie przetworzonych danych do aplikacji iOS
            return res.json(nutritionInfo);
        } else {
            // Obsługa nieoczekiwanej struktury odpowiedzi 
            console.error("Nieprawidłowa struktura odpowiedzi FatSecret lub brak danych odżywczych w 'nutrition_per_serving'.", data);
            return res.status(502).json({ 
                error: "Nieprawidłowa struktura odpowiedzi z API FatSecret.",
                details: data
            });
        }
    } catch (error) {
        const errorMessage = error.message || "Wystąpił nieznany błąd serwera.";
        return res.status(500).json({ error: errorMessage });
    }
});


// Uruchomienie serwera
app.listen(PORT, () => {
    console.log(`Serwer proxy działa na porcie ${PORT}`);
    // Spróbuj pobrać token przy starcie
    getAccessToken();
});