import React from 'react'
import { Alert } from 'react-native'
import { ApiClientError, type WaveRow } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Field,
  Heading,
  Label,
  Loading,
  PrimaryButton,
  Row,
  Screen,
  SecondaryButton,
  StatusPill,
} from '@eventride/ui'
import { client } from '../../src/session.js'

/**
 * FR-A12 / FR-M4–M8 — shuttle waves for the venue surge.
 *
 * 200 guests going to one venue in one window is a shuttle problem, not 200 individual hails. A wave
 * is only a TAG on ordinary trip requests, so everything downstream (priority, bundling, capacity,
 * assignment) is the same tested pipeline — this screen just decides when they depart.
 */
export default function WavesScreen(): React.JSX.Element {
  const [waves, setWaves] = React.useState<WaveRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [sessionTime, setSessionTime] = React.useState(defaultSessionTime())
  const [waveCount, setWaveCount] = React.useState('3')

  const load = React.useCallback(async () => {
    try {
      setWaves(await client.admin.waves())
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load waves')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const plan = async () => {
    setBusy('plan')
    setError(null)
    try {
      const venue = 'loc-venue'
      await client.admin.planWaves({
        destinationId: venue,
        sessionStartsAt: new Date(sessionTime).toISOString(),
        waveCount: Number(waveCount) || 3,
      })
      Alert.alert('Waves planned', 'Departures are spaced backwards from the session start.')
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not plan waves')
    } finally {
      setBusy(null)
    }
  }

  const dispatch = async (id: string) => {
    setBusy(id)
    try {
      const result = (await client.admin.dispatchWave(id)) as { seatsShort?: number; chosen?: string[] }
      Alert.alert(
        'Wave dispatched',
        result.seatsShort
          ? `${result.chosen?.length ?? 0} vehicle(s) assigned — still ${result.seatsShort} seats short.`
          : `${result.chosen?.length ?? 0} vehicle(s) assigned.`,
      )
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not dispatch that wave')
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <Loading label="Loading waves…" />

  return (
    <Screen>
      <ErrorBanner message={error} />

      <Card>
        <Heading>Plan venue waves</Heading>
        <Body>
          One set of departures per accommodation, spaced backwards from the session start so the
          last wave still arrives before it begins.
        </Body>
        <Field
          label="Session starts (YYYY-MM-DDTHH:MM)"
          value={sessionTime}
          onChangeText={setSessionTime}
          placeholder="2026-03-11T09:00"
        />
        <Field label="Waves per hotel" value={waveCount} onChangeText={setWaveCount} keyboardType="number-pad" />
        <PrimaryButton title="Plan waves" onPress={() => void plan()} busy={busy === 'plan'} />
      </Card>

      {waves.length === 0 ? (
        <Card>
          <Body>No waves planned yet.</Body>
        </Card>
      ) : null}

      {waves.map((wave) => (
        <Card key={wave.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Heading>{new Date(wave.departsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Heading>
            <StatusPill
              label={wave.state}
              tone={wave.state === 'DISPATCHED' ? 'success' : wave.state === 'CLOSED' ? 'neutral' : 'info'}
            />
          </Row>
          <Body>
            {wave.origin.label} → {wave.destination.label}
          </Body>
          <Label>{wave.seatsNeeded} seat(s) needed</Label>
          {wave.state === 'PLANNED' ? (
            <SecondaryButton title="Dispatch now" onPress={() => void dispatch(wave.id)} disabled={busy === wave.id} />
          ) : null}
        </Card>
      ))}
    </Screen>
  )
}

/** Tomorrow at 09:00, formatted for the datetime-local style input. */
function defaultSessionTime(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
