// Security tests owned by Key Results:
//   ST6  injection: input is data, never code or query
//   ST10 least privilege: kr-role can reach only its own table, queue, topic and goals-internal
// (ST9, the secret scan, is scripts/secret-scan.sh because it reads every repo.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/createApp');
const { fakeRepo, fakeGoals, fakeVerify } = require('../test-support/fakes');

const GOAL_A = 'G-11111111-1111-1111-1111-111111111111';

function setup() {
    const repo = fakeRepo(); const goals = fakeGoals();
    goals.add(GOAL_A, 'user-a');
    const server = createApp({ repo, goals, verify: fakeVerify }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, p, body) => {
        const res = await fetch(base + p, {
            method,
            headers: { authorization: 'Bearer token-a', ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { repo, server, call };
}

test('ST6: SQL / NoSQL / script text in a title is stored and returned as plain text', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    for (const title of ["Books'; DROP TABLE KeyResults;--", '<script>alert(1)</script>', '#c = :c OR attribute_exists(krId)']) {
        const r = await call('POST', `/goals/${GOAL_A}/key-results`, { title, type: 'number', unit: 'books', start: 0, target: 5 });
        assert.equal(r.status, 201);
        assert.equal(r.body.title, title);                              // unchanged, nothing ran
    }
});

test('ST6: operator objects and odd ids are refused, never passed to the database', async (t) => {
    const { server, call, repo } = setup(); t.after(() => server.close());
    const r = await call('POST', `/goals/${GOAL_A}/key-results`, { title: { $ne: '' }, type: 'number', unit: { $gt: '' }, start: { $gt: 0 }, target: 5 });
    assert.equal(r.status, 400);
    assert.equal(repo.rows.size, 0);
    assert.equal((await call('GET', `/key-results/${encodeURIComponent("KR-1' OR '1'='1")}`)).status, 404);
    assert.equal((await call('GET', `/goals/${encodeURIComponent('G-*')}/key-results`)).status, 404);
});

test('ST6: every database value goes in as a placeholder, never pasted into an expression', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'keyResultsRepo.js'), 'utf8');
    // expressions may only be built from #name / :value placeholders and fixed words
    const built = [...src.matchAll(/Expression:\s*`([^`]*)`/g)].map((m) => m[1]);
    built.forEach((expr) => assert.doesNotMatch(expr, /\$\{(?!sets)/, `expression built from input: ${expr}`));
    assert.doesNotMatch(src, /PartiQL|ExecuteStatement/);
});

test('ST10: kr-role allows only its own resources (no wildcards, no other table)', () => {
    const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'infra', 'iam', 'kr-policy.json'), 'utf8'));
    const resources = policy.Statement.flatMap((s) => [].concat(s.Resource));
    const actions = policy.Statement.flatMap((s) => [].concat(s.Action));

    assert.ok(policy.Statement.every((s) => s.Effect === 'Allow'));
    assert.ok(!actions.some((a) => a === '*' || a.endsWith(':*')), 'no service-wide actions');
    assert.ok(!resources.includes('*'), 'no "*" resource');

    const tables = resources.filter((r) => r.includes(':dynamodb:'));
    assert.deepEqual(tables.map((r) => r.split(':table/')[1]), ['KeyResults', 'KeyResults/index/goalId-index']);
    assert.ok(!actions.includes('dynamodb:Scan'), 'no full-table scans');

    const functions = resources.filter((r) => r.includes(':lambda:'));
    assert.deepEqual(functions.map((r) => r.split(':function:')[1]), ['goals-internal']);
    assert.deepEqual(resources.filter((r) => r.includes(':sqs:')).map((r) => r.split(':').pop()), ['kr-inbox']);
    assert.deepEqual(resources.filter((r) => r.includes(':sns:')).map((r) => r.split(':').pop()), ['okr-events']);
});
