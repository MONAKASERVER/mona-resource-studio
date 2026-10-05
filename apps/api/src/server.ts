import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createApp } from "./app.js";

const config = loadConfig(); const db = createPool(config.DATABASE_URL); const app = await createApp(config, db);
const shutdown = async (signal: string) => { app.log.info({ signal }, "shutting down"); await app.close(); await db.end(); process.exit(0); };
process.on("SIGINT", () => void shutdown("SIGINT")); process.on("SIGTERM", () => void shutdown("SIGTERM"));
try { await app.listen({ host: config.API_HOST, port: config.API_PORT }); }
catch (error) { app.log.error(error); await db.end(); process.exit(1); }

