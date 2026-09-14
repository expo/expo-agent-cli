// @ref llp/0002-testing-and-evals.plan.md
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAgentEval, type AgentRunner, type ProjectSetup } from '@expo/agent-eval-vitest';
import { runLoop, type CommandResult, type LoopEvent, AgentAttemptError } from './loop';
import { chat, identifyModel } from './ollama';
import { runProcess } from './process';
import { artifactRoot, cliBin, copyWorkspace, packageRoot, snapshot } from './workspace';

export type FixtureContext = {
  root: string;
  artifacts: string;
  env: NodeJS.ProcessEnv;
};
export type FixtureSession = {
  close?: () => Promise<void>;
  evidence?: () => unknown;
};
export type EvalInput = {
  fixture: string;
  linkDependencies?: boolean;
  setupProject?: (context: FixtureContext) => Promise<FixtureSession>;
};
export type EvalOutput = {
  root: string;
  before: Record<string, string>;
  commands: CommandResult[];
  summary: string;
  turns: number;
  cliEvents: Record<string, unknown>[];
  fixtureEvidence: unknown;
};
export type CliFixture = { output: () => EvalOutput };
type Prepared = {
  env: NodeJS.ProcessEnv;
  output: EvalOutput;
};
const prepared = new Map<string, Prepared>();

/** The kit owns the workspace and lifecycle; this adapter prepares CLI-specific context. */
export function setupProject(input: EvalInput): ProjectSetup<CliFixture> {
  return {
    async prepareAsync({ root, artifactsDir: artifacts, onCleanup }) {
      copyWorkspace(input.fixture, input.linkDependencies, root);
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-home-'));
      onCleanup(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));
      const env = {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
        GROK_HOME: '',
        CI: '1',
        NO_COLOR: '1',
        npm_config_user_agent: '',
        npm_execpath: '',
        LOG_EVENTS: path.join(artifacts, 'cli-events.jsonl'),
      };
      const session = await input.setupProject?.({ root, artifacts, env });
      if (session?.close) onCleanup(session.close);
      const output: EvalOutput = {
        root,
        before: snapshot(root),
        commands: [],
        summary: '',
        turns: 0,
        cliEvents: [],
        fixtureEvidence: null,
      };
      // Human fixture preparation is not agent evidence.
      fs.writeFileSync(env.LOG_EVENTS, '');
      prepared.set(root, { env, output });
      onCleanup(() => {
        prepared.delete(root);
      });
      const readOutput = () => {
        output.cliEvents = fs
          .readFileSync(env.LOG_EVENTS, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        output.fixtureEvidence = session?.evidence?.() ?? null;
        return output;
      };
      onCleanup(() => {
        fs.writeFileSync(
          path.join(artifacts, 'workspace.json'),
          JSON.stringify(
            {
              before: output.before,
              after: snapshot(root),
            },
            null,
            2
          )
        );
        fs.writeFileSync(
          path.join(artifacts, 'fixture-evidence.json'),
          JSON.stringify(readOutput().fixtureEvidence, null, 2)
        );
      });
      return { output: readOutput };
    },
  };
}

/** Preserve the native tool-call protocol and pinned inference settings used by Tier 1. */
export const cliRunner: AgentRunner = async ({ prompt, root, artifactsDir, signal }) => {
  const state = prepared.get(root);
  if (!state) throw new Error('CLI runner requires setupProject');
  const { env, output } = state;
  const events: LoopEvent[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const identity = await identifyModel(signal);
  const help = await runProcess(process.execPath, [cliBin, '--help'], { cwd: root, env, signal });
  if (help.exitCode !== 0 || help.timedOut) throw new Error('CLI help could not be loaded');
  const metadata = {
    ...identity,
    node: process.version,
    cliVersion: JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version,
    commit: process.env.GITHUB_SHA ?? null,
    options: { think: false, temperature: 0, seed: 42, num_predict: 512, num_ctx: 8192 },
  };
  fs.writeFileSync(path.join(artifactsDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  let endReason: 'completed' | 'failed' | 'timeout' | 'budget-exhausted' = 'completed';
  let error: string | undefined;
  try {
    Object.assign(
      output,
      await runLoop({
        prompt,
        help: help.stdout,
        signal,
        chat: async (messages) => {
          output.turns++;
          const reply = await chat(messages, signal, (request, response) => {
            const usage = response as { prompt_eval_count?: number; eval_count?: number };
            inputTokens += Number(usage.prompt_eval_count ?? 0);
            outputTokens += Number(usage.eval_count ?? 0);
            fs.appendFileSync(
              path.join(artifactsDir, 'inference.jsonl'),
              `${JSON.stringify({ request, response })}\n`
            );
          });
          return reply.content;
        },
        execute: (argv) =>
          runProcess(process.execPath, [cliBin, ...argv], {
            cwd: root,
            env,
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          }),
        record: (event) => {
          events.push(event);
          if (event.type === 'tool_result') output.commands.push(event.content);
          fs.appendFileSync(path.join(artifactsDir, 'trace.jsonl'), `${JSON.stringify(event)}\n`);
        },
      })
    );
  } catch (cause) {
    if (!(cause instanceof AgentAttemptError)) throw cause;
    endReason = cause.endReason;
    error = cause.message;
  }
  return {
    finalAnswer: output.summary,
    toolCalls: events
      .filter((event) => event.type === 'tool_result')
      .map((event) => ({
        id: event.toolCallId,
        name: event.name,
        input: { argv: event.content.argv },
        result: event.content,
      })),
    endReason,
    artifacts: ['metadata.json', 'inference.jsonl', 'trace.jsonl', 'cli-events.jsonl'],
    metadata: {
      ...metadata,
      inputTokens,
      outputTokens,
      turns: output.turns,
      ...(error ? { error } : {}),
    },
  };
};

export const agentEval = createAgentEval({
  runner: cliRunner,
  timeoutMs: 240_000,
  artifactsDir: artifactRoot,
  dryRun: process.env.AGENT_CLI_EVAL_DRY === '1',
  keepWorkspace: process.env.AGENT_CLI_EVAL_KEEP === '1',
});
