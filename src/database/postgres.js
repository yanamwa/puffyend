import "dotenv/config";
import pg from "pg";
import fs from "node:fs/promises";

export function postgresConfig(env = process.env) {
  const schema = env.DB_SCHEMA || "puffybrain";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error("DB_SCHEMA must be a lowercase PostgreSQL schema name.");
  const connectionString = env.DATABASE_URL || env.SUPABASE_DB_URL;
  if (env.NODE_ENV === "production" && !connectionString)
    throw new Error(
      "Set DATABASE_URL to the Supabase PostgreSQL session-pooler connection string.",
    );
  let url;
  try {
    url = new URL(
      connectionString ||
        "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    );
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid PostgreSQL connection string.",
    );
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error(
      "DATABASE_URL must be a PostgreSQL connection string, not a Supabase API URL.",
    );
  if (url.hostname.endsWith("pooler.supabase.com") && url.port === "6543")
    throw new Error(
      "Use the Supabase session pooler (port 5432), not the transaction pooler: background jobs use session advisory locks.",
    );
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname,
  );
  // Explicit TLS options avoid connection-string parameters overriding verification.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ssl:
      local && env.NODE_ENV !== "production"
        ? false
        : {
            rejectUnauthorized: true,
            ...(env.DB_SSL_CA
              ? { ca: env.DB_SSL_CA.replace(/\\n/g, "\n") }
              : {}),
          },
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    options: `-c search_path=${schema},public -c timezone=UTC`,
    types: {
      getTypeParser(oid, format) {
        if (format !== "binary" && oid === 1114)
          return (value) => new Date(value.replace(" ", "T") + "Z");
        if (format !== "binary" && oid === 20)
          return (value) =>
            Number.isSafeInteger(Number(value)) ? Number(value) : value;
        return pg.types.getTypeParser(oid, format);
      },
    },
    schema,
  };
}

// Keep existing service method signatures and API response keys while using
// native PostgreSQL SQL and bound parameters throughout the application.
export function bindParameters(sql, values = []) {
  let index = 0;
  let bound = 0;
  const parameters = [];
  const tokens =
    /'(?:''|[^'])*'|"(?:""|[^"])*"|\$([A-Za-z_][\w]*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\/|\?/g;
  const text = sql.replace(tokens, (token) => {
    if (token !== "?") return token;
    if (index >= values.length)
      throw new Error("Missing database query parameter.");
    const value = values[index++];
    parameters.push(
      value === undefined
        ? null
        : Array.isArray(value)
          ? JSON.stringify(value)
          : value,
    );
    return `$${++bound}`;
  });
  if (index !== values.length)
    throw new Error("Unexpected database query parameters.");
  return { text, values: parameters };
}

function normalizeRow(row) {
  const mapped = { ...row };
  for (const [key, value] of Object.entries(mapped))
    if (value instanceof Uint8Array && !Buffer.isBuffer(value))
      mapped[key] = Buffer.from(value);
  if ("userid" in mapped) {
    mapped.userId = mapped.userid;
    delete mapped.userid;
  }
  for (const key of ["column_name", "table_name", "constraint_name"])
    if (key in mapped) {
      mapped[key.toUpperCase()] = mapped[key];
      delete mapped[key];
    }
  return mapped;
}

export function createDatabase(pool) {
  const primaryKeys = new Map();
  function wrap(client, release = () => {}) {
    async function execute(sql, values = []) {
      // Preserve explicit camelCase aliases used by the existing frontend.
      sql = sql.replace(
        /\bAS\s+([a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*)\b/g,
        'AS "$1"',
      );
      const insert = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(sql);
      if (insert && !/\bRETURNING\b/i.test(sql))
        sql = sql.trim().replace(/;$/, "") + " RETURNING *";
      const query = bindParameters(sql, values);
      const result = await client.query(query.text, query.values);
      if (/^\s*(SELECT|WITH)\b/i.test(sql))
        return [result.rows.map(normalizeRow), result.fields];
      let insertId = 0;
      if (insert && result.rows?.length) {
        const table = insert[1].toLowerCase();
        if (!primaryKeys.has(table)) {
          const keys = await client.query(
            `SELECT a.attname FROM pg_index i
            JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
            JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
            WHERE i.indisprimary AND n.nspname=current_schema() AND t.relname=$1`,
            [table],
          );
          primaryKeys.set(table, keys.rows[0]?.attname);
        }
        insertId = result.rows[0][primaryKeys.get(table)] ?? 0;
      }
      return [
        { insertId, affectedRows: result.rowCount ?? result.affectedRows ?? 0 },
        result.fields,
      ];
    }
    return {
      execute,
      query: execute,
      beginTransaction: () => client.query("BEGIN"),
      commit: () => client.query("COMMIT"),
      rollback: () => client.query("ROLLBACK"),
      release,
    };
  }
  return {
    ...wrap(pool),
    async getConnection() {
      const client = await pool.connect();
      return wrap(client, () => client.release());
    },
    end: () => pool.end(),
  };
}

const config = postgresConfig();
export const pgPool = new pg.Pool(config);
pgPool.on("error", (error) =>
  console.error(
    "Idle PostgreSQL connection failed:",
    error.code || "connection error",
  ),
);
export const db = createDatabase(pgPool);

export async function initializeDatabase() {
  const [schemas] = await db.execute(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name=?",
    [config.schema],
  );
  if (!schemas.length)
    throw new Error(
      `Schema ${config.schema} does not exist. Set DB_SCHEMA to the schema containing your imported tables.`,
    );
  const [userColumns] = await db.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name='users' AND column_name IN ('userId','userid')",
    [config.schema],
  );
  if (
    userColumns.some((row) => row.COLUMN_NAME === "userId") &&
    !userColumns.some((row) => row.COLUMN_NAME === "userid")
  )
    await db.execute('ALTER TABLE users RENAME COLUMN "userId" TO userid');
  // pgloader commonly converts MySQL TINYINT(1) flags into booleans.
  // Retain the numeric flags expected by existing authorization and UI code.
  const [flags] = await db.execute(
    `SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema=? AND data_type='boolean' AND column_name IN
    ('onboarding_completed','is_archived','must_change_password','is_temporary','is_verified','archived','has_quiz','published','is_read')`,
    [config.schema],
  );
  for (const flag of flags) {
    const table = quoteIdentifier(flag.TABLE_NAME),
      column = quoteIdentifier(flag.COLUMN_NAME);
    await db.execute(
      `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`,
    );
    await db.execute(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE SMALLINT USING CASE WHEN ${column} IS NULL THEN NULL WHEN ${column} THEN 1 ELSE 0 END`,
    );
    await db.execute(
      `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT 0`,
    );
  }
  const [settings] = await db.execute(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=?
    AND table_name='system_settings' AND data_type IN ('smallint','integer') AND column_name IN
    ('maintenance_mode','require_password_change','professor_approval','practice_quiz_enabled','main_quiz_enabled',
    'record_practice_quiz','record_main_quiz','adaptive_quiz_enabled','quiz_analysis_enabled','enrollment_approval',
    'enrollment_accepted_email','enrollment_declined_email','enrollment_system_notification','professor_approval_notification','announcements_enabled')`,
    [config.schema],
  );
  for (const row of settings) {
    const name = quoteIdentifier(row.COLUMN_NAME);
    await db.execute(
      `ALTER TABLE system_settings ALTER COLUMN ${name} DROP DEFAULT`,
    );
    await db.execute(
      `ALTER TABLE system_settings ALTER COLUMN ${name} TYPE BOOLEAN USING (${name} <> 0)`,
    );
    await db.execute(
      `ALTER TABLE system_settings ALTER COLUMN ${name} SET DEFAULT ${row.COLUMN_NAME === "maintenance_mode" ? "FALSE" : "TRUE"}`,
    );
  }
}

export function quoteIdentifier(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export async function migrateLessonTables(database = db) {
  for (const name of [
    "create_system_tables.sql",
    "create_lesson_rag_tables.sql",
    "create_lesson_rag_jobs.sql",
    "create_lesson_rag_batch_tables.sql",
    "create_postgres_indexes.sql",
  ]) {
    const sql = await fs.readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await database.query(statement);
  }
}

export async function finalizeDatabase(database = db) {
  // PostgreSQL has no ON UPDATE CURRENT_TIMESTAMP column clause.
  await database.query(`CREATE OR REPLACE FUNCTION puffy_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END $$`);
  const [tables] =
    await database.query(`SELECT table_name FROM information_schema.columns
    WHERE table_schema=CURRENT_SCHEMA() AND column_name='updated_at'`);
  for (const table of tables) {
    const name = quoteIdentifier(table.TABLE_NAME);
    await database.query(`CREATE OR REPLACE TRIGGER puffy_updated_at BEFORE UPDATE ON ${name}
      FOR EACH ROW EXECUTE FUNCTION puffy_touch_updated_at()`);
  }
}
