import React from 'react'
import { Stack, router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Loading, theme, usePushRegistration } from '@eventride/ui'
import { SessionProvider, useSession, client } from '../src/session.js'

/**
 * Admin Portal root.
 *
 * One app, two roles (the brief's structure). The role in the session decides which tree the user
 * lands in; the server enforces the same separation independently, so this routing is convenience
 * rather than security — a Driver-role token calling an admin endpoint gets 403 regardless.
 */
function RoleGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { session, restoring } = useSession()
  // Drivers need the offer push (60-second window); admins need critical alerts.
  usePushRegistration(client, Boolean(session), { androidChannelName: 'Dispatch & alerts' })

  React.useEffect(() => {
    if (restoring) return
    if (!session) {
      router.replace('/login')
      return
    }
    // Land each role on its own home rather than showing a chooser nobody needs.
    if (session.role === 'DRIVER') router.replace('/driver')
    else if (session.role === 'ADMIN') router.replace('/admin')
  }, [session, restoring])

  if (restoring) return <Loading label="Restoring your session…" />
  return <>{children}</>
}

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <RoleGate>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: theme.colour.surface },
              headerTitleStyle: { fontWeight: '700' },
              contentStyle: { backgroundColor: theme.colour.background },
            }}
          >
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="driver/index" options={{ title: 'My Trip' }} />
            <Stack.Screen name="admin/index" options={{ title: 'Operations' }} />
            <Stack.Screen name="admin/drivers" options={{ title: 'Drivers' }} />
            <Stack.Screen name="admin/guests" options={{ title: 'Guests' }} />
            <Stack.Screen name="admin/approvals" options={{ title: 'Approvals' }} />
            <Stack.Screen name="admin/exceptions" options={{ title: 'Exceptions' }} />
            <Stack.Screen name="admin/waves" options={{ title: 'Shuttle Waves' }} />
            <Stack.Screen name="admin/rounds" options={{ title: 'Dispatch Rounds' }} />
            <Stack.Screen name="admin/audit" options={{ title: 'Audit Trail' }} />
            <Stack.Screen name="admin/config" options={{ title: 'Configuration' }} />
          </Stack>
        </RoleGate>
      </SessionProvider>
    </SafeAreaProvider>
  )
}
