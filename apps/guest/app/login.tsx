import React from 'react'
import { router } from 'expo-router'
import { ApiClientError } from '@eventride/api-client'
import {
  Body,
  Card,
  ErrorBanner,
  Field,
  Heading,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from '@eventride/ui'
import { client, useSession } from '../src/session.js'

/**
 * FR-G1 — phone + OTP, and nothing else.
 *
 * There is no signup form: the guest record was loaded by ops before the event, so an unknown
 * number is told to contact the event desk rather than being invited to create an account.
 */
export default function LoginScreen(): React.JSX.Element {
  const { signIn } = useSession()
  const [phone, setPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [stage, setStage] = React.useState<'PHONE' | 'CODE'>('PHONE')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [devHint, setDevHint] = React.useState<string | null>(null)

  const sendCode = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await client.requestOtp(phone.trim())
      // In dev the server returns the fixed code so a reviewer needs no SMS provider.
      setDevHint(result.devCode ?? null)
      setStage('CODE')
    } catch (e) {
      setError(e instanceof ApiClientError ? e.payload.message : 'Could not send the code')
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
      router.replace('/')
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.payload.code === 'UNKNOWN_USER'
            ? 'We could not find your booking. Please contact the event desk.'
            : e.payload.message
          : 'Sign in failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <Card>
        <Heading>EventRide</Heading>
        <Body>Sign in with the phone number on your event invitation.</Body>

        <ErrorBanner message={error} />

        {stage === 'PHONE' ? (
          <>
            <Field
              label="Phone number"
              value={phone}
              onChangeText={setPhone}
              placeholder="+91 90000 00000"
              keyboardType="phone-pad"
            />
            <PrimaryButton title="Send code" onPress={sendCode} busy={busy} disabled={phone.trim().length < 6} />
          </>
        ) : (
          <>
            <Field
              label="6-digit code"
              value={code}
              onChangeText={setCode}
              placeholder="000000"
              keyboardType="number-pad"
            />
            {devHint ? <Body>Development code: {devHint}</Body> : null}
            <PrimaryButton title="Sign in" onPress={verify} busy={busy} disabled={code.trim().length < 4} />
            <SecondaryButton title="Use a different number" onPress={() => setStage('PHONE')} />
          </>
        )}
      </Card>
    </Screen>
  )
}
