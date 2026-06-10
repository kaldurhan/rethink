/**
 * @deprecated ComponentInfo now has an index signature — extra fields no longer
 * need this wrapper. Remove call sites and delete this function once clear.
 */
export function allowExtendedType<T, Q extends T>(t: Q): T {
    return t
}
