export default class HADevice {
    static config(meta, deviceInfo) {
        return {
            availability: [{ topic: '$this/availability' }, { topic: '$rethink/availability' }],
            availability_mode: 'all',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: meta.modelName,
                sw_version: meta.swVersion,
                ...(deviceInfo || {}),
            },
            origin: {
                name: 'rethink',
                support_url: 'https://github.com/anszom/rethink',
            },
            components: {},
        };
    }
    constructor(HA, id) {
        this.HA = HA;
        this.id = id;
    }
    setConfig(config) {
        this.config = config;
        this.publishConfig();
    }
    drop() {
        this.HA.publishProperty(this.id, 'availability', 'offline');
    }
    start() { }
    // HA-side
    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', 'online');
            this.HA.publishConfig(this.id, this.config);
        }
    }
    setProperty(_prop, _mqttValue) {
        // read-only device: override in subclasses that accept commands
    }
}
