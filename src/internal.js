// ---------------------------------------------------------------
// The answers kr-internal gives other services (TEAM-GUIDE section 4).
// Goals and Check-ins call it by direct Lambda invoke; there is no public route.
//
//   { action: 'countKeyResults', goalId }          -> { count }
//   { action: 'getGoalsProgress', goalIds: [...] } -> { progress: { <goalId>: 0..100 } }   unknown goal = 0
//   { action: 'getKeyResult', krId }               -> { found: true, userId, goalId, type, start, target, current, status }
//                                                     or { found: false }
// ---------------------------------------------------------------
const { goalProgress } = require('./rules');

const MAX_GOALS_PER_CALL = 100;   // a list page never has more; stops a huge request

async function handleInternal(event, { repo }) {
    switch (event?.action) {
        case 'countKeyResults': {
            if (typeof event.goalId !== 'string') return { error: 'BAD_REQUEST' };
            return { count: await repo.countByGoal(event.goalId) };
        }
        case 'getGoalsProgress': {
            const ids = event.goalIds;
            if (!Array.isArray(ids) || ids.length > MAX_GOALS_PER_CALL || ids.some((id) => typeof id !== 'string')) {
                return { error: 'BAD_REQUEST' };
            }
            const unique = [...new Set(ids)];
            const lists = await Promise.all(unique.map((id) => repo.listByGoal(id)));
            const progress = {};
            unique.forEach((id, i) => { progress[id] = goalProgress(lists[i]); });   // K6, 0 when it has none
            return { progress };
        }
        case 'getKeyResult': {
            if (typeof event.krId !== 'string') return { error: 'BAD_REQUEST' };
            const kr = await repo.getById(event.krId);
            if (!kr) return { found: false };
            const { userId, goalId, type, start, target, current, status } = kr;
            return { found: true, userId, goalId, type, start, target, current, status };
        }
        default:
            return { error: 'UNKNOWN_ACTION' };
    }
}

module.exports = { handleInternal };
