import { spawn } from 'node:child_process';
import { binary, configure, gatewayEnv, lockPath } from './config.js';

await configure();
const cli = spawn('flock', ['-s', lockPath, binary, ...process.argv.slice(2)], {
  env: gatewayEnv(), stdio: 'inherit',
});
cli.on('error', error => { console.error(error.message); process.exitCode = 1; });
cli.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
