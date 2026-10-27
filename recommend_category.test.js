const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { once } = require('events')
const main = require('./main')
const cache = require('./util/apicache')
const setCategory = require('./module/recommend_category_set')

const upstreamPath = '/api/homepage/daily/song/tag/save'
const upstreamResponse = { status: 200, body: { code: 200 }, cookie: [] }

describe('daily recommendation category parameters', () => {
  const validCases = [
    ['documented parameters', { category: '1000', tags: '10004,10015' }],
    ['legacy parameter', { categoryId: '1000', tags: '10004,10015' }],
    [
      'numeric category and tag array',
      { category: 1000, tags: [10004, '10015'] },
    ],
    ['whitespace', { category: ' 1000 ', tags: ' 10004 , 10015 ' }],
    ['single tag', { category: 1000, tags: 10004 }, [10004]],
    ['zero IDs', { category: 0, tags: '0' }, [0], 0],
    [
      'canonical parameter precedence',
      { category: '1000', categoryId: '2000', tags: '10004,10015' },
    ],
  ]

  for (const [
    name,
    query,
    tagIds = [10004, 10015],
    categoryId = 1000,
  ] of validCases) {
    it(`accepts ${name} and forwards numeric IDs`, async () => {
      let calls = 0
      const response = await setCategory(query, async (url, data, options) => {
        calls++
        assert.strictEqual(url, upstreamPath)
        assert.deepStrictEqual(JSON.parse(data.tags), { tagIds, categoryId })
        assert.strictEqual(options.crypto, 'xeapi')
        return upstreamResponse
      })
      assert.strictEqual(calls, 1)
      assert.strictEqual(response, upstreamResponse)
    })
  }

  it('preserves caller request options and does not mutate the query', async () => {
    const query = Object.freeze({
      category: '1000',
      tags: '10004',
      cookie: { MUSIC_U: 'test-only' },
      crypto: 'eapi',
      proxy: 'http://127.0.0.1:9999',
      realIP: '127.0.0.1',
      randomCNIP: false,
      headers: { 'X-Test': 'category' },
      timeout: 1234,
    })
    await setCategory(query, async (_, __, options) => {
      for (const key of [
        'cookie',
        'crypto',
        'proxy',
        'realIP',
        'randomCNIP',
        'headers',
        'timeout',
      ]) {
        assert.strictEqual(options[key], query[key])
      }
      return upstreamResponse
    })
  })

  it('propagates an upstream rejection unchanged', async () => {
    const rejection = { status: 503, body: { code: 503 }, cookie: [] }
    await assert.rejects(
      setCategory({ category: 1000, tags: '10004' }, () =>
        Promise.reject(rejection),
      ),
      (error) => error === rejection,
    )
  })

  async function expectInvalid(query) {
    let calls = 0
    await assert.rejects(
      setCategory(query, async () => {
        calls++
        return upstreamResponse
      }),
      (error) => {
        assert.strictEqual(error.status, 400)
        assert.strictEqual(error.body.code, 400)
        assert.strictEqual(typeof error.body.msg, 'string')
        assert(error.body.msg.length > 0)
        assert.deepStrictEqual(error.cookie, [])
        return true
      },
    )
    assert.strictEqual(calls, 0)
  }

  const invalidIds = [
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '  '],
    ['nonnumeric', 'invalid'],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['negative', -1],
    ['fraction', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['boolean', true],
    ['object', {}],
    ['array', [1000]],
  ]
  for (const [name, value] of invalidIds) {
    it(`rejects ${name} category IDs through either parameter`, async () => {
      for (const key of ['category', 'categoryId']) {
        await expectInvalid({ [key]: value, tags: '10004' })
      }
    })
  }

  it('does not hide an invalid canonical category with a valid alias', async () => {
    await expectInvalid({ category: '', categoryId: 1000, tags: '10004' })
  })

  const invalidTags = [
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '  '],
    ['nonnumeric entry', '10004,invalid'],
    ['empty entry', '10004,,10015'],
    ['trailing comma', '10004,'],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['negative', '-1'],
    ['fraction', '1.5'],
    ['unsafe integer', '9007199254740992'],
    ['boolean', true],
    ['object', {}],
    ['empty array', []],
    ['sparse array', new Array(1)],
    ['nested array', [[10004]]],
    ['null array entry', [10004, null]],
  ]
  for (const [name, tags] of invalidTags) {
    it(`rejects ${name} tags before making an upstream request`, async () => {
      await expectInvalid({ category: '1000', tags })
    })
  }
})

describe('daily recommendation category HTTP routes (mock upstream)', () => {
  let server
  let baseURL
  let calls

  before(async () => {
    const definitions = await main.getModulesDefinitions(
      path.join(__dirname, 'module'),
      undefined,
      false,
    )
    const targets = definitions.filter((definition) =>
      ['recommend_category_set', 'recommend_category_config'].includes(
        definition.identifier,
      ),
    )
    assert.deepStrictEqual(
      targets.map((definition) => definition.route).sort(),
      ['/recommend/category/config', '/recommend/category/set'],
    )
    const moduleDefs = targets.map((definition) => {
      const handler = require(definition.module)
      return {
        ...definition,
        module: (query) =>
          handler(query, async (url, data, options) => {
            calls.push({ url, data, options })
            return upstreamResponse
          }),
      }
    })
    const app = await main.serveNcmApi({
      port: '0',
      host: '127.0.0.1',
      checkVersion: false,
      moduleDefs,
    })
    server = app.server
    if (!server.listening) await once(server, 'listening')
    baseURL = `http://127.0.0.1:${server.address().port}`
  })

  beforeEach(() => {
    calls = []
    cache.clear()
  })

  after(async () => {
    cache.clear()
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  function send(route, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const request = http.request(
        new URL(route, baseURL),
        {
          method: payload === undefined ? 'GET' : 'POST',
          agent: false,
          headers:
            payload === undefined ? {} : { 'Content-Type': 'application/json' },
        },
        (response) => {
          let data = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            data += chunk
          })
          response.on('end', () => {
            try {
              resolve({ status: response.statusCode, body: JSON.parse(data) })
            } catch (error) {
              reject(error)
            }
          })
          response.on('error', reject)
        },
      )
      request.on('error', reject)
      request.setTimeout(5000, () =>
        request.destroy(new Error('local HTTP request timed out')),
      )
      request.end(payload)
    })
  }

  function assertSaved(response, expectedCategory = 1000) {
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(response.body, upstreamResponse.body)
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].url, upstreamPath)
    assert.deepStrictEqual(JSON.parse(calls[0].data.tags), {
      tagIds: [10004, 10015],
      categoryId: expectedCategory,
    })
    assert.strictEqual(calls[0].options.crypto, 'xeapi')
  }

  it('executes the canonical request copied directly from the documentation', async () => {
    const docs = fs.readFileSync(
      path.join(__dirname, 'public/docs/home.md'),
      'utf8',
    )
    const section = docs
      .split('## 设置每日指定风格歌曲推荐的风格')[1]
      .split('\n## ')[0]
    const example = section.match(/\*\*调用例子 :\*\* `([^`]+)`/)
    assert(example, 'setting section must contain a runnable request example')
    assert.strictEqual(
      example[1],
      '/recommend/category/set?tags=10004,10015&category=1000',
    )
    assertSaved(await send(example[1]))
  })

  const compatibilityRequests = [
    '/recommend/category/config?tags=10004,10015&categoryId=1000',
    '/recommend/category/set?tags=10004,10015&categoryId=1000',
    '/recommend/category/config?tags=10004,10015&category=1000',
  ]
  for (const route of compatibilityRequests) {
    it(`supports ${route}`, async () => {
      assertSaved(await send(route))
    })
  }

  for (const route of [
    '/recommend/category/set',
    '/recommend/category/config',
  ]) {
    it(`accepts JSON bodies at ${route}`, async () => {
      assertSaved(await send(route, { categoryId: 1000, tags: [10004, 10015] }))
    })

    it(`returns HTTP 400 for missing and malformed parameters at ${route}`, async () => {
      for (const suffix of [
        '',
        '?category=1000',
        '?tags=10004',
        '?category=bad&tags=10004',
        '?category=1000&tags=10004,',
        '?category=1000&category=2000&tags=10004',
      ]) {
        const response = await send(route + suffix)
        assert.strictEqual(response.status, 400)
        assert.strictEqual(response.body.code, 400)
        assert.strictEqual(typeof response.body.msg, 'string')
        assert.strictEqual(calls.length, 0)
      }
    })

    it(`rejects malformed JSON parameter types at ${route}`, async () => {
      const response = await send(route, {
        category: null,
        categoryId: 1000,
        tags: [10004],
      })
      assert.strictEqual(response.status, 400)
      assert.strictEqual(response.body.code, 400)
      assert.strictEqual(calls.length, 0)
    })
  }
})
