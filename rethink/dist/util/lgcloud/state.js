// (De)serialization of the lgcloud cloud State to disk. This is the persistence side that
// monitor.ts deliberately leaves to its callers: load a complete State or nothing, and
// save a State as a whole.
import * as fs from 'node:fs';
export const DEFAULT_STATE_FILE = '/data/oauth.json';
// Returns a State only if the file exists and is complete; a missing, partial or corrupt
// file yields undefined ("not logged in").
export function loadState(path = DEFAULT_STATE_FILE) {
    try {
        const s = JSON.parse(fs.readFileSync(path, 'utf-8'));
        if (s.countryCode && s.refreshToken)
            return s;
    }
    catch { }
    return undefined;
}
export function saveState(state, path = DEFAULT_STATE_FILE) {
    fs.writeFileSync(path, JSON.stringify(state));
}
