import { Body, Controller, Delete, Inject, Post, UseGuards } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { AuthGuard, Principal, Roles, RolesGuard } from './guards.js'
import type { AuthPrincipal } from '../auth/rbac.js'

const tokenSchema = z.object({
  token: z.string().min(10).max(255),
  platform: z.enum(['ios', 'android', 'web']),
})

/**
 * Push-token registration for ALL THREE roles.
 *
 * This lived on the guest controller and was therefore gated to `@Roles('GUEST')` — which meant
 * drivers and admins could never register a device, so the server dutifully looked up their tokens,
 * found none, and sent nothing. The two notifications that matter most are a driver's 60-second
 * offer and a critical ops alert, so the gap silently disabled exactly the wrong half of PRD §15.
 */
@Controller('api/v1/me')
@UseGuards(AuthGuard, RolesGuard)
@Roles('ADMIN', 'DRIVER', 'GUEST')
export class PushController {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  @Post('push-token')
  async register(@Principal() principal: AuthPrincipal, @Body() body: unknown) {
    const input = tokenSchema.parse(body)
    // Upsert on the token, not the user: one person may sign in on a second device, and a shared
    // device may be handed to a different driver between shifts.
    await this.prisma.notificationToken.upsert({
      where: { token: input.token },
      create: { userId: principal.userId, token: input.token, platform: input.platform },
      update: { userId: principal.userId, platform: input.platform },
    })
    return { registered: true }
  }

  /** Called on sign-out so a shared device stops receiving the previous user's notifications. */
  @Delete('push-token')
  async unregister(@Principal() principal: AuthPrincipal, @Body() body: unknown) {
    const { token } = z.object({ token: z.string().min(10) }).parse(body)
    await this.prisma.notificationToken.deleteMany({
      where: { token, userId: principal.userId },
    })
    return { removed: true }
  }
}
