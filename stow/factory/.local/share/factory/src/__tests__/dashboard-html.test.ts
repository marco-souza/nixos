import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_DIR } from '../paths'

const html = readFileSync(join(PACKAGE_DIR, 'dashboard.html'), 'utf8')
const libSrc = /<script id="lib">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

/** The page's `<script id="lib">`: pure helpers with no DOM, so they run here. */
function lib(fetch: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response('{}')) {
  if (!libSrc) throw new Error('dashboard.html has no <script id="lib">')
  return new Function('fetch', `${libSrc}\nreturn { markdown, inline, post, safeUrl }`)(fetch) as {
    markdown(src: string): string
    inline(src: string): string
    post(path: string, body?: unknown): Promise<unknown>
    safeUrl(url: string): string | null
  }
}

describe('dashboard.html', () => {
  test('loads nothing from another host', () => {
    const urls = [
      ...html.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi),
      ...html.matchAll(/url\(\s*["']?([^"')]+)/gi),
      ...html.matchAll(/@import\s+["']([^"']+)/gi),
    ].map((m) => m[1]!)
    expect(urls.filter((u) => /^(https?:)?\/\//i.test(u))).toEqual([])
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
  })

  test('the POST helper sends X-Factory: 1 and a JSON body', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const { post } = lib(async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ job: { id: 'x' } }), { status: 200 })
    })
    expect(await post('/api/jobs/x/feedback', { note: 'hi' })).toEqual({ job: { id: 'x' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(new Headers(calls[0]!.init?.headers).get('X-Factory')).toBe('1')
    expect(calls[0]!.init?.body).toBe('{"note":"hi"}')
  })

  test('the POST helper throws the server error', async () => {
    const { post } = lib(async () => new Response(JSON.stringify({ error: 'driver already running for x (pid 7)' }), { status: 409 }))
    await expect(post('/api/jobs/x/approve')).rejects.toThrow('driver already running for x (pid 7)')
  })

  test('markdown escapes raw HTML', () => {
    const { markdown } = lib()
    const out = markdown('# Title <b>x</b>\n\nHello <img src=x onerror=alert(1)>\n\n- <script>alert(1)</script>\n\n| a | <i>b</i> |\n| - | - |\n| `<x>` | y |')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<b>')
    expect(out).not.toContain('<i>')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('<code>&lt;x&gt;</code>')
  })

  test('markdown escapes code blocks and attribute quotes', () => {
    const { markdown } = lib()
    expect(markdown('```\n<script>"x"</script>\n```')).toBe('<pre><code>&lt;script&gt;&quot;x&quot;&lt;/script&gt;</code></pre>')
    expect(markdown('[x](https://a.test/?q="><script>)')).not.toContain('"><script>')
  })

  test('markdown links only http, https and relative targets', () => {
    const { markdown } = lib()
    const bad = markdown('[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html,x) [d](vbscript:x)')
    expect(bad).not.toContain('<a')
    expect(bad).not.toMatch(/href/i)
    // The link text stays, the whole target (parentheses included) goes.
    expect(bad).toBe('<p>a b c d</p>')
    expect(markdown('[w](https://en.wikipedia.org/wiki/Foo_(bar))')).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"')
    const good = markdown('[pr](https://github.com/o/r/pull/1) [spec](../specs/x.md) [top](#intent)')
    expect(good).toContain('<a href="https://github.com/o/r/pull/1" target="_blank" rel="noopener noreferrer">pr</a>')
    expect(good).toContain('href="../specs/x.md"')
    expect(good).toContain('href="#intent"')
  })

  test('markdown renders headings, lists, emphasis, tables and verdicts', () => {
    const { markdown } = lib()
    const out = markdown('VERDICT: CHANGES\n\n## Findings\n\n1. **Bold** and *em*\n2. `code`\n\n| k | v |\n| --- | --- |\n| a | b |')
    expect(out).toContain('<div class="verdict warn">VERDICT: CHANGES</div>')
    expect(out).toContain('<h2>Findings</h2>')
    expect(out).toContain('<ol><li><strong>Bold</strong> and <em>em</em></li><li><code>code</code></li></ol>')
    expect(out).toContain('<table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>')
  })

  test('safeUrl keeps http(s) only', () => {
    const { safeUrl } = lib()
    expect(safeUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1')
    expect(safeUrl('http://localhost:5110')).toBe('http://localhost:5110')
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('/relative')).toBeNull()
    expect(safeUrl('')).toBeNull()
  })

  // A loop in markdown() would hang this process, so it runs in a child that is killed after 5 s.
  test.each([
    ['U+2028', '# Title tail\n\nbody', '<h1>Title tail</h1>'],
    ['U+2029', '## Risks   more\nbody', '<h2>Risks   more</h2>'],
  ])('markdown terminates on a heading with %s', (_, input, heading) => {
    const code = `${libSrc}\nprocess.stdout.write(markdown(${JSON.stringify(input)}))`
    const r = Bun.spawnSync([process.execPath, '-e', code], { timeout: 5000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString()).toBe(`${heading}<p>body</p>`)
  })

  test('markdown drops protocol-relative links', () => {
    const { markdown } = lib()
    const out = markdown('[a](//evil.example/x) [b](/\\evil.example) [c](\\\\evil.example)')
    expect(out).not.toContain('<a')
    expect(out).toBe('<p>a b c</p>')
    expect(markdown('[ok](/docs/x.md)')).toContain('href="/docs/x.md"')
  })

  test('link text never holds a second link', () => {
    const { inline } = lib()
    const out = inline('[see https://a.test/x](https://b.test)')
    expect(out.match(/<a /g)).toHaveLength(1)
    expect(out).toContain('>see https://a.test/x</a>')
  })

  test('the page keeps no copies of the CLI wording, step labels or the trip cap', () => {
    // /api/jobs serves them: `hint`, `whatFor`, `steps` and `limits.maxTrips`.
    expect(html).not.toMatch(/function nextHint|function whatFor|MAX_TRIPS|label: 'tech discovery'/)
    expect(html).not.toContain('once QA is back')
  })
})
