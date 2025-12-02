const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors({
    origin: '*'
}));

app.use(express.json());

app.post('/api/nutrition', async (req, res) => {
    try {
        const { ingredients, servings } = req.body;
        
        if (!ingredients || ingredients.length === 0) {
            return res.status(400).json({ error: 'Brak składników w zapytaniu.' });
        }
        
        const FATSECRET_API_KEY = 'YOUR_API_KEY';
        const FATSECRET_API_URL = 'https://platform.fatsecret.com/rest/server.api';
        
        const ingredientString = ingredients.join(', ');
        
        const response = await axios.get(FATSECRET_API_URL, {
            params: {
                method: 'foods.search.v2',
                format: 'json',
                search_expression: ingredientString,
                max_results: 1
            },
            headers: {
                Authorization: `Bearer ${FATSECRET_API_KEY}`
            }
        });

        const foodItems = response.data.foods.food;
        
        if (!foodItems || foodItems.length === 0) {
            return res.status(404).json({ error: 'Nie znaleziono danych odżywczych dla podanych składników.' });
        }
        
        const food = foodItems[0];
        
        const nutritionInfo = {
            calories: food.calories * servings,
            fat: food.fat * servings,
            carbohydrates: food.carbohydrate * servings,
            protein: food.protein * servings
        };

        res.json(nutritionInfo);
    } catch (error) {
        console.error('Błąd serwera proxy:', error.message);
        res.status(500).json({ error: 'Wewnętrzny błąd serwera. Sprawdź dzienniki.' });
    }
});

app.listen(PORT, () => {
    console.log(`Serwer proxy działa na porcie ${PORT}`);
});
