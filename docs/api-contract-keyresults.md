# Key Results Service: API contract

Owner: Amr Shalaby. All bodies are JSON (`Content-Type: application/json`, max 10 kB).
Every route except `/api/key-results/health` needs `Authorization: Bearer <Cognito access token>`.
The user is always the token's `sub`; nothing in the body can change the owner, the id, `current` or the status.

Error shape (shared by all three services):

```json
{ "error": { "code": "KR_LIMIT", "message": "A goal can have at most 5 key results.", "details": ["..."] } }
```

## Key result object

| Field | Type | Set by | Notes |
| --- | --- | --- | --- |
| krId | string `KR-<uuid>` | server | |
| goalId | string `G-<uuid>` | server (from the URL) | |
| title | string 3–80 | client | the only field that can change once the goal is Active (K5) |
| type | `number`, `percentage`, `milestone` | client | |
| unit | string 1–20 | client | `done` for a milestone |
| start, target | number | client | must differ (K1); percentage 0–100; milestone 0 → 1 |
| weight | whole number 1–5, default 1 | client | used for the goal's weighted progress (K6) |
| current | number | server, from check-in events | starts at `start` |
| status | `Open`, `Completed`, `Frozen` | server | K7, K8 |
| progress | 0–100 | server (K3) | added on read, never stored |
| createdAt, updatedAt | ISO time | server | |

## Endpoints

| Method and path | Body | Success | Errors |
| --- | --- | --- | --- |
| GET /api/key-results/health | | 200 `{status:"ok",service:"keyresults"}` | |
| POST /api/goals/{goalId}/key-results | title, type, unit, start, target, weight? | 201 key result | 400 VALIDATION_ERROR, 401, 404 GOAL_NOT_FOUND, 409 GOAL_LOCKED / KR_LIMIT, 413, 415, 503 |
| GET /api/goals/{goalId}/key-results | | 200 `{goalId, goalStatus, canChange, progress, maxKeyResults, keyResults[]}` | 401, 404, 503 |
| GET /api/key-results/{id} | | 200 key result | 401, 404 KR_NOT_FOUND (also another user's) |
| PATCH /api/key-results/{id} | any of title, type, unit, start, target, weight | 200 key result | 400, 401, 404, 409 GOAL_LOCKED / KR_LOCKED / CONFLICT, 415, 503 |
| DELETE /api/key-results/{id} | | 204 | 401, 404, 409 GOAL_LOCKED / KR_LOCKED / LAST_KEY_RESULT, 503 |

503 DEPENDENCY_UNAVAILABLE means Goals (`goals-internal`) did not answer; nothing was changed.

## What Key Results offers (direct Lambda invoke of `kr-internal`)

| Request | Answer | Who calls it |
| --- | --- | --- |
| `{ "action": "countKeyResults", "goalId": "G-..." }` | `{ "count": 2 }` | Goals (G2: Activate) |
| `{ "action": "getGoalsProgress", "goalIds": ["G-...", ...] }` (max 100) | `{ "progress": { "G-...": 62.5 } }` weighted 0–100; unknown goal = 0 | Goals (lists, G4 Achieve, G6 daily scan) |
| `{ "action": "getKeyResult", "krId": "KR-..." }` | `{ "found": true, "userId", "goalId", "type", "start", "target", "current", "status" }` or `{ "found": false }` | Check-ins (C1) |

Bad input answers `{ "error": "BAD_REQUEST" }`, an unknown action `{ "error": "UNKNOWN_ACTION" }`.
IAM: `goals-role` and `checkins-role` need `lambda:InvokeFunction` on `kr-internal`.

## What Key Results asks Goals (direct Lambda invoke of `goals-internal`)

`{ "action": "getGoalStatus", "goalId": "G-..." }` → `{ "found", "userId", "status", "year" }`, before every write (K4).

## Events

**Reads** (queue `kr-inbox`, dead-letter queue `kr-inbox-dlq` after 3 tries), filter
`{"eventType": ["check-in.logged", "check-in.undone", "goal.deleted", "goal.abandoned", "goal.reopened"]}`:

| type | data | What Key Results does |
| --- | --- | --- |
| check-in.logged | `{krId, value, previousValue}` | current = value; Completed at the target (K7) |
| check-in.undone | `{krId, previousValue}` | current = previousValue; back to Open below the target |
| goal.abandoned | (goalId in the envelope) | its key results become Frozen (K8) |
| goal.reopened | | Frozen → Open or Completed |
| goal.deleted | | its key results are deleted |

**Publishes** on `okr-events` (message attribute `eventType`), envelope `{ "type", "userId", "at", "data" }`:

| type | When | data | Who listens |
| --- | --- | --- | --- |
| kr.completed | a key result reaches its target for the first time | `{krId, goalId, title}` | Check-ins (digest) |
