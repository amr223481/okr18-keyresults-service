// ---------------------------------------------------------------
// Key Results business rules (K1 to K8).
// Pure functions: no database, no network, no clock of their own.
// Everything they need is passed in, so each rule can be tested alone.
// ---------------------------------------------------------------

// What a key result measures
const TYPES = Object.freeze(['number', 'percentage', 'milestone']);

// A key result's own status (the goal has its own, in the Goals service)
const KR_STATUS = Object.freeze({
    OPEN: 'Open',            // still being worked on
    COMPLETED: 'Completed',  // current has reached the target (K7)
    FROZEN: 'Frozen'         // its goal was abandoned: check-ins are ignored (K8)
});

// K2: at most this many key results per goal
const MAX_PER_GOAL = 5;

// K4: key results may only be written while their goal is in one of these states
const WRITABLE_GOAL_STATUSES = Object.freeze(['Draft', 'Active']);

const MAX_ABS = 1e9;    // K1: keeps numbers sane (no 1e308 tricks)

const pass = () => ({ ok: true });
const fail = (status, code, message) => ({ ok: false, status, code, message });

// ---- K3: progress of one key result ----
// Works whether the target goes up (read 0 -> 12 books) or down (weight 90 -> 80 kg):
// (current - start) / (target - start) is the share of the distance already covered.
function krProgress({ start, target, current }) {
    const span = target - start;
    if (span === 0) return 0;                       // cannot happen after K1, but never divide by 0
    const share = ((current - start) / span) * 100;
    return round1(clamp(share, 0, 100));
}

// ---- K6: progress of a goal = weighted average of its key results ----
function goalProgress(keyResults) {
    const totalWeight = keyResults.reduce((n, kr) => n + (kr.weight || 1), 0);
    if (totalWeight === 0) return 0;
    const sum = keyResults.reduce((n, kr) => n + krProgress(kr) * (kr.weight || 1), 0);
    return round1(sum / totalWeight);
}

// ---- K2: how many key results a goal may have ----
function canAdd(existingCount) {
    return existingCount < MAX_PER_GOAL
        ? pass()
        : fail(409, 'KR_LIMIT', `A goal can have at most ${MAX_PER_GOAL} key results.`);
}

// ---- K4: the parent goal must be the caller's, and still open for changes ----
// goal = answer of goals-internal getGoalStatus: { found, userId, status }
function checkParentGoal(goal, userId) {
    if (!goal || !goal.found || goal.userId !== userId) {
        // Someone else's goal looks exactly like a goal that does not exist
        return fail(404, 'GOAL_NOT_FOUND', 'Goal not found.');
    }
    if (!WRITABLE_GOAL_STATUSES.includes(goal.status)) {
        return fail(409, 'GOAL_LOCKED', `Key results can only change while the goal is Draft or Active (it is ${goal.status}).`);
    }
    return pass();
}

// ---- K5: once the goal is Active, the goalposts are fixed ----
// Draft: everything can change. Active: only the title.
const LOCKED_WHEN_ACTIVE = Object.freeze(['type', 'unit', 'start', 'target', 'weight']);
function checkEdit(goalStatus, changes) {
    if (goalStatus === 'Draft') return pass();
    const locked = Object.keys(changes).filter((k) => LOCKED_WHEN_ACTIVE.includes(k));
    return locked.length === 0
        ? pass()
        : fail(409, 'KR_LOCKED', `The goal is ${goalStatus}: ${locked.join(', ')} can no longer change. Only the title can.`);
}

// ---- K2 + K5: deleting ----
// Draft: any key result. Active: only one with no progress yet, and never the last one
// (an Active goal must keep something to measure, rule G2 in Goals).
function checkDelete(goalStatus, kr, countForGoal) {
    if (goalStatus === 'Draft') return pass();
    if (countForGoal <= 1) {
        return fail(409, 'LAST_KEY_RESULT', 'An active goal must keep at least one key result.');
    }
    if (kr.current !== kr.start) {
        return fail(409, 'KR_LOCKED', 'This key result already has progress, so it cannot be deleted while the goal is active.');
    }
    return pass();
}

// ---- K7: status after current changes ----
function statusAfterUpdate(kr) {
    if (kr.status === KR_STATUS.FROZEN) return KR_STATUS.FROZEN;
    return krProgress(kr) >= 100 ? KR_STATUS.COMPLETED : KR_STATUS.OPEN;
}

// K7: kr.completed is announced only the first time a key result reaches its target
function shouldAnnounceCompleted(before, after) {
    return after.status === KR_STATUS.COMPLETED && before.status !== KR_STATUS.COMPLETED && !before.completionAnnounced;
}

// ---- small helpers ----
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function round1(n) { return Math.round(n * 10) / 10; }

module.exports = {
    TYPES,
    KR_STATUS,
    MAX_PER_GOAL,
    MAX_ABS,
    WRITABLE_GOAL_STATUSES,
    LOCKED_WHEN_ACTIVE,
    krProgress,
    goalProgress,
    canAdd,
    checkParentGoal,
    checkEdit,
    checkDelete,
    statusAfterUpdate,
    shouldAnnounceCompleted
};
