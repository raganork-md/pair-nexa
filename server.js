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
            const sessionDir = './session-' + socket.id;
            
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

            const conn = makeWASocket({
                auth: state,
                // IP Block ഒഴിവാക്കാൻ ലേറ്റസ്റ്റ് സ്റ്റേബിൾ വേർഷൻ ഉപയോഗിക്കുന്നു
                version: [2, 3000, 1015901307], 
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                // ലോഗിൻ എറർ വരാതിരിക്കാൻ ഒരു യഥാർത്ഥ Mac Chrome ആയി ലോഗിൻ ചെയ്യുന്നു
                browser: ["Mac OS", "Chrome", "121.0.6167.160"],
                syncFullHistory: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 10000
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
                    // സെഷൻ ഐഡി (Base64 ഫോർമാറ്റിൽ)
                    const sessionID = "NEXA-MD~" + Buffer.from(JSON.stringify(conn.authState.creds)).toString('base64');
                    
                    await conn.sendMessage(conn.user.id, { text: `*NEXA-MD SESSION ID*\n\n${sessionID}` });
                    socket.emit('connected', { sessionID });

                    // സെഷൻ അയച്ച ശേഷം 10 സെക്കൻഡിൽ സ്റ്റോറേജ് ക്ലീൻ ചെയ്യും
                    setTimeout(() => {
                        conn.end();
                        if (fs.existsSync(sessionDir)) {
                            fs.rmSync(sessionDir, { recursive: true, force: true });
                        }
                    }, 10000);
                }
            });

            if (type === 'pair' && phone) {
                await delay(3000); // പെട്ടെന്ന് ബ്ലോക്ക് ആകാതിരിക്കാൻ ചെറിയ ഡിലേ
                try {
                    const cleanNumber = phone.replace(/[^0-9]/g, '');
                    const code = await conn.requestPairingCode(cleanNumber);
                    socket.emit('code', code);
                } catch (err) {
                    socket.emit('error', "WhatsApp Temporary Block. Try QR method.");
                }
            }
        });
    });

    server.all('*', (req, res) => handle(req, res));

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 Server connected on port ${PORT}`);
    });
});
