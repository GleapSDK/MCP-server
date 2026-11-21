// Secret redaction for SDK telemetry returned by get_ticket_activity_log.
// Ported from the Gleap Server's Kai Resolve tests
// (ticket.telemetry.redaction.test.ts). Rows and cases marked "Server#1783"
// cover rules that match Server `ticket.telemetry.redaction.ts` as of
// GleapSDK/Server#1783, commit d24241285.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.GLEAP_API_BASE = 'https://gleap-api.invalid/v3';
const { isSensitiveKey, redactJson, redactText, redactUrl, REDACTED } = await import(
  '../src/utils/telemetryRedaction.js'
);

describe('isSensitiveKey', () => {
  const rows = [
    ['password', true],
    ['newPassword', true],
    ['access_token', true],
    ['refreshToken', true],
    ['X-API-Key', true],
    ['Authorization', true],
    ['client_secret', true],
    ['sessionId', true],
    ['cvv', true],
    ['iban', true],
    ['tokenType', false],
    ['tokens', false],
    ['sessionCount', false],
    ['primaryKey', false],
    ['keyboard', false],
    ['code', false],
    ['email', false],
    ['id', false],
  ];
  for (const [key, expected] of rows) {
    test(`${key} -> ${expected}`, () => {
      assert.equal(isSensitiveKey(key), expected);
    });
  }
});

describe('redactJson', () => {
  test('sensitive keys at any depth -> value redacted, other values kept', () => {
    const input = {
      user: { email: 'a@acme.test', auth: { accessToken: 'at_1', expiresIn: 3600 } },
      items: [{ apiKey: 'k1' }],
    };
    assert.deepEqual(redactJson(input), {
      user: { email: 'a@acme.test', auth: { accessToken: REDACTED, expiresIn: 3600 } },
      items: [{ apiKey: REDACTED }],
    });
  });

  test('null, booleans and placeholder strings under a sensitive key stay readable', () => {
    assert.deepEqual(redactJson({ token: null, hasPassword: true, password: 'undefined' }), {
      token: null,
      hasPassword: true,
      password: 'undefined',
    });
  });

  test('a payment card object -> redacted as a whole', () => {
    assert.deepEqual(redactJson({ card: { number: '4242424242424242', exp: '12/30' }, cards: [1] }), {
      card: REDACTED,
      cards: [1],
    });
  });

  test('keys from the project privacy settings are removed, case-insensitively and at depth', () => {
    assert.deepEqual(redactJson({ a: 1, nested: { InternalNote: 'x', b: 2 } }, { propsToIgnore: ['internalNote'] }), {
      a: 1,
      nested: { b: 2 },
    });
  });

  test('secrets inside string values are redacted too', () => {
    assert.deepEqual(redactJson({ message: 'retry with Bearer abcdefghijklmnop' }), {
      message: 'retry with Bearer [redacted]',
    });
  });
});

describe('redactText', () => {
  const rows = [
    ['Authorization: Bearer abcdef1234567890', 'Authorization: Bearer [redacted]'],
    ['header was Bearer undefined', 'header was Bearer undefined'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl ok', 'jwt [redacted] ok'],
    ['key sk_live_51Habcdefghijklmn used', 'key [redacted] used'],
    ['GET /cb?code=abc&access_token=tok123456&state=x', 'GET /cb?code=abc&access_token=[redacted]&state=x'],
    ['body {"password":"hunter2","user":"a"}', 'body {"password":"[redacted]","user":"a"}'],
    ['login failed, password: hunter2', 'login failed, password: [redacted]'],
    ['Invalid token: expired', 'Invalid token: expired'],
    ['paid with 4242 4242 4242 4242 today', 'paid with [redacted] today'],
    ['event at 1727272727272 ms', 'event at 1727272727272 ms'],
    // Server#1783: a JSON value cut off at the end of a trimmed line is still a secret.
    ['{"user":"a","sessionToken":"st_9f8e7d6c5b4a', '{"user":"a","sessionToken":"[redacted]'],
    ['{"password":"hunt\\', '{"password":"[redacted]'],
    // Server#1783: numbers under a credential-like key, as redactJson does.
    ['{"pin":1234,"qty":2}', '{"pin":"[redacted]","qty":2}'],
    ['{"token":"", "otp": null}', '{"token":"", "otp": null}'],
  ];
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(redactText(input), expected);
    });
  }
});

describe('redactUrl', () => {
  test('sensitive query and fragment values -> redacted, the rest kept', () => {
    assert.equal(
      redactUrl('https://app.acme.test/cb?page=2&api_key=k_123456#access_token=abc123456&type=bearer'),
      'https://app.acme.test/cb?page=2&api_key=[redacted]#access_token=[redacted]&type=bearer',
    );
  });

  test('credentials in the authority -> redacted', () => {
    assert.equal(redactUrl('https://bob:s3cret@api.acme.test/v1'), 'https://[redacted]@api.acme.test/v1');
  });

  test('an empty sensitive value stays visible (it is a finding, not a secret)', () => {
    assert.equal(redactUrl('https://api.acme.test/v1?token='), 'https://api.acme.test/v1?token=');
  });
});

// Log text is customer-controlled. A pattern that backtracks quadratically
// turns one long line into seconds of CPU for every MCP client on the
// instance. The Server's first two inputs each took well over a second before
// its patterns were anchored; the "-eyJ" run took about 7 s with the JWT
// pattern before GleapSDK/Server#1783.
describe('pathological input stays linear', () => {
  const elapsedMs = (run) => {
    const started = process.hrtime.bigint();
    run();
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const N = 200_000;
  const inputs = {
    'a run of word characters': 'a'.repeat(N),
    'a URL with thousands of "?" and no "="': `https://x.test/${'?a'.repeat(N / 2)}`,
    'a base64url run with "-eyJ" every 5 chars (Server#1783)': '-eyJa'.repeat(N / 5),
    'an unterminated JSON value full of escapes (Server#1783)': `"token":"${'\\x'.repeat(N / 2)}`,
    '"password" followed by long whitespace, repeated': `${'password'}${' '.repeat(50)}`.repeat(N / 58),
    'spaced digits': '1 '.repeat(N / 2),
  };
  for (const [name, input] of Object.entries(inputs)) {
    test(`${name} -> redactText and redactUrl return quickly`, () => {
      const ms = elapsedMs(() => {
        redactText(input);
        redactUrl(input);
      });
      assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
    });
  }
});
