# okr18-keyresults-service

Team 18 OKR Tracker: the **Key Results Service** (owner: Amr Shalaby).
Key Results turns a goal into numbers: each goal gets up to 5 measurable key results,
and this service calculates how far each one (and the whole goal) has come.
Goals asks it before Activate and Achieve; Check-ins asks it before logging a value,
and tells it (through events) every time a value changes.

## Business rules

| Rule | Summary |
| --- | --- |
| K1 | A key result has a title (3–80), a type (`number`, `percentage`, `milestone`), a unit, a start and a target that are real numbers and **differ**, and a weight 1–5. A percentage stays within 0–100; a milestone is always 0 → 1. |
| K2 | At most **5** key results per goal (checked again after saving, so two clicks at once cannot make 6). |
| K3 | Progress = (current − start) / (target − start), kept within 0–100 %. Works when the target goes **down** too (e.g. 90 kg → 80 kg). |
| K4 | Every change asks Goals (`goals-internal`) about the parent goal: not yours → **404**; not Draft or Active → **409**. |
| K5 | Once the goal is Active, only the **title** can change (type, unit, start, target and weight are locked), so nobody can move the goalposts. An Active goal keeps at least one key result, and one with progress cannot be deleted. |
| K6 | Goal progress = **weighted** average of its key results (answered to Goals through `kr-internal`). |
| K7 | `current` only changes through check-ins (events). Reaching the target sets the key result to Completed and publishes `kr.completed` **once**; an undo below the target reopens it. |
| K8 | Goal abandoned → its key results are **Frozen** (check-ins ignored); reopened → unfrozen; deleted → removed. |

Endpoints, internal calls and events: [docs/api-contract-keyresults.md](docs/api-contract-keyresults.md).

## Layout

```
app.js                    the Express app wired to AWS (no listen)
server.js                 runs it on a PC: npm run dev  (port 3002)
handlers/api.js           Lambda kr-api (API Gateway -> Express via serverless-http)
handlers/internal.js      Lambda kr-internal (direct invoke only: Goals and Check-ins)
handlers/events.js        Lambda kr-events (reads the kr-inbox SQS queue)
src/rules.js              business rules K1-K8, pure functions
src/validate.js           input validation (K1)
src/keyResultsController.js  request -> Goals check -> rules -> data -> response
src/keyResultsRepo.js     the only file that talks to DynamoDB
src/goalsClient.js        calls goals-internal
src/internal.js           the three kr-internal answers
src/eventHandlers.js      check-in and goal events (K7, K8)
src/events.js             publishes kr.completed to SNS okr-events
src/auth.js               Cognito token -> req.user (copied unchanged from Goals)
infra/iam/                kr-role policy (least privilege) and trust policy
scripts/deploy.sh         creates or updates everything on Floci
scripts/zip-lambda.js     builds lambda.zip (no .env, no tests)
scripts/e2e-floci.sh      end-to-end test through API Gateway with a real login
scripts/st10-iam-check.sh ST10 on Floci: kr-role cannot touch other tables
scripts/secret-scan.sh    ST9: secret scan of every team repo
events/                   saved Lambda events for testing
test/                     unit, endpoint and security tests (npm test)
```

## AWS services used here

Lambda (3 functions), DynamoDB (table KeyResults, KMS-encrypted, index goalId-index),
API Gateway (5 routes + 2 CORS preflight + health), SQS (kr-inbox with dead-letter queue kr-inbox-dlq after 3 tries),
SNS (subscribed with a filter policy; publishes kr.completed), IAM (kr-role, least privilege),
CloudWatch Logs (kept 7 days).

## Run the tests

```
npm install
npm test
```

## Deploy to Floci

1. Docker Desktop running, Floci started (`okr18-frontend`: `docker compose -f infra/floci/docker-compose.yml up -d`).
2. Everything at once, from `okr18-frontend`: `bash infra/deploy-all.sh`
   (or only this service, from this folder: `bash scripts/deploy.sh`).
3. The last lines show `{"status":"ok","service":"keyresults"}` and `{"count":0}`.
4. `bash scripts/e2e-floci.sh` runs Goals and Key Results together through the real API.

## Security tests

| Test | How | Where |
| --- | --- | --- |
| ST6 injection | SQL/NoSQL/script text stays text; operator objects refused; all DB values are placeholders | `npm test` (test/security.test.js) |
| ST9 secret scan | every repo's files and history | `bash scripts/secret-scan.sh` |
| ST10 role cannot read another table | policy test + IAM evaluation on Floci | `npm test` and `bash scripts/st10-iam-check.sh` |
| ST1 / ST3 (shared) | no token 401; another user's data 404 | `npm test` (test/api.test.js) |
