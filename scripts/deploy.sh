#!/usr/bin/env bash
# ---------------------------------------------------------------
# Deploy the Key Results Service to Floci (or real AWS: change the profile).
# Safe to run again: it creates what is missing and updates the rest.
# Run from this repo's folder in Git Bash:   bash scripts/deploy.sh
#
# Needs the shared base first (okr18-frontend: bash infra/shared-setup.sh),
# which writes the ids this script reads (API, topic, Cognito).
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
SHARED_VARS="${SHARED_VARS:-../okr18-frontend/infra/okr18-vars.sh}"

TABLE=KeyResults
ROLE=kr-role
FN_API=kr-api
FN_INTERNAL=kr-internal
FN_EVENTS=kr-events
QUEUE=kr-inbox
DLQ=kr-inbox-dlq
GOALS_FN=goals-internal

if [ -f "$SHARED_VARS" ]; then
  # shellcheck source=/dev/null
  source "$SHARED_VARS"
  echo "Shared base: $SHARED_VARS"
else
  echo "WARNING: $SHARED_VARS not found. Run the shared setup first; deploying without API routes or events."
fi

# The policies are written for Floci's account 000000000000; swap in the real one if different
policy_file() { sed "s/000000000000/$ACCOUNT/g; s/us-east-1/$REGION/g" "$1" > "out/$(basename "$1")"; echo "file://out/$(basename "$1")"; }
mkdir -p out

echo "1/8 DynamoDB table $TABLE (+ index goalId-index, KMS encryption)"
if ! aws dynamodb describe-table --table-name $TABLE > /dev/null 2>&1; then
  aws dynamodb create-table --table-name $TABLE \
    --attribute-definitions AttributeName=krId,AttributeType=S AttributeName=goalId,AttributeType=S \
    --key-schema AttributeName=krId,KeyType=HASH \
    --global-secondary-indexes "IndexName=goalId-index,KeySchema=[{AttributeName=goalId,KeyType=HASH}],Projection={ProjectionType=ALL}" \
    --billing-mode PAY_PER_REQUEST \
    --sse-specification Enabled=true,SSEType=KMS > /dev/null
  aws dynamodb wait table-exists --table-name $TABLE
fi

echo "2/8 SQS: $QUEUE (+ $DLQ after 3 tries), subscribed to okr-events with a filter"
DLQ_URL=$(aws sqs create-queue --queue-name $DLQ --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
DLQ_ARN="arn:aws:sqs:$REGION:$ACCOUNT:$DLQ"
QUEUE_URL=$(aws sqs create-queue --queue-name $QUEUE --query QueueUrl --output text)
QUEUE_ARN="arn:aws:sqs:$REGION:$ACCOUNT:$QUEUE"
# Queue settings as a JSON file: the values are themselves JSON, which the CLI short form cannot hold
node -e '
const [dlqArn, queueArn, topicArn] = process.argv.slice(1);
const attrs = {
  VisibilityTimeout: "60",
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "3" })
};
if (topicArn) attrs.Policy = JSON.stringify({ Version: "2012-10-17", Statement: [{
  Sid: "OnlyOkrEventsTopic", Effect: "Allow", Principal: { Service: "sns.amazonaws.com" },
  Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topicArn } } }] });
require("fs").writeFileSync("out/queue-attributes.json", JSON.stringify(attrs));
' "$DLQ_ARN" "$QUEUE_ARN" "${EVENTS_TOPIC_ARN:-}"
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes file://out/queue-attributes.json
if [ -n "${EVENTS_TOPIC_ARN:-}" ]; then
  FILTER='{"eventType":["check-in.logged","check-in.undone","goal.deleted","goal.abandoned","goal.reopened"]}'
  SUB_ARN=$(aws sns list-subscriptions-by-topic --topic-arn "$EVENTS_TOPIC_ARN" \
    --query "Subscriptions[?Endpoint=='$QUEUE_ARN'].SubscriptionArn | [0]" --output text)
  if [ "$SUB_ARN" = "None" ] || [ -z "$SUB_ARN" ]; then
    SUB_ARN=$(aws sns subscribe --topic-arn "$EVENTS_TOPIC_ARN" --protocol sqs --notification-endpoint "$QUEUE_ARN" \
      --query SubscriptionArn --output text)
  fi
  aws sns set-subscription-attributes --subscription-arn "$SUB_ARN" --attribute-name FilterPolicy --attribute-value "$FILTER"
else
  echo "   skipped the subscription: EVENTS_TOPIC_ARN unknown"
fi

echo "3/8 IAM: $ROLE (own table, own queue, publish to okr-events, invoke goals-internal, own logs)"
aws iam get-role --role-name $ROLE > /dev/null 2>&1 || \
  aws iam create-role --role-name $ROLE --assume-role-policy-document file://infra/iam/trust-policy.json > /dev/null
aws iam put-role-policy --role-name $ROLE --policy-name kr-access --policy-document "$(policy_file infra/iam/kr-policy.json)"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

echo "4/8 Install and zip"
npm install --omit=dev --no-audit --no-fund --loglevel=error
npm run zip --silent

# Lambda environment variables as a JSON file: the CLI's short form breaks on values that
# contain commas (CORS_ORIGINS has two addresses), JSON does not.
write_env() {   # KEY=VALUE ...  ->  out/env.json
  node -e 'const v={};for(const kv of process.argv.slice(1)){const i=kv.indexOf("=");v[kv.slice(0,i)]=kv.slice(i+1);}require("fs").writeFileSync("out/env.json",JSON.stringify({Variables:v}));' "$@"
}
write_env NODE_ENV=production "KR_TABLE=$TABLE" "GOALS_INTERNAL_FUNCTION=$GOALS_FN" "EVENTS_TOPIC_ARN=${EVENTS_TOPIC_ARN:-}" \
  "COGNITO_ISSUER=${COGNITO_ISSUER:-}" "COGNITO_JWKS_URI=${COGNITO_JWKS_URI:-}" "COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID:-}" \
  "ALLOW_HTTP_JWKS=${ALLOW_HTTP_JWKS:-true}" "CORS_ORIGINS=${CORS_ORIGINS:-http://localhost:8080}" \
  "RATE_LIMIT_MAX=${RATE_LIMIT_MAX:-60}"   # requests per IP per minute; raise only for a load test

deploy_fn() {   # name handler
  if aws lambda get-function --function-name "$1" > /dev/null 2>&1; then
    aws lambda update-function-code --function-name "$1" --zip-file fileb://lambda.zip > /dev/null
    aws lambda wait function-updated-v2 --function-name "$1"
    aws lambda update-function-configuration --function-name "$1" --handler "$2" --environment file://out/env.json > /dev/null
  else
    aws lambda create-function --function-name "$1" --runtime nodejs24.x --handler "$2" \
      --role "$ROLE_ARN" --zip-file fileb://lambda.zip --timeout 10 --memory-size 128 \
      --environment file://out/env.json > /dev/null
  fi
  aws lambda wait function-active-v2 --function-name "$1"
  aws logs create-log-group --log-group-name "/aws/lambda/$1" > /dev/null 2>&1 || true
  aws logs put-retention-policy --log-group-name "/aws/lambda/$1" --retention-in-days 7 > /dev/null 2>&1 || true
  echo "   $1 ready"
}

echo "5/8 Lambda functions"
deploy_fn $FN_INTERNAL handlers/internal.handler   # first: Goals' Activate and Achieve wait for it
deploy_fn $FN_API handlers/api.handler
deploy_fn $FN_EVENTS handlers/events.handler

echo "6/8 kr-events reads $QUEUE (batches of 10, only failed messages are retried)"
MAPPING=$(aws lambda list-event-source-mappings --function-name $FN_EVENTS --event-source-arn "$QUEUE_ARN" \
  --query "EventSourceMappings[0].UUID" --output text)
if [ "$MAPPING" = "None" ] || [ -z "$MAPPING" ]; then
  aws lambda create-event-source-mapping --function-name $FN_EVENTS --event-source-arn "$QUEUE_ARN" \
    --batch-size 10 --function-response-types ReportBatchItemFailures > /dev/null
fi

echo "7/8 API Gateway routes (only these reach kr-api)"
if [ -n "${API_ID:-}" ]; then
  FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN_API"
  INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
    --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]" --output text)
  if [ "$INTEGRATION_ID" = "None" ] || [ -z "$INTEGRATION_ID" ]; then
    INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
      --payload-format-version 2.0 --integration-uri "$FN_ARN" --query IntegrationId --output text)
  fi
  EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text)
  add_route() {   # "METHOD path" protected(yes/no)
    if printf '%s\n' "$EXISTING" | tr '\t' '\n' | grep -Fxq "$1"; then return; fi   # exact match only
    if [ "$2" = yes ] && [ -n "${AUTHORIZER_ID:-}" ]; then
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" \
        --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" --query RouteKey --output text
    else
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" \
        --query RouteKey --output text
    fi
  }
  add_route "GET /api/key-results/health" no
  add_route "POST /api/goals/{goalId}/key-results" yes
  add_route "GET /api/goals/{goalId}/key-results" yes
  add_route "GET /api/key-results/{id}" yes
  add_route "PATCH /api/key-results/{id}" yes
  add_route "DELETE /api/key-results/{id}" yes
  # CORS preflight: the browser asks OPTIONS first for requests with a token; Express cors() answers
  add_route "OPTIONS /api/goals/{goalId}/key-results" no
  add_route "OPTIONS /api/key-results/{id}" no
  aws lambda add-permission --function-name $FN_API --statement-id apigw-invoke-kr \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" > /dev/null 2>&1 || true
else
  echo "   skipped: API_ID unknown"
fi

echo "8/8 Smoke test: health through kr-api, and the call Goals makes to kr-internal"
aws lambda invoke --function-name $FN_API --payload file://events/1-health.json \
  --cli-binary-format raw-in-base64-out out/health.json > /dev/null
cat out/health.json; echo
aws lambda invoke --function-name $FN_INTERNAL --payload file://events/internal-count.json \
  --cli-binary-format raw-in-base64-out out/count.json > /dev/null
cat out/count.json; echo
echo "Done. Saved events to try: ls events/"
