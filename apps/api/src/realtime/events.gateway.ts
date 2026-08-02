import { Logger, Inject } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'
import type { Role } from '@eventride/shared'
import { roomsFor, type AuthPrincipal } from '../auth/rbac.js'
import { loadEnv } from '../config/env.js'

const env = loadEnv()

/**
 * Realtime fanout (HLD §7).
 *
 * Rooms are DERIVED FROM THE TOKEN and joined server-side; the gateway never reads a client-supplied
 * room list, so a driver cannot subscribe to the admin feed by crafting a payload (NFR-6).
 */
@WebSocketGateway({ cors: { origin: env.corsOrigins, credentials: true } })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server
  private readonly logger = new Logger(EventsGateway.name)

  /** Aggregated driver positions, so 100 drivers pinging at 5 s become 1 message/second out. */
  private pendingPositions = new Map<string, { lat: number; lng: number; at: Date }>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = String(client.handshake.auth?.token ?? '')
      const payload = await this.jwt.verifyAsync<{
        sub: string
        role: Role
        driverId?: string
        guestId?: string
      }>(token)

      const principal: AuthPrincipal = {
        userId: payload.sub,
        role: payload.role,
        driverId: payload.driverId,
        guestId: payload.guestId,
      }
      const rooms = roomsFor(principal)
      if (rooms.length === 0) {
        client.disconnect(true)
        return
      }
      await client.join(rooms)
      client.data.principal = principal
    } catch {
      // No valid token ⇒ no rooms, no events. Fail closed.
      client.disconnect(true)
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`socket disconnected: ${client.id}`)
  }

  // ---------------------------------------------------------------- emitters

  requestState(guestId: string, payload: unknown): void {
    this.server.to(`guest:${guestId}`).emit('request.state', payload)
    this.server.to('admins').emit('request.state', payload)
  }

  tripAssigned(guestId: string, payload: unknown): void {
    this.server.to(`guest:${guestId}`).emit('trip.assigned', payload)
  }

  tripOffered(driverId: string, payload: unknown): void {
    this.server.to(`driver:${driverId}`).emit('trip.offered', payload)
  }

  tripUpdated(driverId: string, payload: unknown): void {
    this.server.to(`driver:${driverId}`).emit('trip.updated', payload)
  }

  breakGranted(driverId: string, payload: unknown): void {
    this.server.to(`driver:${driverId}`).emit('break.granted', payload)
  }

  alertRaised(payload: unknown): void {
    this.server.to('admins').emit('alert.raised', payload)
  }

  /**
   * Positions are buffered and flushed at 1 Hz as a single array. Emitting per ping would push
   * 20 messages/second to every admin client for zero extra information.
   */
  driverMoved(driverId: string, lat: number, lng: number, at: Date): void {
    this.pendingPositions.set(driverId, { lat, lng, at })
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const batch = [...this.pendingPositions.entries()].map(([id, p]) => ({ driverId: id, ...p }))
      this.pendingPositions.clear()
      if (batch.length > 0) this.server.to('admins').emit('driver.positions', batch)
    }, 1000)
  }
}
