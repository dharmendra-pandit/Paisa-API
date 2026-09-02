/* eslint-disable no-undef */
/**
 * Creates the least-privilege application user.
 *
 * The official mongo image runs every .js in /docker-entrypoint-initdb.d exactly
 * once — on first boot, when the data directory is empty. It is a no-op on every
 * subsequent start, so re-deploying never disturbs an existing database.
 *
 * The point of this file is that the API must NOT connect as root. The root
 * credentials can drop databases, read every collection and create users; the
 * application only ever needs readWrite on its own database. If the API is ever
 * compromised — a dependency, an injection, a leaked env file — the blast radius
 * should be "this app's data", not "the entire MongoDB instance".
 *
 * Credentials come from the environment so nothing secret is committed here.
 */

const dbName = process.env.PAISA_DB_NAME || 'paisa';
const user = process.env.PAISA_DB_USER;
const password = process.env.PAISA_DB_PASSWORD;

if (!user || !password) {
  throw new Error('PAISA_DB_USER and PAISA_DB_PASSWORD must be set for the init script');
}

const appDb = db.getSiblingDB(dbName);

appDb.createUser({
  user,
  pwd: password,
  roles: [{ role: 'readWrite', db: dbName }],
});

print(`[paisa] created application user "${user}" with readWrite on "${dbName}"`);

/**
 * Seed a marker collection so the database is non-empty and the healthcheck has
 * something to read. Real indexes are created by `npm run indexes:sync` as an
 * explicit deploy step — see src/scripts/syncIndexes.js for why that is not
 * done at application boot.
 */
appDb.createCollection('_deploy_meta');
appDb.getCollection('_deploy_meta').insertOne({
  initialisedAt: new Date(),
  note: 'Created by deploy/mongo-init.js on first boot. Indexes are built by npm run indexes:sync.',
});

print('[paisa] database initialised');
