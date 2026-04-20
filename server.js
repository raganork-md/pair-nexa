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
//  CONNECTION MANAGER — SESSION GENERATE & SEND
// ═══════════════════════════════════════════════════════

class ConnectionManager {
    constructor(socket, type, phone) {
        this.socket = socket;
        this.type = type;
        this.phone = phone;
        this.maxRetries = 5;
        this.retryCount = 0;
        this.conn = null;
        this.sessionDir = path.join(__dirname, 'temp-session-' + socket.id);
        this.isDestroyed = false;
    }

    async start() {
        if (fs.existsSync(this.sessionDir)) fs.removeSync(this.sessionDir);
        await this.connect();
    }

    async connect() {
        if (this.isDestroyed) return;
        if (this.retryCount >= this.maxRetries) {
            this.socket.emit('error', '❌ Max retries. Try after 5 minutes.');
            this.cleanup();
            return;
        }

        const browser = getRandomBrowser();
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

        this.conn = makeWASocket({
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
        });

        this.conn.ev.on("creds.update", saveCreds);
        this.setupEvents();

        if (this.type === 'pair' && this.phone) {
            setTimeout(async () => {
                if (this.isDestroyed) return;
                try {
                    const cleanNumber = this.phone.replace(/[^0-9]/g, '');
                    const code = await this.conn.requestPairingCode(cleanNumber);
                    this.socket.emit('code', code);
                } catch (err) {
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
            }, getRandomDelay(5000, 9000));
        }
    }

    setupEvents() {
        this.conn.ev.on("connection.update", async (update) => {
            if (this.isDestroyed) return;
            const { connection, qr, lastDisconnect } = update;

            if (qr && this.type === 'qr') {
                try {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    this.socket.emit('qr', qrBase64);
                } catch {}
            }

            // ══════════════════════════════════════════════════════
            //  CONNECTED → SESSION ID GENERATE → WHATSAPP-ലേക്ക് SEND
            // ══════════════════════════════════════════════════════
            if (connection === "open") {
                console.log(`✅ Connected: ${this.socket.id}`);
                await delay(getRandomDelay(3000, 7000));

                try {
                    // ── auth folder full read ──
                    const sessionFiles = {};
                    const files = fs.readdirSync(this.sessionDir);

                    for (const file of files) {
                        const filePath = path.join(this.sessionDir, file);
                        const stat = fs.statSync(filePath);
                        if (stat.isFile()) {
                            const content = fs.readFileSync(filePath, 'utf-8');
                            sessionFiles[file] = content;
                        }
                    }

                    // ══════════════════════════════════════
                    //  NEXA~ SESSION ID
                    //  Full auth state → JSON → Base64 → NEXA~ prefix
                    // ══════════════════════════════════════
                    const sessionJSON = JSON.stringify(sessionFiles);
                    const base64Session = Buffer.from(sessionJSON, 'utf-8').toString('base64');
                    const sessionID = `NEXA~${base64Session}`;

                    // ── സ്വന്തം നമ്പറിലേക്ക് send ──
                    const userJid = this.conn.user.id;

                    await this.conn.sendMessage(userJid, {
                        text:
                            `╔══════════════════════════╗\n` +
                            `║   ✅ NEXA-MD SESSION ID   ║\n` +
                            `╚══════════════════════════╝\n\n` +
                            `📋 *Copy this full ID and set as*\n` +
                            `*SESSION_ID environment variable*\n\n` +
                            `\`\`\`${sessionID}\`\`\`\n\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `📌 *How to use:*\n` +
                            `1️⃣ Copy the above ID\n` +
                            `2️⃣ Go to Render/Heroku/VPS\n` +
                            `3️⃣ Set env: SESSION_ID = <paste>\n` +
                            `4️⃣ Deploy & start the bot\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                            `⚠️ _Do not share this with anyone_\n` +
                            `⏰ _${new Date().toLocaleString()}_`
                    });

                    console.log(`📤 Session ID sent to ${userJid}`);
                    this.socket.emit('connected', {
                        sessionID,
                        message: 'Session ID sent to your WhatsApp!'
                    });

                } catch (e) {
                    console.log('Session gen error:', e.message);
                    this.socket.emit('error', 'Connected but session ID generation failed.');
                }

                setTimeout(() => this.cleanup(), 15000);
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.output?.payload?.message || '';

                if (statusCode === DisconnectReason.loggedOut) {
                    this.socket.emit('error', 'Logged out.');
                    this.cleanup();
                    return;
                }

                const blockCodes = [405, 503, 428, 402, 401, 440, 408, 500];
                const isBlocked = blockCodes.includes(statusCode) ||
                    reason.toLowerCase().includes('rate') ||
                    reason.toLowerCase().includes('block');

                if (isBlocked) {
                    this.retryCount++;
                    const backoff = getRandomDelay(
                        8000 * Math.pow(2, this.retryCount),
                        15000 * Math.pow(2, this.retryCount)
                    );
                    this.socket.emit('status', {
                        message: `Rate limited. Waiting ${Math.round(backoff / 1000)}s...`
                    });
                    try { this.conn.end(); } catch {}
                    try { fs.removeSync(this.sessionDir); } catch {}
                    await delay(backoff);
                    await this.connect();
                    return;
                }

                if (this.retryCount < 3) {
                    this.retryCount++;
                    await delay(getRandomDelay(3000, 6000));
                    await this.connect();
                } else {
                    this.socket.emit('error', 'Connection failed.');
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

// Rate limiter
const timestamps = [];
function canConnect() {
    const now = Date.now();
    while (timestamps.length && now - timestamps[0] > 60000) timestamps.shift();
    return timestamps.length < 3;
}

// ═══════════════════════════════════════════════════════
//  SERVER START
// ═══════════════════════════════════════════════════════

app.prepare().then(() => {
    const server = express();
    const httpServer = http.createServer(server);
    const io = new Server(httpServer, { cors: { origin: "*" } });
    const sessions = new Map();

    io.on('connection', (socket) => {
        socket.on('start-session', async (data) => {
            if (!canConnect()) {
                socket.emit('status', { message: 'Server busy. Wait 60s.' });
                return;
            }
            if (sessions.has(socket.id)) sessions.get(socket.id).cleanup();
            timestamps.push(Date.now());

            const mgr = new ConnectionManager(socket, data.type, data.phone);
            sessions.set(socket.id, mgr);
            try { await mgr.start(); }
            catch { socket.emit('error', 'Failed.'); mgr.cleanup(); sessions.delete(socket.id); }
        });

        socket.on('disconnect', () => {
            if (sessions.has(socket.id)) {
                sessions.get(socket.id).cleanup();
                sessions.delete(socket.id);
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));
    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => console.log(`🚀 Session Getter on ${PORT}`));
});
