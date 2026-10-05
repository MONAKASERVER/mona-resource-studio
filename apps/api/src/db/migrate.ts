import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  const sql = await readFile(new URL("../../src/db/schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
  console.log("Mona Resource Studio schema is up to date.");
} finally {
  await pool.end();
}

