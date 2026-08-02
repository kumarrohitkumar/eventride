import React from 'react'
import { ApiClientError, type AdminGuest } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Heading,
  Label,
  Loading,
  Row,
  Screen,
  SecondaryButton,
  StatusPill,
} from '@eventride/ui'
import { client } from '../../src/session.js'

const FILTERS = ['ALL', 'QUEUED', 'ASSIGNED', 'BOARDED', 'COMPLETED', 'UNMATCHED'] as const

/**
 * FR-A3 — the guest board.
 *
 * On a phone a wide table is unusable, so each guest is a card and the state filter is a row of
 * chips. Waiting guests come first, because that is the queue ops is judged on.
 */
export default function GuestsScreen(): React.JSX.Element {
  const [guests, setGuests] = React.useState<AdminGuest[]>([])
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]>('ALL')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      setGuests(await client.admin.guests())
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load guests')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  if (loading) return <Loading label="Loading guests…" />

  const visible = guests
    .filter((g) => filter === 'ALL' || g.currentState === filter)
    .sort((a, b) => rank(a.currentState) - rank(b.currentState))

  return (
    <Screen>
      <ErrorBanner message={error} />

      <Card>
        <Label>FILTER</Label>
        <Row style={{ flexWrap: 'wrap' }}>
          {FILTERS.map((option) => (
            <SecondaryButton
              key={option}
              title={option === filter ? `● ${option}` : option}
              onPress={() => setFilter(option)}
            />
          ))}
        </Row>
        <Label>
          {visible.length} of {guests.length} guests
        </Label>
      </Card>

      {visible.map((guest) => (
        <Card key={guest.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Heading>{guest.name}</Heading>
            {guest.isVip ? <StatusPill label="VIP" tone="info" /> : null}
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Body>
              {guest.groupSize} guest{guest.groupSize === 1 ? '' : 's'} · {guest.luggageCount} bag
              {guest.luggageCount === 1 ? '' : 's'}
            </Body>
            <StatusPill
              label={guest.currentState ?? 'No trip'}
              tone={toneFor(guest.currentState)}
            />
          </Row>
          <Body>Staying at {guest.accommodation ?? 'not yet allotted'}</Body>
          {guest.arrivalAt ? (
            <Label>
              Arrives {new Date(guest.arrivalAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </Label>
          ) : null}
        </Card>
      ))}
    </Screen>
  )
}

/** Waiting and unmatched guests float to the top — they are the ones needing action. */
const rank = (state: string | null): number => {
  const order: Record<string, number> = {
    UNMATCHED: 0,
    QUEUED: 1,
    PENDING_APPROVAL: 2,
    ASSIGNED: 3,
    ACCEPTED: 4,
    EN_ROUTE: 5,
    ARRIVED_PICKUP: 6,
    BOARDED: 7,
    COMPLETED: 9,
  }
  return order[state ?? ''] ?? 8
}

const toneFor = (state: string | null): 'neutral' | 'success' | 'warn' | 'danger' | 'info' => {
  if (state === 'UNMATCHED') return 'danger'
  if (state === 'QUEUED' || state === 'PENDING_APPROVAL') return 'warn'
  if (state === 'COMPLETED') return 'success'
  if (state) return 'info'
  return 'neutral'
}
