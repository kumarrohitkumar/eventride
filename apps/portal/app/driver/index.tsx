import React from 'react'
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Location from 'expo-location'
import { ApiClientError, type DriverShift, type DriverTrip } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Heading,
  Label,
  Loading,
  PrimaryButton,
  Row,
  SecondaryButton,
  StatusPill,
  TileMap,
  theme,
} from '@eventride/ui'
import { client, useSession } from '../../src/session.js'

/**
 * Driver home (FR-D2…D13).
 *
 * Exactly ONE trip is ever on screen. There is no queue, no other drivers, no map of waiting
 * guests — not because the UI hides them but because no endpoint exposes them (FR-D3).
 */
export default function DriverScreen(): React.JSX.Element {
  const { signOut } = useSession()
  const [trip, setTrip] = React.useState<DriverTrip | null>(null)
  const [shift, setShift] = React.useState<DriverShift | null>(null)
  const [online, setOnline] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [tripResult, shiftResult] = await Promise.all([
        client.driver.currentTrip(),
        client.driver.shift(),
      ])
      setTrip(tripResult.trip)
      setShift(shiftResult)
      setError(null)
    } catch (e) {
      if (!(e instanceof ApiClientError && e.payload.code === 'NETWORK_UNAVAILABLE')) {
        setError(e instanceof ApiClientError ? e.payload.message : 'Could not refresh')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  React.useEffect(() => {
    void client.connectSocket({
      onTripOffered: () => void load(),
      onTripUpdated: () => {
        // FR-D8: the engine inserted a stop into the trip already under way.
        Alert.alert('New stop added', 'Your route has been updated with an extra pickup.')
        void load()
      },
    })
    return () => client.disconnectSocket()
  }, [load])

  /** FR-D7 / D17: location is streamed only while a trip is active — never when merely online. */
  React.useEffect(() => {
    const active = trip && ['ACCEPTED', 'EN_ROUTE', 'AT_PICKUP', 'ON_TRIP'].includes(trip.state)
    if (!active) return

    let cancelled = false
    let subscription: Location.LocationSubscription | null = null

    void (async () => {
      const permission = await Location.requestForegroundPermissionsAsync()
      if (permission.status !== 'granted' || cancelled) return
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 25 },
        (position) => {
          void client.driver
            .sendLocation(position.coords.latitude, position.coords.longitude)
            .catch(() => {
              /* a dropped ping is not worth interrupting the driver for */
            })
        },
      )
    })()

    return () => {
      cancelled = true
      subscription?.remove()
    }
  }, [trip?.state, trip?.id])

  /** FR-D5: the 60-second offer window, counted down visibly. */
  React.useEffect(() => {
    if (trip?.state !== 'OFFERED' || !trip.offerExpiresAt) {
      setSecondsLeft(null)
      return
    }
    const expiry = new Date(trip.offerExpiresAt).getTime()
    const tick = () => setSecondsLeft(Math.max(0, Math.round((expiry - Date.now()) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [trip?.state, trip?.offerExpiresAt])

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const toggleDuty = () =>
    act(async () => {
      const result = await client.driver.setDuty(!online)
      setOnline(result.online)
    })

  if (loading) return <Loading label="Loading your trip…" />

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ErrorBanner message={error} />

      {/* FR-D10: shift + next break only. Deliberately no upcoming-trip list. */}
      {shift ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <Label>SHIFT</Label>
            <StatusPill
              label={shift.breakState === 'DUE' ? 'Break due' : online ? 'Online' : 'Offline'}
              tone={shift.breakState === 'DUE' ? 'warn' : online ? 'success' : 'neutral'}
            />
          </Row>
          <Body>
            Until {new Date(shift.shiftEnd).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ·{' '}
            {shift.drivingMinutesToday} min driven
          </Body>
          <Body>
            Next break after {shift.tripsUntilBreakDue} more trip
            {shift.tripsUntilBreakDue === 1 ? '' : 's'} or {shift.minutesUntilBreakDue} min
          </Body>
        </Card>
      ) : null}

      {!trip ? (
        <Card>
          <Heading>{online ? "You're online" : "You're offline"}</Heading>
          <Body>
            {online
              ? 'Waiting for your next trip. You will be notified as soon as one is assigned.'
              : 'Go online to start receiving trips.'}
          </Body>
          <PrimaryButton
            title={online ? 'Go offline' : 'Go online'}
            tone={online ? 'danger' : 'success'}
            onPress={() => void toggleDuty()}
            busy={busy}
          />
          {online && shift?.breakState !== 'ON_BREAK' ? (
            <SecondaryButton
              title="Request a break"
              onPress={() =>
                void act(async () => {
                  const result = await client.driver.requestBreak()
                  Alert.alert(
                    result.granted ? 'Break granted' : 'Break requested',
                    result.granted
                      ? 'Enjoy your break. You will not be assigned trips.'
                      : 'Guests are waiting, so ops will confirm your break shortly.',
                  )
                })
              }
            />
          ) : null}
        </Card>
      ) : trip.state === 'OFFERED' ? (
        <OfferCard trip={trip} secondsLeft={secondsLeft} busy={busy} onAct={act} />
      ) : (
        <ActiveTripCard trip={trip} busy={busy} onAct={act} />
      )}

      {shift ? (
        <Card>
          <Label>HELP</Label>
          <SecondaryButton
            title={`Call ops · ${shift.opsHelpdeskPhone}`}
            onPress={() => void Linking.openURL(`tel:${shift.opsHelpdeskPhone}`)}
          />
        </Card>
      ) : null}

      <SecondaryButton title="Sign out" onPress={() => void signOut()} />
    </ScrollView>
  )
}

function OfferCard({
  trip,
  secondsLeft,
  busy,
  onAct,
}: {
  trip: DriverTrip
  secondsLeft: number | null
  busy: boolean
  onAct: (action: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const pickup = trip.stops.find((s) => s.kind === 'PICKUP')
  const drop = trip.stops.find((s) => s.kind === 'DROP')

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <StatusPill label="New trip" tone="info" />
        {secondsLeft !== null ? (
          <Text style={[styles.countdown, secondsLeft <= 15 && styles.countdownUrgent]}>{secondsLeft}s</Text>
        ) : null}
      </Row>

      <Heading>
        {trip.guestNames.join(', ')} · {trip.guestCount} guest{trip.guestCount === 1 ? '' : 's'}
      </Heading>
      <Body>{trip.luggageCount} bag{trip.luggageCount === 1 ? '' : 's'}</Body>

      <Label>PICKUP</Label>
      <Body>{pickup?.label}</Body>
      {pickup?.instruction ? <Body>{pickup.instruction}</Body> : null}

      <Label>DROP</Label>
      <Body>{drop?.label}</Body>

      <PrimaryButton
        title="Accept trip"
        tone="success"
        busy={busy}
        onPress={() => void onAct(() => client.driver.accept(trip.id, trip.version))}
      />
      <SecondaryButton
        title="Reject"
        onPress={() =>
          Alert.alert('Reject this trip?', 'The guest will be reassigned to another driver.', [
            { text: 'Keep trip', style: 'cancel' },
            {
              text: 'Reject',
              style: 'destructive',
              onPress: () => void onAct(() => client.driver.reject(trip.id, 'Declined by driver')),
            },
          ])
        }
      />
    </Card>
  )
}

/**
 * The active trip has exactly one dominant action, and it advances the state machine. The driver
 * never has to work out which button applies — the current stop decides.
 */
function ActiveTripCard({
  trip,
  busy,
  onAct,
}: {
  trip: DriverTrip
  busy: boolean
  onAct: (action: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const currentStop = trip.stops.find((s) => s.state === 'PENDING' || s.state === 'ARRIVED')
  const arrivedHere = currentStop?.state === 'ARRIVED'

  const action = !currentStop
    ? null
    : arrivedHere
      ? currentStop.kind === 'PICKUP'
        ? { title: 'Guest boarded', run: () => client.driver.boarded(trip.id, currentStop.id) }
        : { title: 'Arrived at drop', run: () => client.driver.dropped(trip.id, currentStop.id) }
      : { title: `Arrived at ${currentStop.kind === 'PICKUP' ? 'pickup' : 'drop-off'}`, run: () => client.driver.arrived(trip.id, currentStop.id) }

  return (
    <Card>
      <StatusPill label={humanTripState(trip.state)} tone="success" />
      <Heading>
        {currentStop?.kind === 'PICKUP' ? 'Pick up' : 'Drop off'}: {currentStop?.label ?? 'Trip complete'}
      </Heading>
      {currentStop?.instruction ? <Body>{currentStop.instruction}</Body> : null}
      <Body>
        {trip.guestNames.join(', ')} · {trip.guestCount} guest{trip.guestCount === 1 ? '' : 's'} ·{' '}
        {trip.luggageCount} bag{trip.luggageCount === 1 ? '' : 's'}
      </Body>

      {currentStop ? (
        <TileMap
          center={{ lat: currentStop.lat, lng: currentStop.lng }}
          markers={[
            {
              lat: currentStop.lat,
              lng: currentStop.lng,
              label: currentStop.label,
              kind: currentStop.kind === 'PICKUP' ? 'PICKUP' : 'DROP',
            },
          ]}
          height={180}
        />
      ) : null}

      {action ? <PrimaryButton title={action.title} onPress={() => void onAct(action.run)} busy={busy} /> : null}

      {currentStop ? (
        <SecondaryButton
          title="Open in Maps"
          onPress={() => void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${currentStop.lat},${currentStop.lng}`)}
        />
      ) : null}

      {/* FR-D11: only meaningful once the driver has arrived; the server enforces the wait timer. */}
      {arrivedHere && currentStop?.kind === 'PICKUP' ? (
        <SecondaryButton
          title="Guest not found"
          onPress={() =>
            Alert.alert('Guest not found?', 'Ops will be notified and you will be released.', [
              { text: 'Keep waiting', style: 'cancel' },
              {
                text: 'Report',
                style: 'destructive',
                onPress: () => void onAct(() => client.driver.guestNotFound(trip.id, currentStop.id)),
              },
            ])
          }
        />
      ) : null}

      <View style={styles.stopList}>
        {trip.stops.map((stop) => (
          <Row key={stop.id}>
            <Text style={styles.stopGlyph}>{stop.state === 'DONE' ? '✓' : stop.state === 'SKIPPED' ? '–' : '○'}</Text>
            <Body>
              {stop.kind === 'PICKUP' ? 'Pick up' : 'Drop'} · {stop.label}
            </Body>
          </Row>
        ))}
      </View>
    </Card>
  )
}

const humanTripState = (state: string): string =>
  ({ ACCEPTED: 'On the way', EN_ROUTE: 'On the way', AT_PICKUP: 'At pickup', ON_TRIP: 'Guest aboard' })[state] ??
  state

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  content: { padding: theme.space(2), gap: theme.space(1.5) },
  countdown: { fontSize: 24, fontWeight: '800', color: theme.colour.muted },
  countdownUrgent: { color: theme.colour.danger },
  stopList: { gap: 4, marginTop: theme.space(1) },
  stopGlyph: { width: 18, fontSize: 16, color: theme.colour.muted },
})
