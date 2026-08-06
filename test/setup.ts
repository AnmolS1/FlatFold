// Seeds the D1 schema before every test. Without this, any test that
// touches env.DB fails with "no such table: users" — vitest-pool-workers
// gives each test isolated storage, so this has to be idempotent and cheap
// to re-run rather than a one-time global setup.
import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
// `?raw` is a Vite convention: embeds the file's contents as a string at
// build time, since the Workers runtime has no filesystem to read from.
import migration0001 from '../migrations/0001_init.sql?raw';
import migration0002 from '../migrations/0002_prekeys.sql?raw';
import migration0003 from '../migrations/0003_rate_limits.sql?raw';
import migration0004 from '../migrations/0004_push.sql?raw';
import migration0005 from '../migrations/0005_seal_token.sql?raw';
import migration0006 from '../migrations/0006_token_epoch.sql?raw';
import migration0007 from '../migrations/0007_apns.sql?raw';
import migration0008 from '../migrations/0008_recovery.sql?raw';
import migration0009 from '../migrations/0009_totp.sql?raw';
import migration0010 from '../migrations/0010_terms.sql?raw';

const migrationSql = [
	migration0001,
	migration0002,
	migration0003,
	migration0004,
	migration0005,
	migration0006,
	migration0007,
	migration0008,
	migration0009,
	migration0010,
].join('\n');

// D1Database.exec() treats each NEWLINE as a statement boundary (it does
// NOT parse multi-line statements or split on `;`) — so a pretty-printed
// CREATE TABLE has to be flattened to one line per statement first.
function toSingleLineStatements(sql: string): string[] {
	const withoutComments = sql
		.split('\n')
		.map((line) => line.replace(/--.*$/, ''))
		.join('\n');

	return withoutComments
		.split(';')
		.map((statement) => statement.replace(/\s+/g, ' ').trim())
		.filter((statement) => statement.length > 0);
}

beforeEach(async () => {
	for (const statement of toSingleLineStatements(migrationSql)) {
		try {
			await env.DB.exec(statement);
		} catch (err) {
			// The seed re-runs every migration each test. `CREATE TABLE IF NOT
			// EXISTS` is idempotent, but SQLite has no `ADD COLUMN IF NOT EXISTS`,
			// so an already-applied `ALTER TABLE ... ADD COLUMN` throws on re-run.
			// Swallow ONLY that; any other error is a real schema problem.
			if (!(err instanceof Error && /duplicate column name/.test(err.message))) throw err;
		}
	}
});
