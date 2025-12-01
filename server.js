const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// --- BEZPIECZNA KONFIGURACJA KLUCZY ---
// WAŻNE: Na produkcji (Render.com) musisz ustawić te zmienne
// środowiskowe w panelu Render.com, aby te wartości działały.
// Nigdy nie zapisuj kluczy bezpośrednio w kodzie na produkcji!
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID; 
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

// Zmienne globalne do przechowywania tokena dostępu
let accessToken = null;
let tokenExpiry = 0;

/**
 * Endpoint zdrowia: Sprawdza, czy serwer działa.
 * Musi obsługiwać GET, aby Render.com wiedział, że usługa jest aktywna.
 */
app.get('/', (req, res) => {
    // --- DODANO TĘ FUNKCJĘ ---
    // Odpowiedź na żądanie GET
    res.status(200).send("FatSecret Nutrition Proxy Server is running and healthy. Endpoint for Nutrition calculation is POST /api/nutrition.");
});

/**
 * Pobiera token dostępu OAuth 2.0 z FatSecret.
 * Token jest buforowany, aby uniknąć ponownego żądania przy każdym wywołaniu.
 */
async function getAccessToken() {
    // 1. Walidacja kluczy
    if (!FATSECRET_CLIENT_ID || !FATSECRET_CLIENT_SECRET) {
        throw new Error("FATSECRET_CLIENT_ID lub FATSECRET_CLIENT_SECRET nie są ustawione w zmiennych środowiskowych.");
    }
    
    // Jeśli token istnieje i jest ważny (ma > 60s do wygaśnięcia)
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
        // Ustaw czas wygaśnięcia
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        console.log("Pomyślnie uzyskano nowy token.");
        return accessToken;
    } catch (error) {
        console.error("Błąd podczas uzyskiwania tokena FatSecret:", error.response ? error.response.data : error.message);
        throw new Error("Nie można uwierzytelnić się w FatSecret. Sprawdź klucze API.");
    }
}

/**
 * Główny punkt końcowy, który wywołuje Twoja aplikacja Swift.
 * Obsługuje żądania POST z listy składników.
 */
app.post('/api/nutrition', async (req, res) => {
    // Pobierz dane z aplikacji mobilnej
    const { ingredients, servings } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Pole "ingredients" jest wymagane i musi być niepustą tablicą.' });
    }
    
    // Użyj 'servings' z body lub domyślnie 1
    const numServings = servings || 1; 

    try {
        // 1. Zdobądź token dostępu (lub użyj buforowanego)
        const token = await getAccessToken();
        const apiUrl = 'https://platform.fatsecret.com/rest/v4/recipe.nutrition.v1';
        
        // 2. Przygotuj ciało żądania dla FatSecret
        const body = {
            recipe_ingredients: {
                ingredient_description: ingredients
            },
            // FatSecret API oczekuje liczby całkowitej lub typu float.
            number_of_servings: numServings, 
            nutrient_selection: "calories,fat.total_fat,carbohydrates.total_carbohydrate,protein"
        };

        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };

        // 3. Wyślij żądanie do FatSecret
        const nutritionResponse = await axios.post(apiUrl, body, { headers });
        
        // 4. Przetwórz i wyodrębnij dane
        const servingNutrition = nutritionResponse.data
            ?.recipe_nutrition
            ?.nutrient_summary
            ?.nutrient_values
            ?.find(val => val.unit_of_measure === 'per_serving_basis');

        if (!servingNutrition) {
            // Może się zdarzyć, jeśli FatSecret nie znalazł żadnych danych dla składników
            return res.status(404).json({ error: 'Nie można obliczyć wartości odżywczych dla podanych składników.' });
        }

        // 5. Zwróć czystą, bezpieczną odpowiedź do aplikacji Swift
        const appResponse = {
            calories: servingNutrition.calories.value,
            fat: servingNutrition.fat.total_fat.value,
            carbohydrates: servingNutrition.carbohydrates.total_carbohydrate.value,
            protein: servingNutrition.protein.value
        };

        return res.status(200).json(appResponse);

    } catch (error) {
        // Logowanie szczegółów dla nas
        console.error("Błąd serwera proxy:", error.response?.data || error.message);
        
        // Sprawdź, czy błąd pochodzi z FatSecret (może być błąd 400/401)
        if (error.response?.status === 401) {
            return res.status(401).json({ error: 'Błąd uwierzytelnienia w FatSecret. Sprawdź klucze i token.' });
        }

        // Zwróć ogólny błąd dla klienta
        return res.status(500).json({ error: 'Wewnętrzny błąd serwera podczas przetwarzania żądania.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serwer proxy FatSecret działa na porcie ${PORT}`);
});
