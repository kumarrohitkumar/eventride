import React from 'react'
import { Alert } from 'react-native'
import { ApiClientError, type AdminDriver, type AdminRequest } from '@eventride/api-client'
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
 * FR-A10 / FR-A11 / FR-A9 — the exception queue.
 *
 * Every unmatched request arrives with a typed reason from the engine, and each reason maps to a
 * concrete suggested action. This is the screen that turns "the algorithm did nothing" into
 * "the algorithm could not do anything, and here is why, and here is what to do".
 */
export default function ExceptionsScreen(): React.JSX.Element {
  const [requests, setRequests] = React.useState<AdminRequest[]>([])
  const [drivers, setDrivers] = React.useState<AdminDriver[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [overrideFor, setOverrideFor] = React.useState<string | null>(null)
  const [driverId, setDriverId] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [unmatched, driverList] = await Promise.all([
        client.admin.requests('UNMATCHED'),
        client.admin.drivers(),
      ])
      setRequests(unmatched)
      setDrivers(driverList)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load exceptions')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  const retry = async (id: string) => {
    setBusyId(id)
    try {
      await client.admin.retry(id)
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Retry failed')
    } finally {
      setBusyId(null)
    }
  }

  const override = async (id: string) => {
    if (reason.trim().length < 3) {
      setError('Override needs a reason — it goes into the audit trail.')
      return
    }
    setBusyId(id)
    try {
      await client.admin.overrideAssign(id, driverId.trim(), reason.trim())
      Alert.alert('Assigned', 'This trip is pinned; the engine will not reassign it.')
      setOverrideFor(null)
      setDriverId('')
      setReason('')
      await load()
    } catch (e) {
      // Even an override cannot break an invariant — the server refuses with a typed code.
      setError(
        e instanceof ApiClientError
          ? e.payload.code === 'NO_CAPACITY'
            ? 'That vehicle cannot carry this group.'
            : e.payload.message
          : 'Override failed',
      )
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <Loading label="Loading exceptions…" />

  const availableDrivers = drivers.filter((d) => d.state === 'AVAILABLE')

  return (
    <Screen>
      <ErrorBanner message={error} />

      {requests.length === 0 ? (
        <Card>
          <Heading>No exceptions</Heading>
          <Body>Every guest currently has a feasible ride.</Body>
        </Card>
      ) : null}

      {requests.map((request) => {
        const guidance = suggestionFor(request.unmatchedReason)
        return (
          <Card key={request.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <StatusPill label="Unmatched" tone="danger" />
              {request.guest.isVip ? <StatusPill label="VIP" tone="info" /> : null}
            </Row>
            <Heading>{request.guest.name}</Heading>
            <Body>
              {request.origin.label} → {request.destination.label} · {request.groupSize} guest
              {request.groupSize === 1 ? '' : 's'}
            </Body>

            <Label>WHY</Label>
            <Body>{guidance.explanation}</Body>
            <Label>SUGGESTED ACTION</Label>
            <Body>{guidance.action}</Body>

            {overrideFor === request.id ? (
              <>
                <Field
                  label="Driver ID"
                  value={driverId}
                  onChangeText={setDriverId}
                  placeholder={availableDrivers[0]?.id ?? 'no driver is currently free'}
                />
                <Label>
                  {availableDrivers.length} available:{' '}
                  {availableDrivers
                    .slice(0, 3)
                    .map((d) => `${d.vehicleNumber} (${d.seatCapacity} seats)`)
                    .join(', ') || 'none'}
                </Label>
                <Field
                  label="Reason (required, audited)"
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Why are you overriding dispatch?"
                  multiline
                />
                <PrimaryButton
                  title="Assign this driver"
                  busy={busyId === request.id}
                  onPress={() => void override(request.id)}
                />
                <SecondaryButton title="Cancel" onPress={() => setOverrideFor(null)} />
              </>
            ) : (
              <>
                <PrimaryButton
                  title="Retry automatic dispatch"
                  busy={busyId === request.id}
                  onPress={() => void retry(request.id)}
                />
                <SecondaryButton title="Override — assign manually" onPress={() => setOverrideFor(request.id)} />
              </>
            )}
          </Card>
        )
      })}
    </Screen>
  )
}

/** FR-A11: each engine reason maps to something ops can actually do about it. */
function suggestionFor(reason: string | null): { explanation: string; action: string } {
  switch (reason) {
    case 'NO_DRIVER_ONLINE':
      return {
        explanation: 'No driver is online right now.',
        action: 'Call drivers to go on duty, then retry.',
      }
    case 'ALL_DRIVERS_BUSY':
      return {
        explanation: 'Every driver is already on a trip.',
        action: 'Wait for the next vehicle to free up, or escalate the fleet.',
      }
    case 'NO_CAPACITY':
      return {
        explanation: 'No available vehicle is large enough for this group and its luggage.',
        action: 'Split the group, or bring a larger vehicle on duty.',
      }
    case 'DEADLINE_INFEASIBLE':
      return {
        explanation: 'No driver can reach the destination before this guest’s hard deadline.',
        action: 'Confirm the flight/train time, or tell the guest the realistic arrival time.',
      }
    case 'ALL_DRIVERS_ON_BREAK':
      return {
        explanation: 'Every driver is on, or owed, a mandatory break.',
        action: 'Bring a rested driver on duty — break rules are a safety limit.',
      }
    case 'GROUP_TOO_LARGE':
      return {
        explanation: 'This party is larger than the entire fleet can seat in one go.',
        action: 'Split across multiple trips manually, or add a larger vehicle.',
      }
    case 'OUTSIDE_SHIFT_HOURS':
      return {
        explanation: 'The trip would run past every available driver’s shift end.',
        action: 'Extend a shift, or assign a driver from the next shift.',
      }
    case 'COOLDOWN_ONLY_CANDIDATES':
      return {
        explanation: 'The only nearby drivers recently rejected this trip.',
        action: 'Wait for the cooldown to lapse, or override to assign directly.',
      }
    default:
      return {
        explanation: 'Dispatch could not find a feasible driver.',
        action: 'Retry, or override to assign manually.',
      }
  }
}
