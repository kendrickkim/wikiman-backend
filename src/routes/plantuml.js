import { Router } from 'express'
import plantumlEncoder from 'plantuml-encoder'

const router = Router()
const plantumlServer = (process.env.PLANTUML_SERVER || 'https://www.plantuml.com/plantuml').replace(/\/$/, '')

async function renderSvg(source) {
  const encoded = plantumlEncoder.encode(source)
  const url = `${plantumlServer}/svg/${encoded}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('PlantUML 렌더링에 실패했습니다.')
  }
  return response.text()
}

router.post('/', async (req, res) => {
  const source = String(req.body?.source || req.body?.text || '')
  if (!source.trim()) {
    return res.status(400).json({ error: 'PlantUML 소스가 필요합니다.' })
  }
  try {
    const svg = await renderSvg(source)
    res.type('image/svg+xml').send(svg)
  } catch (err) {
    res.status(502).json({ error: err.message || 'PlantUML 서버에 연결할 수 없습니다.' })
  }
})

router.get('/:encoded', async (req, res) => {
  try {
    const encoded = req.params.encoded
    const url = `${plantumlServer}/svg/${encoded}`
    const response = await fetch(url)
    if (!response.ok) {
      return res.status(502).json({ error: 'PlantUML 렌더링에 실패했습니다.' })
    }
    const svg = await response.text()
    res.type('image/svg+xml').send(svg)
  } catch {
    res.status(502).json({ error: 'PlantUML 서버에 연결할 수 없습니다.' })
  }
})

export default router
