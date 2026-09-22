const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());

// Sert les fichiers statiques (index.html, css/, js/, etc.)
app.use(express.static(__dirname));

const ADE_URL = "https://edt.univ-littoral.fr/jsp/custom/modules/plannings/OnEMEVnr.shu?days=60";
const CACHE_DUREE_MS = 5 * 60 * 1000; // 5 minutes

let cache = { ics: null, date: 0 };

app.get('/api/edt', async (req, res) => {
    const maintenant = Date.now();
    const forcer = req.query.refresh === '1';
    const cacheValide = cache.ics && (maintenant - cache.date) < CACHE_DUREE_MS;

    res.set('Content-Type', 'text/calendar; charset=utf-8');

    if (cacheValide && !forcer) {
        res.set('X-Cache', 'HIT');
        return res.send(cache.ics);
    }

    try {
        const response = await axios.get(ADE_URL, {
            timeout: 5000,
            responseType: 'text',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/calendar,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });
        cache = { ics: response.data, date: maintenant };
        res.set('X-Cache', 'MISS');
        res.send(response.data);
    } catch (error) {
        console.error("Erreur lors de la récupération d'ADE :", error.message);

        if (cache.ics) {
            res.set('X-Cache', 'STALE');
            return res.send(cache.ics);
        }
        res.status(502).type('text/plain').send("Impossible de joindre ADE");
    }
});

// Redirection pour les requêtes inconnues vers l'accueil
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});