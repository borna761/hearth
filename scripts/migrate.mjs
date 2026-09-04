#!/usr/bin/env node
// Applies pending Drizzle migrations to the live database. Run on the Pi before
// (re)starting the app — see deploy/hearth.service's ExecStartPre and scripts/deploy.sh.
//
// Deliberately plain JS with no build step: drizzle-kit (the codegen CLI) is a
// devDependency and never ships to the Pi, but drizzle-orm's runtime migrator is a
// production dependency and can replay the *.sql files already generated into drizzle/.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
const MIGRATIONS_FOLDER = path.join(__dirname, '..', 'drizzle');

const sqlite = new Database(DATABASE_URL);
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
console.log(`migrated ${DATABASE_URL} using ${MIGRATIONS_FOLDER}`);
sqlite.close();
