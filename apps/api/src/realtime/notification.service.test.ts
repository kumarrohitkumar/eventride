import { describe, it, expect, vi } from 'vitest'
import { NotificationService, messages } from './notification.service.js'

/** Minimal Prisma stand-in: only the three reads the service performs. */
function fakePrisma(tokens: string[], role: 'GUEST' | 'DRIVER' | 'ADMIN' = 'GUEST') {
  const deleted: string[] = []
  return {
    deleted,
    client: {
      notificationToken: {
        findMany: vi.fn().mockResolvedValue(tokens.map((token) => ({ token }))),
        deleteMany: vi.fn().mockImplementation(({ where }: { where: { token: string } }) => {
          deleted.push(where.token)
          return Promise.resolve({ count: 1 })
        }),
      },
      guest: { findUnique: vi.fn().mockResolvedValue(role === 'GUEST' ? { userId: 'u1' } : null) },
      driver: { findUnique: vi.fn().mockResolvedValue(role === 'DRIVER' ? { userId: 'u1' } : null) },
    },
  }
}

const okResponse = (statuses: ('ok' | 'error')[], error?: string) => ({
  ok: true,
  json: async () => ({
    data: statuses.map((status) => ({
      status,
      ...(status === 'error' ? { message: 'failed', details: { error } } : {}),
    })),
  }),
})

describe('NotificationService', () => {
  it('sends one batched request to every registered device', async () => {
    const prisma = fakePrisma(['tok-a', 'tok-b'])
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(['ok', 'ok']))
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    const result = await service.sendToUser('u1', { title: 'T', body: 'B' })

    expect(result.sent).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as { to: string }[]
    expect(body.map((m) => m.to)).toEqual(['tok-a', 'tok-b'])
  })

  it('does not call the network when a user has no devices', async () => {
    const prisma = fakePrisma([])
    const fetchImpl = vi.fn()
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    expect(await service.sendToUser('u1', { title: 'T', body: 'B' })).toEqual({ sent: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('NEVER throws when the push transport fails — a state change must not roll back', async () => {
    const prisma = fakePrisma(['tok-a'])
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    await expect(service.sendToUser('u1', { title: 'T', body: 'B' })).resolves.toEqual({ sent: 0 })
  })

  it('swallows a non-OK HTTP response too', async () => {
    const prisma = fakePrisma(['tok-a'])
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    await expect(service.sendToUser('u1', { title: 'T', body: 'B' })).resolves.toEqual({ sent: 0 })
  })

  it('prunes a token whose device has uninstalled the app', async () => {
    const prisma = fakePrisma(['tok-dead'])
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(['error'], 'DeviceNotRegistered'))
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    await service.sendToUser('u1', { title: 'T', body: 'B' })
    // Otherwise that device costs us a request on every notification, forever.
    expect(prisma.deleted).toEqual(['tok-dead'])
  })

  it('keeps a token when the failure is transient rather than permanent', async () => {
    const prisma = fakePrisma(['tok-a'])
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(['error'], 'MessageRateExceeded'))
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    await service.sendToUser('u1', { title: 'T', body: 'B' })
    expect(prisma.deleted).toEqual([])
  })

  it('splits more than 100 devices across requests', async () => {
    const prisma = fakePrisma(Array.from({ length: 150 }, (_, i) => `tok-${i}`))
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(Array.from({ length: 100 }, () => 'ok')))
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    await service.sendToUser('u1', { title: 'T', body: 'B' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('resolves a guest to their user before sending', async () => {
    const prisma = fakePrisma(['tok-a'], 'GUEST')
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(['ok']))
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    expect((await service.sendToGuest('g1', { title: 'T', body: 'B' })).sent).toBe(1)
  })

  it('returns zero for an unknown driver rather than throwing', async () => {
    const prisma = fakePrisma(['tok-a'], 'GUEST') // driver.findUnique resolves null
    const fetchImpl = vi.fn()
    const service = new NotificationService(prisma.client as never, fetchImpl as never)

    expect(await service.sendToDriver('nope', { title: 'T', body: 'B' })).toEqual({ sent: 0 })
  })
})

describe('message catalogue (PRD §15)', () => {
  it('gives the guest the driver, vehicle and ETA in one glance', () => {
    const m = messages.tripAssigned('Suresh', 'KA01AB1234', 7.4)
    expect(m.body).toContain('Suresh')
    expect(m.body).toContain('KA01AB1234')
    expect(m.body).toContain('7 min')
  })

  it('omits the ETA gracefully when it is not yet known', () => {
    expect(messages.tripAssigned('Suresh', 'KA01AB1234', null).body).toBe('Suresh · KA01AB1234')
  })

  it('leads with the vehicle number on arrival — the thing the guest is scanning for', () => {
    expect(messages.driverArrived('KA01AB1234').body).toContain('KA01AB1234')
  })

  it('marks a driver offer high priority, since it expires in 60 seconds', () => {
    expect(messages.tripOffered(2, 'Airport T2').priority).toBe('high')
  })

  it('marks a breakdown reassignment high priority', () => {
    expect(messages.reassigning().priority).toBe('high')
  })

  it('passes the admin decline reason through verbatim, so the guest sees the real reason', () => {
    expect(messages.requestDeclined('Not an event guest').body).toBe('Not an event guest')
  })

  it('never rounds an ETA below 1 minute', () => {
    expect(messages.detourAdded(0.2).body).toContain('1 min')
  })
})
