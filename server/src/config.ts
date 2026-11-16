import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  // 32 random bytes, base64. Encrypts MFA secrets and stored documents.
  APP_ENCRYPTION_KEY: z.string().min(1),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  PRICE_PROVIDER: z.enum(['simulated', 'manual']).default('manual'),
  PRICE_POLL_SECONDS: z.coerce.number().int().min(5).default(30),
  UPLOAD_DIR: z.string().default('./storage/documents'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Borrowings System <no-reply@localhost>'),
  SMS_WEBHOOK_URL: z.string().url().optional(),
  SMS_WEBHOOK_TOKEN: z.string().optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  LOGIN_RATE_PER_MINUTE: z.coerce.number().int().positive().default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:', z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;
const key = Buffer.from(env.APP_ENCRYPTION_KEY, 'base64');
if (key.length !== 32) {
  console.error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  process.exit(1);
}
if (env.NODE_ENV === 'production' && env.COOKIE_SECURE !== 'true') {
  console.error('COOKIE_SECURE must be true in production');
  process.exit(1);
}

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  host: env.HOST,
  databaseUrl: env.DATABASE_URL,
  encryptionKey: key,
  cookieSecure: env.COOKIE_SECURE === 'true',
  sessionIdleMs: env.SESSION_IDLE_MINUTES * 60_000,
  sessionAbsoluteMs: env.SESSION_ABSOLUTE_HOURS * 3_600_000,
  priceProvider: env.PRICE_PROVIDER,
  pricePollMs: env.PRICE_POLL_SECONDS * 1000,
  uploadDir: env.UPLOAD_DIR,
  maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
  smtpUrl: env.SMTP_URL,
  mailFrom: env.MAIL_FROM,
  smsWebhookUrl: env.SMS_WEBHOOK_URL,
  smsWebhookToken: env.SMS_WEBHOOK_TOKEN,
  trustProxy: env.TRUST_PROXY === 'true',
  rateLimit: env.RATE_LIMIT_PER_MINUTE,
  loginRateLimit: env.LOGIN_RATE_PER_MINUTE,
};
