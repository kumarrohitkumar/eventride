import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

/**
 * Push notifications (PRD §15, T10).
 *
 * Sockets only reach a foregrounded app. The moments that matter most are exactly the ones where the
 * app is NOT foregrounded: a guest who put their phone away after landing, and a driver who has 60
 * seconds to accept a trip. Those need a real push.
 *
 * Delivery is strictly best-effort: a push failure is logged and swallowed, never propagated. A
 * notification that cannot be delivered must not roll back the state transition that caused it —
 * the trip is still assigned whether or not the phone buzzed.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
/** Expo accepts up to 100 messages per request. */
const MAX_BATCH = 100

export interface PushMessage {
  title: string
  body: string
  data?: Record<string, unknown>
  /** `high` wakes the device promptly — used for a driver's expiring offer. */
  priority?: 'default' | 'high'
  sound?: 'default' | null
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name)

  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    /** Injected so tests can assert payloads without touching the network. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Send to every device registered by one user. */
  async sendToUser(userId: string, message: PushMessage): Promise<{ sent: number }> {
    const tokens = await this.prisma.notificationToken.findMany({
      where: { userId },
      select: { token: true },
    })
    return this.send(tokens.map((t) => t.token), message)
  }

  async sendToGuest(guestId: string, message: PushMessage): Promise<{ sent: number }> {
    const guest = await this.prisma.guest.findUnique({
      where: { id: guestId },
      select: { userId: true },
    })
    return guest ? this.sendToUser(guest.userId, message) : { sent: 0 }
  }

  async sendToDriver(driverId: string, message: PushMessage): Promise<{ sent: number }> {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    })
    return driver ? this.sendToUser(driver.userId, message) : { sent: 0 }
  }

  /** Critical operational alerts go to every admin device (FR-A4). */
  async sendToAdmins(message: PushMessage): Promise<{ sent: number }> {
    const tokens = await this.prisma.notificationToken.findMany({
      where: { user: { role: 'ADMIN' } },
      select: { token: true },
    })
    return this.send(tokens.map((t) => t.token), message)
  }

  private async send(tokens: string[], message: PushMessage): Promise<{ sent: number }> {
    if (tokens.length === 0) return { sent: 0 }

    let sent = 0
    for (let i = 0; i < tokens.length; i += MAX_BATCH) {
      const chunk = tokens.slice(i, i + MAX_BATCH)
      const payload = chunk.map((to) => ({
        to,
        title: message.title,
        body: message.body,
        data: message.data ?? {},
        priority: message.priority ?? 'default',
        sound: message.sound === null ? undefined : 'default',
      }))

      try {
        const response = await this.fetchImpl(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          this.logger.warn(`push rejected with ${response.status}`)
          continue
        }
        const body = (await response.json()) as {
          data?: { status: string; message?: string; details?: { error?: string } }[]
        }
        for (const [index, ticket] of (body.data ?? []).entries()) {
          if (ticket.status === 'ok') {
            sent += 1
            continue
          }
          // A device that uninstalled the app should stop costing us requests forever.
          if (ticket.details?.error === 'DeviceNotRegistered') {
            const dead = chunk[index]
            if (dead) await this.prisma.notificationToken.deleteMany({ where: { token: dead } })
            this.logger.log('pruned an unregistered push token')
          } else {
            this.logger.warn(`push ticket failed: ${ticket.message ?? ticket.status}`)
          }
        }
      } catch (error) {
        // Network failure, DNS, timeout — never allowed to reach the caller.
        this.logger.warn(`push transport failed: ${String(error)}`)
      }
    }
    return { sent }
  }
}

/**
 * The notification catalogue (PRD §15) in one place, so wording and data payloads are consistent and
 * a new notification is a table entry rather than a new code path.
 */
export const messages = {
  tripAssigned: (driverName: string, vehicleNumber: string, etaMin: number | null): PushMessage => ({
    title: 'Your driver is on the way',
    body:
      etaMin !== null
        ? `${driverName} · ${vehicleNumber} · arriving in about ${Math.max(1, Math.round(etaMin))} min`
        : `${driverName} · ${vehicleNumber}`,
    data: { kind: 'TRIP_ASSIGNED' },
  }),

  driverArrived: (vehicleNumber: string): PushMessage => ({
    title: 'Your driver has arrived',
    body: `Look for vehicle ${vehicleNumber}`,
    priority: 'high',
    data: { kind: 'DRIVER_ARRIVED' },
  }),

  detourAdded: (newEtaMin: number): PushMessage => ({
    title: 'One short stop added',
    body: `Your arrival is now about ${Math.max(1, Math.round(newEtaMin))} min away`,
    data: { kind: 'DETOUR' },
  }),

  reassigning: (): PushMessage => ({
    title: 'Reassigning your ride',
    body: 'Your vehicle had a problem. We are finding you another one now.',
    priority: 'high',
    data: { kind: 'REASSIGNING' },
  }),

  requestApproved: (): PushMessage => ({
    title: 'Request approved',
    body: 'Finding you a driver now.',
    data: { kind: 'APPROVED' },
  }),

  requestDeclined: (reason: string): PushMessage => ({
    title: 'Request declined',
    body: reason,
    data: { kind: 'DECLINED' },
  }),

  // High priority with sound: the driver has 60 seconds, so a silent notification is useless.
  tripOffered: (guestCount: number, pickupLabel: string): PushMessage => ({
    title: 'New trip',
    body: `${guestCount} guest${guestCount === 1 ? '' : 's'} from ${pickupLabel} — tap to accept`,
    priority: 'high',
    data: { kind: 'TRIP_OFFERED' },
  }),

  detourForDriver: (addedMinutes: number): PushMessage => ({
    title: 'New stop added',
    body: `Your route now includes one more pickup (+${addedMinutes} min)`,
    priority: 'high',
    data: { kind: 'TRIP_UPDATED' },
  }),

  breakGranted: (durationMin: number): PushMessage => ({
    title: 'Break granted',
    body: `Take ${durationMin} minutes. You will not be assigned trips.`,
    data: { kind: 'BREAK' },
  }),

  criticalAlert: (message: string): PushMessage => ({
    title: 'Operations alert',
    body: message,
    priority: 'high',
    data: { kind: 'ALERT' },
  }),
} as const
