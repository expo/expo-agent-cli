// @ref llp/0028-command-telemetry.rfc.md
import * as ciInfo from 'ci-info';
import { boolish } from 'getenv';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { detectSandbox } from 'sandbox-cli-detector';

import { getAgentTelemetryContext } from '../utils/agent';
import { getTelemetryIdentityAsync } from './identity';
import type { CommandTelemetry } from './types';

export const TELEMETRY_TIMEOUT_MS = 3_000;

/** Runs only in the detached worker. Delivery is best effort, with no retries. */
export async function sendCommandTelemetryAsync(data: CommandTelemetry): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (boolish('EXPO_NO_TELEMETRY', false) || boolish('EXPO_OFFLINE', false)) return;

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    const identity = await getTelemetryIdentityAsync();
    const agent = getAgentTelemetryContext();
    const sandboxProvider = getSandboxProvider();
    const target =
      boolish('EXPO_STAGING', false) || boolish('EXPO_LOCAL', false)
        ? '24TKICqYKilXM480mA7ktgVDdea'
        : '24TKR7CQAaGgIrLTgu3Fp4OdOkI';
    const sentAt = new Date().toISOString();

    const response = await fetch('https://cdp.expo.dev/v1/batch', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': `expo-agent-cli/${data.version}`,
        authorization: `Basic ${Buffer.from(`${target}:`).toString('base64')}`,
      },
      body: JSON.stringify({
        sentAt,
        batch: [
          {
            type: 'track',
            event: 'action',
            ...identity,
            messageId: randomUUID(),
            sentAt,
            originalTimestamp: data.timestamp,
            properties: { action: `expo-agent-cli ${data.command}` },
            context: {
              sessionId: randomUUID(),
              app: { name: 'expo/agent-cli', version: data.version },
              os: { name: os.platform(), version: os.release(), node: process.versions.node },
              device: { arch: os.arch() },
              ...(ciInfo.isCI ? { ci: { name: ciInfo.name, isPr: ciInfo.isPR } } : {}),
              ...(agent ? { agent } : {}),
              ...(sandboxProvider ? { sandbox_provider: sandboxProvider } : {}),
              client: { mode: 'detached' },
            },
          },
        ],
      }),
    });
    // No response data is used. Release the connection even if a server streams its body.
    await response.body?.cancel();
  } catch {
    // Telemetry must never print errors or affect a command's output or exit status.
  } finally {
    clearTimeout(timer);
  }
}

function getSandboxProvider(): string | undefined {
  try {
    const { detected, sandbox } = detectSandbox();
    return detected && sandbox ? sandbox.id : undefined;
  } catch {
    return undefined;
  }
}
