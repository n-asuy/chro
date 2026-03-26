# Security Policy

We take the security of Chro seriously. If you believe you have found a vulnerability, please report it privately so we can investigate and remediate it before public disclosure.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security reports.

Send reports to `security@chro-ai.com` and include, where possible:

- A short summary of the issue and its potential impact
- The affected component, URL, binary, or package
- Steps to reproduce the issue
- A proof of concept, logs, screenshots, or payloads
- Version, commit, platform, and environment details

We will make a good-faith effort to:

- Acknowledge receipt within 5 business days
- Triage and investigate the report
- Contact you if we need clarification or retesting
- Coordinate disclosure after a fix or mitigation is available

## Scope

The following are generally in scope:

- First-party code in this repository
- Official Chro desktop, web, API, and browser extension code maintained here
- Official release artifacts published by the maintainers
- Official Chro-operated services and domains, including `chro-ai.com` and first-party `*.chro-ai.com` properties directly tied to this project

The following are generally out of scope:

- Social engineering, phishing, or physical attacks
- Denial-of-service, brute-force, or resource exhaustion attacks
- Vulnerabilities in third-party dependencies without a demonstrated impact on Chro
- Reports that require access to data you do not own or are not authorized to access
- Best-practice gaps without a concrete security impact

If you are unsure whether something is in scope, send the report first and we will clarify.

## Supported Versions

We prioritize fixes for:

- The latest code on `main`
- The latest public release artifacts
- Currently operated first-party hosted services

Older forks or unmaintained versions may not receive fixes.

## Disclosure Guidelines

Please give us a reasonable opportunity to investigate and remediate an issue before public disclosure.

When researching, do not:

- Access, modify, or destroy data that does not belong to you
- Exfiltrate secrets, tokens, or personal data
- Degrade availability for other users or systems

## Rewards

Chro does not currently operate a public bug bounty program. Responsible reports are still appreciated.
