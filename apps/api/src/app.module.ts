import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { ScheduleModule } from '@nestjs/schedule'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { LoggerModule } from 'nestjs-pino'
import { DEFAULT_CONFIG, systemClock } from '@eventride/shared'
import { createRoutingProvider, type CacheStore } from '@eventride/routing'
import { loadEnv } from './config/env.js'
import { AuthController } from './auth/auth.controller.js'
import { GuestController } from './http/guest.controller.js'
import { DriverController } from './http/driver.controller.js'
import { AdminController } from './http/admin.controller.js'
import { HealthController } from './http/health.controller.js'
import { PushController } from './http/push.controller.js'
import { AuthGuard, RolesGuard } from './http/guards.js'
import { PrismaRepositories } from './prisma/prisma-repos.js'
import { TripService } from './trips/trip.service.js'
import { DispatchService } from './dispatch/dispatch.service.js'
import { SweeperService } from './dispatch/sweeper.service.js'
import { EventsGateway } from './realtime/events.gateway.js'
import { NotificationService } from './realtime/notification.service.js'

const env = loadEnv()

/** Redis-backed cache for the routing layer, so entries survive a restart and are shared. */
class RedisCacheStore implements CacheStore {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key)
    } catch {
      return null // L2: Redis down ⇒ treated as a cache miss, never an error
    }
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds)
    } catch {
      /* caching is best-effort by design */
    }
  }
}

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
        // Never log credentials or tokens, even at debug level.
        redact: ['req.headers.authorization', 'req.body.password', 'req.body.code'],
      },
    }),
    JwtModule.register({ secret: env.JWT_SECRET, signOptions: { expiresIn: env.JWT_TTL } }),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    AuthController,
    GuestController,
    DriverController,
    AdminController,
    PushController,
    HealthController,
  ],
  providers: [
    { provide: PrismaClient, useFactory: () => new PrismaClient() },
    { provide: Redis, useFactory: () => new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 }) },
    {
      provide: 'ROUTING',
      inject: [Redis],
      useFactory: (redis: Redis) =>
        createRoutingProvider({
          provider: env.ROUTING_PROVIDER,
          apiKey: env.GOOGLE_MAPS_API_KEY,
          store: new RedisCacheStore(redis),
        }),
    },
    PrismaRepositories,
    {
      provide: TripService,
      inject: [PrismaRepositories],
      // The clock is injected so tests (and the simulator) can control time.
      useFactory: (repos: PrismaRepositories) =>
        new TripService(repos, systemClock, DEFAULT_CONFIG),
    },
    DispatchService,
    SweeperService,
    EventsGateway,
    { provide: NotificationService, inject: [PrismaClient], useFactory: (prisma: PrismaClient) => new NotificationService(prisma) },
    AuthGuard,
    RolesGuard,
  ],
})
export class AppModule {}
