import React from 'react'
import { Alert } from 'react-native'
import { ApiClientError, type AdminDriver } from '@eventride/api-client'
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
 * FR-A2 / FR-A6 — the fleet board and manual driver onboarding.
 *
 * Onboarding is manual by design: there is no self-signup anywhere in the system, because this is a
 * private event fleet, not a marketplace.
 */
export default function DriversScreen(): React.JSX.Element {
  const [drivers, setDrivers] = React.useState<AdminDriver[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [form, setForm] = React.useState({
    name: '',
    phone: '',
    vehicleNumber: '',
    vehicleType: 'Sedan',
    seatCapacity: '4',
    luggageCapacity: '4',
  })

  const load = React.useCallback(async () => {
    try {
      setDrivers(await client.admin.drivers())
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load drivers')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  const createDriver = async () => {
    setBusy(true)
    setError(null)
    try {
      const now = new Date()
      const shiftEnd = new Date(now.getTime() + 10 * 3600_000)
      await client.admin.createDriver({
        name: form.name.trim(),
        phone: form.phone.trim(),
        vehicleNumber: form.vehicleNumber.trim(),
        vehicleType: form.vehicleType.trim(),
        seatCapacity: Number(form.seatCapacity) || 4,
        luggageCapacity: Number(form.luggageCapacity) || 4,
        shiftStart: now.toISOString(),
        shiftEnd: shiftEnd.toISOString(),
      })
      setAdding(false)
      setForm({ name: '', phone: '', vehicleNumber: '', vehicleType: 'Sedan', seatCapacity: '4', luggageCapacity: '4' })
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not add the driver')
    } finally {
      setBusy(false)
    }
  }

  /** E5 — breakdown. Onboard guests are re-queued from the vehicle's live position. */
  const markBreakdown = (driver: AdminDriver) =>
    Alert.alert(
      `Mark ${driver.vehicleNumber} unavailable?`,
      'Any guests aboard will be re-queued for immediate reassignment.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark unavailable',
          style: 'destructive',
          onPress: () =>
            void client.admin
              .markUnavailable(driver.id, 'Reported by ops')
              .then((result) => {
                Alert.alert('Done', `${result.requeued.length} guest(s) re-queued.`)
                return load()
              })
              .catch((e: unknown) =>
                setError(e instanceof ApiClientError ? e.payload.message : 'Failed'),
              ),
        },
      ],
    )

  if (loading) return <Loading label="Loading drivers…" />

  return (
    <Screen>
      <ErrorBanner message={error} />

      {adding ? (
        <Card>
          <Heading>Add a driver</Heading>
          <Field label="Name" value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} />
          <Field label="Phone" value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })} keyboardType="phone-pad" />
          <Field label="Vehicle number" value={form.vehicleNumber} onChangeText={(v) => setForm({ ...form, vehicleNumber: v })} />
          <Field label="Vehicle type" value={form.vehicleType} onChangeText={(v) => setForm({ ...form, vehicleType: v })} />
          <Row>
            <Field label="Seats" value={form.seatCapacity} onChangeText={(v) => setForm({ ...form, seatCapacity: v })} keyboardType="number-pad" />
            <Field label="Bags" value={form.luggageCapacity} onChangeText={(v) => setForm({ ...form, luggageCapacity: v })} keyboardType="number-pad" />
          </Row>
          <PrimaryButton title="Add driver" onPress={() => void createDriver()} busy={busy} disabled={!form.name || !form.phone || !form.vehicleNumber} />
          <SecondaryButton title="Cancel" onPress={() => setAdding(false)} />
        </Card>
      ) : (
        <PrimaryButton title="Add a driver" onPress={() => setAdding(true)} />
      )}

      {drivers.map((driver) => (
        <Card key={driver.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Heading>{driver.vehicleNumber}</Heading>
            <StatusPill label={driver.state} tone={toneForDriverState(driver.state)} />
          </Row>
          <Body>
            {driver.name} · {driver.vehicleType} · {driver.seatCapacity} seats / {driver.luggageCapacity} bags
          </Body>
          <Body>
            {driver.drivingMinutesToday} min driven
            {driver.breakState === 'DUE' ? ' · break due' : ''}
            {driver.predictedFreeAt
              ? ` · free ${new Date(driver.predictedFreeAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
              : ''}
          </Body>
          {driver.position ? (
            <Label>
              At {driver.position.lat.toFixed(4)}, {driver.position.lng.toFixed(4)}
            </Label>
          ) : (
            <Label>No position reported</Label>
          )}

          <Row>
            <SecondaryButton
              title={driver.breakState === 'ON_BREAK' ? 'End break' : 'Grant break'}
              onPress={() =>
                void client.admin
                  .manageBreak(driver.id, driver.breakState !== 'ON_BREAK')
                  .then(() => load())
              }
            />
            <SecondaryButton title="Breakdown" onPress={() => markBreakdown(driver)} />
          </Row>
        </Card>
      ))}
    </Screen>
  )
}

const toneForDriverState = (state: string): 'neutral' | 'success' | 'warn' | 'danger' | 'info' => {
  if (state === 'AVAILABLE') return 'success'
  if (state === 'ON_TRIP' || state === 'EN_ROUTE_TO_PICKUP' || state === 'AT_PICKUP') return 'info'
  if (state === 'ON_BREAK') return 'warn'
  if (state === 'UNAVAILABLE') return 'danger'
  return 'neutral'
}
