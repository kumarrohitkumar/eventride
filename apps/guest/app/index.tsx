import React from 'react'
import { Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { ApiClientError, type GuestCurrent } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  EtaText,
  Heading,
  Label,
  Loading,
  PrimaryButton,
  Row,
  Screen,
  SecondaryButton,
  StaleNotice,
  StatusPill,
  TileMap,
  theme,
  type MapMarker,
} from '@eventride/ui'
import { client, useSession } from '../src/session.js'

const OPS_HELPDESK = '+91-99999-00000'

/**
 * Guest home (FR-G2, G5, G6, G7, G8, G11, G14).
 *
 * One screen, one dominant action, and the label of that action follows the trip state. A tired
 * guest at 02:00 should not have to navigate anywhere to answer "where is my ride".
 */
export default function HomeScreen(): React.JSX.Element {
  const { session, signOut } = useSession()
  const [data, setData] = React.useState<GuestCurrent | null>(null)
  const [fetchedAt, setFetchedAt] = React.useState<Date | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [offline, setOffline] = React.useState(false)

  React.useEffect(() => {
    if (!session) router.replace('/login')
  }, [session])

  const load = React.useCallback(async () => {
    try {
      const next = await client.guest.current()
      setData(next)
      setFetchedAt(new Date())
      setOffline(false)
      setError(null)
    } catch (e) {
      // FR-G14: keep whatever we last had and mark it stale rather than blanking the screen.
      if (e instanceof ApiClientError && e.payload.code === 'NETWORK_UNAVAILABLE') setOffline(true)
      else setError(e instanceof ApiClientError ? e.payload.message : 'Could not refresh')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    // Polling backs up the socket: if the websocket drops on hotel wifi the screen still updates.
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  React.useEffect(() => {
    void client.connectSocket({
      onRequestState: () => void load(),
      onTripAssigned: () => void load(),
      onTripLocation: () => void load(),
      onConnectionChange: (connected) => setOffline(!connected),
    })
    return () => client.disconnectSocket()
  }, [load])

  const markReady = async () => {
    if (!data?.request) return
    setBusy(true)
    try {
      await client.guest.ready(data.request.id)
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not confirm')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading label="Loading your ride…" />

  if (!data?.request) {
    return (
      <Screen>
        <Card>
          <Heading>No active ride</Heading>
          <Body>You have no ride in progress. Your scheduled trips are in My Trips.</Body>
          <SecondaryButton title="My Trips" onPress={() => router.push('/itinerary')} />
          <SecondaryButton title="Request a ride" onPress={() => router.push('/request')} />
        </Card>
        <HelpCard />
        <SecondaryButton title="Sign out" onPress={() => void signOut()} />
      </Screen>
    )
  }

  const request = data.request
  const driver = data.driver ?? null
  const view = viewForState(request.state)

  const markers: MapMarker[] = []
  if (typeof driver?.lat === 'number' && typeof driver?.lng === 'number') {
    markers.push({ lat: driver.lat, lng: driver.lng, label: driver.vehicleNumber, kind: 'DRIVER' })
  }
  markers.push({ lat: request.pickup.lat, lng: request.pickup.lng, label: request.pickup.label, kind: 'PICKUP' })

  const etaMinutes =
    data.plannedPickupAt && ['ACCEPTED', 'EN_ROUTE'].includes(request.state)
      ? (new Date(data.plannedPickupAt).getTime() - Date.now()) / 60_000
      : null

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
    >
      {offline ? (
        <View style={styles.offline}>
          <Text style={styles.offlineText}>Offline — showing last known information</Text>
        </View>
      ) : null}
      <ErrorBanner message={error} />

      <Card>
        <Row>
          <StatusPill label={view.pill} tone={view.tone} />
          <StaleNotice at={fetchedAt} />
        </Row>
        <Heading>{view.headline}</Heading>
        <Body>{view.detail(request.destination.label)}</Body>

        {/* ARRIVED is the moment the vehicle number matters most, so it gets the largest type. */}
        {request.state === 'ARRIVED_PICKUP' && driver ? (
          <Text style={styles.plate}>{driver.vehicleNumber}</Text>
        ) : null}
      </Card>

      {view.showReadyButton ? (
        <Card>
          <Label>PICKUP</Label>
          <Body>{request.pickup.label}</Body>
          {request.pickup.instruction ? <Body>{request.pickup.instruction}</Body> : null}
          <PrimaryButton title="I have arrived" onPress={() => void markReady()} busy={busy} />
        </Card>
      ) : null}

      {driver ? (
        <Card>
          <Label>YOUR DRIVER</Label>
          <Heading>{driver.name}</Heading>
          <Body>
            {driver.vehicleType} · {driver.vehicleNumber}
          </Body>
          {/* ETA as text, ABOVE the map, always present (FR-G6). */}
          <EtaText minutes={etaMinutes} estimated />
          <TileMap center={markers[0] ?? request.pickup} markers={markers} height={200} />
          <SecondaryButton title={`Call driver · ${driver.phone}`} onPress={() => void Linking.openURL(`tel:${driver.phone}`)} />
        </Card>
      ) : null}

      {data.isShared ? (
        <Card>
          <Label>SHARED RIDE</Label>
          <Body>
            {data.coPassengers} co-passenger{data.coPassengers === 1 ? '' : 's'} ·{' '}
            {data.stopsBeforeYou === 0
              ? 'you are the next stop'
              : `${data.stopsBeforeYou} stop${data.stopsBeforeYou === 1 ? '' : 's'} before yours`}
          </Body>
        </Card>
      ) : null}

      {request.state === 'UNMATCHED' ? (
        <Card>
          <Label>STATUS</Label>
          {/* FR-G11: honest, never an endless spinner. */}
          <Body>Arranging your ride — our team has been notified and is on it.</Body>
        </Card>
      ) : null}

      {request.declineReason ? (
        <Card>
          <Label>REQUEST DECLINED</Label>
          <Body>{request.declineReason}</Body>
        </Card>
      ) : null}

      <Row>
        <SecondaryButton title="My Trips" onPress={() => router.push('/itinerary')} />
        <SecondaryButton title="Request a ride" onPress={() => router.push('/request')} />
      </Row>
      <HelpCard />
    </ScrollView>
  )
}

function HelpCard(): React.JSX.Element {
  return (
    <Card>
      <Label>NEED HELP?</Label>
      <SecondaryButton
        title={`Call event helpdesk · ${OPS_HELPDESK}`}
        onPress={() => void Linking.openURL(`tel:${OPS_HELPDESK}`)}
      />
    </Card>
  )
}

/** FR-G7 — one place that maps state to what the guest reads. */
function viewForState(state: string): {
  pill: string
  tone: 'neutral' | 'info' | 'success' | 'warn' | 'danger'
  headline: string
  detail: (destination: string) => string
  showReadyButton: boolean
} {
  switch (state) {
    case 'REGISTERED':
      return {
        pill: 'Scheduled',
        tone: 'neutral',
        headline: 'Tap when you land',
        detail: (d) => `We will take you to ${d}.`,
        showReadyButton: true,
      }
    case 'PENDING_APPROVAL':
      return {
        pill: 'Pending approval',
        tone: 'warn',
        headline: 'Request sent',
        detail: () => 'The event team is reviewing your request.',
        showReadyButton: false,
      }
    case 'QUEUED':
    case 'APPROVED':
      return {
        pill: 'Finding your ride',
        tone: 'info',
        headline: 'Finding your ride',
        detail: () => 'We are assigning the nearest available vehicle.',
        showReadyButton: false,
      }
    case 'ASSIGNED':
      // Deliberately still "finding": the driver has not accepted, so naming them could mean the
      // guest watches a driver appear and vanish (HLD §6.1).
      return {
        pill: 'Finding your ride',
        tone: 'info',
        headline: 'Finding your ride',
        detail: () => 'Confirming with a driver now.',
        showReadyButton: false,
      }
    case 'ACCEPTED':
    case 'EN_ROUTE':
      return {
        pill: 'Driver on the way',
        tone: 'success',
        headline: 'Your driver is on the way',
        detail: (d) => `Heading to you, then on to ${d}.`,
        showReadyButton: false,
      }
    case 'ARRIVED_PICKUP':
      return {
        pill: 'Driver arrived',
        tone: 'success',
        headline: 'Your driver has arrived',
        detail: () => 'Look for this vehicle number:',
        showReadyButton: false,
      }
    case 'BOARDED':
      return {
        pill: 'On the way',
        tone: 'success',
        headline: 'On the way',
        detail: (d) => `Next stop: ${d}.`,
        showReadyButton: false,
      }
    case 'UNMATCHED':
      return {
        pill: 'Arranging',
        tone: 'warn',
        headline: 'Arranging your ride',
        detail: () => 'Our team has been notified.',
        showReadyButton: false,
      }
    case 'NO_SHOW':
      return {
        pill: 'Missed pickup',
        tone: 'danger',
        headline: 'We could not find you',
        detail: () => 'Please contact the event helpdesk to rebook.',
        showReadyButton: false,
      }
    default:
      return {
        pill: state,
        tone: 'neutral',
        headline: 'Your ride',
        detail: (d) => `Destination: ${d}.`,
        showReadyButton: false,
      }
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  content: { padding: theme.space(2), gap: theme.space(1.5) },
  plate: { fontSize: 40, fontWeight: '800', letterSpacing: 2, color: theme.colour.text },
  offline: { backgroundColor: '#fef3c7', padding: theme.space(1), borderRadius: theme.radius },
  offlineText: { color: '#92400e', fontWeight: '600' },
})
