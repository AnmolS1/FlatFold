# FlatFold

An end-to-end encrypted messenger that runs in your browser and keeps almost nothing on the server.

FlatFold started as a small chat app so my family could reach my sisters after their school banned phones. This is that idea taken seriously: a private messenger anyone can sign up for, built so that the honest answer to "what does the server know about your messages?" is short, and you can check it yourself. Messages are encrypted on your device with the actual Signal protocol. The server is a dumb relay that only ever handles ciphertext, holds it just long enough to deliver it, then forgets it. If someone shows up with a subpoena, there's very little to hand over: a username, a signup date, some public keys, and whatever encrypted blobs happen to be waiting for an offline device.

It's live at [flatfold.ponderance.dev](https://flatfold.ponderance.dev).

## The honest version

FlatFold runs in a browser, which means the same server that carries your encrypted messages also hands you the JavaScript that does the encrypting. A compromised or compelled server could hand you bad code instead, and you'd have no easy way to know. No web app fully escapes this, and I'm not going to pretend otherwise. I do what I can about it (a strict Content Security Policy, an integrity-pinned service worker, a build you can reproduce and check), and I wrote down exactly what that does and doesn't protect. If your adversary is the server itself, use something you can verify on your own machine.

Two documents say the rest, plainly: the [threat model](./docs/THREAT_MODEL.md), and the in-app [/transparency page](https://flatfold.ponderance.dev/transparency) that lists every field the server stores and what a legal request could actually pull from it.

## What it does

- 1:1 and small-group messaging, end-to-end encrypted
- accounts with just a username and a password, no phone number and no email
- disappearing messages, set per conversation
- encrypted images, files, and voice notes
- safety-number verification (digit blocks and QR), with a loud warning if a contact's key ever changes
- sealed sender, which hides who you're talking to on top of what you say
- local-only search over your history that never leaves the device
- an installable PWA with content-free push (the notification carries no message text and no sender)
- a panic wipe that clears everything on the device, fast, even while locked

## How the encryption works

The crypto is the real Signal machinery, built on audited primitives (`@noble/*`, `@hpke/core`) rather than anything I hand-rolled: X3DH to start a conversation, the Double Ratchet with header encryption to keep it going, and sender keys for groups, where every message is signed per sender so no member can forge as another. Sealed sender routes a message through an OHTTP relay run by a different company, so no single party ever sees both your IP and your message.

The server is a Cloudflare Worker with a Durable Object "mailbox" per user. It stores only what it needs to move ciphertext: usernames, public keys, and envelopes for offline recipients (deleted on delivery, and after 14 days no matter what). It never holds a private key. The full accounting is in the [threat model](./docs/THREAT_MODEL.md).

## Running it locally

```sh
npm install
npx wrangler d1 migrations apply DB --local   # set up the local database once
npm run dev
```

`npm run dev` serves the React client and runs the Worker, Durable Objects, and D1 locally via `workerd`, so no Cloudflare account is needed. Open http://localhost:5173, sign up, add a contact by their exact username, and message them.

(`npm install` runs `wrangler types` to generate `worker-configuration.d.ts`. It's gitignored but has to exist before the Worker typechecks; re-run `npm run cf-typegen` after editing `wrangler.jsonc`.)

Other scripts:

```sh
npm test      # vitest: crypto, worker, and integration tests
npm run lint  # eslint
npm run build # tsc + vite build + the service-worker integrity manifest
```

## Deploying

FlatFold is one Worker with static assets, served only at its custom domain. With the Cloudflare resources created (a D1 database, an R2 bucket, the Mailbox Durable Object) and secrets set via `npx wrangler secret put`:

```sh
npm run build && npx wrangler deploy
```

The CSP and other security headers live in `public/_headers` and are enforced on the deployed site, not under `vite dev`, so validate any security change against `vite preview` or the live site (`curl -I https://flatfold.ponderance.dev`).

## Built with

React, TypeScript, and Vite on the client; Cloudflare Workers, Durable Objects, D1, and R2 on the server. No runtime CDN, self-hosted fonts, no third-party trackers.

## Security

Found something? See [SECURITY.md](./SECURITY.md): email security@flatfold.ponderance.dev, and please don't file a public issue for anything sensitive until it's fixed. The [threat model](./docs/THREAT_MODEL.md) lists the residuals I already know about, so those aren't findings.

## License

[AGPL-3.0](./LICENSE). It's a privacy tool, so the license is the strong-copyleft kind: if you run a modified version as a service, you have to publish your source. Nobody gets to take this, quietly weaken the privacy, and ship it closed.

---

Built by [Anmol](https://ponderance.dev), part of [ponderance.dev](https://ponderance.dev).
