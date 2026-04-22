// Centralised job number generation — J-XXXX format.
// All routes (projects, jobs, opportunities) use this single function.

// db/database.js is still plain JS and has no type declarations. Cast the
// bound methods through `unknown` so strict null checks don't reject the
// SQLite return shape until better-sqlite3's own types are hooked up in a
// later migration step.
const { getDb } = require('../db/database') as {
  getDb: () => {
    prepare: (sql: string) => {
      run: (...params: unknown[]) => { changes: number };
      get: (...params: unknown[]) => unknown;
    };
  };
};

/**
 * Generate the next sequential job number in J-XXXX format.
 * Uses the job_code_sequence table for atomic increment.
 */
export function generateJobNumber(): string {
  const db = getDb();
  db.prepare('UPDATE job_code_sequence SET last_number = last_number + 1 WHERE id = 1').run();
  const seq = db.prepare('SELECT last_number FROM job_code_sequence WHERE id = 1').get() as
    | { last_number: number }
    | undefined;
  const n = seq ? seq.last_number : 0;
  return 'J-' + String(n).padStart(4, '0');
}

// CommonJS interop for existing `require('../lib/jobNumbers')` callsites.
module.exports = { generateJobNumber };
