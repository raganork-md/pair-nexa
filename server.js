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
    const io = new Server(httpServer, {
        cors: { origin: "*" }
    });

    io.on('connection', (socket) => {
        socket.on('start-session', async (data) => {
            const { type, phone } = data;
            const sessionDir = '/tmp/session-' + socket.id;
            
            // താൽക്കാലിക ഫോൾഡർ നിർമ്മാണം
            if (!fs.existsSync('/tmp')) fs.mkdirSync('/tmp');

            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const conn = makeWASocket({
                auth: state,
                version,
                logger: pino({ level: "silent" }),
                browser: Browsers.ubuntu("Chrome"),
                syncFullHistory: false,
                printQRInTerminal: false
            });

            conn.ev.on("creds.update", saveCreds);

            conn.ev.on("connection.update", async (s) => {
                const { connection, qr, lastDisconnect } = s;

                // QR Code ജനറേഷൻ
                if (qr && type === 'qr') {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    socket.emit('qr', qrBase64);
                }

                // കണക്ഷൻ സക്സസ് ആയാൽ
                if (connection === "open") {
                    // സെഷൻ ഐഡി Hex ഫോർമാറ്റിൽ
                    const sessionID = "NEXA-MD~" + Buffer.from(JSON.stringify(conn.authState.creds)).toString('hex');
                    
                    await delay(3000); 
                    
                    // യൂസർക്ക് സെഷൻ ഐഡി അയക്കുന്നു
                    await conn.sendMessage(conn.user.id, { 
                        text: `*NEXA-MD SESSION CONNECTED*\n\n*ID:* \`\`\`${sessionID}\`\`\`\n\n_Keep this ID safe. Local storage will be cleaned in 10 seconds._` 
                    });

                    socket.emit('connected', { sessionID });
                    console.log("✅ Session Sent & Local Storage Cleaning Scheduled");

                    // നിങ്ങളുടെ ഐഡിയ: 10 സെക്കൻഡിന് ശേഷം ക്ലീൻ ആക്കുന്നു
                    setTimeout(async () => {
                        try {
                            conn.end(); 
                            if (fs.existsSync(sessionDir)) {
                                fs.rmSync(sessionDir, { recursive: true, force: true });
                                console.log(`🗑️ Storage Cleaned: ${socket.id}`);
                            }
                        } catch (err) {
                            console.log("Cleanup Error: ", err);
                        }
                    }, 10000);
                }

                // കണക്ഷൻ എറർ ഹാൻഡ്‌ലിംഗ്
                if (connection === "close") {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect) {
                        console.log("Connection closed, please restart session.");
                    }
                }
            });

            // പെയറിംഗ് കോഡ് റിക്വസ്റ്റ്
            if (type === 'pair' && phone) {
                await delay(3000); 
                try {
                    const code = await conn.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                    socket.emit('code', code);
                } catch (err) {
                    socket.emit('error', "WhatsApp pairing limit reached. Try again later.");
                }
            }
        });
    });

    // Next.js ഹാൻഡ്‌ലർ (Not Found എറർ ഒഴിവാക്കാൻ)
    server.all('*', (req, res) => {
        return handle(req, res);
    });

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 NEXA-MD Server Live on Port ${PORT}`);
    });
});
