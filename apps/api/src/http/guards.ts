import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  Inject,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { Request } from 'express'
import type { Role } from '@eventride/shared'
import { hasRole, type AuthPrincipal } from '../auth/rbac.js'

export const ROLES_KEY = 'eventride:roles'

/** `@Roles('ADMIN')` — layer 1 of the RBAC design (HLD §11). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles)

/** `@Principal()` — the authenticated caller, always derived from the token, never from the body. */
export const Principal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const request = ctx.switchToHttp().getRequest<Request & { principal?: AuthPrincipal }>()
    if (!request.principal) throw new UnauthorizedException('Missing principal')
    return request.principal
  },
)

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { principal?: AuthPrincipal }>()
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token')

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string
        role: Role
        driverId?: string
        guestId?: string
      }>(header.slice(7))
      request.principal = {
        userId: payload.sub,
        role: payload.role,
        driverId: payload.driverId,
        guestId: payload.guestId,
      }
      return true
    } catch {
      throw new UnauthorizedException('Invalid or expired token')
    }
  }
}

/**
 * Endpoint-level role check. Runs before any handler, so a driver token hitting an admin route is
 * refused with 403 without the controller ever executing.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required || required.length === 0) return true

    const request = context.switchToHttp().getRequest<Request & { principal?: AuthPrincipal }>()
    const principal = request.principal
    if (!principal) throw new UnauthorizedException('Missing principal')
    if (!hasRole(principal, required)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_ROLE',
        message: `Requires ${required.join('|')}`,
      })
    }
    return true
  }
}
