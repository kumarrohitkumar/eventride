import React from 'react'
import { ApiClientError, type DecisionRoundSummary } from '@eventride/api-client'
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

/**
 * FR-M23 — the "why did dispatch do that?" screen.
 *
 * Every round persists its decisions AND every rejection with a typed reason, so any assignment (or
 * non-assignment) can be explained after the fact. Without this, an automated allocator is a black
 * box that ops cannot defend to a guest who waited.
 */

interface RoundDetail extends DecisionRoundSummary {
  decisions: { kind: string; driverId?: string; requestIds?: string[]; requestId?: string; reason?: string; addedMinutes?: number; seatsShort?: number; guestsAffected?: number }[]
  rejections: { requestId: string; driverId: string; reason: string }[]
}

export default function RoundsScreen(): React.JSX.Element {
  const [rounds, setRounds] = React.useState<DecisionRoundSummary[]>([])
  const [detail, setDetail] = React.useState<RoundDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        setRounds(await client.admin.rounds())
      } catch (e) {
        setError(e instanceof ApiClientError ? e.payload.message : 'Could not load rounds')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const open = async (id: string) => {
    try {
      const raw = await client.admin.round(id)
      setDetail(raw as unknown as RoundDetail)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load that round')
    }
  }

  if (loading) return <Loading label="Loading dispatch rounds…" />

  if (detail) {
    // Group rejections by reason: "17 × ALL_DRIVERS_BUSY" is the actionable summary, not 17 rows.
    const byReason = new Map<string, number>()
    for (const r of detail.rejections ?? []) {
      byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1)
    }
    const assigns = (detail.decisions ?? []).filter((d) => d.kind === 'ASSIGN')
    const detours = (detail.decisions ?? []).filter((d) => d.kind === 'INSERT_DETOUR')
    const unmatched = (detail.decisions ?? []).filter((d) => d.kind === 'UNMATCHED')
    const shortfall = (detail.decisions ?? []).find((d) => d.kind === 'SHORTFALL')

    return (
      <Screen>
        <SecondaryButton title="← Back to rounds" onPress={() => setDetail(null)} />
        <Card>
          <Heading>Round detail</Heading>
          <Body>
            Trigger: {detail.trigger} · {new Date(detail.startedAt).toLocaleTimeString()} ·{' '}
            {detail.durationMs} ms · {detail.routingCalls} routing call(s)
          </Body>
        </Card>

        <Card>
          <Label>WHAT IT DECIDED</Label>
          <Body>{assigns.length} assignment(s)</Body>
          <Body>{detours.length} mid-trip detour insertion(s)</Body>
          <Body>{unmatched.length} unmatched</Body>
          {shortfall ? (
            <Body>
              Shortfall: {shortfall.guestsAffected} guests / {shortfall.seatsShort} seats
            </Body>
          ) : null}
        </Card>

        {assigns.length > 0 ? (
          <Card>
            <Label>ASSIGNMENTS</Label>
            {assigns.slice(0, 25).map((d, i) => (
              <Body key={i}>
                driver {String(d.driverId).slice(0, 8)} ← {d.requestIds?.length ?? 0} guest
                {(d.requestIds?.length ?? 0) === 1 ? '' : 's'}
                {(d.requestIds?.length ?? 0) > 1 ? ' (pooled)' : ''}
              </Body>
            ))}
          </Card>
        ) : null}

        {detours.length > 0 ? (
          <Card>
            <Label>DETOURS INSERTED</Label>
            {detours.map((d, i) => (
              <Body key={i}>
                {String(d.requestId).slice(0, 8)} added to a live trip (+{Math.round(d.addedMinutes ?? 0)} min)
              </Body>
            ))}
          </Card>
        ) : null}

        {byReason.size > 0 ? (
          <Card>
            <Label>WHY DRIVERS WERE REJECTED</Label>
            {[...byReason.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <Row key={reason} style={{ justifyContent: 'space-between' }}>
                  <Body>{reason}</Body>
                  <StatusPill label={String(count)} tone="neutral" />
                </Row>
              ))}
          </Card>
        ) : null}
      </Screen>
    )
  }

  return (
    <Screen>
      <ErrorBanner message={error} />
      <Card>
        <Heading>Dispatch rounds</Heading>
        <Body>Every allocation decision the engine made, and every driver it ruled out.</Body>
      </Card>

      {rounds.length === 0 ? (
        <Card>
          <Body>No rounds recorded yet.</Body>
        </Card>
      ) : null}

      {rounds.map((round) => (
        <Card key={round.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Body>{new Date(round.startedAt).toLocaleTimeString()}</Body>
            <StatusPill
              label={`${round.durationMs} ms`}
              tone={round.durationMs > 5000 ? 'danger' : round.durationMs > 1000 ? 'warn' : 'success'}
            />
          </Row>
          <Label>
            trigger: {round.trigger} · {round.routingCalls} routing call(s)
          </Label>
          <SecondaryButton title="View decisions" onPress={() => void open(round.id)} />
        </Card>
      ))}
    </Screen>
  )
}
