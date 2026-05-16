const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { useMongoAuthState } = require("./mongoAuthState");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// -- MongoDB Auth Store Schema --------------------------------------------------
const AuthStoreSchema = new mongoose.Schema({
    _id: { type: String },
    data: { type: String, required: true }
}, { versionKey: false });
const AuthStore = mongoose.model("AuthStore", AuthStoreSchema);

// -- In-Memory User Session State (conversation flow) --------------------------
const sessionStore = new Map();
const userStateStore = {
    get: async (key) => sessionStore.get(key),
    set: async (key, val) => sessionStore.set(key, val),
    del: async (key) => sessionStore.delete(key)
};

// -- Connect MongoDB ------------------------------------------------------------
mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/baze_delivery")
    .then(() => {
        console.log("Connected to MongoDB");
        connectToWhatsApp();
    })
    .catch(err => console.error("MongoDB connection error:", err));

// -- WhatsApp Connection --------------------------------------------------------
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMongoAuthState(AuthStore);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Baze Delivery", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    // Request pairing code if not registered
    if (!sock.authState.creds.registered) {
        const phoneNumber = "2348052587667";
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log("========================================");
                console.log("YOUR PAIRING CODE: " + code);
                console.log("========================================");
                console.log("This code is valid for ~60 seconds.");
                console.log("Go to WhatsApp > Linked Devices > Link with phone number");
            } catch (err) {
                console.error("Error requesting pairing code:", err.message);
                console.log("Retrying connection in 5 seconds...");
                setTimeout(connectToWhatsApp, 5000);
            }
        }, 5000);
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log(`Connection closed (code: ${code}), reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === "open") {
            console.log("? WhatsApp Client is READY! Session saved to MongoDB.");
        }
    });

    // -- Conversational Flow ----------------------------------------------------
    sock.ev.on("messages.upsert", async (m) => {
        if (m.type !== "notify") return;
        for (const msg of m.messages) {
            if (msg.key.fromMe || !msg.message) continue;

            const from = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!text) continue;

            console.log(`Message from ${from}: ${text}`);

            let userState = await userStateStore.get(`user:${from}:state`) || "START";
            const reply = async (txt) => { await sock.sendMessage(from, { text: txt }); };

            try {
                if (userState === "START" || text.toLowerCase() === "reset") {
                    await reply("Welcome to Baze Campus Delivery! ??\n\nWhat would you like to do?\n1?? Order Food\n2?? Request Package Pickup\n\nReply with 1 or 2.");
                    await userStateStore.set(`user:${from}:state`, "SELECT_SERVICE");
                }
                else if (userState === "SELECT_SERVICE") {
                    if (text === "1") {
                        await reply("??? Select a vendor:\n1?? Chicken Republic\n2?? The Cafe\n3?? Suya Spot\n\nReply with a number.");
                        await userStateStore.set(`user:${from}:state`, "SELECT_VENDOR");
                    } else if (text === "2") {
                        await reply("?? Please describe the package and pickup location.");
                        await userStateStore.set(`user:${from}:state`, "AWAITING_PACKAGE_DETAILS");
                    } else {
                        await reply("Please reply with 1 or 2.");
                    }
                }
                else if (userState === "SELECT_VENDOR") {
                    const vendors = { "1": "Chicken Republic", "2": "The Cafe", "3": "Suya Spot" };
                    const vendorName = vendors[text];
                    if (vendorName) {
                        await reply(`Nice! You selected ${vendorName}. ??\n\nWhat would you like to order?\n(e.g., Refuel Meal)`);
                        await userStateStore.set(`user:${from}:state`, `ORDERING:${vendorName}`);
                    } else {
                        await reply("Please select 1, 2, or 3.");
                    }
                }
                else if (userState.startsWith("ORDERING:")) {
                    const vendor = userState.split(":")[1];
                    await reply(`? Added "${text}" to your ${vendor} order.\n\nWhere should we deliver it? ??\n1?? Block A (Hostels)\n2?? Library\n3?? Faculty of Law\n\nReply with a number.`);
                    await userStateStore.set(`user:${from}:state`, `CONFIRMING:${vendor}:${text}`);
                }
                else if (userState.startsWith("CONFIRMING:")) {
                    const [, vendor, item] = userState.split(":");
                    const locations = { "1": "Block A", "2": "Library", "3": "Faculty of Law" };
                    const location = locations[text];
                    if (location) {
                        await reply(`?? Order Confirmed!\n\nVendor: ${vendor}\nItem: ${item}\nDelivery to: ${location}\n\nThe vendor is preparing your order now. Type RESET to start over.`);
                        io.emit("new_order", {
                            id: Date.now(),
                            customer: from.split("@")[0],
                            item: `${vendor} - ${item}`,
                            location,
                            time: new Date().toISOString()
                        });
                        await userStateStore.del(`user:${from}:state`);
                    } else {
                        await reply("Please select 1, 2, or 3 for the location.");
                    }
                }
            } catch (err) {
                console.error("Error in conversational flow:", err);
            }
        }
    });
}

// -- REST Endpoints -------------------------------------------------------------
app.get("/", (req, res) => res.send("Baze Delivery Backend is Running ?"));

// -- Start Server ---------------------------------------------------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is listening on port ${PORT}`);
});
