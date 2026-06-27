# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities by email to **security@bymax.one**. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Affected versions
- Any suggested mitigations or patches (optional but welcome)

We follow a **90-day coordinated-disclosure policy**:

1. We acknowledge receipt within 3 business days.
2. We investigate and aim to produce a fix within 30 days for critical issues,
   and within 90 days for all other confirmed vulnerabilities.
3. We notify you when a fix is ready and coordinate a disclosure date before
   publishing a security advisory.

If you do not receive acknowledgement within 5 business days, please follow up
by email.

---

## Supported Versions

| Version | Support |
|---|---|
| `0.1.x` | Active — security fixes applied |
| `< 0.1.0` | Pre-release — no support |

---

## Scope

### In scope

- Runtime vulnerabilities in `@bymax-one/nest-queue` library code
- Vulnerabilities in the bundled (non-peer) code shipped in `dist/`
- Supply-chain issues in the release pipeline (OIDC provenance, SHA-pinned actions)
- Improper handling of connection credentials or job data

### Out of scope

- Vulnerabilities in peer dependencies (`bullmq`, `ioredis`, `@nestjs/*`,
  `reflect-metadata`, `bullmq-otel`) — report those upstream to their maintainers
- Vulnerabilities that require direct access to the Redis instance
- Issues in the `examples/` directory (demonstration code, not published)

---

## Supply-Chain Security

This package is published to npm with **OIDC provenance attestation** (Trusted Publishing).
Each release can be verified:

```bash
npm audit signatures @bymax-one/nest-queue
```

The release pipeline enforces:

- SHA-pinned GitHub Actions (Pinned-Dependencies Scorecard check)
- Least-privilege workflow permissions
- TruffleHog OSS secret scanning on every push
- OSV-Scanner dependency advisory scanning
- OpenSSF Scorecard transparency (target ≥ 7.0)

See the [OpenSSF Scorecard report](https://securityscorecards.dev/viewer/?uri=github.com/bymaxone/nest-queue)
for the current posture.

---

## Disclosure Policy

We follow the principle of coordinated disclosure. We ask reporters not to:

- Publish details of the vulnerability before a fix is available
- Exploit the vulnerability beyond what is necessary for proof-of-concept
- Perform tests on production systems operated by third parties

We will credit reporters in the security advisory unless they prefer to remain
anonymous.
