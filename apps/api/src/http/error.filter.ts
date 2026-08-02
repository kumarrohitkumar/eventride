import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'
import type { Response } from 'express'
import { ZodError } from 'zod'
import { IllegalTransitionError } from '@eventride/shared'
import { DomainError } from '../trips/ports.js'
import { ForbiddenRoleError, ForbiddenRowError } from '../auth/rbac.js'

/**
 * One error envelope for the whole API (LLD §4):
 *   { error: { code, message, details? } }
 *
 * Stack traces are logged, never returned — a client must not learn the internal shape of the
 * system from an error body.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const { status, code, message, details } = this.map(exception)

    if (status >= 500) this.logger.error(exception)
    else this.logger.debug(`${code}: ${message}`)

    response.status(status).json({ error: { code, message, ...(details ? { details } : {}) } })
  }

  private map(exception: unknown): {
    status: number
    code: string
    message: string
    details?: unknown
  } {
    if (exception instanceof DomainError) {
      return { status: exception.status, code: exception.code, message: exception.message }
    }
    if (exception instanceof IllegalTransitionError) {
      return { status: 409, code: exception.code, message: exception.message }
    }
    if (exception instanceof ForbiddenRoleError) {
      return { status: 403, code: 'FORBIDDEN_ROLE', message: exception.message }
    }
    if (exception instanceof ForbiddenRowError) {
      return { status: 403, code: 'FORBIDDEN_ROW', message: exception.message }
    }
    if (exception instanceof ZodError) {
      return {
        status: 422,
        code: 'VALIDATION_FAILED',
        message: 'Request body failed validation',
        details: exception.flatten(),
      }
    }
    if (exception instanceof HttpException) {
      const payload = exception.getResponse()
      const code =
        typeof payload === 'object' && payload !== null && 'code' in payload
          ? String((payload as { code: unknown }).code)
          : httpCodeFor(exception.getStatus())
      return { status: exception.getStatus(), code, message: exception.message }
    }
    // Unknown failures return a generic message; the detail goes to the logs only.
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Unexpected server error' }
  }
}

function httpCodeFor(status: number): string {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  return 'HTTP_ERROR'
}
