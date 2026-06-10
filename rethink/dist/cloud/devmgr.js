import { TypedEmitter } from 'tiny-typed-emitter';
export class DeviceManager extends TypedEmitter {
    constructor() {
        super(...arguments);
        // Treat as read-only outside this class; use getDevice() for single lookups.
        this.allDevices = {};
    }
    getDevice(id) {
        return this.allDevices[id];
    }
    accept(device) {
        this.allDevices[device.id] = device;
        device.on('close', () => {
            if (this.allDevices[device.id] === device) {
                delete this.allDevices[device.id];
                this.emit('dropDevice', device.id);
            }
        });
        this.emit('newDevice', device);
    }
}
