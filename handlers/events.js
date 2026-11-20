// ---------------------------------------------------------------
// Lambda: kr-events. Reads the kr-inbox SQS queue (check-in and goal events).
// Returns the ids of messages that failed, so only those are tried again.
// ---------------------------------------------------------------
require('dotenv').config({ quiet: true });
const { createKeyResultsRepo } = require('../src/keyResultsRepo');
const { createEvents } = require('../src/events');
const { createEventHandlers } = require('../src/eventHandlers');

let handlers;   // created once per container, reused while it is warm

module.exports.handler = async (sqsEvent) => {
    handlers = handlers || createEventHandlers({ repo: createKeyResultsRepo(), events: createEvents() });
    return handlers.handleBatch(sqsEvent);
};
