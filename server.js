const express = require('express');
const next = require('next');
const http = require('http');
const { Server } = require('socket.io');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    Browsers, 
    delay, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');

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
            // ഓരോ സോക്കറ്റിനും പ്രത്യേകം താൽക്കാലിക സെഷൻ ഫോൾഡർ
            const sessionDir = path.join(__dirname, 'session-' + socket.id);
            
            if (fs.existsSync(sessionDir)) fs.removeSync(sessionDir);

            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

            const conn = makeWASocket({
                auth: state,
                logger: pino({ level: 'silent' }),
                // 1. Meta AI നിർദ്ദേശിച്ച സേഫ് ബ്രൗസർ (NEXA എന്ന് ഉപയോഗിക്കരുത്)
                browser: Browsers.macOS('Desktop'), 
                // 2. 2026 ഏപ്രിൽ അപ്‌ഡേറ്റ് പ്രകാരമുള്ള ലേറ്റസ്റ്റ് വേർഷൻ
                version: [2, 3000, 1023223821], 
                printQRInTerminal: false,
                syncFullHistory: false,
                // 3. കണക്ട് ആയ ഉടനെ ഓൺലൈൻ സ്റ്റാറ്റസ് കാണിക്കില്ല (ബ്ലോക്ക് ഒഴിവാക്കാൻ)
                markOnlineOnConnect: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 0
            });

            conn.ev.on("creds.update", saveCreds);

            conn.ev.on("connection.update", async (s) => {
                const { connection, qr, lastDisconnect } = s;

                if (qr && type === 'qr') {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    socket.emit('qr', qrBase64);
                }

                if (connection === "open") {
                    await delay(5000);
                    
                    // സെഷൻ ഡാറ്റ ഫയലിൽ നിന്ന് റീഡ് ചെയ്യുന്നു
                    const credsFile = path.join(sessionDir, 'creds.json');
                    const credsData = fs.readFileSync(credsFile, 'utf-8');
                    
                    // Base64 സെഷൻ ഐഡി ജനറേഷൻ
                    const sessionID = "NEXA-MD~" + Buffer.from(credsData).toString('base64');
                    
                    await conn.sendMessage(conn.user.id, { 
                        text: `*NEXA-MD SESSION CONNECTED*\n\n*ID:* \`\`\`${sessionID}\`\`\`` 
                    });

                    socket.emit('connected', { sessionID });

                    // 10 സെക്കൻഡിന് ശേഷം ക്ലീൻ ചെയ്യുന്നു
                    setTimeout(() => {
                        conn.end();
                        if (fs.existsSync(sessionDir)) fs.removeSync(sessionDir);
                    }, 10000);
                }

                if (connection === "close") {
                    const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                    if (statusCode !== DisconnectReason.loggedOut) {
                        socket.emit('error', "Connection failed. Try again with Mobile Data.");
                    }
                }
            });

            if (type === 'pair' && phone) {
                // 4. മെറ്റ ഐ പറഞ്ഞ പോലെ 3 സെക്കൻഡ് വെയിറ്റ് ചെയ്ത് പെയറിംഗ് റിക്വസ്റ്റ് ചെയ്യുന്നു
                setTimeout(async () => {
                    try {
                        const cleanNumber = phone.replace(/[^0-9]/g, '');
                        const code = await conn.requestPairingCode(cleanNumber);
                        socket.emit('code', code);
                    } catch (err) {
                        socket.emit('error', "WhatsApp IP Block. Please use Mobile Data and Flight Mode.");
                    }
                }, 3000);
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 NEXA-MD Server running on port ${PORT}`);
    });
});
