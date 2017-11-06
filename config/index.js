'use strict';

require('dotenv').config();
const OrientDB = require('orientjs');

const NODE_ENV = process.env.NODE_ENV;

// API
const config = {
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT || 10010,
  url: process.env.URL,
};
if (!config.url) {
  throw Error('Please set the URL environment variable to a URL like "http://www.foo.com:10010".');
}

// OrientDB
const orientDBConfig = {
  host: process.env.ORIENTDB_HOST,
  port: process.env.ORIENTDB_PORT,
  name: process.env.ORIENTDB_DB,
  username: process.env.ORIENTDB_USER,
  password: process.env.ORIENTDB_PASS,
  storage: (NODE_ENV === 'test') ? ('memory') : ('plocal'),
};
config.db = new OrientDB.ODatabase(orientDBConfig);

// Migrations
const migrationsDir = `${__dirname}/../migrations`;

config.migrationManager = new OrientDB.Migration.Manager({
  db: config.db,
  dir: migrationsDir,
});

module.exports = config;
