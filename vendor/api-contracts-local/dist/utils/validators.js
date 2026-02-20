export function isUuidV4(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function isMonotonicSequence(next, current) {
    return Number.isInteger(next) && Number.isInteger(current) && next > current;
}
