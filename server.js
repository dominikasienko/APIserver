const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// --- WSTAW SWOJE KLUCZE BEZPIECZNIE ---
// Na produkcji, te wartości MUSZĄ pochodzić ze zmiennych środowiskowych
// (np. process.env.FATSECRET_CLIENT_ID)
const FATSECRET_CLIENT_ID = "174b384c16f74a8a90d18346a1f77bb1"; // Zastąp swoim Client ID
const FATSECRET_CLIENT_SECRET = "33186fe03c3c4bb283d37a61097f1903"; // Zastąp swoim Client Secret

// Zmienne globalne do przechowywania tokena dostępu
let accessToken = null;
let tokenExpiry = 0;

/**
 * Pobiera token dostępu OAuth 2.0 z FatSecret.
 * Token jest buforowany, aby uniknąć ponownego żądania przy każdym wywołaniu.
 */
async function getAccessToken() {
    // Jeśli token istnieje i jest ważny (ma > 60s do wygaśnięcia)
    if (accessToken && Date.now() < tokenExpiry - 60000) {
        return accessToken;
    }

    console.log("Generowanie nowego tokena dostępu FatSecret...");
    const url = 'https://oauth.fatsecret.com/connect/token';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'basic'); // 'basic' lub 'premier' w zależności od Twojego planu

    const headers = {
        // Używa Client ID i Secret do uwierzytelnienia się i uzyskania tokena
        'Authorization': 'Basic ' + Buffer.from(`${FATSECRET_CLIENT_ID}:${FATSECRET_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    try {
        const response = await axios.post(url, params, { headers });
        accessToken = response.data.access_token;
        // Ustaw czas wygaśnięcia (np. 3600 sekund * 1000 ms)
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        console.log("Pomyślnie uzyskano nowy token.");
        return accessToken;
    } catch (error) {
        console.error("Błąd podczas uzyskiwania tokena FatSecret:", error.response ? error.response.data : error.message);
        // Jeśli nie można uzyskać tokena, zatrzymaj działanie
        throw new Error("Nie można uwierzytelnić się w FatSecret. Sprawdź klucze.");
    }
}

/**
 * Główny punkt końcowy, który wywołuje Twoja aplikacja Swift.
 * Oczekuje JSON: { "ingredients": ["1 cup flour", "2 large eggs"], "servings": 4 }
 */
app.post('/api/nutrition', async (req, res) => {
    // Pobierz dane z aplikacji mobilnej
    const { ingredients, servings } = req.body;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Pole "ingredients" jest wymagane i musi być tablicą.' });
    }
    
    const numServings = servings || 1; // Domyślnie 1 porcja

    try {
        // 1. Zdobądź token dostępu (lub użyj buforowanego)
        const token = await getAccessToken();
        const apiUrl = 'https://platform.fatsecret.com/rest/v4/recipe.nutrition.v1';
        
        // 2. Przygotuj ciało żądania dla FatSecret
        const body = {
            recipe_ingredients: {
                ingredient_description: ingredients
            },
            number_of_servings: numServings, 
            nutrient_selection: "calories,fat.total_fat,carbohydrates.total_carbohydrate,protein"
        };

        const headers = {
            // Użyj tokena w nagłówku "Bearer"
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
            return res.status(404).json({ error: 'Nie można znaleźć danych "per_serving_basis" w odpowiedzi API.' });
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
        console.error("Błąd serwera proxy:", error.response ? error.response.data : error.message);
        // Zwróć ogólny błąd, aby nie ujawniać wewnętrznych szczegółów
        return res.status(500).json({ error: 'Wewnętrzny błąd serwera podczas przetwarzania żądania.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serwer proxy FatSecret działa na porcie ${PORT}`);
});
