import { spawn } from 'node:child_process';
export function subprocess(command, args, stdin = '') {
    return new Promise((resolve, reject) => {
        const subprocess = spawn(command, args);
        const out = [];
        subprocess.stdout.on('data', (data) => {
            out.push(data);
        });
        subprocess.on('close', (code) => {
            resolve(Buffer.concat(out).toString('utf-8'));
        });
        subprocess.on('error', reject);
        subprocess.stdin.end(stdin);
    });
}
