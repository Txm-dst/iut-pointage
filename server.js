const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

// Configuration de la connexion PostgreSQL
// Configuration de la connexion PostgreSQL avec prise en charge de DATABASE_URL
const pool = new Pool(
    process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false } // Indispensable pour Supabase / Render
        }
      : {
          user: process.env.PGUSER || 'postgres',
          host: process.env.PGHOST || 'localhost',
          database: process.env.PGDATABASE || 'pointage_iut',
          password: process.env.PGPASSWORD || 'Tom62800',
          port: process.env.PGPORT || 5432,
        }
  );

// Test de connexion à la base de données
pool.connect((err, client, release) => {
  if (err) {
    console.error('Erreur de connexion à PostgreSQL :', err.stack);
  } else {
    console.log('Connecté avec succès à la base PostgreSQL pointage_iut');
    release();
  }
});

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
const CACHE_DURATION = 15 * 60 * 1000;

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

// --- ROUTE 2 : POINTAGE / SCAN NFC (RASPBERRY PI) ---
app.post(['/api/nfc', '/api/pointage'], async (req, res) => {
    const { uid, id_nfc, timestamp } = req.body;
    const nfc_code = String(uid || id_nfc);
    
    console.log(`[POINTAGE REÇU] Badge UID: ${nfc_code}`);

    try {
        // Enregistrement réel en BDD PostgreSQL
        const insertQuery = `
            INSERT INTO pointages (id_badge, horodatage)
            VALUES ($1, COALESCE($2::timestamp, NOW()))
            RETURNING *;
        `;
        const result = await pool.query(insertQuery, [nfc_code, timestamp || null]);

        // Diffusion temps réel en WebSockets vers l'interface web
        io.emit('nfc-scan', { uid: nfc_code, pointage: result.rows[0] });

        res.json({ status: 'success', data: result.rows[0] });
    } catch (err) {
        console.error('Erreur lors de l insertion en BDD :', err.message);
        res.status(500).json({ error: 'Erreur BDD', details: err.message });
    }
});

// --- ROUTES 3 : SYNCHRONISATION ÉTUDIANTS / ENSEIGNANTS ---
app.get('/api/etudiants', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM etudiants');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/professeurs', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM enseignants');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

io.on('connection', (socket) => {
    console.log('Client Web connecté ID:', socket.id);
});

// Port dynamique Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});