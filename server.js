const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configuration Socket.IO (autorise toutes les origines)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Servir les fichiers statiques à la racine du projet
app.use(express.static(__dirname));

// Endpoint appelé par le script Python du Raspberry Pi
app.post('/api/nfc', (req, res) => {
    const { uid } = req.body;
    console.log(`[NFC SCAN DETECTÉ] UID Card: ${uid}`);
    
    // Diffusion en temps réel à toutes les pages web ouvertes
    io.emit('nfc-scan', { uid: String(uid) });
    
    res.json({ status: 'success', uid });
});

io.on('connection', (socket) => {
    console.log('Client Web connecté ID:', socket.id);
});

// Port dynamique pour Render (ou 3000 en local)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur prêt et en écoute sur le port ${PORT}`);
});