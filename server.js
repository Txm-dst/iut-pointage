const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

// Configuration de la connexion PostgreSQL (Cloud Supabase ou local)
const pool = new Pool(
    process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false } // Requis pour Supabase / Render
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
    console.log('Connecté avec succès à la base PostgreSQL Supabase');
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
    const { uid, id_nfc, timestamp, id_boitier } = req.body;
    const nfc_code = String(uid || id_nfc);
    const boitier_id = id_boitier || 1; // Boîtier 1 par défaut si non spécifié
    
    console.log(`[POINTAGE REÇU] Badge UID: ${nfc_code} depuis Boîtier: ${boitier_id}`);

    try {
        // 1. Recherche de l'étudiant correspondant à cet UID
        const etuRes = await pool.query('SELECT id FROM etudiants WHERE id_nfc = $1', [nfc_code]);
        let id_etudiant = etuRes.rows.length > 0 ? etuRes.rows[0].id : null;

        // 2. Si ce n'est pas un étudiant, recherche dans la table enseignants
        if (!id_etudiant) {
            const profRes = await pool.query('SELECT id FROM enseignants WHERE id_nfc = $1', [nfc_code]);
            if (profRes.rows.length > 0) {
                id_etudiant = profRes.rows[0].id;
            }
        }

        // 3. Insertion enrichie dans la table pointages
        const insertQuery = `
            INSERT INTO pointages (id_badge, horodatage, id_etudiant, id_boitier)
            VALUES ($1, COALESCE($2::timestamp, NOW()), $3, $4)
            RETURNING *;
        `;
        const result = await pool.query(insertQuery, [nfc_code, timestamp || null, id_etudiant, boitier_id]);

        // Diffusion WebSockets vers l'interface web
        io.emit('nfc-scan', { uid: nfc_code, pointage: result.rows[0] });

        res.json({ status: 'success', data: result.rows[0] });
    } catch (err) {
        console.error('Erreur insertion pointage BDD :', err.message);
        res.status(500).json({ error: 'Erreur BDD', details: err.message });
    }
});

// --- ROUTE 3 : LECTURE ÉTUDIANTS / ENSEIGNANTS (SUPABASE) ---
app.get('/api/etudiants', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM etudiants ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/professeurs', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM enseignants ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE 4 : CRÉATION ÉTUDIANT (INSERTION SUPABASE) ---
app.post('/api/etudiants', async (req, res) => {
    const { nom, prenom, numero_etu, groupe, id_nfc } = req.body;
    try {
        const query = `
            INSERT INTO etudiants (nom, prenom, numero_etu, groupe, id_nfc)
            VALUES ($1, $2, $3, $4, $5) RETURNING *;
        `;
        const { rows } = await pool.query(query, [nom, prenom, numero_etu, groupe, id_nfc]);
        console.log('[BDD] Étudiant créé :', rows[0]);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Erreur création étudiant BDD :', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE 5 : CRÉATION ENSEIGNANT ---
app.post('/api/professeurs', async (req, res) => {
    const { nom, prenom, numero_etu, id_nfc, id_boitier } = req.body;
    try {
        const query = `
            INSERT INTO enseignants (nom, prenom, numero_etu, id_nfc, id_boitier)
            VALUES ($1, $2, $3, $4, $5) RETURNING *;
        `;
        const { rows } = await pool.query(query, [nom, prenom, numero_etu, id_nfc, id_boitier || null]);
        console.log('[BDD] Enseignant créé :', rows[0]);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Erreur création enseignant BDD :', err.message);
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