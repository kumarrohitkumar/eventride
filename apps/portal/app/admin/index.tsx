import React from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { ApiClientError, type AdminDashboard, type AdminDriver } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Label,
  Loading,
  PrimaryButton,
  Row,
  SecondaryButton,
  StatusPill,
  TileMap,
  theme,
  type MapMarker,
} from '@eventride/ui'
import { client, useSession } from '../../src/session.js'

/**
 * Ops dashboard (FR-A1, FR-A4, FR-A14).
 *
 * Mobile-first because the portal is a mobile app: dense tables become card lists, and the three
 * things an event-day coordinator actually needs are surfaced first — what is broken, who is
 * waiting too long, and whether the fleet can cope with what is coming.
 */
export default function AdminDashboardScreen(): React.JSX.Element {
  const { signOut } = useSession()
  const [data, setData] = React.useState<AdminDashboard | null>(null)
  const [drivers, setDrivers] = React.useState<AdminDriver[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [dashboard, driverList] = await Promise.all([client.admin.dashboard(), client.admin.drivers()])
      setData(dashboard)
      setDrivers(driverList)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load the dashboard')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  React.useEffect(() => {
    void client.connectSocket({
      onDriverPositions: (positions) => {
        // Batched at 1 Hz by the server, so this is one message for the whole fleet.
        setDrivers((current) =>
          current.map((d) => {
            const update = positions.find((p) => p.driverId === d.id)
            return update ? { ...d, position: { lat: update.lat, lng: update.lng, at: null } } : d
          }),
        )
      },
      onAlert: () => void load(),
    })
    return () => client.disconnectSocket()
  }, [load])

  if (loading) return <Loading label="Loading operations…" />
  if (!data) return <ErrorBanner message={error ?? 'No data'} />

  const criticalAlerts = data.alerts.filter((a) => a.severity === 'critical')
  const markers: MapMarker[] = drivers
    .filter((d) => d.position)
    .map((d) => ({
      lat: d.position!.lat,
      lng: d.position!.lng,
      label: d.vehicleNumber,
      kind: 'DRIVER' as const,
    }))
  const mapCentre = markers[0] ?? { lat: 12.9756, lng: 77.6068 }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            void load()
          }}
        />
      }
    >
      <ErrorBanner message={error} />

      {/* Critical first: on event day this is what the coordinator opens the app for. */}
      {criticalAlerts.length > 0 ? (
        <Card style={styles.criticalCard}>
          <Label>NEEDS ATTENTION</Label>
          {criticalAlerts.slice(0, 5).map((alert) => (
            <Row key={alert.id} style={{ justifyContent: 'space-between' }}>
              <Body>{alert.message}</Body>
              <SecondaryButton
                title="Ack"
                onPress={() =>
                  void client.admin.ackAlert(alert.id).then(() => load())
                }
              />
            </Row>
          ))}
        </Card>
      ) : null}

      {/* FR-A14: the number that lets ops escalate the fleet BEFORE the queue explodes. */}
      <Card style={data.demandVsSupply.gap > 0 ? styles.warnCard : undefined}>
        <Label>DEMAND VS SUPPLY</Label>
        <Row style={{ justifyContent: 'space-between' }}>
          <Metric label="Seats needed" value={data.demandVsSupply.seatsNeeded} />
          <Metric label="Seats available" value={data.demandVsSupply.seatsAvailable} />
          <Metric
            label="Shortfall"
            value={data.demandVsSupply.gap}
            tone={data.demandVsSupply.gap > 0 ? 'danger' : 'ok'}
          />
        </Row>
      </Card>

      <Card>
        <Label>GUESTS</Label>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Metric label="Waiting" value={data.counts.queued} tone={data.counts.queued > 0 ? 'warn' : 'ok'} />
          <Metric label="Assigned" value={data.counts.assigned} />
          <Metric label="In transit" value={data.counts.inTransit} />
          <Metric label="Done" value={data.counts.completed} />
          <Metric label="Unmatched" value={data.counts.unmatched} tone={data.counts.unmatched > 0 ? 'danger' : 'ok'} />
        </Row>
      </Card>

      <Card>
        <Label>FLEET</Label>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Metric label="Available" value={data.drivers.available} />
          <Metric label="On trip" value={data.drivers.onTrip} />
          <Metric label="On break" value={data.drivers.onBreak} />
          <Metric label="Offline" value={data.drivers.offline} />
        </Row>
        <TileMap center={mapCentre} markers={markers} height={220} fallbackLabel="Fleet map unavailable" />
      </Card>

      {/* FR-A4: longest wait first, colour-coded by severity. */}
      {data.waiting.length > 0 ? (
        <Card>
          <Label>LONGEST WAITS</Label>
          {data.waiting.slice(0, 6).map((entry) => (
            <Row key={entry.requestId} style={{ justifyContent: 'space-between' }}>
              <Body>{entry.waitedMin} min waiting</Body>
              <StatusPill
                label={entry.severity}
                tone={entry.severity === 'CRITICAL' ? 'danger' : entry.severity === 'WARN' ? 'warn' : 'success'}
              />
            </Row>
          ))}
        </Card>
      ) : null}

      <Card>
        <Label>MANAGE</Label>
        <SecondaryButton title="Approvals" onPress={() => router.push('/admin/approvals')} />
        <SecondaryButton title="Exceptions" onPress={() => router.push('/admin/exceptions')} />
        <SecondaryButton title="Drivers" onPress={() => router.push('/admin/drivers')} />
        <SecondaryButton title="Guests" onPress={() => router.push('/admin/guests')} />
        <PrimaryButton
          title="Run dispatch round now"
          onPress={() => void client.admin.runBatch().then(() => load())}
        />
      </Card>

      <SecondaryButton title="Sign out" onPress={() => void signOut()} />
    </ScrollView>
  )
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'ok' | 'warn' | 'danger'
}): React.JSX.Element {
  const colour =
    tone === 'danger' ? theme.colour.danger : tone === 'warn' ? theme.colour.warn : theme.colour.text
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricValue, { color: colour }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  content: { padding: theme.space(2), gap: theme.space(1.5) },
  metric: { alignItems: 'center', minWidth: 72, paddingVertical: 4 },
  metricValue: { fontSize: 26, fontWeight: '800' },
  metricLabel: { fontSize: 11, color: theme.colour.muted, fontWeight: '600' },
  criticalCard: { borderColor: theme.colour.danger, borderWidth: 2 },
  warnCard: { borderColor: theme.colour.warn, borderWidth: 2 },
})
