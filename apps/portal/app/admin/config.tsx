import React from 'react'
import { Alert } from 'react-native'
import { ApiClientError } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Field,
  Heading,
  Label,
  Loading,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from '@eventride/ui'
import { client } from '../../src/session.js'

/**
 * FR-A15 — every threshold from PRD §12, editable without a deploy.
 *
 * Grouped the way an event-day coordinator thinks, not the way the config object is ordered, and
 * each field says what it actually does — "30" means nothing on its own at 2 a.m.
 */
const GROUPS: { title: string; keys: { key: string; label: string; help: string }[] }[] = [
  {
    title: 'Guest experience',
    keys: [
      { key: 'guest_wait_warn_min', label: 'Wait warning (min)', help: 'Amber on the dashboard past this' },
      { key: 'guest_wait_critical_min', label: 'Wait critical (min)', help: 'Red alert; ops must act' },
      { key: 'auto_queue_fallback_min', label: 'Auto-queue after (min)', help: 'Serves a guest who never taps "arrived"' },
    ],
  },
  {
    title: 'Driver offers',
    keys: [
      { key: 'offer_expiry_sec', label: 'Offer expiry (sec)', help: 'Unanswered offers auto-reject' },
      { key: 'driver_reject_cooldown_min', label: 'Reject cooldown (min)', help: 'That driver is not re-offered the same trip' },
      { key: 'no_show_wait_min', label: 'No-show wait (min)', help: 'How long a driver waits before releasing' },
    ],
  },
  {
    title: 'Pooling & detours',
    keys: [
      { key: 'pool_time_window_min', label: 'Pool window (± min)', help: 'How far apart two guests can be and still share' },
      { key: 'pool_cluster_radius_km', label: 'Cluster radius (km)', help: 'Two hotels within this count as one destination' },
      { key: 'pool_max_drop_stops', label: 'Max drop stops', help: 'Caps route complexity per trip' },
      { key: 'detour_max_added_min', label: 'Max detour (min)', help: 'Extra time an onboard guest may absorb' },
    ],
  },
  {
    title: 'Deadlines',
    keys: [
      { key: 'airport_departure_buffer_min', label: 'Airport buffer (min)', help: 'Arrive this long before a flight' },
      { key: 'station_departure_buffer_min', label: 'Station buffer (min)', help: 'Arrive this long before a train' },
      { key: 'venue_arrival_buffer_min', label: 'Venue buffer (min)', help: 'Arrive this long before a session' },
    ],
  },
  {
    title: 'Driver welfare',
    keys: [
      { key: 'break_after_driving_min', label: 'Break after driving (min)', help: 'Mandatory break trigger' },
      { key: 'break_after_trips', label: 'Break after trips', help: 'The other trigger — whichever comes first' },
      { key: 'break_duration_min', label: 'Break length (min)', help: '' },
      { key: 'max_duty_hours', label: 'Max duty (hours)', help: 'Hard stop; not negotiable by queue pressure' },
    ],
  },
  {
    title: 'Dispatch engine',
    keys: [
      { key: 'reoptimise_tick_sec', label: 'Re-optimise tick (sec)', help: 'How often the engine re-plans' },
      { key: 'reservation_horizon_min', label: 'Reservation horizon (min)', help: 'Hold a driver for an imminent hard deadline' },
      { key: 'max_passed_over_count', label: 'Pass-over limit', help: 'Then the guest is forced to the front — anti-starvation' },
      { key: 'candidate_topk_for_live_eta', label: 'Live-ETA candidates', help: 'Caps external routing spend per decision' },
    ],
  },
]

export default function ConfigScreen(): React.JSX.Element {
  const [config, setConfig] = React.useState<Record<string, unknown>>({})
  const [draft, setDraft] = React.useState<Record<string, string>>({})
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const next = await client.admin.config()
      setConfig(next)
      setDraft(
        Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) as Record<string, string>,
      )
      setError(null)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not load configuration')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // Only send what actually changed: a full-object PATCH would silently overwrite a value another
  // coordinator edited while this screen was open.
  const changed = Object.entries(draft).filter(([key, value]) => String(config[key]) !== value)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const patch: Record<string, unknown> = {}
      for (const [key, value] of changed) {
        const asNumber = Number(value)
        patch[key] = value !== '' && !Number.isNaN(asNumber) ? asNumber : value
      }
      await client.admin.updateConfig(patch)
      Alert.alert('Saved', `${changed.length} setting(s) updated. Dispatch uses them immediately.`)
      await load()
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.payload.code === 'VALIDATION_FAILED'
            ? 'One of those values is out of range — nothing was saved.'
            : e.payload.message
          : 'Could not save',
      )
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading label="Loading configuration…" />

  return (
    <Screen>
      <ErrorBanner message={error} />
      <Card>
        <Heading>Event configuration</Heading>
        <Body>
          These take effect on the next dispatch round — no restart, no deploy. Changing them changes
          how the engine behaves for every guest.
        </Body>
      </Card>

      {GROUPS.map((group) => (
        <Card key={group.title}>
          <Label>{group.title.toUpperCase()}</Label>
          {group.keys.map(({ key, label, help }) => (
            <React.Fragment key={key}>
              <Field
                label={label}
                value={draft[key] ?? ''}
                onChangeText={(v) => setDraft({ ...draft, [key]: v })}
                keyboardType="number-pad"
              />
              {help ? <Label>{help}</Label> : null}
            </React.Fragment>
          ))}
        </Card>
      ))}

      <Card>
        <Label>{changed.length === 0 ? 'NO CHANGES' : `${changed.length} UNSAVED CHANGE(S)`}</Label>
        {changed.map(([key, value]) => (
          <Body key={key}>
            {key}: {String(config[key])} → {value}
          </Body>
        ))}
        <PrimaryButton
          title="Save changes"
          onPress={() => void save()}
          busy={busy}
          disabled={changed.length === 0}
        />
        <SecondaryButton title="Discard" onPress={() => void load()} disabled={changed.length === 0} />
      </Card>
    </Screen>
  )
}
