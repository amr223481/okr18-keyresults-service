// ---------------------------------------------------------------
// Input validation for key results (rule K1).
// Only the fields named here are read; anything else in the body
// (krId, userId, goalId, current, status...) is ignored, because the
// server owns those values. "current" only changes through check-ins.
// ---------------------------------------------------------------
const { TYPES, MAX_ABS } = require('./rules');

function text(value, label, min, max) {
    if (value === undefined || value === null || value === '') return `${label} is required.`;
    if (typeof value !== 'string') return `${label} must be text.`;
    const len = value.trim().length;
    if (len < min || len > max) return `${label} must be between ${min} and ${max} characters.`;
    return null;
}

// A real number: "5" (text), NaN, Infinity, true or {} are refused
function number(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number.`;
    if (Math.abs(value) > MAX_ABS) return `${label} is too large.`;
    return null;
}

/**
 * Checks a full key result (after merging an edit into the stored one, or a new one).
 * K1: title 3-80, unit 1-20, type, start and target are numbers and differ,
 *     a percentage stays within 0-100, weight is a whole number 1-5.
 */
function checkShape(kr) {
    const errors = [];
    const t = text(kr.title, 'Title', 3, 80); if (t) errors.push(t);
    if (!TYPES.includes(kr.type)) errors.push(`Type must be one of: ${TYPES.join(', ')}.`);
    if (kr.type !== 'milestone') {
        const u = text(kr.unit, 'Unit', 1, 20); if (u) errors.push(u);
        const s = number(kr.start, 'Start'); if (s) errors.push(s);
        const g = number(kr.target, 'Target'); if (g) errors.push(g);
        if (!s && !g && kr.start === kr.target) errors.push('Target must be different from start.');
        if (kr.type === 'percentage' && !s && !g && [kr.start, kr.target].some((n) => n < 0 || n > 100)) {
            errors.push('A percentage must be between 0 and 100.');
        }
    }
    if (!Number.isInteger(kr.weight) || kr.weight < 1 || kr.weight > 5) errors.push('Weight must be a whole number from 1 to 5.');
    return errors;
}

// A milestone is done or not done: always 0 -> 1, unit "done"
function normalise(kr) {
    if (kr.type === 'milestone') return { ...kr, unit: 'done', start: 0, target: 1 };
    return kr;
}

/** New key result. Returns { errors } or { value: clean fields }. */
function validateNew(body) {
    const b = body || {};
    const kr = normalise({
        title: b.title,
        type: b.type,
        unit: b.unit,
        start: b.start,
        target: b.target,
        weight: b.weight === undefined ? 1 : b.weight
    });
    const errors = checkShape(kr);
    if (errors.length) return { errors };
    return { value: { ...kr, title: kr.title.trim(), unit: kr.unit.trim() } };
}

const EDITABLE = ['title', 'type', 'unit', 'start', 'target', 'weight'];

/**
 * Edit: any of title, type, unit, start, target, weight. At least one must be sent.
 * Returns { errors } or { changes: only what really changes, merged: the full result }.
 */
function validateEdit(body, stored) {
    const b = body || {};
    const sent = EDITABLE.filter((k) => k in b);
    if (sent.length === 0) return { errors: [`Send at least one of: ${EDITABLE.join(', ')}.`] };

    const merged = normalise({ ...pick(stored, EDITABLE), ...pick(b, sent) });
    const errors = checkShape(merged);
    if (errors.length) return { errors };
    merged.title = merged.title.trim();
    merged.unit = merged.unit.trim();

    const changes = {};
    EDITABLE.forEach((k) => { if (merged[k] !== stored[k]) changes[k] = merged[k]; });
    return { changes, merged };
}

const GOAL_ID = /^G-[0-9a-f-]{36}$/;
const KR_ID = /^KR-[0-9a-f-]{36}$/;
function isGoalId(id) { return typeof id === 'string' && GOAL_ID.test(id); }
function isKrId(id) { return typeof id === 'string' && KR_ID.test(id); }

function pick(obj, keys) { return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]])); }

module.exports = { validateNew, validateEdit, isGoalId, isKrId };
