const express = require('express');
const next = require('next');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, delay } = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require('qrcode');
const fs = require('fs');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
    const server = express();
    const httpServer = http.createServer(server);
    const io = new Server(httpServer, {
        cors: { origin: "*" }
    });

    io.on('connection', (socket) => {
        socket.on('start-session', async (data) => {
            const { type, phone } = data;
            const sessionDir = '/tmp/session-' + socket.id;
            
            if (!fs.existsSync('/tmp')) fs.mkdirSync('/tmp');

            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const conn = makeWASocket({
                auth: state,
                version,
                logger: pino({ level: "fatal" }),
                browser: Browsers.macOS("Desktop"),
                syncFullHistory: false
            });

            conn.ev.on("creds.update", saveCreds);

            conn.ev.on("connection.update", async (s) => {
                const { connection, qr } = s;

                if (qr && type === 'qr') {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    socket.emit('qr', qrBase64);
                }

                if (connection === "open") {
                    const sessionID = "NEXA-MD~" + Buffer.from(JSON.stringify(conn.authState.creds)).toString('base64');
                    await conn.sendMessage(conn.user.id, { text: `*NEXA-MD SESSION CONNECTED*\n\n${sessionID}` });
                    socket.emit('connected', { sessionID });
                    
                    await delay(5000);
                    conn.end();
                    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            });

            if (type === 'pair' && phone) {
                await delay(5000); 
                try {
                    const code = await conn.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                    socket.emit('code', code);
                } catch (err) {
                    socket.emit('error', "Try again later.");
                }
            }
        });
    });

    // ഇതാണ് "Not Found" ഒഴിവാക്കുന്ന മെയിൻ ലൈൻ
    server.all('*', (req, res) => {
        return handle(req, res);
    });

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 NEXA-MD Running on Port ${PORT}`);
    });
});
