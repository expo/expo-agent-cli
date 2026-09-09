// @ref llp/0002-testing-and-evals.plan.md
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { onTestFinished } from 'vitest';
import { createHarness } from 'vitest-evals';
import { runLoop, type CommandResult, type LoopEvent } from './loop';
import { chat, identifyModel } from './ollama';
import { runProcess } from './process';
import { artifactRoot, cliBin, copyWorkspace, packageRoot, snapshot } from './workspace';

export type EvalInput = {
  id: string;
  prompt: string;
  fixture: string;
  linkDependencies?: boolean;
  maxTurns?: number;
};
export type EvalOutput = {
  root: string;
  before: Record<string, string>;
  commands: CommandResult[];
  summary: string;
  turns: number;
};

export const cliHarness = createHarness<EvalInput, EvalOutput>({
  name: 'ollama-cli',
  async run({ input, signal: parentSignal, setArtifact }) {
    if (!/^[a-z0-9-]+$/.test(input.id)) throw new Error('Eval id must be kebab-case');
    const signal = AbortSignal.any([
      AbortSignal.timeout(180_000),
      ...(parentSignal ? [parentSignal] : []),
    ]);
    const root = copyWorkspace(input.fixture, input.linkDependencies);
    fs.mkdirSync(artifactRoot, { recursive: true });
    const artifacts = fs.mkdtempSync(path.join(artifactRoot, `${input.id}-`));
    const events: LoopEvent[] = [];
    const before = snapshot(root);
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-home-'));
    const started = Date.now();
    const write = (name: string, value: unknown) =>
      fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value, null, 2));
    onTestFinished(() => {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
      write('workspace.json', { before, after: snapshot(root) });
      if (process.env.AGENT_CLI_EVAL_KEEP !== '1')
        fs.rmSync(root, { recursive: true, force: true });
    });
    setArtifact('artifactDirectory', artifacts);
    setArtifact('prompt', input.prompt);
    const env = {
      ...process.env,
      // Child processes get an empty user profile; local agent installs cannot alter detection.
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
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      if (process.env.AGENT_CLI_EVAL_DRY === '1') {
        return {
          output: { root, before, commands: [], summary: '', turns: 0 },
          events: [{ type: 'message', role: 'user', content: input.prompt }],
          artifacts: { dry: true },
        };
      }
      const identity = await identifyModel(signal);
      const help = await runProcess(process.execPath, [cliBin, '--help'], {
        cwd: root,
        env,
        signal,
      });
      if (help.exitCode !== 0 || help.timedOut) throw new Error('CLI help could not be loaded');
      const metadata = {
        ...identity,
        node: process.version,
        cliVersion: JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
          .version,
        commit: process.env.GITHUB_SHA ?? null,
        options: {
          think: false,
          temperature: 0,
          seed: 42,
          num_predict: 512,
          num_ctx: 8192,
        },
      };
      write('metadata.json', metadata);
      setArtifact('versions', metadata);
      const outcome = await runLoop({
        prompt: input.prompt,
        help: help.stdout,
        signal,
        maxTurns: input.maxTurns,
        chat: async (messages) => {
          const reply = await chat(messages, signal, (request, response) => {
            const usage = response as {
              prompt_eval_count?: number;
              eval_count?: number;
            };
            inputTokens += Number(usage.prompt_eval_count ?? 0);
            outputTokens += Number(usage.eval_count ?? 0);
            fs.appendFileSync(
              path.join(artifacts, 'inference.jsonl'),
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
          fs.appendFileSync(path.join(artifacts, 'trace.jsonl'), `${JSON.stringify(event)}\n`);
        },
      });
      write('outcome.json', {
        status: 'completed',
        ...outcome,
        durationMs: Date.now() - started,
        inputTokens,
        outputTokens,
      });
      return {
        output: { root, before, ...outcome },
        events,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
    } catch (error) {
      write('outcome.json', {
        status: signal.aborted ? 'timeout' : 'error',
        error: String(error),
        inputTokens,
        outputTokens,
        durationMs: Date.now() - started,
      });
      setArtifact('partialTrace', events);
      throw error;
    }
  },
});
