// The four runtime SECRETS this Worker reads off `env`. They are set in
// production via `wrangler secret put …` and locally via `.dev.vars`
// (gitignored) — deliberately NOT in wrangler.jsonc's `vars`, so they never
// enter git (see the note there).
//
// `wrangler types` only adds them to the generated types when it can see
// `.dev.vars`. That's true locally but NOT in CI or a fresh clone, where
// `postinstall`'s `wrangler types` runs with no `.dev.vars` and emits an `Env`
// missing these four — making `tsc -b` fail (it did, the first time CI ran on
// prod). Declaring them here (tracked, ambient) merges them into the generated
// base `__BaseEnv_Env`, which BOTH the global `Env` and `Cloudflare.Env` extend,
// so the two stay in sync and the typecheck is hermetic — no dependency on
// `.dev.vars` or any Cloudflare credentials.
//
// `__BaseEnv_Env` is wrangler's generated base interface. If a future wrangler
// renames it this merge stops taking effect and `tsc` fails again in CI —
// which is self-correcting: fix the name here. Keep this list in sync with the
// secrets documented in wrangler.jsonc.
interface __BaseEnv_Env {
	SESSION_SECRET: string;
	VAPID_PRIVATE_JWK: string;
	SEAL_GATEWAY_PRIVATE_KEY: string;
	SEAL_RELAY_AUTH: string;
}
