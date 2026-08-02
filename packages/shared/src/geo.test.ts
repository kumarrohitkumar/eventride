import { describe, it, expect } from 'vitest'
import { haversineKm, estimateMinutes, isSameCluster, snapToGrid } from './geo.js'

// Real coordinates so the numbers are checkable against a map.
const BLR_AIRPORT = { lat: 13.1986, lng: 77.7066 }
const MG_ROAD = { lat: 12.9756, lng: 77.6068 }

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(MG_ROAD, MG_ROAD)).toBe(0)
  })

  it('matches the known ~28 km airport-to-city distance', () => {
    expect(haversineKm(BLR_AIRPORT, MG_ROAD)).toBeGreaterThan(26)
    expect(haversineKm(BLR_AIRPORT, MG_ROAD)).toBeLessThan(30)
  })

  it('is symmetric', () => {
    expect(haversineKm(BLR_AIRPORT, MG_ROAD)).toBeCloseTo(haversineKm(MG_ROAD, BLR_AIRPORT), 9)
  })
})

describe('estimateMinutes (NFR-3 L1 fallback)', () => {
  it('never returns zero, so a trip always has non-zero duration', () => {
    expect(estimateMinutes(MG_ROAD, MG_ROAD)).toBeGreaterThanOrEqual(1)
  })

  it('gives a plausible airport run under urban assumptions', () => {
    const min = estimateMinutes(BLR_AIRPORT, MG_ROAD)
    expect(min).toBeGreaterThan(50)
    expect(min).toBeLessThan(100)
  })
})

describe('isSameCluster (D23)', () => {
  it('groups two hotels 1.5 km apart at a 2 km radius', () => {
    const hotelA = { lat: 12.9756, lng: 77.6068 }
    const hotelB = { lat: 12.9856, lng: 77.6118 } // ~1.2 km away
    expect(isSameCluster(hotelA, hotelB, 2)).toBe(true)
  })

  it('does NOT group hotels in opposite directions (E11)', () => {
    expect(isSameCluster(MG_ROAD, BLR_AIRPORT, 2)).toBe(false)
  })
})

describe('snapToGrid (HLD §8.2 cache key)', () => {
  it('gives two drivers ~30 m apart the same cache key', () => {
    const a = { lat: 12.9756, lng: 77.6068 }
    const b = { lat: 12.97563, lng: 77.60682 }
    expect(snapToGrid(a)).toBe(snapToGrid(b))
  })

  it('gives distant points different keys', () => {
    expect(snapToGrid(MG_ROAD)).not.toBe(snapToGrid(BLR_AIRPORT))
  })
})
