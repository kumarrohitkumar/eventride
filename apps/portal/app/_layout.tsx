import React from 'react'
import { Stack, router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Loading, theme } from '@eventride/ui'
import { SessionProvider, useSession } from '../src/session.js'

/**
 * Admin Portal root.
 *
 * One app, two roles (the brief's structure). The role in the session decides which tree the user
 * lands in; the server enforces the same separation independently, so this routing is convenience
 * rather than security — a Driver-role token calling an admin endpoint gets 403 regardless.
 */
function RoleGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { session, restoring } = useSession()

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
          </Stack>
        </RoleGate>
      </SessionProvider>
    </SafeAreaProvider>
  )
}
