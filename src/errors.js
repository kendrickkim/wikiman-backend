const STABLE_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

function stableCode(value) {
  return typeof value === 'string' && STABLE_CODE.test(value) ? value : null
}

export function apiError(code, status = 400, params = {}) {
  return Object.assign(new Error(code), {
    code,
    status,
    params
  })
}

export function errorPayload(error, fallbackCode = 'SERVER_ERROR') {
  const fallback = stableCode(fallbackCode) || 'SERVER_ERROR'
  const code = stableCode(error?.code) || stableCode(error?.message) || fallback
  const params = error?.params
  const hasParams = params && typeof params === 'object' && Object.keys(params).length > 0
  return {
    error: code,
    ...(hasParams ? { params } : {})
  }
}

export function sendError(res, error, fallbackCode = 'SERVER_ERROR', fallbackStatus = 500) {
  const status = Number.isInteger(error?.status) ? error.status : fallbackStatus
  return res.status(status).json(errorPayload(error, fallbackCode))
}
