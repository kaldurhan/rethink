import WTDN3 from './devices/WTDN3.js';
import RAC_056905_WW from './devices/RAC_056905_WW.js';
import WIN_056905_WW from './devices/WIN_056905_WW.js';
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4.js';
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2.js';
import Dev_2REB1GLVB1__2 from './devices/2REB1GLVB1__2.js';
import Dev_2RES1VE600FWC from './devices/2RES1VE600FWC.js';
import RH90V9_WW from './devices/RH90V9_WW.js';
import RHX7009TWS from './devices/RHX7009TWS.js';
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK.js';
import F_V8_Y___W_B_2QEUK from './devices/F_V8_Y___W.B_2QEUK.js';
import F_V__F___W_B_1QEUK from './devices/F_V__F___W.B_1QEUK.js';
import VCDWL2QEUK from './devices/VCDWL2QEUK.js';
const t1deviceTypes = {
    WTDN3,
};
const t2deviceTypes = {
    RAC_056905_WW,
    WIN_056905_WW,
    RH90V9_WW,
    ['SDH_X7_7008']: RHX7009TWS,
    ['2REF11EIDA__4']: Dev_2REF11EIDA__4,
    ['2RES1VE61NFA2']: Dev_2RES1VE61NFA2,
    ['2REB1GLVB1__2']: Dev_2REB1GLVB1__2,
    ['2RES1VE600FWC']: Dev_2RES1VE600FWC,
    ['Y_V8_Y___W.B32QEUK']: Y_V8_Y___W_B32QEUK,
    ['F_V8_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK,
    ['F_V__Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    ['F_V__F___W.B_1QEUK']: F_V__F___W_B_1QEUK,
    ['VCDWL2QEUK']: VCDWL2QEUK,
};
class Bridge {
    constructor(HA) {
        this.HA = HA;
        this.haDevices = new Map();
        HA.on('discovery', () => {
            this.haDevices.forEach((ha) => ha.publishConfig());
        });
        HA.on('setProperty', (id, prop, value) => {
            const ha = this.haDevices.get(id);
            if (ha)
                ha.setProperty(prop, value);
        });
    }
    newDevice(thinqdev) {
        const meta = thinqdev.meta;
        const oldDevice = this.haDevices.get(thinqdev.id);
        if (oldDevice)
            oldDevice.drop();
        let hadevice;
        if (thinqdev.platform === 'thinq1') {
            const devclass = t1deviceTypes[meta.modelId];
            if (devclass)
                hadevice = new devclass(this.HA, thinqdev, meta);
        }
        else if (thinqdev.platform === 'thinq2') {
            const devclass = t2deviceTypes[meta.modelId];
            if (devclass)
                hadevice = new devclass(this.HA, thinqdev, meta);
        }
        if (!hadevice) {
            console.warn(`${thinqdev.platform} device type ${meta.modelId} unknown`);
            return;
        }
        this.haDevices.set(thinqdev.id, hadevice);
        thinqdev.on('close', () => this.dropDevice(hadevice));
        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        hadevice.start();
    }
    dropDevice(ha) {
        if (this.haDevices.get(ha.id) === ha) {
            this.haDevices.delete(ha.id);
            ha.drop();
        }
    }
}
export default Bridge;
