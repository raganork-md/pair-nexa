const express = require('express');
const next = require('next');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, delay, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require('qrcode');
const fs = require('fs');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
    const server = express();
    const httpServer = http.createServer(server);
    const io = new Server(httpServer, { cors: { origin: "*" } });

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
                logger: pino({ level: "silent" }), // ലോഗ് കുറച്ചു
                browser: Browsers.ubuntu("Chrome"), // ബ്രൗസർ മാറ്റി നോക്കുന്നു
                syncFullHistory: false,
                printQRInTerminal: false
            });

            conn.ev.on("creds.update", saveCreds);

            conn.ev.on("connection.update", async (s) => {
                const { connection, qr, lastDisconnect } = s;

                if (qr && type === 'qr') {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    socket.emit('qr', qrBase64);
                }

                if (connection === "open") {
                    const sessionID = "NEXA-MD~" + Buffer.from(JSON.stringify(conn.authState.creds)).toString('base64');
                    
                    // മെസ്സേജ് അയക്കാൻ കുറച്ച് സമയം കൂടി നൽകുന്നു
                    await delay(3000); 
                    await conn.sendMessage(conn.user.id, { text: `*NEXA-MD SESSION CONNECTED*\n\n${sessionID}` });
                    
                    socket.emit('connected', { sessionID });
                    console.log("Session Connected: " + sessionID);

                    // കണക്ഷൻ ഉടനെ കട്ട് ചെയ്യാതെ 10 സെക്കൻഡ് വെയിറ്റ് ചെയ്യുന്നു
                    setTimeout(async () => {
                        conn.end();
                        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                    }, 10000);
                }

                if (connection === "close") {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect && connection !== "open") {
                        // എറർ ഉണ്ടെങ്കിൽ റീ കണക്ട് ചെയ്യാൻ ശ്രമിക്കരുത്, പകരം യൂസറോട് വീണ്ടും ചെയ്യാൻ പറയാം
                        socket.emit('error', "Connection failed. Please refresh and try again.");
                    }
                }
            });

            if (type === 'pair' && phone) {
                // പെയറിംഗ് കോഡിന് മുൻപ് ചെറിയൊരു ഡിലേ നൽകുന്നു
                await delay(3000); 
                try {
                    const code = await conn.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                    socket.emit('code', code);
                } catch (err) {
                    console.log(err);
                    socket.emit('error', "WhatsApp limits exceeded. Try again in a few minutes.");
                }
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 NEXA-MD Running on Port ${PORT}`);
    });
});
