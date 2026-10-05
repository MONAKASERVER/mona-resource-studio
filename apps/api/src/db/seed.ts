import argon2 from "argon2";
import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  const passwordHash = await argon2.hash(config.SEED_ADMIN_PASSWORD, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  await pool.query(
    `INSERT INTO users (username, display_name, password_hash, system_role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, system_role = 'admin', disabled_at = NULL, updated_at = now()`,
    [config.SEED_ADMIN_USERNAME, "Studio Administrator", passwordHash],
  );
  console.log(`Seeded administrator: ${config.SEED_ADMIN_USERNAME}`);
} finally {
  await pool.end();
}

