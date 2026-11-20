// ---------------------------------------------------------------
// What Key Results does when another service announces something.
// The kr-inbox queue is subscribed to okr-events with a filter, so only
// these five event types ever arrive here (TEAM-GUIDE section 4).
//
//   check-in.logged   data { krId, value, previousValue }  -> current = value     (K7)
//   check-in.undone   data { krId, previousValue }         -> current = previousValue
//   goal.abandoned    goalId                               -> freeze its key results (K8)
//   goal.reopened     goalId                               -> unfreeze them
//   goal.deleted      goalId                               -> delete them
//
// Every handler is safe to run twice: SQS can deliver the same message again.
// ---------------------------------------------------------------
const { KR_STATUS, MAX_ABS, statusAfterUpdate, shouldAnnounceCompleted } = require('./rules');

const log = (fields) => console.log(JSON.stringify({ service: 'keyresults', ...fields }));

// A message from SNS through SQS: the body is SNS's wrapper, our envelope is in "Message"
function parseRecord(record) {
    const body = JSON.parse(record.body);
    return typeof body.Message === 'string' ? JSON.parse(body.Message) : body;
}

function createEventHandlers({ repo, events, now = () => new Date() }) {

    // Sets current to a new value and works out the status that follows (K7)
    async function moveCurrent(krId, value, why) {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS) {
            log({ event: why, krId, ignored: 'value is not a number' });
            return;
        }
        const kr = await repo.getById(krId);
        if (!kr) { log({ event: why, krId, ignored: 'key result not found' }); return; }
        if (kr.status === KR_STATUS.FROZEN) { log({ event: why, krId, ignored: 'goal is abandoned (frozen)' }); return; }
        if (kr.current === value) { log({ event: why, krId, ignored: 'already applied' }); return; }   // repeated delivery

        const after = { ...kr, current: value };
        after.status = statusAfterUpdate(after);
        const announce = shouldAnnounceCompleted(kr, after);

        // Announce first, then save: if saving fails the message comes back and is tried again.
        // (The rare cost is a repeated kr.completed; the other way round could lose it.)
        if (announce) {
            await events.publish('kr.completed', kr.userId, { krId: kr.krId, goalId: kr.goalId, title: kr.title });
        }
        const saved = await repo.setCurrent(krId, {
            expectedCurrent: kr.current,
            current: value,
            status: after.status,
            completionAnnounced: Boolean(kr.completionAnnounced || announce),
            nowIso: now().toISOString()
        });
        if (!saved) throw new Error(`Key result ${krId} changed meanwhile; retry.`);   // SQS will redeliver
        log({ event: why, krId, from: kr.current, to: value, status: after.status, announced: announce });
    }

    async function handle(envelope) {
        const { type, data = {} } = envelope;
        const goalId = envelope.goalId || data.goalId;
        switch (type) {
            case 'check-in.logged':
                return moveCurrent(data.krId, data.value, type);
            case 'check-in.undone':
                return moveCurrent(data.krId, data.previousValue, type);
            case 'goal.abandoned':
            case 'goal.reopened': {
                const iso = now().toISOString();
                const items = await repo.listByGoal(goalId);
                for (const kr of items) {
                    const status = type === 'goal.abandoned'
                        ? KR_STATUS.FROZEN
                        : statusAfterUpdate({ ...kr, status: KR_STATUS.OPEN });
                    if (status !== kr.status) await repo.setStatus(kr.krId, status, iso);
                }
                log({ event: type, goalId, keyResults: items.length });
                return undefined;
            }
            case 'goal.deleted': {
                const removed = await repo.removeByGoal(goalId);
                log({ event: type, goalId, removed });
                return undefined;
            }
            default:
                log({ event: type, ignored: 'not handled here' });
                return undefined;
        }
    }

    // The SQS batch: a message that fails goes back to the queue on its own
    // (after 3 tries it moves to the dead-letter queue kr-inbox-dlq).
    async function handleBatch(sqsEvent) {
        const failures = [];
        for (const record of sqsEvent.Records || []) {
            try {
                await handle(parseRecord(record));
            } catch (error) {
                console.error(JSON.stringify({ service: 'keyresults', messageId: record.messageId, error: error.message }));
                failures.push({ itemIdentifier: record.messageId });
            }
        }
        return { batchItemFailures: failures };
    }

    return { handle, handleBatch };
}

module.exports = { createEventHandlers, parseRecord };
