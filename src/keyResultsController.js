// ---------------------------------------------------------------
// Key Results controller: reads the request, asks Goals about the parent
// goal, applies the rules, calls the data layer and chooses the HTTP answer.
// Dependencies are passed in (repo, goals, now) so tests can use fakes.
// ---------------------------------------------------------------
const { randomUUID } = require('crypto');
const {
    KR_STATUS, MAX_PER_GOAL, WRITABLE_GOAL_STATUSES,
    krProgress, goalProgress, canAdd, checkParentGoal, checkEdit, checkDelete
} = require('./rules');
const { validateNew, validateEdit, isGoalId, isKrId } = require('./validate');

function sendError(res, status, code, message, details) {
    return res.status(status).json({ error: details ? { code, message, details } : { code, message } });
}
const goalNotFound = (res) => sendError(res, 404, 'GOAL_NOT_FOUND', 'Goal not found.');
const krNotFound = (res) => sendError(res, 404, 'KR_NOT_FOUND', 'Key result not found.');
const conflict = (res) => sendError(res, 409, 'CONFLICT', 'The key result changed meanwhile. Reload and try again.');

// What the browser sees: the stored fields it needs plus the calculated progress (K3)
function toView(kr) {
    const { krId, goalId, title, type, unit, start, target, current, weight, status, createdAt, updatedAt } = kr;
    return { krId, goalId, title, type, unit, start, target, current, weight, status, progress: krProgress(kr), createdAt, updatedAt };
}

function createKeyResultsController({ repo, goals, now = () => new Date() }) {

    // Asks Goals for the parent goal (owner and status)
    const parentGoal = (goalId, userId) => goals.getGoalStatus(goalId, { asUser: userId });

    // POST /api/goals/:goalId/key-results
    async function create(req, res) {
        const { goalId } = req.params;
        if (!isGoalId(goalId)) return goalNotFound(res);

        const goal = await parentGoal(goalId, req.user.id);
        const parent = checkParentGoal(goal, req.user.id);                         // K4
        if (!parent.ok) return sendError(res, parent.status, parent.code, parent.message);

        const { errors, value } = validateNew(req.body);                            // K1
        if (errors) return sendError(res, 400, 'VALIDATION_ERROR', errors[0], errors);

        const limit = canAdd(await repo.countByGoal(goalId));                       // K2
        if (!limit.ok) return sendError(res, limit.status, limit.code, limit.message);

        const iso = now().toISOString();
        const kr = {
            krId: `KR-${randomUUID()}`,          // the server creates the id
            goalId,
            userId: req.user.id,                 // the owner comes from the token
            ...value,
            current: value.start,                // a new key result starts at its start value
            status: KR_STATUS.OPEN,
            completionAnnounced: false,
            createdAt: iso,
            updatedAt: iso
        };
        await repo.create(kr);

        // K2 again: two "add" clicks at the same moment could both see 4. Whoever made the 6th undoes it.
        if (await repo.countByGoal(goalId) > MAX_PER_GOAL) {
            await repo.remove(kr.krId, req.user.id);
            return sendError(res, 409, 'KR_LIMIT', `A goal can have at most ${MAX_PER_GOAL} key results.`);
        }
        return res.status(201).json(toView(kr));
    }

    // GET /api/goals/:goalId/key-results
    async function listForGoal(req, res) {
        const { goalId } = req.params;
        if (!isGoalId(goalId)) return goalNotFound(res);
        const goal = await parentGoal(goalId, req.user.id);
        if (!goal?.found || goal.userId !== req.user.id) return goalNotFound(res);   // read: owner only, any status

        const items = await repo.listByGoal(goalId);
        return res.status(200).json({
            goalId,
            goalStatus: goal.status,
            canChange: WRITABLE_GOAL_STATUSES.includes(goal.status),               // the panel shows or hides its buttons
            progress: goalProgress(items),                                         // K6
            maxKeyResults: MAX_PER_GOAL,
            keyResults: items.map(toView)
        });
    }

    // GET /api/key-results/:id
    async function getOne(req, res) {
        if (!isKrId(req.params.id)) return krNotFound(res);
        const kr = await repo.getOwned(req.params.id, req.user.id);
        if (!kr) return krNotFound(res);                                          // also for another user's
        return res.status(200).json(toView(kr));
    }

    // PATCH /api/key-results/:id
    async function edit(req, res) {
        if (!isKrId(req.params.id)) return krNotFound(res);
        const kr = await repo.getOwned(req.params.id, req.user.id);
        if (!kr) return krNotFound(res);

        const goal = await parentGoal(kr.goalId, req.user.id);
        const parent = checkParentGoal(goal, req.user.id);                         // K4
        if (!parent.ok) return sendError(res, parent.status, parent.code, parent.message);

        const { errors, changes } = validateEdit(req.body, kr);                     // K1
        if (errors) return sendError(res, 400, 'VALIDATION_ERROR', errors[0], errors);
        if (Object.keys(changes).length === 0) return res.status(200).json(toView(kr));

        const allowed = checkEdit(goal.status, changes);                            // K5
        if (!allowed.ok) return sendError(res, allowed.status, allowed.code, allowed.message);

        // In a Draft goal nobody has checked in yet, so a new start moves current with it
        if ('start' in changes) changes.current = changes.start;

        const updated = await repo.updateFields(kr.krId, req.user.id, changes, kr.updatedAt, now().toISOString());
        if (!updated) return conflict(res);
        return res.status(200).json(toView(updated));
    }

    // DELETE /api/key-results/:id
    async function remove(req, res) {
        if (!isKrId(req.params.id)) return krNotFound(res);
        const kr = await repo.getOwned(req.params.id, req.user.id);
        if (!kr) return krNotFound(res);

        const goal = await parentGoal(kr.goalId, req.user.id);
        const parent = checkParentGoal(goal, req.user.id);                         // K4
        if (!parent.ok) return sendError(res, parent.status, parent.code, parent.message);

        const allowed = checkDelete(goal.status, kr, await repo.countByGoal(kr.goalId));   // K2 + K5
        if (!allowed.ok) return sendError(res, allowed.status, allowed.code, allowed.message);

        if (!await repo.remove(kr.krId, req.user.id)) return krNotFound(res);
        return res.status(204).end();
    }

    return { create, listForGoal, getOne, edit, remove };
}

module.exports = { createKeyResultsController, sendError, toView };
