const DEV_SECRETS = new Set(['', 'dev-secret-change-me', 'change-me'])

function isProduction() {
  return process.env.NODE_ENV === 'production'
}

export function jwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim()
  if (!secret || DEV_SECRETS.has(secret)) {
    if (isProduction()) {
      throw Object.assign(new Error('운영 환경에서는 JWT_SECRET을 안전한 값으로 설정해야 합니다.'), { fatal: true })
    }
    return secret || 'dev-secret-change-me'
  }
  return secret
}

export function assertJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim()
  if (!secret || DEV_SECRETS.has(secret)) {
    if (isProduction()) {
      throw Object.assign(
        new Error('운영 환경에서는 JWT_SECRET을 안전한 값으로 설정해야 합니다. 기본값이나 빈 값은 사용할 수 없습니다.'),
        { fatal: true }
      )
    }
    console.warn('JWT_SECRET이 없거나 기본값입니다. 개발용으로만 사용하세요.')
  }
}
