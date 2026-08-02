import React from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Loading, theme } from '@eventride/ui'
import { SessionProvider, useSession } from '../src/session.js'

/** Root layout: gates every screen behind a restored session. */
function Gate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { restoring } = useSession()
  if (restoring) return <Loading label="Signing you in…" />
  return <>{children}</>
}

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Gate>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: theme.colour.surface },
              headerTitleStyle: { fontWeight: '700' },
              contentStyle: { backgroundColor: theme.colour.background },
            }}
          >
            <Stack.Screen name="index" options={{ title: 'My Ride' }} />
            <Stack.Screen name="login" options={{ title: 'Sign in', headerShown: false }} />
            <Stack.Screen name="itinerary" options={{ title: 'My Trips' }} />
            <Stack.Screen name="request" options={{ title: 'Request a Ride' }} />
          </Stack>
        </Gate>
      </SessionProvider>
    </SafeAreaProvider>
  )
}
