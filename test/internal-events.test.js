// kr-internal answers (the contract Goals and Check-ins rely on) and kr-events (K7, K8).
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleInternal } = require('../src/internal');
const { createEventHandlers, parseRecord } = require('../src/eventHandlers');
const { fakeRepo, fakeEvents } = require('../test-support/fakes');

const G1 = 'G-11111111-1111-1111-1111-111111111111';
const iso = '2026-06-01T12:00:00.000Z';

function seed(repo, krId, over = {}) {
    const kr = { krId, goalId: G1, userId: 'user-a', title: `KR ${krId}`, type: 'number', unit: 'pages', start: 0, target: 10, current: 0, weight: 1, status: 'Open', completionAnnounced: false, createdAt: iso, updatedAt: iso, ...over };
    repo.rows.set(krId, kr);
    return kr;
}

// What SQS hands the Lambda: the SNS wrapper inside each record body
const sqs = (...envelopes) => ({
    Records: envelopes.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(e) }) }))
});

test('kr-internal: countKeyResults and getGoalsProgress match the TEAM-GUIDE contract', async () => {
    const repo = fakeRepo();
    seed(repo, 'KR-1', { current: 10, weight: 3 });
    seed(repo, 'KR-2', { current: 0 });
    assert.deepEqual(await handleInternal({ action: 'countKeyResults', goalId: G1 }, { repo }), { count: 2 });
    assert.deepEqual(await handleInternal({ action: 'countKeyResults', goalId: 'G-unknown' }, { repo }), { count: 0 });
    assert.deepEqual(
        await handleInternal({ action: 'getGoalsProgress', goalIds: [G1, 'G-unknown'] }, { repo }),
        { progress: { [G1]: 75, 'G-unknown': 0 } }
    );
});

test('kr-internal: getKeyResult answers found/not found with exactly the agreed fields', async () => {
    const repo = fakeRepo();
    seed(repo, 'KR-1', { current: 4 });
    assert.deepEqual(await handleInternal({ action: 'getKeyResult', krId: 'KR-1' }, { repo }), {
        found: true, userId: 'user-a', goalId: G1, type: 'number', start: 0, target: 10, current: 4, status: 'Open'
    });
    assert.deepEqual(await handleInternal({ action: 'getKeyResult', krId: 'KR-nope' }, { repo }), { found: false });
});

test('kr-internal: unknown actions and bad input are refused', async () => {
    const repo = fakeRepo();
    assert.deepEqual(await handleInternal({ action: 'deleteEverything' }, { repo }), { error: 'UNKNOWN_ACTION' });
    assert.deepEqual(await handleInternal({ action: 'countKeyResults', goalId: { $ne: '' } }, { repo }), { error: 'BAD_REQUEST' });
    assert.deepEqual(await handleInternal({ action: 'getGoalsProgress', goalIds: 'G-1' }, { repo }), { error: 'BAD_REQUEST' });
    assert.deepEqual(await handleInternal(null, { repo }), { error: 'UNKNOWN_ACTION' });
});

test('K7: check-ins move current; reaching the target completes it and announces kr.completed once', async () => {
    const repo = fakeRepo(); const events = fakeEvents();
    const h = createEventHandlers({ repo, events, now: () => new Date(iso) });
    seed(repo, 'KR-1');

    let out = await h.handleBatch(sqs({ type: 'check-in.logged', userId: 'user-a', data: { krId: 'KR-1', value: 6, previousValue: 0 } }));
    assert.deepEqual(out, { batchItemFailures: [] });
    assert.deepEqual([repo.rows.get('KR-1').current, repo.rows.get('KR-1').status], [6, 'Open']);

    await h.handleBatch(sqs({ type: 'check-in.logged', userId: 'user-a', data: { krId: 'KR-1', value: 10, previousValue: 6 } }));
    assert.equal(repo.rows.get('KR-1').status, 'Completed');
    assert.deepEqual(events.sent, [{ type: 'kr.completed', userId: 'user-a', data: { krId: 'KR-1', goalId: G1, title: 'KR KR-1' } }]);

    // the same message delivered twice changes nothing and announces nothing
    await h.handleBatch(sqs({ type: 'check-in.logged', userId: 'user-a', data: { krId: 'KR-1', value: 10, previousValue: 6 } }));
    assert.equal(events.sent.length, 1);

    // undo goes back below the target, then reaching it again is not announced twice
    await h.handleBatch(sqs({ type: 'check-in.undone', userId: 'user-a', data: { krId: 'KR-1', previousValue: 6 } }));
    assert.deepEqual([repo.rows.get('KR-1').current, repo.rows.get('KR-1').status], [6, 'Open']);
    await h.handleBatch(sqs({ type: 'check-in.logged', userId: 'user-a', data: { krId: 'KR-1', value: 10, previousValue: 6 } }));
    assert.equal(events.sent.length, 1);
});

test('K8: abandoned goal freezes its key results (check-ins ignored), reopen unfreezes, delete removes', async () => {
    const repo = fakeRepo(); const events = fakeEvents();
    const h = createEventHandlers({ repo, events, now: () => new Date(iso) });
    seed(repo, 'KR-1'); seed(repo, 'KR-2', { current: 10, status: 'Completed', completionAnnounced: true });
    seed(repo, 'KR-other', { goalId: 'G-other' });

    await h.handleBatch(sqs({ type: 'goal.abandoned', goalId: G1, userId: 'user-a', data: {} }));
    assert.deepEqual(['KR-1', 'KR-2'].map((id) => repo.rows.get(id).status), ['Frozen', 'Frozen']);

    await h.handleBatch(sqs({ type: 'check-in.logged', userId: 'user-a', data: { krId: 'KR-1', value: 5, previousValue: 0 } }));
    assert.equal(repo.rows.get('KR-1').current, 0);

    await h.handleBatch(sqs({ type: 'goal.reopened', goalId: G1, userId: 'user-a', data: {} }));
    assert.deepEqual(['KR-1', 'KR-2'].map((id) => repo.rows.get(id).status), ['Open', 'Completed']);

    await h.handleBatch(sqs({ type: 'goal.deleted', goalId: G1, userId: 'user-a', data: {} }));
    assert.deepEqual([...repo.rows.keys()], ['KR-other']);
});

test('a broken message is reported as failed (SQS retries it, then the DLQ), the rest still run', async () => {
    const repo = fakeRepo(); const events = fakeEvents();
    const h = createEventHandlers({ repo, events });
    seed(repo, 'KR-1');
    const batch = sqs({ type: 'check-in.logged', data: { krId: 'KR-1', value: 3, previousValue: 0 } });
    batch.Records.unshift({ messageId: 'bad', body: 'not json' });
    const out = await h.handleBatch(batch);
    assert.deepEqual(out, { batchItemFailures: [{ itemIdentifier: 'bad' }] });
    assert.equal(repo.rows.get('KR-1').current, 3);
});

test('raw SQS bodies (no SNS wrapper) are read too', () => {
    assert.deepEqual(parseRecord({ body: JSON.stringify({ type: 'goal.deleted', goalId: G1 }) }), { type: 'goal.deleted', goalId: G1 });
});
