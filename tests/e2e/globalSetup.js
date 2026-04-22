// Runs once before any test. Wipes the test DB so every suite run starts
// from clean migrations + freshly-seeded admin user.

const { resetTestDb } = require('./helpers/setup');

module.exports = async () => {
  resetTestDb();
};
