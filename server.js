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
//  ANTI-DETECTION SYSTEM (NO PROXY NEEDED)
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
//  WA CONNECTION - RENDER OPTIMIZED (PROXY-FREE)
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
            message: `Connecting... (attempt ${this.retryCount + 1})`,
            proxy: false
        });

        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

        let version;
        try {
            const fetched = await fetchLatestBaileysVersion();
            version = fetched.version;
        } catch {
            version = [2, 3000, 1015901307];
        }

        // ═══ HUMAN-LIKE DELAY — KEY TO AVOIDING BLOCK ═══
        // Render IP block mainly happens due to rapid reconnections
        // Slow down = look like real user
        const humanDelay = getRandomDelay(2000, 5000);
        await delay(humanDelay);

        const socketConfig = {
            auth: state,
            logger: pino({ level: 'silent' }),
            browser,
            version,
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            fireInitQueries: false,           // 🔑 reduces initial traffic
            connectTimeoutMs: 120000,         // 🔑 longer timeout for Render
            defaultQueryTimeoutMs: 0,
            retryRequestDelayMs: getRandomDelay(3000, 7000),  // 🔑 slower
            keepAliveIntervalMs: getRandomDelay(30000, 55000), // 🔑 randomized
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' }),
            patchMessageBeforeSending: (msg) => {
                // 🔑 Reduce message fingerprint
                const requiresPatch = !!(
                    msg.buttonsMessage ||
                    msg.templateMessage ||
                    msg.listMessage
                );
                if (requiresPatch) {
                    msg = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {},
                                },
                                ...msg,
                            },
                        },
                    };
                }
                return msg;
            },
        };

        this.conn = makeWASocket(socketConfig);
        this.conn.ev.on("creds.update", saveCreds);
        this.setupEventHandlers();

        // ═══ PAIRING CODE ═══
        if (this.type === 'pair' && this.phone) {
            // 🔑 Wait longer before pairing — critical for Render
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
                    // 🔑 Exponential backoff — this is what saves you without proxy
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

            if (qr && this.type === 'qr') {
                try {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    this.socket.emit('qr', qrBase64);
                } catch (e) {
                    console.log('QR error:', e.message);
                }
            }

            if (connection === "open") {
                console.log(`✅ Connected: ${this.socket.id}`);
                // 🔑 Wait before sending message — don't spam right after connect
                await delay(getRandomDelay(5000, 10000));

                try {
                    const credsFile = path.join(this.sessionDir, 'creds.json');
                    const credsData = fs.readFileSync(credsFile, 'utf-8');
                    const sessionID = "NEXA-MD~" +
                        Buffer.from(credsData).toString('base64');

                    await this.conn.sendMessage(this.conn.user.id, {
                        text:
                            `*✅ NEXA-MD SESSION CONNECTED*\n\n` +
                            `*Session ID:*\n\`\`\`${sessionID}\`\`\`\n\n` +
                            `_Generated at ${new Date().toLocaleString()}_`
                    });

                    this.socket.emit('connected', { sessionID });
                } catch (e) {
                    console.log('Session save error:', e.message);
                    this.socket.emit('error', 'Session generated but send failed.');
                }

                setTimeout(() => this.cleanup(), 15000);
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.output?.payload?.message || '';

                console.log(`❌ Disconnected: code=${statusCode} reason="${reason}"`);

                if (statusCode === DisconnectReason.loggedOut) {
                    this.socket.emit('error', 'Logged out. Start fresh.');
                    this.cleanup();
                    return;
                }

                // 🔑 IP BLOCK DETECTION — use exponential backoff instead of proxy
                const blockCodes = [405, 503, 428, 402, 401, 440, 408, 500];
                const isBlocked =
                    blockCodes.includes(statusCode) ||
                    reason.toLowerCase().includes('rate') ||
                    reason.toLowerCase().includes('block');

                if (isBlocked) {
                    this.retryCount++;
                    // 🔑 EXPONENTIAL BACKOFF — the free alternative to proxies
                    // Each retry waits exponentially longer
                    const backoff = getRandomDelay(
                        8000 * Math.pow(2, this.retryCount),
                        15000 * Math.pow(2, this.retryCount)
                    );

                    this.socket.emit('status', {
                        message:
                            `Rate limited. Waiting ${Math.round(backoff / 1000)}s ` +
                            `before retry (${this.retryCount}/${this.maxRetries})`
                    });

                    // 🔑 Clean old session before retry — fresh auth state
                    try {
                        if (this.conn) this.conn.end();
                        if (fs.existsSync(this.sessionDir)) fs.removeSync(this.sessionDir);
                    } catch {}

                    await delay(backoff);
                    await this.connect();
                    return;
                }

                // Normal disconnect — quick retry
                if (this.retryCount < 3) {
                    this.retryCount++;
                    await delay(getRandomDelay(3000, 6000));
                    await this.connect();
                } else {
                    this.socket.emit('error', 'Connection failed. Try again in a few minutes.');
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
//  RATE LIMITER — GLOBAL PROTECTION
// ═══════════════════════════════════════════════════════

const connectionTimestamps = [];
const MAX_CONNECTIONS_PER_MINUTE = 3; // 🔑 limit concurrent sessions

function canConnect() {
    const now = Date.now();
    // Remove timestamps older than 60s
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
        console.log(`🔌 Connected: ${socket.id}`);

        socket.on('start-session', async (data) => {
            // 🔑 GLOBAL RATE LIMIT CHECK
            if (!canConnect()) {
                socket.emit('status', {
                    message: 'Server busy. Please wait 60 seconds...'
                });
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
                socket.emit('error', 'Failed to start session.');
                manager.cleanup();
                activeSessions.delete(socket.id);
            }
        });

        socket.on('disconnect', () => {
            console.log(`🔌 Disconnected: ${socket.id}`);
            if (activeSessions.has(socket.id)) {
                activeSessions.get(socket.id).cleanup();
                activeSessions.delete(socket.id);
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 NEXA-MD running on port ${PORT}`);
        console.log(`🛡️  Mode: PROXY-FREE (exponential backoff)`);
    });
});
