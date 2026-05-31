# Security Policy

## Supported Versions

Security fixes are applied to the latest published `2.x` release line.

| Version | Supported |
| ------- | --------- |
| 2.x     | ✅        |
| 1.x     | ❌        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

This library implements security-sensitive protocols (DTLS 1.2, X.509
certificate generation, STUN/TURN message integrity). If you discover a
vulnerability — for example in the handshake, certificate handling, message
authentication, or any path that could lead to data disclosure or spoofing —
report it privately:

- Use GitHub's **["Report a vulnerability"](https://github.com/nmhung1210/node-rtc-connection/security/advisories/new)**
  (Security → Advisories) to open a private advisory, or
- Open a minimal public issue asking a maintainer to contact you, without
  disclosing details.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof of concept if possible).
- Affected version(s).

You can expect an initial acknowledgement within a few days. We will work with
you to understand and resolve the issue, and will credit you in the release
notes unless you prefer to remain anonymous.

## Scope notes

This is a from-scratch implementation of WebRTC's transport security. While it
is verified against external references (OpenSSL for DTLS, real browsers for
end-to-end interop), it has **not** undergone a formal third-party security
audit. Evaluate accordingly for high-assurance use cases.
