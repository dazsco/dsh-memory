/**
 * The compliance gate: nothing containing a credential ever reaches a card or
 * the inbox. This is the load-bearing privacy rule of the whole system —
 * fail closed, block the ENTIRE candidate, and report only pattern NAMES in
 * the audit log (never matched content).
 */

export interface SecretScan {
  blocked: boolean;
  /** Pattern names only — deliberately no matched content. */
  reasons: string[];
}

interface SecretPattern {
  name: string;
  re: RegExp;
}

/** Built-in credential patterns. Not overridable by rules; rules can only add. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'private-key-pem', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
  { name: 'url-userinfo', re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]{1,64}:[^/\s@]{4,}@[^\s"'`]*/ },
  {
    name: 'credential-assignment',
    re: /\b(?:password|passwd|pwd|secret|token|api_?key|access_?key|auth_?key|private_?key|client_?secret)\b\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  },
  { name: 'bearer-token', re: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: 'connection-string', re: /\b(?:mongodb(?:\+srv)?|postgres|postgresql|mysql|redis|amqp):\/\/[^/\s:@]{1,64}:[^/\s@]{4,}@/i },
];

/** Scan text for credential patterns. Blocks the whole candidate on any hit. */
export function scanSecrets(text: string): SecretScan {
  const reasons: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) reasons.push(p.name);
  }
  return { blocked: reasons.length > 0, reasons };
}

/** PII (email / CN mobile / CN id number). Optional redaction layer. */
const PII_PATTERNS: readonly { name: string; base: string; mark: string }[] = [
  { name: 'email', base: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', mark: '[REDACTED-EMAIL]' },
  { name: 'cn-mobile', base: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', mark: '[REDACTED-PHONE]' },
  { name: 'cn-id', base: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', mark: '[REDACTED-ID]' },
];

export type PiiMode = 'off' | 'warn' | 'redact';

export interface PiiResult {
  text: string;
  /** Names of the PII categories detected (no content). */
  hits: string[];
}

/** Apply the configured PII policy to one candidate. */
export function redactPii(text: string, mode: PiiMode): PiiResult {
  if (mode === 'off') return { text, hits: [] };
  const hits: string[] = [];
  let out = text;
  for (const p of PII_PATTERNS) {
    const probe = new RegExp(p.base);
    if (!probe.test(out)) continue;
    hits.push(p.name);
    if (mode === 'redact') {
      out = out.replace(new RegExp(p.base, 'g'), p.mark);
    }
  }
  return { text: out, hits };
}

/**
 * Full policy gate for one candidate. Order: secrets (block, audit names) →
 * rules deny keywords (block) → PII policy (redact/warn).
 * @param denyKeywords substring rules from AGENTS.md Memory sections.
 */
export function gateCandidate(
  text: string,
  denyKeywords: string[],
  piiMode: PiiMode,
): { ok: true; text: string; warnings: string[] } | { ok: false; reasons: string[] } {
  const secrets = scanSecrets(text);
  if (secrets.blocked) return { ok: false, reasons: secrets.reasons };

  const lowered = text.toLowerCase();
  const denied = denyKeywords.filter((kw) => {
    const k = kw.trim().toLowerCase();
    return k.length > 0 && lowered.includes(k);
  });
  if (denied.length > 0) return { ok: false, reasons: denied.map((d) => `rule:never:${d}`) };

  const pii = redactPii(text, piiMode);
  return { ok: true, text: pii.text, warnings: pii.hits };
}
