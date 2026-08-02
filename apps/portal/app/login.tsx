import React from 'react'
import { router } from 'expo-router'
import { ApiClientError } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Field,
  Heading,
  Label,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from '@eventride/ui'
import { client, useSession } from '../src/session.js'

/**
 * Portal sign-in for both roles.
 *
 * Drivers use phone + OTP (they are field staff with a phone in hand); admins use credentials
 * issued by another admin. Same screen, two paths, because there is no self-signup for either.
 */
export default function PortalLogin(): React.JSX.Element {
  const { signIn } = useSession()
  const [mode, setMode] = React.useState<'DRIVER' | 'ADMIN'>('DRIVER')
  const [phone, setPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [stage, setStage] = React.useState<'PHONE' | 'CODE'>('PHONE')
  const [devHint, setDevHint] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof ApiClientError ? e.payload.message : fallback)

  const sendCode = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await client.requestOtp(phone.trim())
      setDevHint(result.devCode ?? null)
      setStage('CODE')
    } catch (e) {
      fail(e, 'Could not send the code')
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await client.verifyOtp(phone.trim(), code.trim())
      signIn(session)
      router.replace(session.role === 'ADMIN' ? '/admin' : '/driver')
    } catch (e) {
      fail(e, 'Sign in failed')
    } finally {
      setBusy(false)
    }
  }

  const loginAdmin = async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await client.login(email.trim(), password)
      signIn(session)
      router.replace(session.role === 'ADMIN' ? '/admin' : '/driver')
    } catch (e) {
      fail(e, 'Invalid login')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <Card>
        <Heading>EventRide Portal</Heading>
        <Body>Operations and driver access.</Body>
        <ErrorBanner message={error} />

        {mode === 'DRIVER' ? (
          <>
            <Label>DRIVER SIGN IN</Label>
            {stage === 'PHONE' ? (
              <>
                <Field
                  label="Phone number"
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="+91 90000 00000"
                  keyboardType="phone-pad"
                />
                <PrimaryButton title="Send code" onPress={() => void sendCode()} busy={busy} disabled={phone.trim().length < 6} />
              </>
            ) : (
              <>
                <Field label="6-digit code" value={code} onChangeText={setCode} keyboardType="number-pad" placeholder="000000" />
                {devHint ? <Body>Development code: {devHint}</Body> : null}
                <PrimaryButton title="Sign in" onPress={() => void verify()} busy={busy} disabled={code.trim().length < 4} />
                <SecondaryButton title="Use a different number" onPress={() => setStage('PHONE')} />
              </>
            )}
            <SecondaryButton title="I'm operations staff" onPress={() => setMode('ADMIN')} />
          </>
        ) : (
          <>
            <Label>OPERATIONS SIGN IN</Label>
            <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" />
            <Field label="Password" value={password} onChangeText={setPassword} secure />
            <PrimaryButton title="Sign in" onPress={() => void loginAdmin()} busy={busy} disabled={!email || !password} />
            <SecondaryButton title="I'm a driver" onPress={() => setMode('DRIVER')} />
          </>
        )}
      </Card>
    </Screen>
  )
}
