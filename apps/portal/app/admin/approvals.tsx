import React from 'react'
import { Alert } from 'react-native'
import { ApiClientError, type AdminRequest } from '@eventride/api-client'
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
 * FR-A5 — approve or decline guest ad-hoc requests.
 *
 * Note what is NOT on this screen: any way to choose a driver. Approval decides whether the request
 * enters dispatch at all; the engine then picks the vehicle. The API has no driver parameter on the
 * approve endpoint, so this boundary is structural rather than a UI convention (FR-M25).
 */
export default function ApprovalsScreen(): React.JSX.Element {
  const [requests, setRequests] = React.useState<AdminRequest[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [declineFor, setDeclineFor] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      setRequests(await client.admin.requests('PENDING_APPROVAL'))
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load approvals')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [load])

  const approve = async (id: string) => {
    setBusyId(id)
    try {
      await client.admin.approve(id)
      Alert.alert('Approved', 'Dispatch will assign a driver automatically.')
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Approval failed')
    } finally {
      setBusyId(null)
    }
  }

  const decline = async (id: string) => {
    if (reason.trim().length < 3) {
      setError('A reason is required — the guest sees it.')
      return
    }
    setBusyId(id)
    try {
      await client.admin.decline(id, reason.trim())
      setDeclineFor(null)
      setReason('')
      await load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Decline failed')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <Loading label="Loading approvals…" />

  return (
    <Screen>
      <ErrorBanner message={error} />

      {requests.length === 0 ? (
        <Card>
          <Heading>Nothing waiting</Heading>
          <Body>No ad-hoc ride requests need a decision right now.</Body>
        </Card>
      ) : null}

      {requests.map((request) => (
        <Card key={request.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <StatusPill label="Pending" tone="warn" />
            {request.guest.isVip ? <StatusPill label="VIP" tone="info" /> : null}
          </Row>
          <Heading>{request.guest.name}</Heading>
          <Body>
            {request.origin.label} → {request.destination.label}
          </Body>
          <Body>
            {request.groupSize} guest{request.groupSize === 1 ? '' : 's'} · {request.luggageCount} bag
            {request.luggageCount === 1 ? '' : 's'}
          </Body>
          {request.approvalNote ? (
            <>
              <Label>GUEST&apos;S REASON</Label>
              <Body>{request.approvalNote}</Body>
            </>
          ) : null}

          {declineFor === request.id ? (
            <>
              <Field
                label="Reason (shown to the guest)"
                value={reason}
                onChangeText={setReason}
                placeholder="Why is this being declined?"
                multiline
              />
              <PrimaryButton
                title="Confirm decline"
                tone="danger"
                busy={busyId === request.id}
                onPress={() => void decline(request.id)}
              />
              <SecondaryButton title="Cancel" onPress={() => setDeclineFor(null)} />
            </>
          ) : (
            <>
              <PrimaryButton
                title="Approve"
                tone="success"
                busy={busyId === request.id}
                onPress={() => void approve(request.id)}
              />
              <SecondaryButton title="Decline" onPress={() => setDeclineFor(request.id)} />
            </>
          )}
        </Card>
      ))}
    </Screen>
  )
}
