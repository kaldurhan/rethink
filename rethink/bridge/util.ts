import { spawn } from 'node:child_process'

export function subprocess(command: string, args: string[], stdin: string = ''): Promise<string> {
    return new Promise((resolve, reject) => {
        const subprocess = spawn(command, args)
        const out: Buffer[] = []
        const err: Buffer[] = []
        subprocess.stdout.on('data', (data: Buffer) => out.push(data))
        subprocess.stderr.on('data', (data: Buffer) => err.push(data))
        subprocess.on('close', (code) => {
            if (code !== 0) {
                const stderr = Buffer.concat(err).toString('utf-8').trim()
                reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr}` : ''}`))
                return
            }
            resolve(Buffer.concat(out).toString('utf-8'))
        })
        subprocess.on('error', reject)
        subprocess.stdin.end(stdin)
    })
}
