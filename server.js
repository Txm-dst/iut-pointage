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

// --- HEALTH : test de joignabilité utilisé par le boîtier ---
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- LISTE DES BADGES CONNUS (copie locale du boîtier : retour vert/rouge même hors ligne) ---
app.get('/api/badges', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id_nfc FROM etudiants WHERE id_nfc IS NOT NULL
            UNION
            SELECT id_nfc FROM enseignants WHERE id_nfc IS NOT NULL
        `);
        res.json(rows.map(r => String(r.id_nfc)));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE 2 : POINTAGE / SCAN NFC (RASPBERRY PI) ---
// Idempotente : le boîtier peut renvoyer le même pointage (file hors ligne) sans créer de doublon.
app.post(['/api/nfc', '/api/pointage'], async (req, res) => {
    const { uid, id_nfc, timestamp, id_boitier } = req.body;
    const brut = uid ?? id_nfc;
    if (brut === undefined || brut === null || String(brut).trim() === '') {
        return res.status(400).json({ error: 'uid manquant' });
    }
    const nfc_code = String(brut).trim();
    const boitier_id = id_boitier || 1; // Boîtier 1 par défaut si non spécifié
    
    console.log(`[POINTAGE REÇU] Badge UID: ${nfc_code} depuis Boîtier: ${boitier_id}`);

    try {
        // 1. Recherche de l'étudiant
        const etuRes = await pool.query('SELECT * FROM etudiants WHERE id_nfc = $1', [nfc_code]);
        let id_etudiant = null;
        if (etuRes.rows.length > 0) {
            id_etudiant = etuRes.rows[0].id_etudiants ?? etuRes.rows[0].id ?? etuRes.rows[0].id_etudiant;
        }

        // 2. Badge d'enseignant : id_etudiant reste NULL (la clé étrangère pointages_id_etudiant_fkey
        //    pointe vers la table etudiants). Le pointage reste identifiable via id_badge.
        let reconnu = id_etudiant !== null;
        if (!reconnu) {
            const profRes = await pool.query('SELECT 1 FROM enseignants WHERE id_nfc = $1', [nfc_code]);
            reconnu = profRes.rows.length > 0;
        }

        // 3. Doublon (même badge + même horodatage + même boîtier) : on confirme sans réinsérer
        if (timestamp) {
            const dejaLa = await pool.query(
                'SELECT * FROM pointages WHERE id_badge = $1 AND horodatage = $2::timestamp AND id_boitier = $3 LIMIT 1',
                [nfc_code, timestamp, boitier_id]
            );
            if (dejaLa.rows.length > 0) {
                return res.json({ status: 'success', doublon: true, reconnu, data: dejaLa.rows[0] });
            }
        }

        // 4. Insertion dans la table pointages
        const insertQuery = `
            INSERT INTO pointages (id_badge, horodatage, id_etudiant, id_boitier)
            VALUES ($1, COALESCE($2::timestamp, NOW()), $3, $4)
            RETURNING *;
        `;
        const result = await pool.query(insertQuery, [nfc_code, timestamp || null, id_etudiant, boitier_id]);

        // Diffusion WebSockets vers l'interface web
        io.emit('nfc-scan', { uid: nfc_code, pointage: result.rows[0] });

        res.json({ status: 'success', reconnu, data: result.rows[0] });
    } catch (err) {
        console.error('Erreur insertion pointage BDD :', err.message);
        res.status(500).json({ error: 'Erreur BDD', details: err.message });
    }
});

// --- POINTAGES : consultation (fenêtre de temps en ms epoch UTC) ---
// Réponse : id_badge + horodatage en ms (UTC). Le rattachement au cours se fait côté site (EDT ADE).
app.get('/api/pointages', async (req, res) => {
    const debut = Number(req.query.debut);
    const fin = Number(req.query.fin);
    if (!Number.isFinite(debut) || !Number.isFinite(fin)) {
        return res.status(400).json({ error: 'debut et fin (ms) requis' });
    }
    try {
        const { rows } = await pool.query(`
            SELECT id_pointage, id_badge, id_boitier,
                   (EXTRACT(EPOCH FROM horodatage) * 1000)::bigint AS ts
            FROM pointages
            WHERE EXTRACT(EPOCH FROM horodatage) * 1000 BETWEEN $1 AND $2
            ORDER BY horodatage ASC
            LIMIT 20000
        `, [debut, fin]);
        res.json(rows.map(r => ({ ...r, ts: Number(r.ts) })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE 3 : LECTURE ÉTUDIANTS / ENSEIGNANTS (SUPABASE) ---
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
        // On trie bien par id_enseignant puisque c'est le nom de la colonne dans Supabase
        const { rows } = await pool.query('SELECT * FROM enseignants ORDER BY id_enseignant ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Le badge passé pour inscrire quelqu'un a été enregistré comme pointage par le boîtier :
// on supprime les pointages de ce badge de la dernière minute pour qu'il ne compte pas pour un cours.
async function purgerBadgeInscription(nfc) {
    if (!nfc) return;
    await pool.query(
        "DELETE FROM pointages WHERE id_badge = $1 AND horodatage > (NOW() AT TIME ZONE 'UTC') - interval '1 minute'",
        [String(nfc)]
    );
}

// --- ROUTE 4 : CRÉATION ÉTUDIANT (INSERTION SUPABASE) ---
app.post('/api/etudiants', async (req, res) => {
    const { nom, prenom, numero_etu, groupe, id_nfc } = req.body;
    try {
        const query = `
            INSERT INTO etudiants (nom, prenom, numero_etu, groupe, id_nfc)
            VALUES ($1, $2, $3, $4, $5) RETURNING *;
        `;
        const { rows } = await pool.query(query, [nom, prenom, numero_etu, groupe, id_nfc]);
        await purgerBadgeInscription(id_nfc);
        console.log('[BDD] Étudiant créé :', rows[0]);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Erreur création étudiant BDD :', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE 5 : CRÉATION ENSEIGNANT ---
app.post('/api/professeurs', async (req, res) => {
    // id_enseignant est omis car auto-incrémenté par Supabase
    const { nom, prenom, id_nfc, id_boitier } = req.body;
    try {
        const query = `
            INSERT INTO enseignants (nom, prenom, id_nfc, id_boitier)
            VALUES ($1, $2, $3, $4) RETURNING *;
        `;
        const { rows } = await pool.query(query, [nom, prenom, id_nfc, id_boitier || null]);
        await purgerBadgeInscription(id_nfc);
        console.log('[BDD] Enseignant créé :', rows[0]);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Erreur création enseignant BDD :', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- SUPPRESSION ÉTUDIANT / ENSEIGNANT ---
// Les pointages déjà enregistrés sont conservés (id_badge) : on détache seulement la clé étrangère.
app.delete('/api/etudiants/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' });
    try {
        await pool.query('UPDATE pointages SET id_etudiant = NULL WHERE id_etudiant = $1', [id]);
        const { rowCount } = await pool.query('DELETE FROM etudiants WHERE id_etudiants = $1', [id]);
        if (rowCount === 0) return res.status(404).json({ error: 'introuvable' });
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Erreur suppression étudiant :', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/professeurs/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' });
    try {
        const { rowCount } = await pool.query('DELETE FROM enseignants WHERE id_enseignant = $1', [id]);
        if (rowCount === 0) return res.status(404).json({ error: 'introuvable' });
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Erreur suppression enseignant :', err.message);
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