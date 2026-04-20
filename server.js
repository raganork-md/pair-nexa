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
//  ANTI-DETECTION
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
        if (this.retryCount >= this.maxRetries) {
            this.socket.emit('error', '❌ Max retries reached. Try again in 5 minutes.');
            this.cleanup();
            return;
        }

        const browser = getRandomBrowser();
        console.log(`[Attempt ${this.retryCount + 1}/${this.maxRetries}] Browser: ${browser[1]}`);

        this.socket.emit('status', {
            message: `Connecting... (attempt ${this.retryCount + 1})`
        });

        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

        let version;
        try {
            const fetched = await fetchLatestBaileysVersion();
            version = fetched.version;
        } catch {
            version = [2, 3000, 1015901307];
        }

        await delay(getRandomDelay(2000, 5000));

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
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' }),
        };

        this.conn = makeWASocket(socketConfig);
        this.conn.ev.on("creds.update", saveCreds);
        this.setupEventHandlers();

        // ═══ PAIRING CODE ═══
        if (this.type === 'pair' && this.phone) {
            const pairDelay = getRandomDelay(5000, 9000);
            setTimeout(async () => {
                if (this.isDestroyed) return;
                try {
                    const cleanNumber = this.phone.replace(/[^0-9]/g, '');
                    const code = await this.conn.requestPairingCode(cleanNumber);
                    this.socket.emit('code', code);
                } catch (err) {
                    console.log(`Pairing failed: ${err.message}`);
                    this.retryCount++;
                    const backoff = getRandomDelay(
                        5000 * Math.pow(2, this.retryCount),
                        10000 * Math.pow(2, this.retryCount)
                    );
                    this.socket.emit('status', {
                        message: `Retrying in ${Math.round(backoff / 1000)}s...`
                    });
                    await delay(backoff);
                    try { this.conn.end(); } catch {}
                    await this.connect();
                }
            }, pairDelay);
        }
    }

    setupEventHandlers() {
        this.conn.ev.on("connection.update", async (update) => {
            if (this.isDestroyed) return;
            const { connection, qr, lastDisconnect } = update;

            // ═══ QR CODE ═══
            if (qr && this.type === 'qr') {
                try {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    this.socket.emit('qr', qrBase64);
                } catch (e) {
                    console.log('QR error:', e.message);
                }
            }

            // ═══════════════════════════════════════════════
            //  CONNECTED — SESSION ID GENERATE & SEND
            // ═══════════════════════════════════════════════
            if (connection === "open") {
                console.log(`✅ Connected: ${this.socket.id}`);
                await delay(getRandomDelay(5000, 10000));

                try {
                    // ── creds.json read ചെയ്യുക ──
                    const credsFile = path.join(this.sessionDir, 'creds.json');
                    if (!fs.existsSync(credsFile)) {
                        throw new Error('creds.json not found');
                    }
                    const credsData = fs.readFileSync(credsFile, 'utf-8');

                    // ══════════════════════════════════════
                    //  NEXA~ BASE64 SESSION ID FORMAT
                    // ══════════════════════════════════════
                    // creds.json → Base64 encode → NEXA~ prefix add
                    const base64Creds = Buffer.from(credsData, 'utf-8').toString('base64');
                    const sessionID = `NEXA~${base64Creds}`;

                    // ── സ്വന്തം നമ്പറിലേക്ക് session ID അയയ്ക്കുക ──
                    const userJid = this.conn.user.id;

                    await this.conn.sendMessage(userJid, {
                        text:
                            `╔═══════════════════════╗\n` +
                            `║  ✅ NEXA-MD CONNECTED  ║\n` +
                            `╚═══════════════════════╝\n\n` +
                            `📌 *Your Session ID:*\n\n` +
                            `\`\`\`${sessionID}\`\`\`\n\n` +
                            `⏰ _${new Date().toLocaleString()}_\n\n` +
                            `⚠️ _This ID is private. Do not share._`
                    });

                    console.log(`📤 Session ID sent to ${userJid}`);

                    // ── Frontend-ലേക്കും send ──
                    this.socket.emit('connected', { sessionID });

                } catch (e) {
                    console.log('Session ID error:', e.message);
                    this.socket.emit('error', 'Connected but session ID generation failed.');
                }

                setTimeout(() => this.cleanup(), 15000);
            }

            // ═══ DISCONNECTED ═══
            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.output?.payload?.message || '';

                console.log(`❌ Disconnected: code=${statusCode} reason="${reason}"`);

                if (statusCode === DisconnectReason.loggedOut) {
                    this.socket.emit('error', 'Logged out. Start fresh.');
                    this.cleanup();
                    return;
                }

                const blockCodes = [405, 503, 428, 402, 401, 440, 408, 500];
                const isBlocked =
                    blockCodes.includes(statusCode) ||
                    reason.toLowerCase().includes('rate') ||
                    reason.toLowerCase().includes('block');

                if (isBlocked) {
                    this.retryCount++;
                    const backoff = getRandomDelay(
                        8000 * Math.pow(2, this.retryCount),
                        15000 * Math.pow(2, this.retryCount)
                    );
                    this.socket.emit('status', {
                        message: `Rate limited. Waiting ${Math.round(backoff / 1000)}s (${this.retryCount}/${this.maxRetries})`
                    });
                    try {
                        if (this.conn) this.conn.end();
                        if (fs.existsSync(this.sessionDir)) fs.removeSync(this.sessionDir);
                    } catch {}
                    await delay(backoff);
                    await this.connect();
                    return;
                }

                if (this.retryCount < 3) {
                    this.retryCount++;
                    await delay(getRandomDelay(3000, 6000));
                    await this.connect();
                } else {
                    this.socket.emit('error', 'Connection failed. Try again later.');
                    this.cleanup();
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
//  RATE LIMITER
// ═══════════════════════════════════════════════════════

const connectionTimestamps = [];
const MAX_CONNECTIONS_PER_MINUTE = 3;

function canConnect() {
    const now = Date.now();
    while (connectionTimestamps.length > 0 && now - connectionTimestamps[0] > 60000) {
        connectionTimestamps.shift();
    }
    return connectionTimestamps.length < MAX_CONNECTIONS_PER_MINUTE;
}

// ═══════════════════════════════════════════════════════
//  SERVER
// ═══════════════════════════════════════════════════════

app.prepare().then(() => {
    const server = express();
    const httpServer = http.createServer(server);
    const io = new Server(httpServer, { cors: { origin: "*" } });

    const activeSessions = new Map();

    io.on('connection', (socket) => {
        console.log(`🔌 Client: ${socket.id}`);

        socket.on('start-session', async (data) => {
            if (!canConnect()) {
                socket.emit('status', { message: 'Server busy. Wait 60 seconds...' });
                return;
            }

            if (activeSessions.has(socket.id)) {
                activeSessions.get(socket.id).cleanup();
            }

            connectionTimestamps.push(Date.now());
            const { type, phone } = data;
            const manager = new ConnectionManager(socket, type, phone);
            activeSessions.set(socket.id, manager);

            try {
                await manager.start();
            } catch (err) {
                console.log('Start error:', err.message);
                socket.emit('error', 'Failed to start.');
                manager.cleanup();
                activeSessions.delete(socket.id);
            }
        });

        socket.on('disconnect', () => {
            if (activeSessions.has(socket.id)) {
                activeSessions.get(socket.id).cleanup();
                activeSessions.delete(socket.id);
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 NEXA-MD on port ${PORT}`);
    });
});
