import React from 'react'
import { Platform } from 'react-native'

/**
 * Registers this device for push notifications and hands the token to the server.
 *
 * Shared by both apps because the flow is identical for all three roles: a guest needs "your driver
 * has arrived" while the app is closed, a driver has 60 seconds to accept an offer, and ops need
 * critical alerts. Sockets only reach a foregrounded app, which is precisely when none of those
 * three are looking at their phone.
 *
 * Everything here is best-effort. A denied permission, a simulator with no push support, or a
 * network failure must degrade to "no push, sockets only" — never to a broken screen or a blocked
 * sign-in.
 */

export interface PushRegistrar {
  registerPushToken(token: string, platform: 'ios' | 'android' | 'web'): Promise<void>
}

export type PushStatus = 'idle' | 'unsupported' | 'denied' | 'registered' | 'failed'

interface ExpoNotificationsModule {
  getPermissionsAsync(): Promise<{ status: string }>
  requestPermissionsAsync(): Promise<{ status: string }>
  getExpoPushTokenAsync(options?: { projectId?: string }): Promise<{ data: string }>
  setNotificationHandler(handler: unknown): void
  setNotificationChannelAsync?(id: string, channel: Record<string, unknown>): Promise<unknown>
  AndroidImportance?: { MAX: number }
}

/**
 * Loaded lazily and defensively: expo-notifications throws on an unsupported platform (and is a
 * no-op on web), so a static import would take the whole screen down with it.
 */
function loadNotifications(): ExpoNotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as ExpoNotificationsModule
  } catch {
    return null
  }
}

export function usePushRegistration(
  client: PushRegistrar,
  /** Only register once the user is authenticated — the endpoint derives the user from the token. */
  enabled: boolean,
  options: { projectId?: string; androidChannelName?: string } = {},
): { status: PushStatus; token: string | null } {
  const [status, setStatus] = React.useState<PushStatus>('idle')
  const [token, setToken] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false

    void (async () => {
      const Notifications = loadNotifications()
      if (!Notifications || Platform.OS === 'web') {
        setStatus('unsupported')
        return
      }

      try {
        // Show alerts even while the app is foregrounded: a driver staring at the trip screen still
        // needs to see that a new stop was inserted into their route.
        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          }),
        })

        // Android needs an explicit high-importance channel or notifications arrive silently —
        // useless for a 60-second offer window.
        if (Platform.OS === 'android' && Notifications.setNotificationChannelAsync) {
          await Notifications.setNotificationChannelAsync('dispatch', {
            name: options.androidChannelName ?? 'Dispatch',
            importance: Notifications.AndroidImportance?.MAX ?? 5,
            sound: 'default',
            vibrationPattern: [0, 250, 250, 250],
          })
        }

        const existing = await Notifications.getPermissionsAsync()
        const granted =
          existing.status === 'granted'
            ? existing
            : await Notifications.requestPermissionsAsync()

        if (granted.status !== 'granted') {
          if (!cancelled) setStatus('denied')
          return
        }

        const result = await Notifications.getExpoPushTokenAsync(
          options.projectId ? { projectId: options.projectId } : undefined,
        )
        if (cancelled) return

        await client.registerPushToken(
          result.data,
          Platform.OS === 'ios' ? 'ios' : 'android',
        )
        if (cancelled) return
        setToken(result.data)
        setStatus('registered')
      } catch {
        // No push is a degraded experience, not a broken one: sockets still drive every screen.
        if (!cancelled) setStatus('failed')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client, enabled, options.projectId, options.androidChannelName])

  return { status, token }
}
