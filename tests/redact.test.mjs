import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets, redactPii, gateCandidate } from '../lib/testing.js';

test('every credential fixture is blocked', () => {
  const fixtures = {
    'aws-access-key': 'key AKIAIOSFODNN7EXAMPLE here',
    'openai-style-key': 'k=sk-abcdefghijklmnop1234',
    'github-token': 'ghp_abcdefghijklmnopqrst',
    'slack-token': 'xoxb-1234567890-abcdefg',
    'private-key-pem': '-----BEGIN RSA PRIVATE KEY-----',
    'jwt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123456',
    'url-userinfo': 'postgres://admin:SuperSecret123@db.internal/x',
    'credential-assignment': 'password=Hunter22secret',
    'bearer-token': 'Authorization: Bearer abcdef1234567890xyz',
    'connection-string': 'redis://user:pass1234@cache:6379',
  };
  for (const [name, text] of Object.entries(fixtures)) {
    const scan = scanSecrets(text);
    assert.equal(scan.blocked, true, `${name} should block`);
    assert.ok(scan.reasons.includes(name), `${name} reason missing`);
  }
});

test('clean text passes without reasons', () => {
  const scan = scanSecrets('The build cache lives in D:\\cache and the port is 3080.');
  assert.equal(scan.blocked, false);
  assert.equal(scan.reasons.length, 0);
});

test('near-miss fixtures are NOT blocked (no false-positive over-block)', () => {
  const nearMisses = [
    'the token=abc placeholder in the docs', // short value, below the 6-char floor
    'AKIA123 is not a real key id', // AWS ids are AKIA + 16
    'the query string ?api_key=abc is a stub',
    'sk-abc is a truncated example', // sk- keys need 16+ chars
    'ghp_123 is not a GitHub token',
    'Bearer abc is a placeholder header',
    'postgres://localhost:5432/mydb has no userinfo', // no user:pass@
    'https://example.com/docs/api_key=abc', // short value in a URL
    'base64 payload c2VjcmV0LXZhbHVl is not a JWT', // no two dots / eyJ shape
    'password: "x" and secret: "y" are single-char stubs',
  ];
  for (const text of nearMisses) {
    const scan = scanSecrets(text);
    assert.equal(scan.blocked, false, `near-miss must pass: ${text}`);
    assert.equal(scan.reasons.length, 0, `no reasons: ${text}`);
  }
});

test('audit reasons carry pattern names only, never matched content', () => {
  const scan = scanSecrets('AKIAIOSFODNN7EXAMPLE');
  assert.equal(scan.blocked, true);
  for (const r of scan.reasons) {
    assert.ok(!r.includes('AKIA'), 'reason must not contain the key');
  }
});

test('pii redact masks email and CN mobile numbers', () => {
  const out = redactPii('mail me at bob@example.com or 13812345678', 'redact');
  assert.ok(!out.text.includes('bob@example.com'));
  assert.ok(!out.text.includes('13812345678'));
  assert.ok(out.text.includes('mail me at'));
  assert.ok(out.hits.length >= 2);
});

test('pii off leaves text untouched', () => {
  const out = redactPii('bob@example.com', 'off');
  assert.equal(out.text, 'bob@example.com');
  assert.equal(out.hits.length, 0);
});

test('pii warn reports categories but does not mask (F17-4)', () => {
  const out = redactPii('call 13812345678 or bob@example.com', 'warn');
  assert.deepEqual(out.hits.sort(), ['cn-mobile', 'email'], 'both categories reported');
  assert.ok(out.text.includes('13812345678'), 'warn mode keeps the value verbatim');
  assert.ok(out.text.includes('bob@example.com'), 'warn mode keeps the email verbatim');
});

test('gateCandidate blocks the whole candidate on a rule deny keyword', () => {
  const res = gateCandidate('internal payroll details 薪资表', ['薪资'], 'off');
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes('薪资')));
});

test('gateCandidate applies redaction and reports category names', () => {
  const res = gateCandidate('contact bob@example.com', [], 'redact');
  assert.equal(res.ok, true);
  assert.ok(!res.text.includes('bob@example.com'));
  assert.ok(res.warnings.includes('email'));
});

test('gateCandidate blocks secrets over rules', () => {
  const res = gateCandidate('password=SuperSecret123', ['薪资'], 'off');
  assert.equal(res.ok, false);
  assert.ok(res.reasons.includes('credential-assignment'));
});
