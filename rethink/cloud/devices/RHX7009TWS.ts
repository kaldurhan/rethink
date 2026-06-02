import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'

// ─── Lookup tables ──────────────────────────────────────────────────────────
// TODO: fill in from packet captures.
// Protocol appears to be the same RH-series A/B block format as RH90V9_WW:
//   inner(56): header(4: 30 EC 00 ??) + A block(26) + B block(26)
//   B block: B[0]=0x?? marker, Bd=B[1..25] = authoritative state
//
// Fields to confirm via captures:
//   Bd[0]  — run state
//   Bd[1]  — remain hours
//   Bd[2]  — remain minutes
//   Bd[3]  — initial hours
//   Bd[4]  — initial minutes
//   Bd[5]  — cycle/programme ID
//   Bd[6]  — error code
//   Bd[7]  — dry level
//   Bd[9]  — process state

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, _meta: Metadata) {
        super(HA, thinq)
    }

    processAABB(inner: Buffer) {
        // TODO: implement once packet captures are available.
        // Expected header bytes: inner[0]=0x30, inner[1]=0xEC (same as RH90V9_WW).
        // Verify inner.length and header before decoding.
        void inner
    }
}
