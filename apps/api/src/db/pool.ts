import pg from "pg";

export type Database = pg.Pool;
export function createPool(connectionString: string): Database {
  return new pg.Pool({ connectionString, max: 15, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

