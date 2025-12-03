const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Zmienne środowiskowe, które muszą być ustawione w Render.com
const CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;
const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';

// --- KLUCZOWA POPRAWKA ADRESÓW URL ---
// 1. Definiujemy BAZOWY URL API, ale TYLKO do autoryzacji
const API_BASE_URL = 'https://platform.fatsecret.com'; 

// 2. Definiujemy DOKŁADNY, PEŁNY URL dla obliczeń odżywczych (OAuth 2.0)
// To jest poprawna ścieżka dla tej metody w nowym API
const NUTRITION_ENDPOINT_URL = `${API_BASE_URL}/2.0/recipe/nutrition`; 
// ------------------------------------

// Stan tokenu
let accessToken = null;
let tokenExpiryTime = 0; // Czas w milisekundach

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// -------------------------------------------------------------------
// 1. ZARZĄDZANIE AUTORYZACJĄ (OAuth 2.0)
// -------------------------------------------------------------------

async function getFatSecretToken() {
    // Sprawdzenie, czy token jest nadal ważny (dajemy 60 sekund zapasu)
    if (accessToken && Date.now() < tokenExpiryTime - 60000) {
        console.log("Używam istniejącego tokenu.");
        return accessToken;
    }

    console.log("Odświeżam/Pobieram nowy token OAuth...");

    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("Błąd: FATSECRET_CLIENT_ID lub FATSECRET_CLIENT_SECRET nie są ustawione.");
        return null;
    }

    const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    
    try {
        const tokenResponse = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${authHeader}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials&scope=basic'
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error(`Błąd podczas pobierania tokenu OAuth: ${tokenResponse.status} ${tokenResponse.statusText}. Odpowiedź: ${errorText}`);
            return null;
        }

        const tokenData = await tokenResponse.json();
        accessToken = tokenData.access_token;
        tokenExpiryTime = Date.now() + (tokenData.expires_in * 1000);
        
        console.log("Pomyślnie uzyskano nowy token. Ważny do:", new Date(tokenExpiryTime).toLocaleString());
        return accessToken;

    } catch (error) {
        console.error("Wyjątek podczas pobierania tokenu FatSecret:", error);
        return null;
    }
}

// -------------------------------------------------------------------
// 2. LOGIKA PROXY DLA OBLICZANIA ODŻYWIANIA
// -------------------------------------------------------------------

// Endpoint testowy (GET)
app.get('/', (req, res) => {
    res.send('Serwer proxy działa. Użyj [POST] /api/nutrition');
});

// Główny endpoint proxy (POST)
app.post('/api/nutrition', async (req, res) => {
    const { ingredients, servings } = req.body;
    
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({ error: "Brak listy 'ingredients' w żądaniu." });
    }

    const token = await getFatSecretToken();
    if (!token) {
        return res.status(502).json({ error: "Nie udało się uzyskać tokenu autoryzacji FatSecret." });
    }
    
    // Obiekt żądania FatSecret (jak w dokumentacji)
    // UWAGA: Dla tego endpointu (API 2.0) używamy method: "recipe.get_nutrition"
    const fatSecretPayload = {
        method: "recipe.get_nutrition",
        format: "json", // Żądamy formatu JSON
        ingredients: ingredients,
        servings: servings || 1 
    };
    
    // --- ZMIENIONO LINIĘ LOGOWANIA, ABY POKAZAĆ POPRAWNY ENDPOINT ---
    console.log(`Odebrano zapytanie dla: ${ingredients.length} składników. Wysyłanie żądania do ${NUTRITION_ENDPOINT_URL}...`);

    try {
        // --- KLUCZOWA POPRAWKA: Używamy zdefiniowanej stałej NUTRITION_ENDPOINT_URL ---
        const response = await fetch(NUTRITION_ENDPOINT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(fatSecretPayload)
        });
        // -------------------------------------------------------------------------

        // Sprawdzenie, czy odpowiedź HTTP jest pomyślna
        if (!response.ok) {
            const responseText = await response.text();
            
            // Logowanie diagnostyczne
            console.error(`BŁĄD ZWROTNY Z FATSECRET: Status: ${response.status} (${response.statusText})`);
            
            // Jeśli status to 401, token jest nieprawidłowy/wygasł
            if (response.status === 401) {
                accessToken = null; 
                return res.status(401).json({ error: "Autoryzacja FatSecret nie powiodła się. Token może być nieprawidłowy/wygasły." });
            }
            
            // Próbujemy sparsować błąd jako JSON, jeśli się nie uda, zwracamy ogólny błąd
            try {
                const errorJson = JSON.parse(responseText);
                return res.status(500).json({ error: errorJson.error?.message || "Błąd serwera FatSecret." });
            } catch {
                // Jeśli nie da się sparsować na JSON (jak w przypadku błędu XML/HTML), zwracamy błąd 500
                return res.status(500).json({ error: "FatSecret zwrócił nieoczekiwaną odpowiedź (nie JSON). Sprawdź logi FatSecret. Prawdopodobnie błąd składni żądania." });
            }
        }

        // Parsowanie odpowiedzi (powinna być JSON)
        const data = await response.json();
        
        // Zwracanie odpowiedzi do klienta mobilnego
        res.json(data);

    } catch (error) {
        console.error("Błąd podczas komunikacji z API FatSecret:", error);
        res.status(500).json({ error: "Błąd serwera proxy: Wewnętrzny błąd komunikacji." });
    }
});

// Uruchomienie serwera
app.listen(PORT, async () => {
    console.log(`Serwer proxy działa na porcie ${PORT}`);
    await getFatSecretToken();
});