/**
 * Serwer proxy Node.js dla aplikacji RecipePlanner.
 * Umożliwia bezpieczne obliczanie wartości odżywczych dla listy składników
 * poprzez skalowanie wyników FatSecret API przez podaną liczbę porcji.
 */

// Importowanie wymaganych bibliotek
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfiguracja FatSecret API (zmienne środowiskowe)
const FATSECRET_API_KEY = process.env.FATSECRET_API_KEY || 'TWOJ_KLUCZ_API'; // Zmień na swój klucz
const FATSECRET_BASE_URL = 'https://platform.fatsecret.com/rest/server.api';

// Middleware
app.use(cors()); // Zezwolenie na CORS
app.use(express.json()); // Obsługa JSON w body żądania

// --- Funkcja Pomocnicza do Zabezpieczania i Konwersji Wartości Odżywczych ---
const ensureDouble = (value) => {
    // Sprawdzenie, czy wartość nie jest null, undefined, pustym ciągiem lub nie jest skończoną liczbą
    if (value === null || value === undefined || value === "" || !isFinite(Number(value))) {
        return 0.0;
    }
    // Zwrócenie wartości jako Double
    return Number(value);
};

// --- Główny Endpoint dla Danych Odżywczych ---
app.post('/api/nutrition', async (req, res) => {
    // 1. Walidacja danych wejściowych
    const { ingredients, servings } = req.body;
    
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: 'Lista składników jest pusta lub nieprawidłowa.' });
    }
    
    // Ustalenie liczby porcji (domyślnie 1, jeśli nie podano lub jest nieprawidłowa)
    const servingsCount = ensureDouble(servings) > 0 ? ensureDouble(servings) : 1.0;
    
    console.log(`[Proxy] Otrzymano żądanie: ${ingredients.length} składników, porcji: ${servingsCount}`);

    // 2. Budowa ciała żądania do FatSecret API
    const fatSecretParams = new URLSearchParams();
    fatSecretParams.append('method', 'recipe_finder.get_nutrition_by_ingredients');
    fatSecretParams.append('ingredients', JSON.stringify(ingredients)); // FatSecret oczekuje tablicy w JSON stringu
    fatSecretParams.append('format', 'json');
    fatSecretParams.append('recipe_finder_api_key', FATSECRET_API_KEY);
    
    try {
        // 3. Wykonanie żądania do FatSecret
        const fsResponse = await fetch(`${FATSECRET_BASE_URL}?${fatSecretParams.toString()}`, {
            method: 'GET' // Mimo dużego body, FatSecret używa GET/POST, ale dla tego endpointu dokumentacja sugeruje GET z zakodowanymi parametrami URL
        });

        const fsData = await fsResponse.json();
        
        // 4. Obsługa błędów zwróconych przez FatSecret
        if (fsData.error) {
            console.error('[FatSecret Error]', fsData.error);
            return res.status(502).json({ error: `Błąd API FatSecret: ${fsData.error.message || 'Nieznany błąd.'}` });
        }
        
        const nutritionData = fsData.nutrition_per_serving;

        // 5. Walidacja i przetwarzanie odpowiedzi
        if (!nutritionData) {
            console.warn('[Proxy Warning] FatSecret nie zwrócił danych odżywczych (nutrition_per_serving). Zwracam 0.0.');
            // Zwrócenie zerowych danych w przypadku braku wyników
            return res.json({
                calories: 0.0, fat: 0.0, carbohydrates: 0.0, protein: 0.0
            });
        }
        
        // 6. Skalowanie wartości odżywczych i zabezpieczenie typów
        const totalNutrition = {
            // Użycie funkcji ensureDouble i pomnożenie przez servingsCount
            calories: ensureDouble(nutritionData.calories) * servingsCount,
            fat: ensureDouble(nutritionData.fat) * servingsCount,
            carbohydrates: ensureDouble(nutritionData.carbohydrate) * servingsCount, // UWAGA: pole to 'carbohydrate', nie 'carbohydrates'
            protein: ensureDouble(nutritionData.protein) * servingsCount,
        };

        // 7. Zwrócenie wyniku do aplikacji iOS
        console.log(`[Proxy] Pomyślnie przetworzono i przeskalowano dane. Kcal (cała potrawa): ${totalNutrition.calories.toFixed(0)}`);
        res.json(totalNutrition);

    } catch (error) {
        // Obsługa błędów sieci lub innych nieoczekiwanych awarii
        console.error('[Proxy Critical Error]', error.message);
        // Zwrócenie błędu 500 do klienta Swift
        res.status(500).json({ error: `Wewnętrzny błąd serwera proxy: ${error.message}` });
    }
});

// --- Inne Endpoiny ---
app.get('/', (req, res) => {
    res.send('Serwer proxy FatSecret działa poprawnie. Użyj endpointu POST /api/nutrition.');
});

// Uruchomienie serwera
app.listen(PORT, () => {
    console.log(`Serwer proxy działa na porcie ${PORT}`);
});