import React from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'

/**
 * Minimal slippy-map view built from raw OpenStreetMap tiles.
 *
 * Why not react-native-maps or MapLibre: both need a native module (and Google Maps needs a billed
 * API key on Android), which would mean a custom dev client and make the app unrunnable for a
 * reviewer with Expo Go and no Google account. This renders a 3×3 grid of plain <Image> tiles with
 * absolutely-positioned markers — no native dependency, no key, works offline-degraded.
 *
 * The trade-off is deliberate and documented: no gestures, no rotation, no vector styling. For
 * "where is my driver right now" that is enough, and the numeric ETA above the map is the primary
 * signal anyway (FR-G6).
 */

const TILE_SIZE = 256

export interface MapMarker {
  lat: number
  lng: number
  label: string
  kind: 'DRIVER' | 'PICKUP' | 'DROP' | 'GUEST'
}

export interface TileMapProps {
  center: { lat: number; lng: number }
  markers?: MapMarker[]
  zoom?: number
  height?: number
  /** Shown when tiles cannot load, so the map area never becomes a blank void. */
  fallbackLabel?: string
}

const lngToTileX = (lng: number, zoom: number): number => ((lng + 180) / 360) * 2 ** zoom

const latToTileY = (lat: number, zoom: number): number => {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom
}

const MARKER_STYLE: Record<MapMarker['kind'], { colour: string; glyph: string }> = {
  DRIVER: { colour: '#1d4ed8', glyph: '🚗' },
  PICKUP: { colour: '#047857', glyph: '📍' },
  DROP: { colour: '#b45309', glyph: '🏨' },
  GUEST: { colour: '#7c3aed', glyph: '🧍' },
}

export function TileMap({
  center,
  markers = [],
  zoom = 13,
  height = 220,
  fallbackLabel = 'Map unavailable',
}: TileMapProps): React.JSX.Element {
  const [failed, setFailed] = React.useState(false)

  const centerX = lngToTileX(center.lng, zoom)
  const centerY = latToTileY(center.lat, zoom)
  const originTileX = Math.floor(centerX) - 1
  const originTileY = Math.floor(centerY) - 1

  // Pixel offset that keeps the requested centre in the middle of the viewport.
  const offsetX = (centerX - originTileX) * TILE_SIZE
  const offsetY = (centerY - originTileY) * TILE_SIZE

  const toScreen = (lat: number, lng: number) => ({
    left: (lngToTileX(lng, zoom) - originTileX) * TILE_SIZE - offsetX,
    top: (latToTileY(lat, zoom) - originTileY) * TILE_SIZE - offsetY,
  })

  if (failed) {
    return (
      <View style={[styles.container, { height }, styles.fallback]}>
        <Text style={styles.fallbackText}>{fallbackLabel}</Text>
        {markers.map((m) => (
          <Text key={`${m.kind}-${m.label}`} style={styles.fallbackCoords}>
            {MARKER_STYLE[m.kind].glyph} {m.label}
          </Text>
        ))}
      </View>
    )
  }

  return (
    <View style={[styles.container, { height }]}>
      <View style={styles.canvas}>
        {[0, 1, 2].map((row) =>
          [0, 1, 2].map((col) => (
            <Image
              key={`${row}-${col}`}
              source={{
                uri: `https://tile.openstreetmap.org/${zoom}/${originTileX + col}/${originTileY + row}.png`,
              }}
              style={[
                styles.tile,
                { left: col * TILE_SIZE - offsetX, top: row * TILE_SIZE - offsetY },
              ]}
              onError={() => setFailed(true)}
            />
          )),
        )}

        {clusterMarkers(markers, toScreen).map((cluster) => {
          const style = MARKER_STYLE[cluster.kind]
          return (
            <View
              key={cluster.key}
              style={[styles.marker, { left: cluster.left - 14, top: cluster.top - 14 }]}
            >
              <View style={[styles.pin, { borderColor: style.colour }]}>
                <Text style={styles.pinGlyph}>{style.glyph}</Text>
              </View>
              {/* Without this a staged fleet renders 39 pins on one pixel and ops sees "a vehicle"
                  instead of "39 vehicles waiting at the terminal". */}
              {cluster.count > 1 ? (
                <View style={[styles.badge, { backgroundColor: style.colour }]}>
                  <Text style={styles.badgeText}>{cluster.count > 99 ? '99+' : cluster.count}</Text>
                </View>
              ) : null}
            </View>
          )
        })}
      </View>
      <Text style={styles.attribution}>© OpenStreetMap</Text>
    </View>
  )
}

/**
 * Groups markers that would land within a pin's width of each other into one pin with a count.
 *
 * Vehicles staged at the same terminal share coordinates almost exactly, so without clustering the
 * fleet map is a single pin sitting on 38 invisible ones.
 */
interface Cluster {
  key: string
  kind: MapMarker['kind']
  left: number
  top: number
  count: number
}

const CLUSTER_RADIUS_PX = 22

function clusterMarkers(
  markers: readonly MapMarker[],
  toScreen: (lat: number, lng: number) => { left: number; top: number },
): Cluster[] {
  const clusters: Cluster[] = []

  for (const marker of markers) {
    const { left, top } = toScreen(marker.lat, marker.lng)
    // Same kind only: a driver pin must never be absorbed into a pickup pin.
    const existing = clusters.find(
      (c) =>
        c.kind === marker.kind &&
        Math.abs(c.left - left) < CLUSTER_RADIUS_PX &&
        Math.abs(c.top - top) < CLUSTER_RADIUS_PX,
    )
    if (existing) existing.count += 1
    else clusters.push({ key: `${marker.kind}-${left.toFixed(0)}-${top.toFixed(0)}`, kind: marker.kind, left, top, count: 1 })
  }
  return clusters
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#e5e7eb',
    position: 'relative',
  },
  canvas: { position: 'absolute', left: '50%', top: '50%', width: 1, height: 1 },
  tile: { position: 'absolute', width: TILE_SIZE, height: TILE_SIZE },
  marker: { position: 'absolute', alignItems: 'center' },
  pin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinGlyph: { fontSize: 14 },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  attribution: {
    position: 'absolute',
    right: 4,
    bottom: 2,
    fontSize: 9,
    color: '#374151',
    backgroundColor: 'rgba(255,255,255,0.7)',
    paddingHorizontal: 3,
  },
  fallback: { alignItems: 'center', justifyContent: 'center', gap: 4 },
  fallbackText: { color: '#6b7280', fontWeight: '600' },
  fallbackCoords: { color: '#6b7280', fontSize: 12 },
})
