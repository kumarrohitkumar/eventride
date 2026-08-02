import React from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Loading, theme, usePushRegistration } from '@eventride/ui'
import { SessionProvider, useSession, client } from '../src/session.js'

/** Root layout: gates every screen behind a restored session. */
function Gate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { restoring, session } = useSession()
  // Registers the device once the guest is authenticated; failure degrades to sockets only.
  usePushRegistration(client, Boolean(session))
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
