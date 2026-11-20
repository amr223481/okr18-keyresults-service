// ---------------------------------------------------------------
// Talks to the Goals service by direct Lambda invoke of goals-internal.
// Not over HTTP: goals-internal has no public route, and only roles that
// IAM allows (kr-role) can call it.
//
// Contract (TEAM-GUIDE section 4):
//   { action: 'getGoalStatus', goalId } -> { found, userId, status, year }
// ---------------------------------------------------------------
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

class DependencyError extends Error {
    constructor(message) { super(message); this.name = 'DependencyError'; }
}

function createGoalsClient({ functionName = process.env.GOALS_INTERNAL_FUNCTION, client } = {}) {
    if (!functionName) {
        // Allowed on a PC only, so Key Results can be tried without Goals deployed.
        // The stub says every goal is a Draft that belongs to whoever asks.
        if (process.env.NODE_ENV === 'production') throw new Error('GOALS_INTERNAL_FUNCTION is not set.');
        console.warn('GOALS_INTERNAL_FUNCTION not set: using a local stub (every goal is your own Draft).');
        return { getGoalStatus: async (goalId, { asUser } = {}) => ({ found: true, userId: asUser, status: 'Draft', year: new Date().getUTCFullYear() }) };
    }

    const lambda = client || new LambdaClient({});

    // asUser is only used by the PC stub above; the real Goals service decides the owner
    async function getGoalStatus(goalId) {
        let res;
        try {
            res = await lambda.send(new InvokeCommand({
                FunctionName: functionName,
                Payload: Buffer.from(JSON.stringify({ action: 'getGoalStatus', goalId }))
            }));
        } catch (error) {
            throw new DependencyError(`Goals could not be reached (${error.name}).`);
        }
        if (res.FunctionError) throw new DependencyError(`Goals failed (${res.FunctionError}).`);
        const out = JSON.parse(Buffer.from(res.Payload).toString('utf8'));
        if (out.error) throw new DependencyError(`Goals answered ${out.error}.`);
        return out;
    }

    return { getGoalStatus };
}

module.exports = { createGoalsClient, DependencyError };
