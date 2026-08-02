import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import helmet from 'helmet'
import { PrismaClient } from '@prisma/client'
import { AppModule } from './app.module.js'
import { ErrorFilter } from './http/error.filter.js'
import { loadEnv } from './config/env.js'

async function bootstrap(): Promise<void> {
  // Fails fast and loudly on a misconfigured environment, rather than at 02:00 on event night.
  const env = loadEnv()

  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  app.use(helmet())
  app.enableCors({ origin: env.corsOrigins, credentials: true })
  app.useGlobalFilters(new ErrorFilter())

  // NFR-9: MySQL DATETIME has no offset, so a wrong session timezone would silently shift every
  // deadline in the system. Assert it at boot instead of debugging it later.
  await assertUtcSession()

  // Let in-flight requests finish and close DB/Redis handles cleanly on SIGTERM.
  app.enableShutdownHooks()

  await app.listen(env.PORT)
  process.stdout.write(
    `EventRide API on :${env.PORT} — routing=${env.ROUTING_PROVIDER}, env=${env.NODE_ENV}\n`,
  )
}

async function assertUtcSession(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    // CAST to CHAR: the driver maps a bare TIMEDIFF to a time object, not a string.
    const rows = await prisma.$queryRawUnsafe<{ offset: string }[]>(
      'SELECT CAST(TIMEDIFF(NOW(), UTC_TIMESTAMP()) AS CHAR) AS offset',
    )
    const offset = String(rows[0]?.offset ?? '')
    if (!offset.startsWith('00:00:00')) {
      throw new Error(
        `MySQL session timezone is not UTC (offset ${offset}). ` +
          'Append ?timezone=UTC to DATABASE_URL — every deadline depends on this.',
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Failed to start: ${String(error)}\n`)
  process.exit(1)
})
