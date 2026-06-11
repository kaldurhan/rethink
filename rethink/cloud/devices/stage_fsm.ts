import log from '@/util/logging'

export type StageEvent =
    | 'cycleActive'
    | 'rinsePhase'
    | 'spinPhase'
    | 'heatPhase'
    | 'dryPhase'
    | 'coolPhase'
    | 'paused'
    | 'ended'
    | 'standby'
    | 'offTimeout'

export type TransitionTable = Record<string, Partial<Record<StageEvent, string>>>

// Entries mapping to the same state are expected repeats (silent no-ops).
// Missing entries are illegal events: ignored, dedup-logged.
export const WASHER_TABLE: TransitionTable = {
    Off: { cycleActive: 'Washing', standby: 'Off', offTimeout: 'Off' },
    Washing: { cycleActive: 'Washing', rinsePhase: 'Rinsing', spinPhase: 'Spinning', ended: 'Done', standby: 'Off' },
    Rinsing: { cycleActive: 'Rinsing', rinsePhase: 'Rinsing', spinPhase: 'Spinning', ended: 'Done', standby: 'Off' },
    Spinning: { cycleActive: 'Spinning', spinPhase: 'Spinning', ended: 'Done', standby: 'Off' },
    Paused: { paused: 'Paused', ended: 'Done', standby: 'Off' },
    Done: { ended: 'Done', standby: 'Off', offTimeout: 'Off', cycleActive: 'Washing' },
}

export const DRYER_TABLE: TransitionTable = {
    Off: { cycleActive: 'Heating', standby: 'Off', offTimeout: 'Off' },
    Heating: {
        cycleActive: 'Heating',
        heatPhase: 'Heating',
        dryPhase: 'Drying',
        coolPhase: 'Cooling',
        ended: 'Done',
        standby: 'Off',
    },
    Drying: {
        cycleActive: 'Drying',
        heatPhase: 'Heating',
        dryPhase: 'Drying',
        coolPhase: 'Cooling',
        ended: 'Done',
        standby: 'Off',
    },
    Cooling: { cycleActive: 'Cooling', coolPhase: 'Cooling', ended: 'Done', standby: 'Off' },
    Paused: { paused: 'Paused', ended: 'Done', standby: 'Off' },
    Done: { ended: 'Done', standby: 'Off', offTimeout: 'Off', cycleActive: 'Heating' },
}

const ACTIVE_STATES = new Set(['Washing', 'Rinsing', 'Spinning', 'Heating', 'Drying', 'Cooling'])

export class StageFSM {
    private state: string
    private pausedFrom: string | null = null
    private lastIllegal = ''

    constructor(
        private readonly id: string,
        private readonly table: TransitionTable,
        initial: string,
        private readonly onChange: (stage: string) => void,
    ) {
        this.state = initial
    }

    get stage(): string {
        return this.state
    }

    dispatch(event: StageEvent) {
        let next: string | undefined

        if (event === 'paused' && ACTIVE_STATES.has(this.state)) {
            this.pausedFrom = this.state
            next = 'Paused'
        } else if (this.state === 'Paused' && event === 'cycleActive') {
            next = this.pausedFrom ?? this.table.Off?.cycleActive
        } else {
            next = this.table[this.state]?.[event]
        }

        if (next === undefined) {
            const key = `${this.state}:${event}`
            if (key !== this.lastIllegal) {
                log('status', this.id, `illegal stage event '${event}' in stage '${this.state}' — ignored`)
                this.lastIllegal = key
            }
            return
        }
        if (next !== this.state) {
            this.state = next
            if (next !== 'Paused') this.pausedFrom = null
            this.onChange(next)
        }
    }
}
