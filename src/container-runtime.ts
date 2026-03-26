/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`;
}

/** Ensure the container runtime is running, starting it if needed.
 *  On macOS, Docker Desktop may take up to 60 s to become ready after login.
 *  We retry every 5 s for up to 60 s before giving up.
 */
export function ensureContainerRuntimeRunning(): void {
  const MAX_WAIT_MS = 60_000;
  const POLL_MS = 5_000;
  const deadline = Date.now() + MAX_WAIT_MS;

  // On macOS, attempt to open Docker Desktop if the socket is missing.
  if (os.platform() === 'darwin') {
    try {
      execSync('open -a Docker', { stdio: 'pipe' });
    } catch {
      // Docker may already be running or not installed — ignore.
    }
  }

  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.debug('Container runtime ready');
      return;
    } catch (err) {
      lastErr = err;
      const remaining = Math.round((deadline - Date.now()) / 1000);
      logger.warn(`Container runtime not ready, retrying (${remaining}s left)…`);
      // Synchronous sleep — acceptable at startup before the event loop is busy.
      execSync(`sleep ${POLL_MS / 1000}`, { stdio: 'pipe' });
    }
  }

  logger.error({ err: lastErr }, 'Failed to reach container runtime after 60 s');
  console.error(
    '\n╔════════════════════════════════════════════════════════════════╗',
  );
  console.error(
    '║  FATAL: Container runtime failed to start                      ║',
  );
  console.error(
    '║                                                                ║',
  );
  console.error(
    '║  Agents cannot run without a container runtime. To fix:        ║',
  );
  console.error(
    '║  1. Ensure Docker is installed and running                     ║',
  );
  console.error(
    '║  2. Run: docker info                                           ║',
  );
  console.error(
    '║  3. Restart NanoClaw                                           ║',
  );
  console.error(
    '╚════════════════════════════════════════════════════════════════╝\n',
  );
  throw new Error('Container runtime is required but failed to start', {
    cause: lastErr,
  });
}

/** Wait for the OneCLI gateway to become reachable, then start its compose stack if needed.
 *  Retries every 5 s for up to 60 s. On macOS, attempts `docker compose up -d` if the gateway
 *  doesn't respond, which covers the case where Docker started but the compose stack didn't.
 */
export async function ensureOneCLIRunning(onecliUrl: string): Promise<void> {
  const MAX_WAIT_MS = 60_000;
  const POLL_MS = 5_000;
  const deadline = Date.now() + MAX_WAIT_MS;
  const composeFile = path.join(os.homedir(), '.onecli', 'docker-compose.yml');

  const isReachable = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${onecliUrl}/api/health`, {
        signal: AbortSignal.timeout(4000),
      });
      return res.ok || res.status === 401; // 401 = gateway up but auth required
    } catch {
      return false;
    }
  };

  if (await isReachable()) {
    logger.debug('OneCLI gateway already reachable');
    return;
  }

  // Try to start the compose stack, then poll until ready.
  if (existsSync(composeFile)) {
    logger.info('OneCLI gateway not reachable — starting compose stack…');
    try {
      execSync(`docker compose -f "${composeFile}" up -d`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch (err) {
      logger.warn({ err }, 'docker compose up failed, will keep polling');
    }
  }

  while (Date.now() < deadline) {
    if (await isReachable()) {
      logger.info('OneCLI gateway ready');
      return;
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    logger.warn(`OneCLI gateway not ready, retrying (${remaining}s left)…`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  logger.warn(
    'OneCLI gateway did not become reachable within 60 s — containers will start without credentials',
  );
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
