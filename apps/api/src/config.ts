import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  DATABASE_URL: z.string().default("postgres://mona:mona_dev@localhost:5432/mona_resource_studio"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  MINIO_ENDPOINT: z.string().url().default("http://localhost:9000"),
  MINIO_ACCESS_KEY: z.string().min(1).default("test"),
  MINIO_SECRET_KEY: z.string().min(8).default("testtest"),
  MINIO_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).default("mona-resource-studio"),
  JWT_ACCESS_SECRET: z.string().min(24).default("development-access-secret-change-me"),
  DATA_ROOT: z.string().default(".data"),
  DESKTOP_ORIGIN: z.string().default("http://localhost:1420"),
  PASSKEY_RP_ID: z.string().min(1).default("localhost"),
  PASSKEY_ORIGIN: z.string().url().default("http://localhost:4100"),
  PASSKEY_PUBLIC_API_URL: z.string().url().default("http://localhost:4100"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SEED_ADMIN_USERNAME: z.string().min(3).default("admin"),
  SEED_ADMIN_PASSWORD: z.string().min(12).default("change-me-now"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = schema.parse(env);
  if (config.NODE_ENV === "production" && config.JWT_ACCESS_SECRET.startsWith("development-")) {
    throw new Error("Production refuses development JWT secrets");
  }
  const passkeyOrigin = new URL(config.PASSKEY_ORIGIN);
  const publicApiUrl = new URL(config.PASSKEY_PUBLIC_API_URL);
  if (passkeyOrigin.hostname !== config.PASSKEY_RP_ID || passkeyOrigin.origin !== config.PASSKEY_ORIGIN.replace(/\/$/, "")) {
    throw new Error("PASSKEY_ORIGIN hostname must match PASSKEY_RP_ID");
  }
  if (publicApiUrl.origin !== passkeyOrigin.origin) throw new Error("PASSKEY_PUBLIC_API_URL must use PASSKEY_ORIGIN");
  if (config.NODE_ENV === "production" && passkeyOrigin.protocol !== "https:") throw new Error("Production passkeys require HTTPS");
  return config;
}
