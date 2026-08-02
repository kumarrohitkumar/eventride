import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

export { TileMap, type MapMarker, type TileMapProps } from './TileMap.js'
export { usePushRegistration, type PushStatus, type PushRegistrar } from './usePushRegistration.js'

/**
 * Shared component vocabulary for both apps (HLD §2.1).
 *
 * Sized for the usability requirement (NFR-5): large touch targets, one dominant action per screen,
 * and text that stays legible for a tired guest at 02:00 or a driver glancing at a phone on a mount.
 */

export const theme = {
  colour: {
    primary: '#1d4ed8',
    primaryText: '#ffffff',
    danger: '#b91c1c',
    success: '#047857',
    warn: '#b45309',
    text: '#111827',
    muted: '#6b7280',
    border: '#e5e7eb',
    surface: '#ffffff',
    background: '#f9fafb',
  },
  space: (n: number) => n * 8,
  radius: 12,
} as const

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: React.ReactNode
  scroll?: boolean
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  const Container = scroll ? ScrollView : View
  return (
    <Container style={[styles.screen, style]} contentContainerStyle={scroll ? styles.screenContent : undefined}>
      {children}
    </Container>
  )
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>
}

export function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.heading}>{children}</Text>
}

export function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.label}>{children}</Text>
}

export function Body({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.body}>{children}</Text>
}

/**
 * The single dominant action on a screen (NFR-5). Deliberately large, and it shows its own busy
 * state so a non-technical user is never left wondering whether their tap registered.
 */
export function PrimaryButton({
  title,
  onPress,
  busy = false,
  disabled = false,
  tone = 'primary',
}: {
  title: string
  onPress: () => void
  busy?: boolean
  disabled?: boolean
  tone?: 'primary' | 'danger' | 'success'
}): React.JSX.Element {
  const background =
    tone === 'danger' ? theme.colour.danger : tone === 'success' ? theme.colour.success : theme.colour.primary
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.primaryButton,
        { backgroundColor: background, opacity: disabled || busy ? 0.55 : pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={theme.colour.primaryText} />
      ) : (
        <Text style={styles.primaryButtonText}>{title}</Text>
      )}
    </Pressable>
  )
}

export function SecondaryButton({
  title,
  onPress,
  disabled = false,
}: {
  title: string
  onPress: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.secondaryButton, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}
    >
      <Text style={styles.secondaryButtonText}>{title}</Text>
    </Pressable>
  )
}

export function StatusPill({
  label,
  tone = 'neutral',
}: {
  label: string
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'info'
}): React.JSX.Element {
  const colours: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: '#f3f4f6', fg: '#374151' },
    success: { bg: '#d1fae5', fg: '#065f46' },
    warn: { bg: '#fef3c7', fg: '#92400e' },
    danger: { bg: '#fee2e2', fg: '#991b1b' },
    info: { bg: '#dbeafe', fg: '#1e40af' },
  }
  const c = colours[tone] ?? colours.neutral!
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.pillText, { color: c.fg }]}>{label}</Text>
    </View>
  )
}

/**
 * FR-G6: the numeric ETA is rendered as TEXT, above the map, and is always present. A map that
 * fails to load must never be the reason a guest cannot see how long they are waiting.
 */
export function EtaText({
  minutes,
  estimated = false,
  prefix = 'Arriving in',
}: {
  minutes: number | null
  estimated?: boolean
  prefix?: string
}): React.JSX.Element {
  if (minutes === null) return <Text style={styles.eta}>Calculating arrival time…</Text>
  return (
    <Text style={styles.eta}>
      {prefix} {Math.max(1, Math.round(minutes))} min{estimated ? ' (estimated)' : ''}
    </Text>
  )
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  secure = false,
  multiline = false,
}: {
  label: string
  value: string
  onChangeText: (next: string) => void
  placeholder?: string
  keyboardType?: 'default' | 'phone-pad' | 'number-pad' | 'email-address'
  secure?: boolean
  multiline?: boolean
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType}
        secureTextEntry={secure}
        multiline={multiline}
        autoCapitalize="none"
      />
    </View>
  )
}

export function ErrorBanner({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <View style={styles.errorBanner}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  )
}

/** FR-G14: shows cached data with its age rather than a blank screen when offline. */
export function StaleNotice({ at }: { at: string | Date | null }): React.JSX.Element | null {
  if (!at) return null
  const when = typeof at === 'string' ? new Date(at) : at
  const hh = String(when.getHours()).padStart(2, '0')
  const mm = String(when.getMinutes()).padStart(2, '0')
  return <Text style={styles.stale}>Last updated {hh}:{mm}</Text>
}

export function Loading({ label = 'Loading…' }: { label?: string }): React.JSX.Element {
  return (
    <View style={styles.loading}>
      <ActivityIndicator />
      <Text style={styles.body}>{label}</Text>
    </View>
  )
}

export function Row({
  children,
  style,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  return <View style={[styles.row, style]}>{children}</View>
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  screenContent: { padding: theme.space(2), gap: theme.space(1.5) },
  card: {
    backgroundColor: theme.colour.surface,
    borderRadius: theme.radius,
    padding: theme.space(2),
    borderWidth: 1,
    borderColor: theme.colour.border,
    gap: theme.space(1),
  },
  heading: { fontSize: 22, fontWeight: '700', color: theme.colour.text },
  label: { fontSize: 13, fontWeight: '600', color: theme.colour.muted },
  body: { fontSize: 15, color: theme.colour.text },
  // 56pt tall: comfortably above the platform minimum, usable one-handed while standing.
  primaryButton: {
    minHeight: 56,
    borderRadius: theme.radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space(2),
  },
  primaryButtonText: { color: theme.colour.primaryText, fontSize: 18, fontWeight: '700' },
  secondaryButton: {
    minHeight: 44,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.colour.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space(2),
    backgroundColor: theme.colour.surface,
  },
  secondaryButtonText: { color: theme.colour.text, fontSize: 15, fontWeight: '600' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '700' },
  eta: { fontSize: 20, fontWeight: '700', color: theme.colour.text },
  field: { gap: 4 },
  input: {
    borderWidth: 1,
    borderColor: theme.colour.border,
    borderRadius: theme.radius,
    paddingHorizontal: theme.space(1.5),
    minHeight: 48,
    fontSize: 16,
    backgroundColor: theme.colour.surface,
    color: theme.colour.text,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top', paddingTop: theme.space(1) },
  errorBanner: {
    backgroundColor: '#fee2e2',
    borderRadius: theme.radius,
    padding: theme.space(1.5),
  },
  errorText: { color: '#991b1b', fontWeight: '600' },
  stale: { fontSize: 12, color: theme.colour.muted },
  loading: { alignItems: 'center', gap: theme.space(1), padding: theme.space(3) },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space(1) },
})
