/** Spawn/await the target app for self-contained evidence generation. */
import { spawn, type ChildProcess } from 'node:child_process';

export interface AppHandle {
  child: ChildProcess;
  kill: () => void;
}

export function spawnTargetApp(tenant: string, port: number): AppHandle {
  const child = spawn('npx', ['tsx', 'src/target-app/index.ts'], {
    env: { ...process.env, TENANT: tenant, PORT: String(port) },
    stdio: 'ignore',
    shell: true,
  });
  return { child, kill: () => child.kill() };
}

export async function waitForHttp(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function harnessPost(base: string, path: string, body: unknown): Promise<void> {
  await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
