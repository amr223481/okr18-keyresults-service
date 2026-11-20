// In-memory stand-ins for DynamoDB, the Goals service and SNS, with the same
// methods and the same conditional behaviour as the real ones.
function fakeRepo() {
    const rows = new Map();
    const copy = (x) => (x ? structuredClone(x) : null);
    const byGoal = (goalId) => [...rows.values()].filter((k) => k.goalId === goalId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
        rows,
        async create(kr) { if (rows.has(kr.krId)) throw new Error('exists'); rows.set(kr.krId, copy(kr)); return kr; },
        async getById(id) { return copy(rows.get(id)); },
        async getOwned(id, userId) { const k = rows.get(id); return k && k.userId === userId ? copy(k) : null; },
        async listByGoal(goalId) { return byGoal(goalId).map(copy); },
        async countByGoal(goalId) { return byGoal(goalId).length; },
        async updateFields(id, userId, fields, expectedUpdatedAt, nowIso) {
            const k = rows.get(id);
            if (!k || k.userId !== userId || k.updatedAt !== expectedUpdatedAt) return null;
            Object.assign(k, fields, { updatedAt: nowIso });
            return copy(k);
        },
        async setCurrent(id, { expectedCurrent, current, status, completionAnnounced, nowIso }) {
            const k = rows.get(id);
            if (!k || k.current !== expectedCurrent) return null;
            Object.assign(k, { current, status, completionAnnounced, updatedAt: nowIso });
            return copy(k);
        },
        async setStatus(id, status, nowIso) {
            const k = rows.get(id);
            if (!k) return null;
            Object.assign(k, { status, updatedAt: nowIso });
            return copy(k);
        },
        async remove(id, userId) {
            const k = rows.get(id);
            if (!k || k.userId !== userId) return false;
            rows.delete(id);
            return true;
        },
        async removeByGoal(goalId) { const list = byGoal(goalId); list.forEach((k) => rows.delete(k.krId)); return list.length; }
    };
}

// The Goals service as kr-internal sees it: goalId -> { userId, status }
function fakeGoals() {
    const state = { goals: {}, down: false };
    return {
        state,
        add(goalId, userId, status = 'Draft') { state.goals[goalId] = { userId, status }; },
        async getGoalStatus(goalId) {
            if (state.down) { const { DependencyError } = require('../src/goalsClient'); throw new DependencyError('Goals could not be reached (test).'); }
            const g = state.goals[goalId];
            return g ? { found: true, userId: g.userId, status: g.status, year: 2026 } : { found: false };
        }
    };
}

function fakeEvents() {
    const sent = [];
    return { sent, async publish(type, userId, data) { sent.push({ type, userId, data }); } };
}

// Token "token-<name>" belongs to user <name>; anything else is rejected
async function fakeVerify(token) {
    const m = /^token-(\w+)$/.exec(token);
    if (!m) throw new Error('bad token');
    return { sub: `user-${m[1]}`, 'cognito:groups': ['user'] };
}

module.exports = { fakeRepo, fakeGoals, fakeEvents, fakeVerify };
