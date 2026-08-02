import React from 'react'
import { Redirect } from 'expo-router'
import { Loading } from '@eventride/ui'
import { useSession } from '../src/session.js'

/**
 * Entry route: sends each role to its own home.
 *
 * Declarative <Redirect> rather than router.replace in an effect — an imperative navigation during
 * the first render happens before expo-router mounts its navigator, which throws
 * "Attempted to navigate before mounting the Root Layout component" and leaves a blank screen.
 */
export default function Index(): React.JSX.Element {
  const { session, restoring } = useSession()

  if (restoring) return <Loading label="Restoring your session…" />
  if (!session) return <Redirect href="/login" />
  return <Redirect href={session.role === 'ADMIN' ? '/admin' : '/driver'} />
}
