import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiError, errorPayload } from '../src/errors.js'

test('apiError는 안정 코드와 상태, params를 보존한다', () => {
  const error = apiError('TOP_MENU_MAX_ITEMS', 400, { max: 20 })

  assert.equal(error.message, 'TOP_MENU_MAX_ITEMS')
  assert.equal(error.code, 'TOP_MENU_MAX_ITEMS')
  assert.equal(error.status, 400)
  assert.deepEqual(error.params, { max: 20 })
  assert.deepEqual(errorPayload(error), {
    error: 'TOP_MENU_MAX_ITEMS',
    params: { max: 20 }
  })
})

test('errorPayload는 임의 메시지를 노출하지 않고 빈 params를 생략한다', () => {
  assert.deepEqual(errorPayload(new Error('database path leaked')), { error: 'SERVER_ERROR' })
  assert.deepEqual(errorPayload({ message: 'POST_NOT_FOUND', params: {} }), { error: 'POST_NOT_FOUND' })
  assert.deepEqual(errorPayload({ code: 'not-stable' }, 'UPLOAD_FAILED'), { error: 'UPLOAD_FAILED' })
})
