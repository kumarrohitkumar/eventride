import { Controller, Get, Inject } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import type { CachingRoutingProvider } from '@eventride/routing'

/**
 * Liveness, readiness and metrics (NFR-7).
 *
 * `/health` answers "is the process up", `/ready` answers "can it actually serve traffic" — they
 * are separate so a dependency blip does not get the container killed and restarted.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(Redis) private readonly redis: Redis,
    @Inject('ROUTING') private readonly routing: CachingRoutingProvider,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', uptimeSec: Math.round(process.uptime()) }
  }

  @Get('ready')
  async ready() {
    const checks = { database: false, redis: false }
    try {
      await this.prisma.$queryRaw`SELECT 1`
      checks.database = true
    } catch {
      /* reported below */
    }
    try {
      await this.redis.ping()
      checks.redis = true
    } catch {
      /* Redis is a soft dependency (HLD §10 L2), so readiness does not fail on it alone */
    }
    return { ready: checks.database, checks }
  }

  /** Prometheus text format — the routing call count is the number NFR-4 caps. */
  @Get('metrics')
  async metrics(): Promise<string> {
    const routing = this.routing.getMetrics()
    const [queued, available, unmatched, alerts] = await Promise.all([
      this.prisma.tripRequest.count({ where: { state: 'QUEUED' } }),
      this.prisma.driver.count({ where: { state: 'AVAILABLE' } }),
      this.prisma.tripRequest.count({ where: { state: 'UNMATCHED' } }),
      this.prisma.alert.count({ where: { acknowledgedAt: null } }),
    ])

    return [
      '# HELP eventride_queue_depth Guests currently queued',
      '# TYPE eventride_queue_depth gauge',
      `eventride_queue_depth ${queued}`,
      '# HELP eventride_drivers_available Drivers available for assignment',
      '# TYPE eventride_drivers_available gauge',
      `eventride_drivers_available ${available}`,
      '# HELP eventride_requests_unmatched Requests with no feasible driver',
      '# TYPE eventride_requests_unmatched gauge',
      `eventride_requests_unmatched ${unmatched}`,
      '# HELP eventride_alerts_open Unacknowledged alerts',
      '# TYPE eventride_alerts_open gauge',
      `eventride_alerts_open ${alerts}`,
      '# HELP eventride_routing_api_calls Upstream routing API calls made',
      '# TYPE eventride_routing_api_calls counter',
      `eventride_routing_api_calls ${routing.apiCalls}`,
      '# HELP eventride_routing_cache_hits Routing lookups served from cache',
      '# TYPE eventride_routing_cache_hits counter',
      `eventride_routing_cache_hits ${routing.cacheHits}`,
      '',
    ].join('\n')
  }
}
