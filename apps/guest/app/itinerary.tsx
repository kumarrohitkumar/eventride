import React from 'react'
import { ApiClientError, type GuestItineraryItem } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Heading,
  Label,
  Loading,
  Row,
  Screen,
  StatusPill,
} from '@eventride/ui'
import { client } from '../src/session.js'

/** FR-G12 — the guest's trips for the event, grouped by day. */
export default function ItineraryScreen(): React.JSX.Element {
  const [items, setItems] = React.useState<GuestItineraryItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        setItems(await client.guest.itinerary())
      } catch (e) {
        setError(e instanceof ApiClientError ? e.payload.message : 'Could not load your trips')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  if (loading) return <Loading label="Loading your trips…" />

  if (items.length === 0) {
    return (
      <Screen>
        <Card>
          <Heading>No trips scheduled yet</Heading>
          <Body>Your event transport will appear here once the team has scheduled it.</Body>
        </Card>
      </Screen>
    )
  }

  const byDay = groupByDay(items)

  return (
    <Screen>
      <ErrorBanner message={error} />
      {[...byDay.entries()].map(([day, dayItems]) => (
        <Card key={day}>
          <Label>{day.toUpperCase()}</Label>
          {dayItems.map((item) => (
            <Row key={item.requestId} style={{ justifyContent: 'space-between' }}>
              <Body>
                {formatTime(item.scheduledAt)} · {item.from} → {item.to}
              </Body>
              <StatusPill label={humanState(item.state)} tone={toneForState(item.state)} />
            </Row>
          ))}
        </Card>
      ))}
    </Screen>
  )
}

function groupByDay(items: GuestItineraryItem[]): Map<string, GuestItineraryItem[]> {
  const groups = new Map<string, GuestItineraryItem[]>()
  for (const item of items) {
    const key = item.scheduledAt
      ? new Date(item.scheduledAt).toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
        })
      : 'Unscheduled'
    const existing = groups.get(key)
    if (existing) existing.push(item)
    else groups.set(key, [item])
  }
  return groups
}

const formatTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'

const humanState = (state: string): string =>
  ({
    REGISTERED: 'Scheduled',
    QUEUED: 'Finding ride',
    ASSIGNED: 'Finding ride',
    ACCEPTED: 'Driver assigned',
    EN_ROUTE: 'On the way',
    ARRIVED_PICKUP: 'Driver here',
    BOARDED: 'In transit',
    COMPLETED: 'Completed',
    UNMATCHED: 'Arranging',
    CANCELLED: 'Cancelled',
    NO_SHOW: 'Missed',
    PENDING_APPROVAL: 'Pending',
    DECLINED: 'Declined',
  })[state] ?? state

const toneForState = (state: string): 'neutral' | 'info' | 'success' | 'warn' | 'danger' => {
  if (state === 'COMPLETED') return 'success'
  if (['CANCELLED', 'DECLINED', 'NO_SHOW'].includes(state)) return 'danger'
  if (['UNMATCHED', 'PENDING_APPROVAL'].includes(state)) return 'warn'
  if (['ACCEPTED', 'EN_ROUTE', 'ARRIVED_PICKUP', 'BOARDED'].includes(state)) return 'info'
  return 'neutral'
}
