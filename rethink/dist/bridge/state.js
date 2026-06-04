import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
export class JSONStorage {
    constructor(basePath) {
        this.basePath = basePath;
    }
    oauth2Path() {
        return `${this.basePath}/oauth2.json`;
    }
    devicePath(id) {
        return `${this.basePath}/device_${id}.json`;
    }
    getCredentials() {
        try {
            return JSON.parse(readFileSync(this.oauth2Path()).toString('utf-8'));
        }
        catch (err) {
            return undefined;
        }
    }
    setCredentials(credentials) {
        if (credentials)
            writeFileSync(this.oauth2Path(), JSON.stringify(credentials));
        else
            unlinkSync(this.oauth2Path());
    }
    getDeviceState(id) {
        try {
            return JSON.parse(readFileSync(this.devicePath(id)).toString('utf-8'));
        }
        catch (err) {
            return undefined;
        }
    }
    setDeviceState(id, state) {
        if (state)
            writeFileSync(this.devicePath(id), JSON.stringify(state));
        else
            unlinkSync(this.devicePath(id));
    }
}
