const express = require('express');
const next = require('next');
const http = require('http');
const { Server } = require('socket.io');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    Browsers, 
    delay, 
    makeCacheableSignalKeyStore, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require('qrcode');
const fs = require('fs-extra');
const axios = require("axios");
const FormData = require("form-data");

// സ്പാർക്കിയുടെ എൻകോഡിംഗ് ഫങ്ക്ഷൻ
async function encodeText(content) {
    const formData = new FormData();
    formData.append("content", content);
    formData.append("filename", "creds.json");
    formData.append("language", "json");

    try {
        const res = await axios.post(
            "https://aswin-sparky-pastebin.onrender.com/api/paste",
            formData,
            { headers: { ...formData.getHeaders(), Accept: "*/*" } }
        );
        return res.data.slug;
    } catch (err) {
        return null;
    }
}

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
            if (fs.existsSync(sessionDir)) fs.emptyDirSync(sessionDir);

            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

            const conn = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }),
                browser: ["Ubuntu", "Chrome", "20.0.04"], // സ്പാർക്കി വേർഷൻ
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
                    await delay(5000);
                    
                    try {
                        const credsData = fs.readFileSync(`${sessionDir}/creds.json`, 'utf-8');
                        const slug = await encodeText(credsData);
                        const sessionID = slug ? "NEXA-MD~" + slug : "NEXA-MD~ERROR";

                        await conn.sendMessage(conn.user.id, { 
                            text: `*NEXA-MD SESSION CONNECTED*\n\n*ID:* \`\`\`${sessionID}\`\`\`` 
                        });

                        socket.emit('connected', { sessionID });

                        // 10 സെക്കൻഡിന് ശേഷം ക്ലീൻ ചെയ്യുന്നു
                        setTimeout(() => {
                            conn.end();
                            if (fs.existsSync(sessionDir)) fs.removeSync(sessionDir);
                        }, 10000);

                    } catch (e) {
                        socket.emit('error', "Session storage error.");
                    }
                }
            });

            if (type === 'pair' && phone) {
                await delay(2000);
                try {
                    const code = await conn.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                    socket.emit('code', code);
                } catch (err) {
                    socket.emit('error', "WhatsApp pairing failed. Try again.");
                }
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));
    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => console.log(`🚀 Port: ${PORT}`));
});
