import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto'; // Moduł do generowania UUID
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// FatSecret API Configuration
const FATSECRET_API_KEY = process.env.FATSECRET_API_KEY;
const FATSECRET_API_SECRET = process.env.FATSECRET_API_SECRET;
const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const NUTRITION_ENDPOINT_BASE = 'https://platform.fatsecret.com';
const NUTRITION_ENDPOINT_PATH = '/2.0/recipe/nutrition';
const NUTRITION_ENDPOINT_URL = NUTRITION_ENDPOINT_BASE + NUTRITION_ENDPOINT_PATH;

if (!FATSECRET_API_KEY || !FATSECRET_API_SECRET) {
    console.error("FATSECRET_API_KEY or FATSECRET_API_SECRET is missing. Check your .env file.");
    process.exit(1);
}

// Global variable for the access token and its expiry time
let accessToken = null;
let tokenExpiryTime = 0; // Timestamp (in ms) when the token expires

// Middleware to parse JSON bodies
app.use(express.json());

/**
 * Pobiera nowy token dostępu OAuth 2.0 (Client Credentials Grant).
 * @returns {Promise<string>} Token dostępu.
 */
async function getAccessToken() {
    // Sprawdzenie, czy token jest ważny
    if (accessToken && Date.now() < tokenExpiryTime) {
        console.log("Używam istniejącego, ważnego tokenu.");
        return accessToken;
    }

    console.log("Pobieram/odświeżam nowy token dostępu...");
    
    // Tworzenie nagłówka Authorization (Basic Base64(client_id:client_secret))
    const credentials = Buffer.from(`${FATSECRET_API_KEY}:${FATSECRET_API_SECRET}`).toString('base64');

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
            throw new Error(`Błąd FatSecret OAuth (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        
        // Zapisanie nowego tokenu i ustawienie czasu wygaśnięcia
        accessToken = data.access_token;
        // Ustawienie wygaśnięcia na 5 minut przed faktycznym końcem (dla bezpieczeństwa)
        tokenExpiryTime = Date.now() + (data.expires_in * 1000) - (5 * 60 * 1000); 

        console.log("Token dostępu pomyślnie odświeżony.");
        return accessToken;

    } catch (error) {
        console.error("Krytyczny błąd podczas pobierania tokenu dostępu:", error.message);
        // Resetowanie tokenu, aby wymusić ponowną próbę przy następnym wywołaniu
        accessToken = null;
        tokenExpiryTime = 0;
        throw new Error("Błąd autoryzacji z FatSecret.");
    }
}

/**
 * Wykonuje żądanie do FatSecret API z obsługą tokenu.
 * Wprowadzono logikę ponawiania prób w przypadku błędu 500/401, co sugeruje problem z tokenem.
 * @param {object} payload - Ładunek JSON do wysłania do API.
 * @param {boolean} isRetry - Flaga wskazująca, czy jest to ponowna próba po niepowodzeniu.
 */
async function callFatSecretApi(payload, isRetry = false) {
    let token;
    try {
        // 1. Pobierz lub odśwież token
        token = await getAccessToken();
    } catch (authError) {
        throw authError; // Wyrzuć błąd autoryzacji, jeśli nie udało się go uzyskać
    }

    try {
        // 2. Wykonaj żądanie do API
        const response = await fetch(NUTRITION_ENDPOINT_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                // Upewniamy się, że API wie, że oczekujemy JSON
                'Accept': 'application/json' 
            },
            body: JSON.stringify(payload)
        });

        // 3. Obsługa odpowiedzi
        // Logowanie statusu, aby zdiagnozować błąd 500
        console.log(`FatSecret API zwróciło status: ${response.status}`); 

        if (response.ok) {
            // Pomyślna odpowiedź 200 OK
            return await response.json();
        } 
        
        // Obsługa nieudanych odpowiedzi (np. 400, 401, 500)
        const status = response.status;
        const responseBodyText = await response.text();
        
        // 4. Obsługa błędu autoryzacji (401) lub błędu serwera (500)
        if ((status === 401 || status === 500) && !isRetry) {
            console.log(`Odebrano błąd ${status}. Resetuję token i ponawiam próbę...`);
            // Resetowanie tokenu, aby wymusić jego odświeżenie
            accessToken = null;
            tokenExpiryTime = 0;
            // Ponowienie próby
            return callFatSecretApi(payload, true);
        }

        // 5. Obsługa błędów, które nie są rozwiązywane przez ponowienie
        try {
            // Spróbuj sparsować JSON błędu, jeśli FatSecret zwrócił go poprawnie (np. 400 Bad Request)
            const errorJson = JSON.parse(responseBodyText);
            throw new Error(`FatSecret API Błąd (${status}): ${JSON.stringify(errorJson)}`);
        } catch (e) {
            // Jeśli parsowanie JSON się nie powiodło (np. otrzymaliśmy HTML ze strony /error/500)
            throw new Error(`Błąd FatSecret API (${status}): ${responseBodyText.substring(0, 100)}... (Brak poprawnego JSON błędu)`);
        }

    } catch (error) {
        // Błędy sieciowe (np. FetchError: invalid json response body)
        console.error("Błąd podczas komunikacji z API FatSecret:", error);
        throw error;
    }
}


// MAIN ROUTE
app.post('/api/nutrition', async (req, res) => {
    const ingredients = req.body.ingredients;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "Wymagana tablica 'ingredients' w ciele żądania." });
    }

    // 1. Stworzenie listy składników w formacie FatSecret
    const recipeIngredients = ingredients.map((item, index) => ({
        // Użycie unikalnego ID dla każdego składnika
        ingredient_id: crypto.randomUUID(), 
        food_entry: item
    }));

    // 2. Generowanie unikalnego ID dla posiłku (być może brak tego ID powodował błąd 500)
    const mealId = crypto.randomUUID(); 

    // 3. Konstruowanie ładunku do wysłania
    const fatSecretPayload = {
        // Wymagana metoda dla tego endpointu
        method: "recipe.get_nutrition",
        // Format, chociaż i tak wysyłamy JSON
        format: "json", 
        // Wymagane pola dla Recipe Nutrition API
        meal_id: mealId, 
        recipe_type: "any", // Można dostosować, ale 'any' jest bezpieczne
        ingredients: recipeIngredients
    };

    console.log(`Odebrano zapytanie dla: ${ingredients.length} składników. Wysyłanie żądania do ${NUTRITION_ENDPOINT_URL}...`);
    // console.log("Ładunek do FatSecret:", JSON.stringify(fatSecretPayload, null, 2)); // W razie problemów odkomentuj to!


    try {
        const data = await callFatSecretApi(fatSecretPayload);
        
        // 4. Przetwarzanie i walidacja odpowiedzi FatSecret
        if (data.result && data.result.nutrition_per_serving) {
            const nutrition = data.result.nutrition_per_serving;

            // Ekstrakcja kluczowych danych odżywczych
            const nutritionInfo = {
                calories: nutrition.calories,
                fat: nutrition.fat,
                carbohydrates: nutrition.carbohydrate, // W FatSecret to 'carbohydrate', nie 'carbohydrates'
                protein: nutrition.protein
            };

            // 5. Odesłanie przetworzonych danych do aplikacji iOS
            return res.json(nutritionInfo);
        } else {
            // Obsługa nieoczekiwanej struktury odpowiedzi
            console.error("Nieprawidłowa struktura odpowiedzi FatSecret:", data);
            return res.status(502).json({ 
                error: "Nieprawidłowa struktura odpowiedzi z API FatSecret.",
                details: data
            });
        }
    } catch (error) {
        // Przechwycenie błędu z callFatSecretApi (autoryzacja, sieć, FatSecret)
        const errorMessage = error.message || "Wystąpił nieznany błąd serwera.";
        // Wysłanie błędu do klienta (iOS) z kodem 500
        return res.status(500).json({ error: errorMessage });
    }
});


// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start the server
app.listen(port, () => {
    console.log(`Serwer proxy nasłuchuje na porcie ${port}`);
});