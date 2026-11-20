// ---------------------------------------------------------------
// Key Results data layer: the ONLY file that talks to the KeyResults table.
// Table:  KR_TABLE (key krId)
// Index:  goalId-index (partition goalId): all key results of one goal
// No access keys in the code: on Lambda the kr-role gives permission,
// on a PC the "floci" AWS profile does.
// Every value goes in as an expression value (:name), never pasted into
// the expression text, so input cannot change the query (ST6).
// ---------------------------------------------------------------
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand
} = require('@aws-sdk/lib-dynamodb');

const GOAL_INDEX = 'goalId-index';

function createKeyResultsRepo({ table = process.env.KR_TABLE, client } = {}) {
    if (!table) throw new Error('KR_TABLE is not set.');
    const db = client || DynamoDBDocumentClient.from(new DynamoDBClient({}));

    async function create(kr) {
        await db.send(new PutCommand({
            TableName: table,
            Item: kr,
            ConditionExpression: 'attribute_not_exists(krId)'     // never overwrite
        }));
        return kr;
    }

    // Read one without an owner check (internal calls and events)
    async function getById(krId) {
        const { Item } = await db.send(new GetCommand({ TableName: table, Key: { krId } }));
        return Item || null;
    }

    // Read one. Someone else's key result looks "not found".
    async function getOwned(krId, userId) {
        const kr = await getById(krId);
        return kr && kr.userId === userId ? kr : null;
    }

    // Query: all key results of one goal, oldest first
    async function listByGoal(goalId) {
        const items = [];
        let ExclusiveStartKey;
        do {
            const page = await db.send(new QueryCommand({
                TableName: table,
                IndexName: GOAL_INDEX,
                KeyConditionExpression: '#g = :g',
                ExpressionAttributeNames: { '#g': 'goalId' },
                ExpressionAttributeValues: { ':g': goalId },
                ExclusiveStartKey
            }));
            items.push(...page.Items);
            ExclusiveStartKey = page.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async function countByGoal(goalId) {
        return (await listByGoal(goalId)).length;
    }

    // Update chosen fields, only for the owner and only if nobody changed it since we read it
    async function updateFields(krId, userId, fields, expectedUpdatedAt, nowIso) {
        const names = { '#owner': 'userId', '#upd': 'updatedAt' };
        const values = { ':owner': userId, ':expected': expectedUpdatedAt, ':upd': nowIso };
        const sets = ['#upd = :upd'];
        Object.entries(fields).forEach(([k, v], i) => {
            names[`#f${i}`] = k; values[`:f${i}`] = v; sets.push(`#f${i} = :f${i}`);
        });
        return conditionalUpdate({
            Key: { krId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: '#owner = :owner AND #upd = :expected',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values
        });
    }

    // Check-in events: set current (and the status that follows from it, K7).
    // Only if current is still what we read, so two events at once cannot mix.
    async function setCurrent(krId, { expectedCurrent, current, status, completionAnnounced, nowIso }) {
        return conditionalUpdate({
            Key: { krId },
            UpdateExpression: 'SET #c = :c, #s = :s, #ann = :ann, #upd = :upd',
            ConditionExpression: 'attribute_exists(krId) AND #c = :expected',
            ExpressionAttributeNames: { '#c': 'current', '#s': 'status', '#ann': 'completionAnnounced', '#upd': 'updatedAt' },
            ExpressionAttributeValues: { ':c': current, ':s': status, ':ann': completionAnnounced, ':expected': expectedCurrent, ':upd': nowIso }
        });
    }

    // Goal events: freeze or unfreeze one key result (K8)
    async function setStatus(krId, status, nowIso) {
        return conditionalUpdate({
            Key: { krId },
            UpdateExpression: 'SET #s = :s, #upd = :upd',
            ConditionExpression: 'attribute_exists(krId)',
            ExpressionAttributeNames: { '#s': 'status', '#upd': 'updatedAt' },
            ExpressionAttributeValues: { ':s': status, ':upd': nowIso }
        });
    }

    // Delete one. The owner condition is checked by DynamoDB itself.
    async function remove(krId, userId) {
        try {
            await db.send(new DeleteCommand({
                TableName: table,
                Key: { krId },
                ConditionExpression: '#owner = :owner',
                ExpressionAttributeNames: { '#owner': 'userId' },
                ExpressionAttributeValues: { ':owner': userId }
            }));
            return true;
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') return false;
            throw error;
        }
    }

    // goal.deleted: remove every key result of that goal (K8)
    async function removeByGoal(goalId) {
        const items = await listByGoal(goalId);
        for (const kr of items) {
            await db.send(new DeleteCommand({ TableName: table, Key: { krId: kr.krId } }));
        }
        return items.length;
    }

    async function conditionalUpdate(params) {
        try {
            const { Attributes } = await db.send(new UpdateCommand({ TableName: table, ReturnValues: 'ALL_NEW', ...params }));
            return Attributes;
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') return null;   // changed meanwhile
            throw error;
        }
    }

    return { create, getById, getOwned, listByGoal, countByGoal, updateFields, setCurrent, setStatus, remove, removeByGoal };
}

module.exports = { createKeyResultsRepo, GOAL_INDEX };
