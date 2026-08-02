import { z } from 'zod'

/**
 * Environment schema. Validated once at boot so a misconfigured deploy fails immediately with a
 * readable message, rather than at 02:00 on event night when the first guest lands.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_TTL: z.string().default('12h'),

  ROUTING_PROVIDER: z.enum(['mock', 'google']).default('mock'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),

  /** Comma-separated allowlist. Never '*' in production. */
  CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:19006'),

  /**
   * Accept a fixed OTP so reviewers can log in as any seeded user without SMS spend.
   * Refused in production by the refinement below.
   */
  DEV_OTP_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  DEV_OTP_CODE: z.string().default('000000'),
})

export type Env = z.infer<typeof envSchema> & { corsOrigins: string[] }

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse(source)

  if (parsed.ROUTING_PROVIDER === 'google' && !parsed.GOOGLE_MAPS_API_KEY) {
    throw new Error('ROUTING_PROVIDER=google requires GOOGLE_MAPS_API_KEY')
  }
  if (parsed.NODE_ENV === 'production') {
    if (parsed.DEV_OTP_ENABLED) throw new Error('DEV_OTP_ENABLED must be false in production')
    if (parsed.CORS_ORIGINS.includes('*')) throw new Error('CORS_ORIGINS must not be * in production')
  }

  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  }
}
