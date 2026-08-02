import { io, type Socket } from 'socket.io-client'

/**
 * Typed API client shared by both mobile apps.
 *
 * One place that knows the wire format, so a backend change is a compile error in the apps rather
 * than a runtime surprise. Also the only place that knows the base URL (never hardcoded in a screen)
 * and the only place that touches the token.
 */

export interface ApiError {
  code: string
  message: string
  details?: unknown
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError,
  ) {
    super(payload.message)
    this.name = 'ApiClientError'
  }
}

export interface TokenStore {
  get(): Promise<string | null>
  set(token: string): Promise<void>
  clear(): Promise<void>
}

/** In-memory fallback; the apps inject an expo-secure-store implementation. */
export class MemoryTokenStore implements TokenStore {
  private token: string | null = null
  async get() {
    return this.token
  }
  async set(token: string) {
    this.token = token
  }
  async clear() {
    this.token = null
  }
}

export type Role = 'ADMIN' | 'DRIVER' | 'GUEST'

export interface Session {
  token: string
  role: Role
  profile: { id: string; name: string; guestId?: string; driverId?: string }
}

const RETRYABLE_STATUS = new Set([502, 503, 504])

export class EventRideClient {
  private socket: Socket | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenStore = new MemoryTokenStore(),
  ) {}

  // ---------------------------------------------------------------- transport

  /**
   * Single request path with bounded retry.
   *
   * Only idempotent GETs and transient gateway errors are retried — retrying a POST could create a
   * duplicate ride request, which is exactly the thing E18 exists to prevent.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    const token = await this.tokens.get()
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (networkError) {
      if (method === 'GET' && attempt < 2) {
        await delay(400 * (attempt + 1))
        return this.request<T>(method, path, body, attempt + 1)
      }
      throw new ApiClientError(0, {
        code: 'NETWORK_UNAVAILABLE',
        message: String(networkError),
      })
    }

    if (response.status === 204) return undefined as T

    const payload = (await response.json().catch(() => null)) as
      | { error?: ApiError }
      | T
      | null

    if (!response.ok) {
      if (method === 'GET' && RETRYABLE_STATUS.has(response.status) && attempt < 2) {
        await delay(400 * (attempt + 1))
        return this.request<T>(method, path, body, attempt + 1)
      }
      const error =
        payload && typeof payload === 'object' && 'error' in payload && payload.error
          ? payload.error
          : { code: 'HTTP_ERROR', message: `Request failed (${response.status})` }
      throw new ApiClientError(response.status, error)
    }
    return payload as T
  }

  // ---------------------------------------------------------------- auth

  async requestOtp(phone: string): Promise<{ sent: boolean; devCode?: string }> {
    return this.request('POST', '/api/v1/auth/otp/request', { phone })
  }

  async verifyOtp(phone: string, code: string): Promise<Session> {
    const session = await this.request<Session>('POST', '/api/v1/auth/otp/verify', { phone, code })
    await this.tokens.set(session.token)
    return session
  }

  async login(email: string, password: string): Promise<Session> {
    const session = await this.request<Session>('POST', '/api/v1/auth/login', { email, password })
    await this.tokens.set(session.token)
    return session
  }

  async signOut(): Promise<void> {
    this.disconnectSocket()
    await this.tokens.clear()
  }

  // ---------------------------------------------------------------- guest

  guest = {
    itinerary: () => this.request<GuestItineraryItem[]>('GET', '/api/v1/me/itinerary'),
    current: () => this.request<GuestCurrent>('GET', '/api/v1/me/current'),
    ready: (requestId: string) =>
      this.request<{ state: string }>('POST', `/api/v1/me/requests/${requestId}/ready`),
    requestRide: (input: AdHocRideInput) =>
      this.request<{ requestId: string; state: string }>('POST', '/api/v1/me/requests', input),
    noLongerNeeded: (requestId: string) =>
      this.request<{ acknowledged: boolean }>(
        'POST',
        `/api/v1/me/requests/${requestId}/no-longer-needed`,
      ),
    registerPush: (token: string, platform: string) =>
      this.request<{ stored: boolean }>('POST', '/api/v1/me/push-token', { token, platform }),
  }

  // ---------------------------------------------------------------- driver

  driver = {
    setDuty: (online: boolean) => this.request<{ online: boolean }>('POST', '/api/v1/me/duty', { online }),
    currentTrip: () => this.request<{ trip: DriverTrip | null }>('GET', '/api/v1/me/trip'),
    shift: () => this.request<DriverShift>('GET', '/api/v1/me/shift'),
    accept: (tripId: string, version: number) =>
      this.request<{ state: string }>('POST', `/api/v1/me/trip/${tripId}/accept`, { version }),
    reject: (tripId: string, reason: string) =>
      this.request<{ requeued: number }>('POST', `/api/v1/me/trip/${tripId}/reject`, { reason }),
    arrived: (tripId: string, stopId: string) =>
      this.request<{ ok: boolean }>('POST', `/api/v1/me/trip/${tripId}/stops/${stopId}/arrived`),
    boarded: (tripId: string, stopId: string) =>
      this.request<{ ok: boolean }>('POST', `/api/v1/me/trip/${tripId}/stops/${stopId}/boarded`),
    dropped: (tripId: string, stopId: string) =>
      this.request<{ tripCompleted: boolean }>(
        'POST',
        `/api/v1/me/trip/${tripId}/stops/${stopId}/dropped`,
      ),
    guestNotFound: (tripId: string, stopId: string) =>
      this.request<{ ok: boolean }>(
        'POST',
        `/api/v1/me/trip/${tripId}/stops/${stopId}/guest-not-found`,
      ),
    sendLocation: (lat: number, lng: number) =>
      this.request<{ stored: boolean }>('POST', '/api/v1/me/location', { lat, lng }),
    requestBreak: () =>
      this.request<{ granted: boolean; pendingAdmin?: boolean }>('POST', '/api/v1/me/break/request'),
  }

  // ---------------------------------------------------------------- admin

  admin = {
    dashboard: () => this.request<AdminDashboard>('GET', '/api/v1/admin/dashboard'),
    drivers: () => this.request<AdminDriver[]>('GET', '/api/v1/admin/drivers'),
    guests: (state?: string) =>
      this.request<AdminGuest[]>('GET', `/api/v1/admin/guests${state ? `?state=${state}` : ''}`),
    requests: (state?: string) =>
      this.request<AdminRequest[]>('GET', `/api/v1/admin/requests${state ? `?state=${state}` : ''}`),
    approve: (id: string) => this.request<{ state: string }>('POST', `/api/v1/admin/requests/${id}/approve`),
    decline: (id: string, reason: string) =>
      this.request<{ state: string }>('POST', `/api/v1/admin/requests/${id}/decline`, { reason }),
    retry: (id: string) => this.request<{ state: string }>('POST', `/api/v1/admin/requests/${id}/retry`),
    overrideAssign: (id: string, driverId: string, reason: string) =>
      this.request<{ tripId: string; pinned: boolean }>(
        'POST',
        `/api/v1/admin/requests/${id}/override-assign`,
        { driverId, reason },
      ),
    markUnavailable: (driverId: string, reason: string) =>
      this.request<{ requeued: string[] }>('POST', `/api/v1/admin/drivers/${driverId}/unavailable`, {
        reason,
      }),
    manageBreak: (driverId: string, grant: boolean) =>
      this.request<{ grant: boolean }>('POST', `/api/v1/admin/drivers/${driverId}/break`, { grant }),
    createDriver: (input: CreateDriverInput) => this.request('POST', '/api/v1/admin/drivers', input),
    runBatch: () => this.request<{ ran: boolean; decisions: number }>('POST', '/api/v1/admin/batch-plan/run'),
    rounds: () => this.request<DecisionRoundSummary[]>('GET', '/api/v1/admin/rounds'),
    alerts: () => this.request<AlertRow[]>('GET', '/api/v1/admin/alerts'),
    ackAlert: (id: string) => this.request('POST', `/api/v1/admin/alerts/${id}/ack`),
    config: () => this.request<Record<string, unknown>>('GET', '/api/v1/admin/config'),
    updateConfig: (patch: Record<string, unknown>) =>
      this.request<Record<string, unknown>>('PATCH', '/api/v1/admin/config', patch),
    planWaves: (input: { destinationId: string; sessionStartsAt: string; waveCount?: number }) =>
      this.request('POST', '/api/v1/admin/waves/plan', input),
    waves: () => this.request<WaveRow[]>('GET', '/api/v1/admin/waves'),
    dispatchWave: (id: string) => this.request('POST', `/api/v1/admin/waves/${id}/dispatch`),
  }

  // ---------------------------------------------------------------- realtime

  /**
   * Rooms are assigned server-side from the token (HLD §7), so there is nothing to subscribe to
   * here — the client only listens.
   */
  async connectSocket(handlers: SocketHandlers): Promise<void> {
    const token = await this.tokens.get()
    if (!token) return
    this.disconnectSocket()

    this.socket = io(this.baseUrl, {
      auth: { token },
      transports: ['websocket', 'polling'], // polling fallback covers hotel wifi
      reconnection: true,
      reconnectionDelay: 1000,
    })

    if (handlers.onRequestState) this.socket.on('request.state', handlers.onRequestState)
    if (handlers.onTripAssigned) this.socket.on('trip.assigned', handlers.onTripAssigned)
    if (handlers.onTripLocation) this.socket.on('trip.location', handlers.onTripLocation)
    if (handlers.onTripOffered) this.socket.on('trip.offered', handlers.onTripOffered)
    if (handlers.onTripUpdated) this.socket.on('trip.updated', handlers.onTripUpdated)
    if (handlers.onDriverPositions) this.socket.on('driver.positions', handlers.onDriverPositions)
    if (handlers.onAlert) this.socket.on('alert.raised', handlers.onAlert)
    if (handlers.onConnectionChange) {
      this.socket.on('connect', () => handlers.onConnectionChange?.(true))
      this.socket.on('disconnect', () => handlers.onConnectionChange?.(false))
    }
  }

  disconnectSocket(): void {
    this.socket?.disconnect()
    this.socket = null
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- wire types

export interface GuestItineraryItem {
  requestId: string
  tripType: string
  state: string
  scheduledAt: string | null
  from: string
  to: string
  groupSize: number
  luggageCount: number
}

export interface GuestCurrent {
  request: {
    id: string
    state: string
    tripType: string
    pickup: { label: string; instruction: string | null; lat: number; lng: number }
    destination: { label: string }
    scheduledAt: string | null
    readyAt: string | null
    groupSize: number
    luggageCount: number
    declineReason: string | null
  } | null
  driver?: {
    name: string
    phone: string
    vehicleNumber: string
    vehicleType: string
    lat: number | null
    lng: number | null
    lastLocationAt: string | null
  } | null
  isShared?: boolean
  coPassengers?: number
  stopsBeforeYou?: number
  plannedPickupAt?: string | null
}

export interface AdHocRideInput {
  originId: string
  destinationId: string
  people: number
  luggage: number
  reason: string
  when?: 'NOW' | 'LATER'
}

export interface DriverTripStop {
  id: string
  seq: number
  kind: 'PICKUP' | 'DROP'
  label: string
  instruction: string | null
  lat: number
  lng: number
  state: 'PENDING' | 'ARRIVED' | 'DONE' | 'SKIPPED'
  plannedAt: string | null
}

export interface DriverTrip {
  id: string
  state: string
  version: number
  offerExpiresAt: string | null
  plannedPickupAt: string | null
  plannedDropAt: string | null
  /** Guest names only — a phone number is never sent to a driver (D9). */
  guestNames: string[]
  guestCount: number
  luggageCount: number
  stops: DriverTripStop[]
}

export interface DriverShift {
  shiftStart: string
  shiftEnd: string
  drivingMinutesToday: number
  tripsSinceBreak: number
  breakState: string
  minutesUntilBreakDue: number
  tripsUntilBreakDue: number
  opsHelpdeskPhone: string
}

export interface AdminDashboard {
  counts: { queued: number; assigned: number; inTransit: number; completed: number; unmatched: number }
  drivers: { total: number; available: number; onTrip: number; onBreak: number; offline: number }
  demandVsSupply: { seatsNeeded: number; seatsAvailable: number; gap: number }
  waiting: { requestId: string; waitedMin: number; severity: 'OK' | 'WARN' | 'CRITICAL' }[]
  alerts: AlertRow[]
}

export interface AdminDriver {
  id: string
  name: string
  phone: string
  vehicleNumber: string
  vehicleType: string
  seatCapacity: number
  luggageCapacity: number
  state: string
  breakState: string
  drivingMinutesToday: number
  position: { lat: number; lng: number; at: string | null } | null
  predictedFreeAt: string | null
  currentTripId: string | null
}

export interface AdminGuest {
  id: string
  name: string
  phone: string
  isVip: boolean
  groupSize: number
  luggageCount: number
  accommodation: string | null
  arrivalAt: string | null
  currentState: string | null
  requests: { id: string; state: string; tripType: string }[]
}

export interface AdminRequest {
  id: string
  state: string
  tripType: string
  groupSize: number
  luggageCount: number
  readyAt: string | null
  unmatchedReason: string | null
  approvalNote: string | null
  guest: { name: string; isVip: boolean }
  origin: { label: string }
  destination: { label: string }
}

export interface AlertRow {
  id: string
  type: string
  severity: string
  message: string
  entityId: string | null
  createdAt: string
  acknowledgedAt: string | null
}

export interface DecisionRoundSummary {
  id: string
  trigger: string
  startedAt: string
  durationMs: number
  routingCalls: number
}

export interface WaveRow {
  id: string
  departsAt: string
  state: string
  seatsNeeded: number
  origin: { label: string }
  destination: { label: string }
}

export interface CreateDriverInput {
  name: string
  phone: string
  vehicleNumber: string
  vehicleType: string
  seatCapacity: number
  luggageCapacity: number
  shiftStart: string
  shiftEnd: string
}

export interface SocketHandlers {
  onRequestState?: (payload: unknown) => void
  onTripAssigned?: (payload: unknown) => void
  onTripLocation?: (payload: unknown) => void
  onTripOffered?: (payload: unknown) => void
  onTripUpdated?: (payload: unknown) => void
  onDriverPositions?: (payload: { driverId: string; lat: number; lng: number }[]) => void
  onAlert?: (payload: AlertRow) => void
  onConnectionChange?: (connected: boolean) => void
}
