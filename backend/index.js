const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/baze_delivery')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// In-Memory Session Store
const sessionStore = new Map();
const redisClient = {
    get: async (key) => sessionStore.get(key),
    set: async (key, val) => sessionStore.set(key, val),
    del: async (key) => sessionStore.delete(key)
};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

        sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        const phoneNumber = "2348052587667";
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log("========================================");
                console.log("YOUR PAIRING CODE: " + code);
                console.log("========================================");
            } catch (err) {
                console.log("Error requesting pairing code: ", err.message);
            }
        }, 10000); // Increased to 10 seconds for stability
    } if(!sock.authState.creds.registered) { const phoneNumber = "2348052587667"; setTimeout(async () => { const code = await sock.requestPairingCode(phoneNumber); console.log("========================================"); console.log("YOUR PAIRING CODE: " + code); console.log("========================================"); }, 3000); }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR Code received, please scan:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed, reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Client is ready!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe && msg.message) {
                    const from = msg.key.remoteJid;
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                    
                    if (!text) continue;
                    console.log(`Received message from ${from}: ${text}`);
                    
                    const userKey = `user:${from}:state`;
                    let userState = await redisClient.get(userKey) || 'START';

                    const reply = async (txt) => {
                        await sock.sendMessage(from, { text: txt });
                    };

                    try {
                        if (userState === 'START' || text.toLowerCase() === 'reset') {
                            await reply("Welcome to Baze Campus Delivery! ????\n\nWhat would you like to do?\n1?? Order Food\n2?? Request Package Pickup\n\nReply with 1 or 2.");
                            await redisClient.set(userKey, 'SELECT_SERVICE');
                        } 
                        else if (userState === 'SELECT_SERVICE') {
                            if (text === '1') {
                                await reply("?? Select a vendor:\n1?? Chicken Republic\n2?? The Cafe\n3?? Suya Spot\n\nReply with a number.");
                                await redisClient.set(userKey, 'SELECT_VENDOR');
                            } else if (text === '2') {
                                await reply("?? Please describe the package and pickup location.");
                                await redisClient.set(userKey, 'AWAITING_PACKAGE_DETAILS');
                            } else {
                                await reply("Please reply with 1 or 2.");
                            }
                        }
                        else if (userState === 'SELECT_VENDOR') {
                            let vendorName = "";
                            if (text === '1') vendorName = "Chicken Republic";
                            else if (text === '2') vendorName = "The Cafe";
                            else if (text === '3') vendorName = "Suya Spot";

                            if (vendorName) {
                                await reply(`Nice! You've selected ${vendorName}. ??\n\nWhat would you like to order?\n(e.g., 'Refuel Meal')`);
                                await redisClient.set(userKey, `ORDERING:${vendorName}`);
                            } else {
                                await reply("Please select 1, 2, or 3.");
                            }
                        }
                        else if (userState.startsWith('ORDERING:')) {
                            const vendor = userState.split(':')[1];
                            await reply(`? Added ${text} to your ${vendor} order.\n\nWhere should we deliver it? ??\n1?? Block A (Hostels)\n2?? Library\n3?? Faculty of Law\n\nReply with a number.`);
                            await redisClient.set(userKey, `CONFIRMING:${vendor}:${text}`);
                        }
                        else if (userState.startsWith('CONFIRMING:')) {
                            const [_, vendor, item] = userState.split(':');
                            let location = "";
                            if (text === '1') location = "Block A";
                            else if (text === '2') location = "Library";
                            else if (text === '3') location = "Faculty of Law";

                            if (location) {
                                await reply(`?? Order Confirmed!\n\nVendor: ${vendor}\nItem: ${item}\nDelivery to: ${location}\n\nThe vendor is preparing your order now. Type 'RESET' to start over.`);
                                
                                // Notify Frontend Dashboard
                                io.emit('new_order', {
                                    id: Date.now(),
                                    customer: from.split('@')[0],
                                    item: `${vendor} - ${item}`,
                                    location: location,
                                    time: new Date().toISOString()
                                });

                                await redisClient.del(userKey);
                            } else {
                                await reply("Please select 1, 2, or 3 for the location.");
                            }
                        }
                    } catch (err) {
                        console.error("Error in conversational flow:", err);
                    }
                }
            }
        }
    });
}

connectToWhatsApp();

app.get('/', (req, res) => {
  res.send('Baze Delivery (Baileys) Backend Running');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is listening on port ${PORT}`);
});





