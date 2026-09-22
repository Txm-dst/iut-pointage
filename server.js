const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Autoriser toutes les origines (Render + local)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/nfc', (req, res) => {
    const { uid } = req.body;
    console.log(`[NFC SCAN DETECTÉ] UID Card: ${uid}`);
    io.emit('nfc-scan', { uid: String(uid) });
    res.json({ status: 'success', uid });
});

io.on('connection', (socket) => {
    console.log('Client Web connecté (Render/Local) ID:', socket.id);
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Serveur prêt et en écoute sur http://localhost:${PORT}`);
});