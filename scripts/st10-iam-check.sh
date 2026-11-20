#!/usr/bin/env bash
# ---------------------------------------------------------------
# ST10 on Floci: can kr-role touch another service's table?
# Asks IAM to evaluate kr-role's policy for each action and table.
# Expected: only KeyResults is "allowed"; Goals, CheckIns and Scan are denied.
# Run after deploy:   bash scripts/st10-iam-check.sh
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION="${AWS_REGION:-us-east-1}"
T="arn:aws:dynamodb:$REGION:$ACCOUNT:table"

aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$ACCOUNT:role/kr-role" \
  --action-names dynamodb:GetItem dynamodb:PutItem dynamodb:Scan \
  --resource-arns "$T/KeyResults" "$T/Goals" "$T/CheckIns" \
  --query "EvaluationResults[].[EvalDecision,EvalActionName,EvalResourceName]" --output text \
  | tr -d '\r' \
  | while read -r decision action resource; do
      table=${resource##*/}
      if [ "$table" = KeyResults ] && [ "$action" != dynamodb:Scan ]; then want=allowed; else want=implicitDeny; fi
      [ "$decision" = "$want" ] && r=PASS || r=FAIL
      printf '%-5s %-16s %-11s %s\n' "$r" "$action" "$table" "$decision"
    done
