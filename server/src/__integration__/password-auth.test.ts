import { createServer, type Server } from 'node:http'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createSession, hashPassword, resolveSession, verifyPassword } from '../auth.js'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const USER_ID = 'password-user'
const COMPANY_ID = 'password-company'
const EMAIL = 'password.user@example.test'
const PASSWORD = 'correct horse battery staple'

let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const express = (await import('express')).default
  const { api } = await import('../api/router.js')
  const app = express()
  app.use('/api', api)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing test address')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
  await pool.query(
    `UPDATE app_settings SET value='false'::jsonb WHERE key IN ('waitlist_enabled','signups_paused')`,
  )
  await pool.query(
    `INSERT INTO companies (id,name,slug,owner_user_id) VALUES ($1,'Password Test',$1,$2)`,
    [COMPANY_ID, USER_ID],
  )
  await seedUserMembership(USER_ID, COMPANY_ID, { email: EMAIL, displayName: 'Password User' })
  await pool.query(`UPDATE users SET password_hash=$1,email_verified_at=NOW() WHERE id=$2`, [await hashPassword(PASSWORD), USER_ID])
})

after(async () => { await teardownAll(server) })

async function passwordLogin(email: string, password: string) {
  return fetch(`${baseUrl}/api/auth/password/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}

test('[integration] password hash round-trips and rejects malformed hashes', async () => {
  const encoded = await hashPassword(PASSWORD)
  assert.equal(await verifyPassword(PASSWORD, encoded), true)
  assert.equal(await verifyPassword('wrong password', encoded), false)
  assert.equal(await verifyPassword(PASSWORD, null), false)
  assert.equal(await verifyPassword(PASSWORD, 'not-a-password-hash'), false)
})

test('[integration] public password registration creates an unverified account, workspace and session', async () => {
  const registeredEmail = 'new.password.user@example.test'
  const response = await fetch(`${baseUrl}/api/auth/password/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: 'New Password User',
      email: registeredEmail.toUpperCase(),
      password: PASSWORD,
    }),
  })
  assert.equal(response.status, 201)
  const body = await response.json() as {
    token: string; companyId: string
    user: { id: string; email: string; displayName: string; emailVerified: boolean }
  }
  assert.equal(body.user.email, registeredEmail)
  assert.equal(body.user.displayName, 'New Password User')
  assert.equal(body.user.emailVerified, false)
  assert.equal((await resolveSession(body.token))?.userId, body.user.id)

  const persisted = await pool.query<{
    password_hash: string | null; email_verified_at: string | null; role: string
  }>(
    `SELECT u.password_hash,u.email_verified_at,cm.role
       FROM users u JOIN company_members cm ON cm.user_id=u.id
      WHERE u.id=$1 AND cm.company_id=$2`,
    [body.user.id, body.companyId],
  )
  assert.match(persisted.rows[0]?.password_hash ?? '', /^scrypt:/)
  assert.equal(persisted.rows[0]?.email_verified_at, null)
  assert.equal(persisted.rows[0]?.role, 'owner')

  const duplicate = await fetch(`${baseUrl}/api/auth/password/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Duplicate', email: registeredEmail, password: PASSWORD }),
  })
  assert.equal(duplicate.status, 409)
})

test('[integration] signup controls reject password registration when paused or waitlisted', async () => {
  await pool.query(`UPDATE app_settings SET value='true'::jsonb WHERE key='signups_paused'`)
  const paused = await fetch(`${baseUrl}/api/auth/password/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Paused', email: 'paused@example.test', password: PASSWORD }),
  })
  assert.equal(paused.status, 503)

  await pool.query(`UPDATE app_settings SET value='false'::jsonb WHERE key='signups_paused'`)
  await pool.query(`UPDATE app_settings SET value='true'::jsonb WHERE key='waitlist_enabled'`)
  const waitlisted = await fetch(`${baseUrl}/api/auth/password/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Waitlisted', email: 'waitlisted@example.test', password: PASSWORD }),
  })
  assert.equal(waitlisted.status, 403)
})

test('[integration] an existing account can sign in with email and password', async () => {
  const response = await passwordLogin(EMAIL.toUpperCase(), PASSWORD)
  assert.equal(response.status, 200)
  const body = await response.json() as { token: string; companyId: string; user: { id: string } }
  assert.equal(body.user.id, USER_ID)
  assert.equal(body.companyId, COMPANY_ID)
  assert.equal((await resolveSession(body.token))?.userId, USER_ID)

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${body.token}` } })
  assert.equal(me.status, 200)
  assert.equal(((await me.json()) as { user: { hasPassword: boolean } }).user.hasPassword, true)
})

test('[integration] unknown email and wrong password return the same public error', async () => {
  const wrongPassword = await passwordLogin(EMAIL, 'definitely wrong')
  const unknownEmail = await passwordLogin('missing@example.test', 'definitely wrong')
  assert.equal(wrongPassword.status, 401)
  assert.equal(unknownEmail.status, 401)
  assert.deepEqual(await wrongPassword.json(), { error: 'invalid email or password' })
  assert.deepEqual(await unknownEmail.json(), { error: 'invalid email or password' })
})

test('[integration] repeated failures lock the email login window', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await passwordLogin(EMAIL, 'wrong password')
    assert.equal(response.status, 401)
  }
  const limited = await passwordLogin(EMAIL, PASSWORD)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '900')
})

test('[integration] OAuth-only account can establish and then change a password', async () => {
  await pool.query(`UPDATE users SET password_hash=NULL WHERE id=$1`, [USER_ID])
  const firstSession = await createSession(USER_ID, {})
  const secondSession = await createSession(USER_ID, {})
  const establish = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${firstSession.token}` },
    body: JSON.stringify({ newPassword: PASSWORD }),
  })
  assert.equal(establish.status, 200)
  assert.equal(await resolveSession(secondSession.token), null, 'setting a password revokes other sessions')
  assert.equal((await resolveSession(firstSession.token))?.userId, USER_ID, 'current session remains active')
  assert.equal((await passwordLogin(EMAIL, PASSWORD)).status, 200)

  const changed = 'this is the replacement password'
  const change = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${firstSession.token}` },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: changed }),
  })
  assert.equal(change.status, 200)
  assert.equal((await passwordLogin(EMAIL, PASSWORD)).status, 401)
  assert.equal((await passwordLogin(EMAIL, changed)).status, 200)
})
