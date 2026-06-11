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

export type Stage = 'Off' | 'Washing' | 'Rinsing' | 'Spinning' | 'Heating' | 'Drying' | 'Cooling' | 'Paused' | 'Done'

export type TransitionTable = Record<string, Partial<Record<StageEvent, Stage>>>

// Entries mapping to the same state are expected repeats (silent no-ops).
// Missing entries are illegal events: ignored, dedup-logged.
export const WASHER_TABLE: TransitionTable = {
    Off: { cycleActive: 'Washing', standby: 'Off', offTimeout: 'Off' },
    Washing: { cycleActive: 'Washing', rinsePhase: 'Rinsing', spinPhase: 'Spinning', ended: 'Done', standby: 'Off' },
    Rinsing: { cycleActive: 'Rinsing', rinsePhase: 'Rinsing', spinPhase: 'Spinning', ended: 'Done', standby: 'Off' },
    Spinning: { cycleActive: 'Spinning', spinPhase: 'Spinning', ended: 'Done', standby: 'Off' },
    // Entry into Paused is guarded in dispatch (ACTIVE_STATES check), not table-driven.
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
    // Entry into Paused is guarded in dispatch (ACTIVE_STATES check), not table-driven.
    Paused: { paused: 'Paused', ended: 'Done', standby: 'Off' },
    Done: { ended: 'Done', standby: 'Off', offTimeout: 'Off', cycleActive: 'Heating' },
}

const ACTIVE_STATES = new Set<Stage>(['Washing', 'Rinsing', 'Spinning', 'Heating', 'Drying', 'Cooling'])

export class StageFSM {
    private state: Stage
    private pausedFrom: Stage | null = null
    // Last-seen dedup key (not a set); suppresses repeated identical illegal-event log lines.
    private lastIllegal = ''

    constructor(
        private readonly id: string,
        private readonly table: TransitionTable,
        initial: Stage,
        private readonly onChange: (stage: Stage) => void,
    ) {
        this.state = initial
    }

    get stage(): Stage {
        return this.state
    }

    dispatch(event: StageEvent) {
        let next: Stage | undefined

        if (event === 'paused' && ACTIVE_STATES.has(this.state)) {
            this.pausedFrom = this.state
            next = 'Paused'
        } else if (this.state === 'Paused' && event === 'cycleActive') {
            // pausedFrom is set when paused via dispatch; it is null when the FSM is
            // constructed with initial='Paused' (persisted paused cycle restored after
            // restart). In that case we fall back to Off.cycleActive — the cycle-start
            // stage — as the safe restart point, since we lost the pre-pause stage.
            next = this.pausedFrom ?? this.table.Off?.cycleActive
            if (next === undefined) {
                log(
                    'status',
                    this.id,
                    `illegal stage event '${event}' in stage 'Paused' — Off.cycleActive missing from table`,
                )
                return
            }
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
