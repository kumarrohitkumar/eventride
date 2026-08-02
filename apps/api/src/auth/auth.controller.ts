import { Body, Controller, Get, Post, UnauthorizedException, UseGuards, Inject } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { addMinutes } from '@eventride/shared'
import { AuthGuard, Principal } from '../http/guards.js'
import type { AuthPrincipal } from './rbac.js'
import { loadEnv } from '../config/env.js'

const env = loadEnv()

/**
 * Auth (LLD §4.1). One users table for all three roles keeps this to a single code path.
 *
 * Dev mode accepts a fixed OTP so a reviewer can sign in as any seeded guest, driver or admin with
 * no SMS provider — and `loadEnv` refuses to boot in production with that enabled.
 */
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  @Post('otp/request')
  async requestOtp(@Body() body: unknown) {
    const { phone } = z.object({ phone: z.string().min(6) }).parse(body)

    const code = env.DEV_OTP_ENABLED
      ? env.DEV_OTP_CODE
      : String(Math.floor(100000 + Math.random() * 900000))

    await this.prisma.otpCode.create({
      data: {
        phone,
        codeHash: await bcrypt.hash(code, 8),
        expiresAt: addMinutes(new Date(), 5),
      },
    })

    // Deliberately does not reveal whether the number belongs to a guest: an unknown number gets
    // the same response, so this endpoint cannot be used to enumerate the guest list.
    return { sent: true, ...(env.DEV_OTP_ENABLED ? { devCode: code } : {}) }
  }

  @Post('otp/verify')
  async verifyOtp(@Body() body: unknown) {
    const { phone, code } = z
      .object({ phone: z.string().min(6), code: z.string().min(4).max(8) })
      .parse(body)

    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    })
    if (!otp) throw new UnauthorizedException({ code: 'OTP_EXPIRED', message: 'No valid code' })
    if (otp.attempts >= 5) {
      throw new UnauthorizedException({ code: 'OTP_RATE_LIMITED', message: 'Too many attempts' })
    }

    const valid = await bcrypt.compare(code, otp.codeHash)
    if (!valid) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: otp.attempts + 1 },
      })
      throw new UnauthorizedException({ code: 'OTP_INVALID', message: 'Incorrect code' })
    }
    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } })

    const user = await this.prisma.appUser.findFirst({
      where: { phone, isActive: true },
      include: { guest: true, driver: true },
    })
    if (!user) {
      throw new UnauthorizedException({
        code: 'UNKNOWN_USER',
        message: 'Contact the event desk',
      })
    }

    return this.issueToken(user)
  }

  /** Admins use credentials rather than OTP — they are staff, created by other admins. */
  @Post('login')
  async login(@Body() body: unknown) {
    const { email, password } = z
      .object({ email: z.string().email(), password: z.string().min(6) })
      .parse(body)

    const user = await this.prisma.appUser.findFirst({
      where: { email, isActive: true },
      include: { guest: true, driver: true },
    })
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      // One message for both cases, so this cannot distinguish "no such user" from "wrong password".
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid login' })
    }
    return this.issueToken(user)
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Principal() principal: AuthPrincipal) {
    return principal
  }

  private async issueToken(user: {
    id: string
    role: 'ADMIN' | 'DRIVER' | 'GUEST'
    name: string
    guest: { id: string } | null
    driver: { id: string } | null
  }) {
    // The token carries the row ids, which is what makes every self-scoped route tamper-proof.
    const token = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      guestId: user.guest?.id,
      driverId: user.driver?.id,
    })
    return {
      token,
      role: user.role,
      profile: { id: user.id, name: user.name, guestId: user.guest?.id, driverId: user.driver?.id },
    }
  }
}
