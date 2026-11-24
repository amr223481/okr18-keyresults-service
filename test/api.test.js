// Endpoint tests: the real Express app and controller, with fakes behind them.
// Functional cases from the test plan, plus ST1 (no token) and ST3 (another user's data).
const test = require('node:test');
const assert = require('node:assert/strict');
const serverless = require('serverless-http');
const { createApp } = require('../src/createApp');
const { fakeRepo, fakeGoals, fakeVerify } = require('../test-support/fakes');

const NOW = new Date('2026-06-01T12:00:00Z');
const GOAL_A = 'G-11111111-1111-1111-1111-111111111111';
const GOAL_B = 'G-22222222-2222-2222-2222-222222222222';

function setup() {
    const repo = fakeRepo(); const goals = fakeGoals();
    goals.add(GOAL_A, 'user-a');
    goals.add(GOAL_B, 'user-b');
    let tick = 0;   // each call gets a later time, so updatedAt changes like it would for real
    const app = createApp({ repo, goals, verify: fakeVerify, now: () => new Date(NOW.getTime() + (tick += 1000)) });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, path, { user = 'a', body, raw, type = 'application/json' } = {}) => {
        const headers = {};
        if (user) headers.authorization = `Bearer token-${user}`;
        if (body !== undefined || raw !== undefined) headers['content-type'] = type;
        const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { repo, goals, server, call };
}

const books = { title: 'Read 12 books', type: 'number', unit: 'books', start: 0, target: 12 };
const krs = (goalId = GOAL_A) => `/goals/${goalId}/key-results`;

test('health answers without a login', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    const r = await call('GET', '/key-results/health', { user: null });
    assert.deepEqual([r.status, r.body], [200, { status: 'ok', service: 'keyresults' }]);
});

test('ST1: no token or a bad token gets 401', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    assert.equal((await call('GET', krs(), { user: null })).status, 401);
    assert.equal((await call('POST', krs(), { user: null, body: books })).status, 401);
    const bad = await fetch(`http://127.0.0.1:${server.address().port}/api${krs()}`, { headers: { authorization: 'Bearer forged' } });
    assert.equal(bad.status, 401);
});

test('create: 201, the server sets id, owner, current and status', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    const r = await call('POST', krs(), { body: { ...books, current: 12, status: 'Completed', userId: 'user-b', krId: 'KR-x', goalId: GOAL_B } });
    assert.equal(r.status, 201);
    assert.match(r.body.krId, /^KR-[0-9a-f-]{36}$/);
    assert.equal(r.body.goalId, GOAL_A);
    assert.deepEqual([r.body.current, r.body.status, r.body.progress, r.body.weight], [0, 'Open', 0, 1]);
    assert.equal(r.body.userId, undefined);
});

test('K1 over HTTP: 400 with every problem, 415 non-JSON, 400 broken JSON, 413 huge body', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    const r = await call('POST', krs(), { body: { title: 'x', type: 'number', unit: 'kg', start: 5, target: 5 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    assert.equal(r.body.error.details.length, 2);
    assert.equal((await call('POST', krs(), { body: { ...books, target: 'twelve' } })).status, 400);
    assert.equal((await call('POST', krs(), { raw: 'title=x', type: 'text/plain' })).status, 415);
    assert.equal((await call('POST', krs(), { raw: '{"title": ' })).status, 400);
    assert.equal((await call('POST', krs(), { raw: JSON.stringify({ title: 'x'.repeat(20000) }) })).status, 413);
});

test('K2: the 6th key result is refused', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', krs(), { body: { ...books, title: `Key result ${i}` } })).status, 201);
    const r = await call('POST', krs(), { body: books });
    assert.deepEqual([r.status, r.body.error.code], [409, 'KR_LIMIT']);
});

test('K4: unknown goal 404, a goal that is not Draft/Active 409, Goals down 503', async (t) => {
    const { server, call, goals } = setup(); t.after(() => server.close());
    assert.equal((await call('POST', krs('G-99999999-9999-9999-9999-999999999999'), { body: books })).status, 404);
    assert.equal((await call('POST', '/goals/not-a-goal-id/key-results', { body: books })).status, 404);
    goals.state.goals[GOAL_A].status = 'Achieved';
    const r = await call('POST', krs(), { body: books });
    assert.deepEqual([r.status, r.body.error.code], [409, 'GOAL_LOCKED']);
    goals.state.down = true;
    assert.equal((await call('POST', krs(), { body: books })).status, 503);
});

test('ST3: user B cannot add to, list, read, edit or delete user A\'s key results (404 each)', async (t) => {
    const { server, call, repo } = setup(); t.after(() => server.close());
    const { body: kr } = await call('POST', krs(), { body: books });
    assert.equal((await call('POST', krs(), { user: 'b', body: books })).status, 404);
    assert.equal((await call('GET', krs(), { user: 'b' })).status, 404);
    assert.equal((await call('GET', `/key-results/${kr.krId}`, { user: 'b' })).status, 404);
    assert.equal((await call('PATCH', `/key-results/${kr.krId}`, { user: 'b', body: { title: 'Hacked title' } })).status, 404);
    assert.equal((await call('DELETE', `/key-results/${kr.krId}`, { user: 'b' })).status, 404);
    assert.equal(repo.rows.get(kr.krId).title, 'Read 12 books');
});

test('list: key results with progress, and the weighted goal progress (K3 + K6)', async (t) => {
    const { server, call, repo } = setup(); t.after(() => server.close());
    const { body: a } = await call('POST', krs(), { body: { ...books, weight: 3 } });
    const { body: b } = await call('POST', krs(), { body: { title: 'Lose 10 kg', type: 'number', unit: 'kg', start: 90, target: 80 } });
    repo.rows.get(a.krId).current = 12;                        // as if check-ins had happened
    repo.rows.get(b.krId).current = 85;
    const r = await call('GET', krs());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.keyResults.map((k) => k.progress), [100, 50]);
    assert.equal(r.body.progress, 87.5);                       // (100*3 + 50*1) / 4
    assert.deepEqual([r.body.goalStatus, r.body.canChange, r.body.maxKeyResults], ['Draft', true, 5]);
});

test('edit: Draft can change everything (start moves current), Active only the title (K5)', async (t) => {
    const { server, call, goals } = setup(); t.after(() => server.close());
    const { body: kr } = await call('POST', krs(), { body: books });

    let r = await call('PATCH', `/key-results/${kr.krId}`, { body: { start: 2, target: 20, weight: 2 } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.start, r.body.current, r.body.target, r.body.weight], [2, 2, 20, 2]);

    goals.state.goals[GOAL_A].status = 'Active';
    r = await call('PATCH', `/key-results/${kr.krId}`, { body: { target: 5 } });
    assert.deepEqual([r.status, r.body.error.code], [409, 'KR_LOCKED']);
    r = await call('PATCH', `/key-results/${kr.krId}`, { body: { title: 'Read 20 books' } });
    assert.deepEqual([r.status, r.body.title], [200, 'Read 20 books']);
    assert.equal((await call('PATCH', `/key-results/${kr.krId}`, { body: { current: 20 } })).status, 400);
});

test('delete: Draft 204; Active keeps its last key result and any with progress', async (t) => {
    const { server, call, goals, repo } = setup(); t.after(() => server.close());
    const { body: a } = await call('POST', krs(), { body: books });
    const { body: b } = await call('POST', krs(), { body: { ...books, title: 'Read 6 papers' } });
    const { body: c } = await call('POST', krs(), { body: { ...books, title: 'Write 3 essays' } });
    assert.equal((await call('DELETE', `/key-results/${c.krId}`)).status, 204);

    goals.state.goals[GOAL_A].status = 'Active';
    repo.rows.get(a.krId).current = 3;
    assert.equal((await call('DELETE', `/key-results/${a.krId}`)).body.error.code, 'KR_LOCKED');
    assert.equal((await call('DELETE', `/key-results/${b.krId}`)).status, 204);
    repo.rows.get(a.krId).current = 0;
    assert.equal((await call('DELETE', `/key-results/${a.krId}`)).body.error.code, 'LAST_KEY_RESULT');
    assert.equal((await call('GET', `/key-results/${b.krId}`)).status, 404);
});

test('behind API Gateway: the event is turned into an Express request (Lambda payload 2.0)', async () => {
    const goals = fakeGoals(); goals.add(GOAL_A, 'user-gw');
    const handler = serverless(createApp({ repo: fakeRepo(), goals, verify: fakeVerify, now: () => NOW }));
    const event = {
        version: '2.0', rawPath: krs(GOAL_A).replace('/goals', '/api/goals'), rawQueryString: '',
        headers: { 'content-type': 'application/json' },
        requestContext: { http: { method: 'POST', path: `/api${krs(GOAL_A)}`, sourceIp: '127.0.0.1' }, authorizer: { jwt: { claims: { sub: 'user-gw', 'cognito:groups': '[user]' } } } },
        body: JSON.stringify(books), isBase64Encoded: false
    };
    const res = await handler(event, {});
    assert.equal(res.statusCode, 201);
    assert.equal(JSON.parse(res.body).title, 'Read 12 books');
});

test('security headers are on every answer, errors too', async (t) => {
    const { server } = setup(); t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}/api/key-results`;
    for (const res of [await fetch(`${base}/health`), await fetch(`${base}/KR-x`)]) {   // 200 and 401
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
    }
});

test('rate limit: request 4 of 3 gets 429, and a fake X-Forwarded-For does not help', async (t) => {
    const app = createApp({ repo: fakeRepo(), goals: fakeGoals(), verify: fakeVerify, now: () => NOW, rateLimitMax: 3 });
    const server = app.listen(0); t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/api/key-results/health`;
    const seen = [];
    for (let i = 0; i < 3; i += 1) seen.push((await fetch(url)).status);
    const fourth = await fetch(url);
    const faked = await fetch(url, { headers: { 'x-forwarded-for': '9.9.9.9' } });
    assert.deepEqual(seen, [200, 200, 200]);
    assert.equal(fourth.status, 429);
    assert.ok(Number(fourth.headers.get('retry-after')) > 0);
    assert.equal((await fourth.json()).error.code, 'RATE_LIMITED');
    assert.equal(faked.status, 429);
});
