// ---------------------------------------------------------------
// Lambda: kr-internal. Called by Goals and Check-ins with a direct Lambda
// invoke, never through API Gateway, so there is no public route to it.
// IAM decides who may call it (goals-role and checkins-role).
// The three answers are in src/internal.js.
// ---------------------------------------------------------------
require('dotenv').config({ quiet: true });
const { createKeyResultsRepo } = require('../src/keyResultsRepo');
const { handleInternal } = require('../src/internal');

let repo;   // created once per container, reused while it is warm

module.exports.handler = async (event) => {
    repo = repo || createKeyResultsRepo();
    return handleInternal(event, { repo });
};
