/**
 * All timestamps in the system are UTC (NFR-9). MySQL has no timezone-aware type (HLD §2.2),
 * so UTC discipline lives here and in the connection settings — never in SQL.
 */

export const MINUTE_MS = 60_000

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MINUTE_MS
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE_MS)
}

export function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000)
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime()
}

export function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime()
}

/**
 * Injected clock. The engine and the simulator never call `new Date()` directly (HLD T15),
 * which is what lets a 6-hour arrival curve replay in seconds.
 */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

export class VirtualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current)
  }
  advanceMinutes(m: number): void {
    this.current = addMinutes(this.current, m)
  }
  advanceSeconds(s: number): void {
    this.current = addSeconds(this.current, s)
  }
  set(d: Date): void {
    this.current = new Date(d)
  }
}
