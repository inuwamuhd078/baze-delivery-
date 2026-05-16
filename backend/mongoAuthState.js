const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

/**
 * Stores the WhatsApp Baileys session entirely in MongoDB.
 * This is required on Render (free tier) which has no persistent disk storage.
 */
async function useMongoAuthState(AuthModel) {
    const writeData = async (data, id) => {
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await AuthModel.findOneAndUpdate(
            { _id: id },
            { _id: id, data: serialized },
            { upsert: true, new: true }
        );
    };

    const readData = async (id) => {
        try {
            const doc = await AuthModel.findById(id).lean();
            if (!doc) return null;
            return JSON.parse(doc.data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = async (id) => {
        await AuthModel.deleteOne({ _id: id });
    };

    const creds = (await readData("creds")) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === "app-state-sync-key" && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const docId = `${category}-${id}`;
                            tasks.push(value ? writeData(value, docId) : removeData(docId));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData(creds, "creds"),
    };
}

module.exports = { useMongoAuthState };
