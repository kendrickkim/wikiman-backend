import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jwtSecret, assertJwtSecret } from '../src/jwt.js'

test('개발 환경에서는 기본 JWT_SECRET을 허용한다', () => {
  const prevEnv = process.env.NODE_ENV
  const prevSecret = process.env.JWT_SECRET
  process.env.NODE_ENV = 'development'
  process.env.JWT_SECRET = 'change-me'
  assert.equal(jwtSecret(), 'change-me')
  assert.doesNotThrow(() => assertJwtSecret())
  process.env.NODE_ENV = prevEnv
  process.env.JWT_SECRET = prevSecret
})

test('운영 환경에서 JWT_SECRET 기본값은 거부한다', () => {
  const prevEnv = process.env.NODE_ENV
  const prevSecret = process.env.JWT_SECRET
  process.env.NODE_ENV = 'production'
  process.env.JWT_SECRET = 'change-me'
  assert.throws(() => jwtSecret(), /JWT_SECRET/)
  assert.throws(() => assertJwtSecret(), /JWT_SECRET/)
  process.env.NODE_ENV = 'production'
  delete process.env.JWT_SECRET
  assert.throws(() => assertJwtSecret(), /JWT_SECRET/)
  process.env.NODE_ENV = prevEnv
  if (prevSecret == null) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = prevSecret
})
