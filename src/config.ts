import "dotenv/config";

const DEV_SECRET = "dev-only-insecure-secret-change-me";

/** JWT secret shared by the API, the gateway and the agent (HS256). */
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET (at least 16 characters) is required when NODE_ENV=production");
  }
  return DEV_SECRET;
}

export const JWT_EXPIRES_IN_SECONDS = 3600;

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
