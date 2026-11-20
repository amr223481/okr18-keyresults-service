#!/usr/bin/env bash
# ---------------------------------------------------------------
# End-to-end test on Floci, through the real API Gateway with a real Cognito login.
# Shows Goals and Key Results working together (and the events between them).
# Run after deploy-all.sh, from this repo:   bash scripts/e2e-floci.sh
# Creates a throw-away user and deletes it at the end.
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
# shellcheck source=/dev/null
source ../okr18-frontend/infra/okr18-vars.sh

USER_EMAIL="e2e-$(date +%s)@okr18.test"
USER_PASS="E2e-test-$(date +%s)Aa1"          # a test password for a throw-away Floci user
YEAR=$(date +%Y)
PASS=0; FAIL=0

aws cognito-idp admin-create-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$USER_EMAIL" --message-action SUPPRESS > /dev/null
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_USER_POOL_ID" --username "$USER_EMAIL" --password "$USER_PASS" --permanent > /dev/null
TOKEN=$(aws cognito-idp initiate-auth --client-id "$COGNITO_CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$USER_EMAIL,PASSWORD=$USER_PASS" --query AuthenticationResult.AccessToken --output text)
cleanup() { aws cognito-idp admin-delete-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$USER_EMAIL" > /dev/null 2>&1 || true; }
trap cleanup EXIT

# call METHOD PATH [BODY]  -> sets $STATUS and $BODY
call() {
  local out
  out=$(curl -s -w '\n%{http_code}' -X "$1" "$API_URL$2" -H "Authorization: Bearer $TOKEN" \
    ${3:+-H "Content-Type: application/json" -d "$3"})
  STATUS=$(printf '%s' "$out" | tail -n1); BODY=$(printf '%s' "$out" | sed '$d')
}
field() { printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
check() {   # name expected-status
  if [ "$STATUS" = "$2" ]; then PASS=$((PASS+1)); echo "PASS  $1  ($STATUS)"; else FAIL=$((FAIL+1)); echo "FAIL  $1  (got $STATUS, expected $2): $BODY"; fi
}

echo "API: $API_URL"
call POST /api/goals "{\"title\":\"Read more this year\",\"category\":\"Learning\",\"year\":$YEAR,\"deadline\":\"$YEAR-12-31\"}"
check "create a goal (Goals)" 201
GOAL=$(field goalId)

call POST "/api/goals/$GOAL/transitions" '{"to":"Active"}'
check "activate with no key results: Goals asks kr-internal, G2 refuses (not 503)" 409

call POST "/api/goals/$GOAL/key-results" '{"title":"Read 12 books","type":"number","unit":"books","start":0,"target":12,"weight":3}'
check "add key result 1" 201
KR1=$(field krId)
call POST "/api/goals/$GOAL/key-results" '{"title":"Finish the reading course","type":"milestone"}'
check "add key result 2 (milestone)" 201
KR2=$(field krId)
call POST "/api/goals/$GOAL/key-results" '{"title":"Bad","type":"number","unit":"x","start":5,"target":5}'
check "K1: target equal to start is refused" 400

call POST "/api/goals/$GOAL/transitions" '{"to":"Active"}'
check "activate: kr-internal says count=2, Goals allows it" 200

call PATCH "/api/key-results/$KR1" '{"target":6}'
check "K5: target locked once the goal is Active" 409
call PATCH "/api/key-results/$KR1" '{"title":"Read 12 good books"}'
check "K5: title can still change" 200

echo "Simulating Check-ins: publishing check-in.logged events on okr-events..."
publish() {
  aws sns publish --topic-arn "$EVENTS_TOPIC_ARN" --message "$1" \
    --message-attributes "{\"eventType\":{\"DataType\":\"String\",\"StringValue\":\"$2\"}}" > /dev/null
}
publish "{\"type\":\"check-in.logged\",\"userId\":\"x\",\"at\":\"now\",\"data\":{\"krId\":\"$KR1\",\"value\":12,\"previousValue\":0}}" check-in.logged
publish "{\"type\":\"check-in.logged\",\"userId\":\"x\",\"at\":\"now\",\"data\":{\"krId\":\"$KR2\",\"value\":1,\"previousValue\":0}}" check-in.logged
for i in $(seq 1 30); do
  call GET "/api/goals/$GOAL/key-results"
  [ "$(field progress)" = "100" ] && break
  sleep 2
done
check "list key results" 200
echo "      goal progress after the events: $(field progress)%  (kr-events moved both to their target)"
[ "$(field progress)" = "100" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); echo "FAIL  events did not reach kr-events in time"; }

call POST "/api/goals/$GOAL/transitions" '{"to":"Achieved"}'
check "achieve: kr-internal says 100%, Goals allows it" 200

call POST "/api/goals/$GOAL/key-results" '{"title":"Too late","type":"number","unit":"x","start":0,"target":1}'
check "K4: no new key results on an Achieved goal" 409

TOKEN="forged.token.value"
call GET "/api/goals/$GOAL/key-results"
check "ST1: a forged token is refused" 401

echo
echo "Summary: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
