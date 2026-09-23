const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// URL officielle du flux iCal ADE ULCO
const ADE_ICAL_URL = "https://edt.univ-littoral.fr/jsp/custom/modules/plannings/OnEMEVnr.shu?days=60";

// Configuration Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Fichiers statiques
app.use(express.static(__dirname));

// --- ROUTE 1 : PROXY ADE (EMPLOI DU TEMPS) ---
let cacheICS = null;
let lastFetch = 0;
const CACHE_DURATION = 15 * 60 * 1000; // Cache 15 min

app.get('/api/edt', async (req, res) => {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    if (!forceRefresh && cacheICS && (now - lastFetch < CACHE_DURATION)) {
        return res.type('text/calendar').send(cacheICS);
    }

    try {
        const response = await fetch(ADE_ICAL_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (!response.ok) {
            throw new Error(`Erreur ADE: ${response.status}`);
        }

        const data = await response.text();
        cacheICS = data;
        lastFetch = now;

        res.type('text/calendar').send(data);
    } catch (error) {
        console.error("Erreur Proxy ADE :", error.message);
        if (cacheICS) {
            return res.setHeader('X-Cache', 'STALE').type('text/calendar').send(cacheICS);
        }
        res.status(502).json({ error: "Impossible de joindre les serveurs ADE" });
    }
});

// --- ROUTE 2 : SCAN NFC (RASPBERRY PI) ---
app.post('/api/nfc', (req, res) => {
    const { uid } = req.body;
    console.log(`[NFC SCAN DETECTÉ] UID Card: ${uid}`);
    
    // Diffusion temps réel vers Render / Navigateur
    io.emit('nfc-scan', { uid: String(uid) });
    
    res.json({ status: 'success', uid });
});

// --- ROUTES 3 : SYNCHRONISATION RASPBERRY PI ---
// Envoi des étudiants au Raspberry Pi
app.get('/api/etudiants', (req, res) => {
    // Si tu utilises une BDD PostgreSQL sur Render, remplace cette réponse par la requête BDD
    res.json([]);
});

// Envoi des professeurs au Raspberry Pi
app.get('/api/professeurs', (req, res) => {
    // Si tu utilises une BDD PostgreSQL sur Render, remplace cette réponse par la requête BDD
    res.json([]);
});

io.on('connection', (socket) => {
    console.log('Client Web connecté ID:', socket.id);
});

// Port dynamique Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});