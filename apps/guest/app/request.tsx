import React from 'react'
import { router } from 'expo-router'
import { ApiClientError } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Field,
  Heading,
  Label,
  PrimaryButton,
  Row,
  Screen,
  SecondaryButton,
  StatusPill,
} from '@eventride/ui'
import { client } from '../src/session.js'

/**
 * FR-G9 / FR-G10 — an ad-hoc ride request.
 *
 * This goes to the event team for approval, never straight to dispatch, and the screen says so
 * plainly so the guest is not left expecting a car in two minutes.
 */
export default function RequestRideScreen(): React.JSX.Element {
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [people, setPeople] = React.useState('1')
  const [luggage, setLuggage] = React.useState('0')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await client.guest.requestRide({
        originId: from.trim(),
        destinationId: to.trim(),
        people: Number(people) || 1,
        luggage: Number(luggage) || 0,
        reason: reason.trim(),
        when: 'NOW',
      })
      setSubmitted(true)
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.payload.code === 'REQUEST_ALREADY_PENDING'
            ? 'You already have a request waiting for approval.'
            : e.payload.message
          : 'Could not send your request',
      )
    } finally {
      setBusy(false)
    }
  }

  if (submitted) {
    return (
      <Screen>
        <Card>
          <StatusPill label="Pending approval" tone="warn" />
          <Heading>Request sent</Heading>
          <Body>
            The event team will review your request. Once approved, a driver is assigned
            automatically and you will be notified.
          </Body>
          <PrimaryButton title="Back to my ride" onPress={() => router.replace('/')} />
        </Card>
      </Screen>
    )
  }

  const valid = from.trim() && to.trim() && reason.trim().length >= 3

  return (
    <Screen>
      <Card>
        <Heading>Request a ride</Heading>
        <Body>Extra trips need approval from the event team before a driver is assigned.</Body>
        <ErrorBanner message={error} />

        <Field label="From" value={from} onChangeText={setFrom} placeholder="Pickup location" />
        <Field label="To" value={to} onChangeText={setTo} placeholder="Destination" />
        <Row>
          <Field label="People" value={people} onChangeText={setPeople} keyboardType="number-pad" />
          <Field label="Bags" value={luggage} onChangeText={setLuggage} keyboardType="number-pad" />
        </Row>
        <Field
          label="Reason"
          value={reason}
          onChangeText={setReason}
          placeholder="Why do you need this trip?"
          multiline
        />

        <PrimaryButton title="Send request" onPress={() => void submit()} busy={busy} disabled={!valid} />
        <SecondaryButton title="Cancel" onPress={() => router.back()} />
        <Label>Approval is a human decision — the driver is then chosen automatically.</Label>
      </Card>
    </Screen>
  )
}
