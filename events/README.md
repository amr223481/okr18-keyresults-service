# Saved events

Try the Lambdas without the website (Lab 7 style):

| File | Lambda | What it does |
| --- | --- | --- |
| `1-health.json` | kr-api | API Gateway event (payload 2.0) for `GET /api/key-results/health` |
| `internal-count.json` | kr-internal | what Goals sends before Activate (rule G2) |
| `internal-progress.json` | kr-internal | what Goals sends for progress bars and Achieve (G4) |
| `internal-get-key-result.json` | kr-internal | what Check-ins sends before logging a check-in (C1) |
| `sqs-check-in-logged.json` | kr-events | an SQS batch holding an SNS `check-in.logged` message |

Replace the zero ids with real ones (from the website or `aws dynamodb scan --table-name KeyResults`).

    aws lambda invoke --function-name kr-internal --payload file://events/internal-count.json \
      --cli-binary-format raw-in-base64-out out/r.json && cat out/r.json
