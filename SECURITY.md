# Security Policy

FlatFold is an end-to-end encrypted messenger. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Email **security@flatfold.ponderance.dev**. Please don't open a public issue for anything security-sensitive until it's fixed.

If you can, include:

- what the issue is and where (file, endpoint, or flow),
- how to reproduce it,
- what an attacker could actually do with it.

I'll acknowledge your report as quickly as I can, keep you updated while it's being worked on, and credit you when it's fixed if you'd like. This is a solo project, so response times are best-effort, not a paid SLA.

There's no bug-bounty program and no payout. What I can offer is a real fix and public credit.

## What's in scope

Anything that breaks one of the seven invariants in [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md), or that lets someone read messages, impersonate a user, take over an account, or learn more than the threat model says the server can learn. The crypto (`src/crypto/`), the keystore (`src/keystore/`), the worker (`worker/`), and the sealed-sender path are the parts most worth poking at.

## What's already known, and not a finding

Read [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) first. It states the residual risks plainly, and reporting one of them back to me isn't a vulnerability. The big ones:

- The server can see the **communication graph and timing** (who talks to whom, and when, coarsened to the minute), even though it can't read message content. Sealed sender narrows this; it doesn't remove it.
- FlatFold runs in a browser, so **the same server that relays your ciphertext also ships the code that encrypts it.** A compromised or compelled server could serve bad JavaScript. This is a structural limit of any web-delivered E2EE app; the threat model explains what does and doesn't mitigate it. If your threat model includes a hostile server, a client you can independently verify is the right tool.

## Supported versions

FlatFold is a single continuously-deployed app at https://flatfold.ponderance.dev. Fixes land on the deployed version; there are no separately-maintained release branches.
