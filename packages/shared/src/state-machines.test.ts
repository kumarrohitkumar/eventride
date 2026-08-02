import { describe, it, expect } from 'vitest'
import {
  canTransitionRequest,
  canTransitionDriver,
  assertRequestTransition,
  REQUEST_TRANSITIONS,
  DRIVER_TRANSITIONS,
  IllegalTransitionError,
} from './state-machines.js'
import { REQUEST_STATES, DRIVER_STATES } from './enums.js'

describe('request state machine (LLD §3.1)', () => {
  it('allows the scheduled happy path end to end', () => {
    expect(canTransitionRequest('REGISTERED', 'QUEUED')).toBe(true)
    expect(canTransitionRequest('QUEUED', 'ASSIGNED')).toBe(true)
    expect(canTransitionRequest('ASSIGNED', 'ACCEPTED')).toBe(true)
    expect(canTransitionRequest('ACCEPTED', 'EN_ROUTE')).toBe(true)
    expect(canTransitionRequest('EN_ROUTE', 'ARRIVED_PICKUP')).toBe(true)
    expect(canTransitionRequest('ARRIVED_PICKUP', 'BOARDED')).toBe(true)
    expect(canTransitionRequest('BOARDED', 'COMPLETED')).toBe(true)
  })

  it('allows the ad-hoc approval path', () => {
    expect(canTransitionRequest('REGISTERED', 'PENDING_APPROVAL')).toBe(true)
    expect(canTransitionRequest('PENDING_APPROVAL', 'APPROVED')).toBe(true)
    expect(canTransitionRequest('PENDING_APPROVAL', 'DECLINED')).toBe(true)
    expect(canTransitionRequest('APPROVED', 'QUEUED')).toBe(true)
  })

  it('lets a rejected/expired offer return to the queue (E2, E3)', () => {
    expect(canTransitionRequest('ASSIGNED', 'QUEUED')).toBe(true)
  })

  it('lets an unmatched request be retried (E1)', () => {
    expect(canTransitionRequest('UNMATCHED', 'QUEUED')).toBe(true)
  })

  it('lets a breakdown re-queue an in-progress request (E5)', () => {
    expect(canTransitionRequest('BOARDED', 'QUEUED')).toBe(true)
    expect(canTransitionRequest('EN_ROUTE', 'QUEUED')).toBe(true)
    expect(canTransitionRequest('ARRIVED_PICKUP', 'QUEUED')).toBe(true)
  })

  it('rejects state jumps that would skip the pickup', () => {
    expect(canTransitionRequest('QUEUED', 'COMPLETED')).toBe(false)
    expect(canTransitionRequest('ASSIGNED', 'BOARDED')).toBe(false)
    expect(canTransitionRequest('REGISTERED', 'ASSIGNED')).toBe(false)
  })

  it('treats terminal states as terminal', () => {
    for (const terminal of ['COMPLETED', 'DECLINED', 'CANCELLED'] as const) {
      expect(REQUEST_TRANSITIONS[terminal]).toEqual([])
    }
  })

  it('throws IllegalTransitionError with both states named', () => {
    expect(() => assertRequestTransition('QUEUED', 'COMPLETED')).toThrow(IllegalTransitionError)
    expect(() => assertRequestTransition('QUEUED', 'COMPLETED')).toThrow(/QUEUED.*COMPLETED/)
  })

  it('defines an entry for every request state (no undefined lookups)', () => {
    for (const s of REQUEST_STATES) expect(Array.isArray(REQUEST_TRANSITIONS[s])).toBe(true)
  })

  it('never lists a transition to an unknown state', () => {
    for (const from of REQUEST_STATES)
      for (const to of REQUEST_TRANSITIONS[from]) expect(REQUEST_STATES).toContain(to)
  })
})

describe('driver state machine (LLD §3.2)', () => {
  it('allows the duty + trip lifecycle', () => {
    expect(canTransitionDriver('OFFLINE', 'AVAILABLE')).toBe(true)
    expect(canTransitionDriver('AVAILABLE', 'OFFERED')).toBe(true)
    expect(canTransitionDriver('OFFERED', 'EN_ROUTE_TO_PICKUP')).toBe(true)
    expect(canTransitionDriver('EN_ROUTE_TO_PICKUP', 'AT_PICKUP')).toBe(true)
    expect(canTransitionDriver('AT_PICKUP', 'ON_TRIP')).toBe(true)
    expect(canTransitionDriver('ON_TRIP', 'AVAILABLE')).toBe(true)
  })

  it('returns a rejecting driver to available (E2)', () => {
    expect(canTransitionDriver('OFFERED', 'AVAILABLE')).toBe(true)
  })

  it('supports breaks in both directions (FR-D9)', () => {
    expect(canTransitionDriver('AVAILABLE', 'ON_BREAK')).toBe(true)
    expect(canTransitionDriver('ON_BREAK', 'AVAILABLE')).toBe(true)
  })

  it('allows breakdown from any state (E5)', () => {
    for (const s of DRIVER_STATES) {
      if (s === 'UNAVAILABLE') continue
      expect(canTransitionDriver(s, 'UNAVAILABLE')).toBe(true)
    }
  })

  it('never lets a driver jump straight from available to on-trip', () => {
    expect(canTransitionDriver('AVAILABLE', 'ON_TRIP')).toBe(false)
    expect(canTransitionDriver('OFFLINE', 'OFFERED')).toBe(false)
  })

  it('forbids going offline mid-trip (must complete or be overridden)', () => {
    expect(canTransitionDriver('ON_TRIP', 'OFFLINE')).toBe(false)
  })

  it('defines an entry for every driver state', () => {
    for (const s of DRIVER_STATES) expect(Array.isArray(DRIVER_TRANSITIONS[s])).toBe(true)
  })
})
