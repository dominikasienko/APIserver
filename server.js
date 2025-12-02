const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Zmienne środowiskowe, które muszą być ustawione w Render.com
const CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;
const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const API_BASE_URL = 'https://platform.fatsecret.com/rest/server.api'; 
// UWAGA: Mimo że token jest uzyskiwany z oauth.fatsecret.com, API dla odżywiania jest pod platform.fatsecret.com

// Stan tokenu
let accessToken = null;
let tokenExpiryTime = 0; // Czas w milisekundach

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' })); // Aby obsługiwać duże żądania POST

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
        // Ustawienie czasu wygaśnięcia (tokenData.expires_in jest w sekundach)
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
    const fatSecretPayload = {
        method: "recipe.get_nutrition",
        format: "json", // ZAWSZE żądamy formatu JSON
        ingredients: ingredients,
        servings: servings || 1 // Domyślnie 1 porcja
    };
    
    console.log(`Odebrano zapytanie dla: ${ingredients.length} składników. Wysyłanie żądania do /2.0/recipe/nutrition...`);

    try {
        const response = await fetch(`${API_BASE_URL}/2.0/recipe/nutrition`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(fatSecretPayload)
        });

        // Sprawdzenie, czy odpowiedź HTTP jest pomyślna
        if (!response.ok) {
            const responseText = await response.text();
            
            // NOWE, LEPSZE LOGOWANIE DIAGNOSTYCZNE
            console.error(`BŁĄD ZWROTNY Z FATSECRET: Status: ${response.status} (${response.statusText})`);
            console.error(`Oczekiwano JSON, otrzymano: ${responseText.substring(0, 500)}...`);
            
            // Jeśli status to 401, token jest nieprawidłowy/wygasł
            if (response.status === 401) {
                // Wymuszamy odświeżenie tokenu przy następnym żądaniu
                accessToken = null; 
                return res.status(401).json({ error: "Autoryzacja FatSecret nie powiodła się. Token może być nieprawidłowy/wygasły." });
            }
            
            // Zwracamy ogólny błąd serwera
            return res.status(500).json({ error: "Błąd serwera proxy: FatSecret zwrócił błąd." });
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
    // Spróbuj pobrać token przy starcie
    await getFatSecretToken();
});