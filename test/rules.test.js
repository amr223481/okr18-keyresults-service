// Unit tests for the business rules K1-K8 and validation. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    KR_STATUS, krProgress, goalProgress, canAdd, checkParentGoal, checkEdit, checkDelete,
    statusAfterUpdate, shouldAnnounceCompleted
} = require('../src/rules');
const { validateNew, validateEdit } = require('../src/validate');

const good = { title: 'Read 12 books', type: 'number', unit: 'books', start: 0, target: 12 };

test('K1: a good key result passes, extra fields are dropped, weight defaults to 1', () => {
    const r = validateNew({ ...good, title: '  Read 12 books ', current: 12, status: 'Completed', userId: 'someone-else', goalId: 'G-x' });
    assert.deepEqual(r.value, { title: 'Read 12 books', type: 'number', unit: 'books', start: 0, target: 12, weight: 1 });
});

test('K1: target equal to start, text instead of a number, bad type and weight are each refused', () => {
    assert.match(validateNew({ ...good, target: 0 }).errors[0], /different from start/);
    assert.match(validateNew({ ...good, start: '0' }).errors[0], /Start must be a number/);
    assert.match(validateNew({ ...good, target: Number.NaN }).errors[0], /Target must be a number/);
    assert.match(validateNew({ ...good, target: 1e12 }).errors[0], /too large/);
    assert.match(validateNew({ ...good, type: 'money' }).errors[0], /Type must be one of/);
    assert.match(validateNew({ ...good, weight: 6 }).errors[0], /Weight/);
    assert.match(validateNew({ ...good, weight: 2.5 }).errors[0], /Weight/);
    assert.equal(validateNew({ title: 'x', type: 'number', start: 1, target: 1, weight: 0 }).errors.length, 4);
});

test('K1: a percentage stays within 0-100, a milestone is always 0 -> 1', () => {
    assert.match(validateNew({ ...good, type: 'percentage', unit: '%', start: 0, target: 120 }).errors[0], /between 0 and 100/);
    const m = validateNew({ title: 'Launch the website', type: 'milestone', start: 5, target: 5 });
    assert.deepEqual([m.value.start, m.value.target, m.value.unit], [0, 1, 'done']);
});

test('K1: edit merges into the stored key result and reports only real changes', () => {
    const stored = { ...good, weight: 1 };
    assert.ok(validateEdit({}, stored).errors);
    assert.ok(validateEdit({ current: 5 }, stored).errors);                       // current is not editable
    assert.match(validateEdit({ target: 0 }, stored).errors[0], /different from start/);
    assert.deepEqual(validateEdit({ title: 'Read 12 books', weight: 3 }, stored).changes, { weight: 3 });
});

test('K2: at most 5 key results per goal', () => {
    assert.equal(canAdd(4).ok, true);
    assert.deepEqual([canAdd(5).status, canAdd(5).code], [409, 'KR_LIMIT']);
});

test('K3: progress works when the target goes up or down, and stays within 0-100', () => {
    assert.equal(krProgress({ start: 0, target: 12, current: 3 }), 25);
    assert.equal(krProgress({ start: 90, target: 80, current: 85 }), 50);           // losing weight: going down is progress
    assert.equal(krProgress({ start: 90, target: 80, current: 95 }), 0);            // went the wrong way
    assert.equal(krProgress({ start: 0, target: 10, current: 15 }), 100);           // beyond the target
    assert.equal(krProgress({ start: 0, target: 3, current: 1 }), 33.3);
});

test('K4: the parent goal must exist, be mine, and be Draft or Active', () => {
    assert.equal(checkParentGoal({ found: true, userId: 'u1', status: 'Draft' }, 'u1').ok, true);
    assert.equal(checkParentGoal({ found: true, userId: 'u1', status: 'Active' }, 'u1').ok, true);
    assert.equal(checkParentGoal({ found: false }, 'u1').status, 404);
    assert.equal(checkParentGoal({ found: true, userId: 'u2', status: 'Draft' }, 'u1').status, 404);   // not 403
    for (const s of ['AtRisk', 'Achieved', 'Abandoned']) {
        assert.deepEqual([checkParentGoal({ found: true, userId: 'u1', status: s }, 'u1').status], [409]);
    }
});

test('K5: in an Active goal only the title can change', () => {
    assert.equal(checkEdit('Draft', { target: 20, weight: 2 }).ok, true);
    assert.equal(checkEdit('Active', { title: 'Read 15 books' }).ok, true);
    const r = checkEdit('Active', { target: 5, title: 'x' });
    assert.deepEqual([r.status, r.code], [409, 'KR_LOCKED']);
    assert.match(r.message, /target/);
});

test('K2 + K5: delete rules', () => {
    const fresh = { start: 0, current: 0 };
    assert.equal(checkDelete('Draft', fresh, 1).ok, true);
    assert.equal(checkDelete('Active', fresh, 1).code, 'LAST_KEY_RESULT');
    assert.equal(checkDelete('Active', { start: 0, current: 4 }, 3).code, 'KR_LOCKED');
    assert.equal(checkDelete('Active', fresh, 3).ok, true);
});

test('K6: goal progress is the weighted average of its key results', () => {
    const krs = [
        { start: 0, target: 10, current: 10, weight: 3 },   // 100%
        { start: 0, target: 10, current: 0, weight: 1 }     // 0%
    ];
    assert.equal(goalProgress(krs), 75);
    assert.equal(goalProgress([]), 0);
});

test('K7: reaching the target completes it, falling back reopens it, kr.completed only once', () => {
    const open = { start: 0, target: 10, current: 10, status: KR_STATUS.OPEN, completionAnnounced: false };
    assert.equal(statusAfterUpdate(open), KR_STATUS.COMPLETED);
    assert.equal(statusAfterUpdate({ ...open, current: 9 }), KR_STATUS.OPEN);
    assert.equal(statusAfterUpdate({ ...open, status: KR_STATUS.FROZEN }), KR_STATUS.FROZEN);

    const done = { ...open, status: KR_STATUS.COMPLETED };
    assert.equal(shouldAnnounceCompleted({ ...open, current: 5 }, done), true);
    assert.equal(shouldAnnounceCompleted({ ...open, current: 5, completionAnnounced: true }, done), false);   // again after an undo
});
