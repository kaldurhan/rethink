import { TypedEmitter } from 'tiny-typed-emitter';
import { splitter, make as makeFrame } from '../../util/length_prefixed_frame.js';
import log from '../../util/logging.js';
// the device sends 'alive' packets every 60s
const IDLE_TIMEOUT = 90 * 1000;
export class Connection extends TypedEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        let timeout;
        const onTimeout = () => this.socket.destroy();
        timeout = setTimeout(onTimeout, IDLE_TIMEOUT);
        this.socket.on('data', splitter((payload) => {
            clearTimeout(timeout);
            timeout = setTimeout(onTimeout, IDLE_TIMEOUT);
            try {
                const str = payload.toString('utf-8');
                log('incoming', str);
                const request = JSON.parse(str);
                const id = request.Header['x-lgedm-deviceId'];
                if (!this.id) {
                    this.id = id;
                    this.emit('init', id);
                }
                if (request?.Body?.Format === 'B64' && typeof request.Body.Data === 'string') {
                    this.emit('status', Buffer.from(request.Body.Data, 'base64'));
                }
                if (request?.Body?.ReturnCode === undefined) {
                    // send ack
                    this.json({
                        Header: { 'x-lgedm-deviceId': id },
                        Body: { CmdWId: request?.Body?.CmdWId, ReturnCode: '0000' },
                    });
                }
            }
            catch (err) {
                console.log(err);
            }
        }));
        this.socket.on('close', () => {
            clearTimeout(timeout);
            this.emit('close');
        });
        this.socket.on('error', (err) => this.emit('error', err));
    }
    json(json) {
        this.socket.write(makeFrame(JSON.stringify(json)));
    }
    destroy() {
        this.socket.destroy();
    }
}
