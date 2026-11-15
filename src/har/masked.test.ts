import { assert, test } from 'orca/testing'
import { zipSync } from '../../vendor/fflate/fflate.mjs'
import { DEMO_SECRETS, demoHar, demoPng } from '../fixtures/demo'
import { decodeText } from './body'
import { maskedHarText, maskedHarZip, maskRecording } from './masked'
import { openHarZip } from './zip'
import type { Har } from './types'

const enc = new TextEncoder()
const SECRET = 'sk-demo-attachedBodySecret0123456789'

function attachedZip(): Uint8Array {
  const har: Har = {
    log: {
      version: '1.2',
      creator: { name: 'Playwright', version: '1.49.0' },
      entries: [
        {
          startedDateTime: '2026-11-15T10:00:00.010Z',
          time: 40,
          request: {
            method: 'POST',
            url: 'https://api.example.com/v1/login',
            headers: [{ name: 'Authorization', value: 'Bearer abcDEF123456' }],
            postData: { mimeType: 'application/json', _file: 'req.json' }
          },
          response: { status: 200, content: { size: 60, mimeType: 'application/json; charset=utf-8', _file: 'res.json' } },
          timings: { send: 1, wait: 30, receive: 9 }
        },
        {
          startedDateTime: '2026-11-15T10:00:00.020Z',
          time: 10,
          request: { method: 'GET', url: 'https://cdn.example.com/chart.png', headers: [] },
          response: { status: 200, content: { size: 10, mimeType: 'image/png', _file: 'chart.png' } },
          timings: { send: 1, wait: 5, receive: 4 }
        }
      ]
    }
  }
  return zipSync({
    'har.har': enc.encode(JSON.stringify(har)),
    'req.json': enc.encode(JSON.stringify({ user: 'demo', password: 'hunter2-demo' })),
    'res.json': enc.encode(JSON.stringify({ ok: true, apiKey: SECRET, name: 'Demo' })),
    'chart.png': demoPng(4, 3),
    'unreferenced.txt': enc.encode(`token=${SECRET}`)
  })
}

test('masking a .har.zip masks its text body files and counts them per request', () => {
  const zip = openHarZip(attachedZip())
  const har = JSON.parse(zip.text) as Har
  const masked = maskRecording(har, zip.files)
  const req = decodeText(masked.files!.get('req.json')!)
  const res = decodeText(masked.files!.get('res.json')!)
  assert.ok(!req.includes('hunter2-demo'), req)
  assert.ok(!res.includes(SECRET), res)
  assert.equal(JSON.parse(res).name, 'Demo')
  assert.ok(masked.report.bodies >= 2)
  assert.ok(masked.report.headers >= 1)
  assert.ok(masked.report.entries.has(0))
  assert.ok(!masked.report.entries.has(1))
  // Binary files are passed through as they are.
  assert.deepEqual([...masked.files!.get('chart.png')!.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  // The source is untouched.
  assert.ok(decodeText(zip.files.get('res.json')!).includes(SECRET))
})

test('the sanitized .har.zip holds the masked HAR and only the files it points to', () => {
  const zip = openHarZip(attachedZip())
  const masked = maskRecording(JSON.parse(zip.text) as Har, zip.files)
  const again = openHarZip(maskedHarZip(masked))
  assert.equal(again.name, 'har.har')
  assert.deepEqual([...again.names].sort(), ['chart.png', 'har.har', 'req.json', 'res.json'])
  assert.ok(!again.text.includes('abcDEF123456'))
  for (const name of ['req.json', 'res.json']) {
    const text = decodeText(again.files.get(name)!)
    assert.ok(!text.includes(SECRET) && !text.includes('hunter2-demo'), `${name}: ${text}`)
  }
  assert.equal(again.files.get('chart.png')!.length, demoPng(4, 3).length)
})

test('the sanitized .har of the demo recording holds none of its secrets', () => {
  const masked = maskRecording(demoHar())
  const text = maskedHarText(masked)
  for (const secret of Object.values(DEMO_SECRETS)) assert.ok(!text.includes(secret), secret)
  assert.ok(JSON.parse(text).log.entries.length > 20)
  assert.ok(masked.report.total > 0)
  assert.equal(masked.files, undefined)
})
