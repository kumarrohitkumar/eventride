import React from 'react'
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { EventRideClient, type Session, type TokenStore } from '@eventride/api-client'

/**
 * Session + client wiring for the portal app.
 *
 * The token lives in expo-secure-store (Keychain / Keystore), never in AsyncStorage: it is a
 * bearer credential for a guest's whole event.
 */

const TOKEN_KEY = 'eventride.portal.token'

/**
 * Keychain / Keystore via expo-secure-store, with an in-memory fallback.
 *
 * The fallback is not cosmetic: SecureStore throws outright on web, and can fail on a device with a
 * locked or unavailable keystore. Without it, a storage failure propagated out of `verifyOtp` and
 * the user saw "Sign in failed" even though the server had issued a perfectly good token — losing
 * persistence is acceptable, losing the session is not.
 */
let memoryToken: string | null = null

const secureTokenStore: TokenStore = {
  get: async () => {
    try {
      return (await SecureStore.getItemAsync(TOKEN_KEY)) ?? memoryToken
    } catch {
      return memoryToken
    }
  },
  set: async (token) => {
    memoryToken = token
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, token)
    } catch {
      // Session still works for this launch; it just will not survive a restart.
    }
  },
  clear: async () => {
    memoryToken = null
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY)
    } catch {
      // Nothing to clean up if the store was never writable.
    }
  },
}


// Base URL comes from app config, never hardcoded in a screen.
const baseUrl =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? 'http://localhost:3000'

export const client = new EventRideClient(baseUrl, secureTokenStore)

interface SessionContextValue {
  session: Session | null
  restoring: boolean
  signIn: (session: Session) => void
  signOut: () => Promise<void>
}

const SessionContext = React.createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [session, setSession] = React.useState<Session | null>(null)
  const [restoring, setRestoring] = React.useState(true)

  React.useEffect(() => {
    // A stored token is validated against the server before we trust it: a guest whose record was
    // removed must not sit in a half-authenticated state.
    void (async () => {
      const token = await secureTokenStore.get()
      if (!token) {
        setRestoring(false)
        return
      }
      try {
        const principal = await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (principal.ok) {
          const me = (await principal.json()) as {
            userId: string
            role: 'ADMIN' | 'DRIVER'
            driverId?: string
          }
          setSession({
            token,
            role: me.role,
            profile: { id: me.userId, name: '', driverId: me.driverId },
          })
        } else {
          await secureTokenStore.clear()
        }
      } catch {
        // Offline: keep the token so cached screens still render (FR-G14).
        setSession({ token, role: 'DRIVER', profile: { id: '', name: '' } })
      }
      setRestoring(false)
    })()
  }, [])

  const value = React.useMemo<SessionContextValue>(
    () => ({
      session,
      restoring,
      signIn: setSession,
      signOut: async () => {
        await client.signOut()
        setSession(null)
      },
    }),
    [session, restoring],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext)
  if (!context) throw new Error('useSession must be used inside SessionProvider')
  return context
}
