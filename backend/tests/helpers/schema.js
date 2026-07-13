// Loads the real schema for pg-mem.
// A couple of statements use Postgres features pg-mem does not model, so they are stripped
// here rather than kept out of the schema file. Both are covered against real Postgres.

const fs = require('fs');
const path = require('path');

const SCHEMA = path.join(__dirname, '../../src/infra/schema.sql');

function loadSchema() {
    return fs.readFileSync(SCHEMA, 'utf8')
        // no row level security in pg-mem
        .replace(/ALTER TABLE[^;]*ENABLE ROW LEVEL SECURITY;/gi, '')
        // no full text search either, so the GIN index over to_tsvector will not parse
        .replace(/CREATE INDEX[^;]*USING GIN[^;]*;/gi, '');
}

module.exports = { loadSchema };
