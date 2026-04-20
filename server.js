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
            
            if (!fs.existsSync('/tmp')) fs.mkdirSync('/tmp');

            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const conn = makeWASocket({
                auth: state,
                version,
                logger: pino({ level: "silent" }),
                // ലേറ്റസ്റ്റ് Chrome User Agent വഴി ലോഗിൻ എറർ ഒഴിവാക്കുന്നു
                browser: ["Ubuntu", "Chrome", "124.0.6367.60"], 
                syncFullHistory: false,
                printQRInTerminal: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 10000
            });

            conn.ev.on("creds.update", saveCreds);

            conn.ev.on("connection.update", async (s) => {
                const { connection, qr, lastDisconnect } = s;

                if (qr && type === 'qr') {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    socket.emit('qr', qrBase64);
                }

                if (connection === "open") {
                    // സെഷൻ ഐഡി Hex ഫോർമാറ്റിൽ
                    const sessionID = "NEXA-MD~" + Buffer.from(JSON.stringify(conn.authState.creds)).toString('hex');
                    
                    await delay(3000); 
                    
                    await conn.sendMessage(conn.user.id, { 
                        text: `*NEXA-MD SESSION CONNECTED*\n\n*ID:* \`\`\`${sessionID}\`\`\`\n\n_Keep this ID safe. Local storage cleaned in 10 seconds._` 
                    });

                    socket.emit('connected', { sessionID });

                    // 10 സെക്കൻഡിന് ശേഷം സ്റ്റോറേജ് ക്ലീൻ ചെയ്യുന്നു
                    setTimeout(async () => {
                        try {
                            conn.end(); 
                            if (fs.existsSync(sessionDir)) {
                                fs.rmSync(sessionDir, { recursive: true, force: true });
                            }
                        } catch (err) {
                            console.log("Cleanup Error: ", err);
                        }
                    }, 10000);
                }

                if (connection === "close") {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect) {
                        socket.emit('error', "Connection closed. Please try again.");
                    }
                }
            });

            if (type === 'pair' && phone) {
                await delay(3000); 
                try {
                    const code = await conn.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                    socket.emit('code', code);
                } catch (err) {
                    socket.emit('error', "WhatsApp limit reached. Try QR method.");
                }
            }
        });
    });

    server.all('*', (req, res) => {
        return handle(req, res);
    });

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Server running on Port ${PORT}`);
    });
});
