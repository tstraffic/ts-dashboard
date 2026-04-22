/**
 * Centralised job number generation — J-XXXX format.
 * All routes (projects, jobs, opportunities) use this single function.
 */
const { getDb } = require('../db/database');

/**
 * Generate the next sequential job number in J-XXXX format.
 * Uses the job_code_sequence table for atomic increment.
 * @returns {string} e.g. "J-0015"
 */
function generateJobNumber() {
  const db = getDb();
  db.prepare('UPDATE job_code_sequence SET last_number = last_number + 1 WHERE id = 1').run();
  const seq = db.prepare('SELECT last_number FROM job_code_sequence WHERE id = 1').get();
  return 'J-' + String(seq.last_number).padStart(4, '0');
}

module.exports = { generateJobNumber };
