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
//  ANTI-DETECTION SYSTEM
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

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ═══════════════════════════════════════════════════════
//  WA CONNECTION MANAGER
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
        if (this.retryCount >= this.maxRetries) {
            this.socket.emit('error', '❌ Max retries reached. Try again later.');
            this.cleanup();
            return;
        }

        const browser = getRandomBrowser();
        this.socket.emit('status', { message: `Connecting... (attempt ${this.retryCount + 1})` });

        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

        let version;
        try {
            const fetched = await fetchLatestBaileysVersion();
            version = fetched.version;
        } catch {
            version = [2, 3000, 1015901307];
        }

        const socketConfig = {
            auth: state,
            logger: pino({ level: 'silent' }),
            browser,
            version,
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            fireInitQueries: false,
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 0,
            retryRequestDelayMs: getRandomDelay(3000, 7000),
            keepAliveIntervalMs: getRandomDelay(30000, 55000),
        };

        this.conn = makeWASocket(socketConfig);
        this.conn.ev.on("creds.update", saveCreds);
        this.setupEventHandlers();

        if (this.type === 'pair' && this.phone) {
            const pairDelay = getRandomDelay(5000, 8000);
            setTimeout(async () => {
                if (this.isDestroyed) return;
                try {
                    const cleanNumber = this.phone.replace(/[^0-9]/g, '');
                    const code = await this.conn.requestPairingCode(cleanNumber);
                    this.socket.emit('code', code);
                } catch (err) {
                    this.retryCount++;
                    const backoff = getRandomDelay(5000 * Math.pow(2, this.retryCount), 10000 * Math.pow(2, this.retryCount));
                    await delay(backoff);
                    if (this.conn) this.conn.end();
                    await this.connect();
                }
            }, pairDelay);
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
                console.log(`✅ Connected: ${this.socket.id}`);
                // ചെറിയൊരു വെയിറ്റിംഗ് സമയം (ബ്ലോക്ക് ഒഴിവാക്കാൻ)
                await delay(7000);

                try {
                    // 🔑 ഇതാ മാറ്റം: ഫയലിന് പകരം നേരിട്ട് മെമ്മറിയിൽ നിന്ന് creds എടുക്കുന്നു
                    const sessionData = JSON.stringify(this.conn.authState.creds);
                    const sessionID = "NEXA-MD~" + Buffer.from(sessionData).toString('base64');

                    // സ്വന്തം നമ്പറിലേക്ക് അയക്കുന്നു
                    await this.conn.sendMessage(this.conn.user.id, {
                        text: `*✅ NEXA-MD SESSION ID*\n\n\`\`\`${sessionID}\`\`\`\n\n_Generated for ${this.phone || 'Your Number'}_`
                    });

                    this.socket.emit('connected', { sessionID });
                    console.log("🚀 Session ID successfully sent to WhatsApp!");
                } catch (e) {
                    console.log('Session ID Send Error:', e.message);
                    this.socket.emit('error', 'Session generated but failed to send to WhatsApp.');
                }

                // ലോഗിൻ കഴിഞ്ഞാൽ 15 സെക്കന്റിനുള്ളിൽ സെഷൻ ഡാറ്റ ക്ലീൻ ചെയ്യും
                setTimeout(() => this.cleanup(), 15000);
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut && this.retryCount < 3) {
                    this.retryCount++;
                    await delay(5000);
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
    httpServer.listen(process.env.PORT || 3000, () => {
        console.log(`🚀 Server live on port ${process.env.PORT || 3000}`);
    });
});
