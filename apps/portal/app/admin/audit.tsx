import React from 'react'
import { ApiClientError } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Field,
  Heading,
  Label,
  Loading,
  Row,
  Screen,
  SecondaryButton,
  StatusPill,
} from '@eventride/ui'
import { client } from '../../src/session.js'

interface AuditRow {
  id: string
  seq: number
  entityType: string
  entityId: string
  fromState: string | null
  toState: string
  actor: 'ENGINE' | 'ADMIN' | 'DRIVER' | 'GUEST' | 'SYSTEM'
  reason: string | null
  at: string
}

/**
 * FR-A16 — the audit timeline.
 *
 * Ordered by `seq`, not by timestamp: several transitions inside one transaction share a
 * millisecond, and the whole value of this screen is showing the ORDER things happened in when a
 * guest disputes what went wrong.
 */
export default function AuditScreen(): React.JSX.Element {
  const [rows, setRows] = React.useState<AuditRow[]>([])
  const [filter, setFilter] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (entityId?: string) => {
    setLoading(true)
    try {
      const data = (await client.admin.audit(entityId)) as unknown as AuditRow[]
      setRows(data)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load the audit trail')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  return (
    <Screen>
      <ErrorBanner message={error} />
      <Card>
        <Heading>Audit trail</Heading>
        <Body>Every state change, who caused it, and why. Append-only.</Body>
        <Field
          label="Filter by guest / driver / trip id"
          value={filter}
          onChangeText={setFilter}
          placeholder="paste an id, or leave blank for everything"
        />
        <Row>
          <SecondaryButton title="Search" onPress={() => void load(filter.trim() || undefined)} />
          <SecondaryButton
            title="Clear"
            onPress={() => {
              setFilter('')
              void load()
            }}
          />
        </Row>
      </Card>

      {loading ? <Loading label="Loading audit trail…" /> : null}

      {!loading && rows.length === 0 ? (
        <Card>
          <Body>No audit entries for that filter.</Body>
        </Card>
      ) : null}

      {rows.map((row) => (
        <Card key={row.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Body>
              {row.entityType} · {row.fromState ?? '—'} → {row.toState}
            </Body>
            <StatusPill label={row.actor} tone={toneForActor(row.actor)} />
          </Row>
          <Label>
            #{row.seq} · {new Date(row.at).toLocaleString()} · {row.entityId.slice(0, 8)}
          </Label>
          {row.reason ? <Body>{row.reason}</Body> : null}
        </Card>
      ))}
    </Screen>
  )
}

/** Colour by actor so "the engine did this" is distinguishable from "a human did this" at a glance. */
const toneForActor = (actor: AuditRow['actor']): 'neutral' | 'info' | 'success' | 'warn' => {
  if (actor === 'ENGINE') return 'info'
  if (actor === 'ADMIN') return 'warn'
  if (actor === 'DRIVER') return 'success'
  return 'neutral'
}
