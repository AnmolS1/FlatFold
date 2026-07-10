// Schema-drift guard: the /transparency page (driven by SERVER_STATE) must
// enumerate exactly the D1 schema that actually ships. If a migration adds,
// removes, or renames a table/column and SERVER_STATE isn't updated to match,
// THIS TEST FAILS — so the transparency page can't silently lie.
//
// (Verified to actually bite: adding a throwaway column to a migration
// without updating SERVER_STATE breaks this test — the revert-and-watch
// check from the M3 ordering work.)
import { describe, expect, it } from 'vitest';
import { SERVER_STATE } from '../src/data/serverState';
import migration0001 from '../migrations/0001_init.sql?raw';
import migration0002 from '../migrations/0002_prekeys.sql?raw';
import migration0003 from '../migrations/0003_rate_limits.sql?raw';
import migration0004 from '../migrations/0004_push.sql?raw';
import migration0005 from '../migrations/0005_seal_token.sql?raw';
import migration0006 from '../migrations/0006_token_epoch.sql?raw';

const ALL_MIGRATIONS = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006].join('\n');

// Extract { table -> [columns] } from CREATE TABLE statements. Deliberately
// simple (matches how the migrations are written), not a full SQL parser.
function parseSchema(sql: string): Map<string, string[]> {
	const withoutComments = sql
		.split('\n')
		.map((line) => line.replace(/--.*$/, ''))
		.join('\n');

	const tables = new Map<string, string[]>();
	const tableRe = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\)\s*;/gi;
	let match: RegExpExecArray | null;
	while ((match = tableRe.exec(withoutComments)) !== null) {
		const [, tableName, body] = match;
		const columns: string[] = [];
		// Split on TOP-LEVEL commas only — a comma inside `PRIMARY KEY (a, b)`
		// is not a column boundary.
		for (const rawLine of splitTopLevel(body)) {
			const line = rawLine.trim();
			if (!line) continue;
			// Skip table-level constraints, not column definitions.
			if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
			const col = /^(\w+)/.exec(line)?.[1];
			if (col) columns.push(col);
		}
		tables.set(tableName, columns);
	}

	// Also fold in `ALTER TABLE <t> ADD COLUMN <col> ...` — otherwise a column
	// added by a later migration would be invisible to the guard, and the
	// transparency page could omit it without failing the build.
	const alterRe = /ALTER TABLE (\w+)\s+ADD COLUMN\s+(\w+)/gi;
	let alter: RegExpExecArray | null;
	while ((alter = alterRe.exec(withoutComments)) !== null) {
		const [, tableName, column] = alter;
		const columns = tables.get(tableName);
		if (columns) columns.push(column);
	}

	return tables;
}

function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of body) {
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) parts.push(current);
	return parts;
}

describe('transparency page ↔ D1 schema (drift guard)', () => {
	const schema = parseSchema(ALL_MIGRATIONS);
	const documentedD1 = SERVER_STATE.filter((s) => s.storage === 'D1' && s.driftChecked);

	it('documents exactly the set of D1 tables that the migrations create', () => {
		const inSchema = [...schema.keys()].sort();
		const documented = documentedD1.map((s) => s.name).sort();
		expect(documented).toEqual(inSchema);
	});

	for (const store of SERVER_STATE.filter((s) => s.storage === 'D1' && s.driftChecked)) {
		it(`documents exactly the columns of \`${store.name}\``, () => {
			const schemaColumns = (schema.get(store.name) ?? []).sort();
			const documentedColumns = store.fields.map((f) => f.name).sort();
			expect(documentedColumns).toEqual(schemaColumns);
		});
	}
});
