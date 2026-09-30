// @ref llp/0029-feedback.rfc.md
// Ports submit-expo-feedback's request and metadata fields.
import { getConfig, getConfigFilePaths } from '@expo/config';
import { resolvePackageManager } from '@expo/package-manager';
import { detectAgent } from 'agent-cli-detector';
import * as ciInfo from 'ci-info';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { boolish } from 'getenv';
import { homedir } from 'os';
import path from 'path';
import prompts from 'prompts';
import { detectSandbox } from 'sandbox-cli-detector';

import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';

import {
  CLI_FEEDBACK_CATEGORIES,
  CLI_FEEDBACK_MAX_LENGTH,
  CLI_FEEDBACK_MIN_LENGTH,
  type CliFeedbackCategory,
  type CliFeedbackContextMetadata,
  type CliFeedbackMetadata,
  type CliFeedbackProjectMetadata,
  type CliFeedbackRequest,
  type CliFeedbackTelemetryMetadata,
} from './types';

// The receiving service's CLI name allowlist must include this identifier.
const CLI_NAME = 'agent-cli';
const FEEDBACK_TIMEOUT_MS = 15_000;
const GENERATED_FEEDBACK_ID_BYTES = 6;
const MIN_FEEDBACK_ID_LENGTH = 6;
const MAX_FEEDBACK_ID_LENGTH = 64;
const FEEDBACK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const TELEMETRY_DISABLED_MESSAGE =
  'Feedback was not sent because telemetry is off. The user has indicated that they do not want to send feedback. Do not enable telemetry or ask the user to enable it.';

type UserSession = {
  sessionSecret?: string;
};

type PackageJson = {
  name?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

type ConfigFilePaths = {
  staticConfigPath: string | null;
  dynamicConfigPath: string | null;
};

export async function resolveFeedbackAsync(
  messageParts: string[],
  categoryValue?: string,
  messageValue?: string
): Promise<{ category: CliFeedbackCategory; feedback: string }> {
  const category = resolveFeedbackCategory(categoryValue);
  const positionalFeedback = messageParts.join(' ').trim();
  if (messageValue !== undefined && positionalFeedback) {
    throw new FeedbackError(
      'Provide feedback with either --message or a positional argument, not both.'
    );
  }

  if (messageValue !== undefined) {
    const feedback = messageValue.trim();
    validateFeedback(feedback);
    return { category, feedback };
  }

  if (positionalFeedback) {
    validateFeedback(positionalFeedback);
    return { category, feedback: positionalFeedback };
  }

  if (ciInfo.isCI || !process.stdin.isTTY) {
    throw new FeedbackError(
      'Feedback message is required in non-interactive environments. Pass it with --message or -m.'
    );
  }

  const response = await prompts(
    [
      {
        type: categoryValue ? null : 'select',
        name: 'category',
        message: 'What is your feedback about?',
        stdout: process.stderr,
        choices: CLI_FEEDBACK_CATEGORIES.map((value) => ({
          title:
            value === 'unknown'
              ? 'Other / unknown'
              : value === 'evals'
                ? 'evals (a task an AI agent failed at)'
                : value,
          value,
        })),
      },
      {
        type: 'text',
        name: 'feedback',
        message: 'Share feedback with Expo',
        stdout: process.stderr,
        validate: (value) => getFeedbackValidationError(value.trim()) ?? true,
      },
    ],
    {
      onCancel() {
        throw new FeedbackError('Feedback prompt was cancelled.');
      },
    }
  );

  const promptedFeedback = response.feedback?.trim();
  if (!promptedFeedback) {
    throw new FeedbackError('Feedback message cannot be empty.');
  }
  validateFeedback(promptedFeedback);
  return {
    category: response.category ?? category,
    feedback: promptedFeedback,
  };
}

export async function createFeedbackMetadataAsync(
  projectRoot: string,
  category: CliFeedbackCategory = 'unknown',
  subjectValue?: string,
  feedbackIdValue?: string
): Promise<CliFeedbackMetadata> {
  const subject = normalizeSubject(subjectValue);
  const feedbackId = resolveFeedbackId(feedbackIdValue);
  const context: CliFeedbackContextMetadata = {
    category,
    feedbackId,
    ...(subject ? { subject } : {}),
  };

  if (isTelemetryDisabled()) {
    return context;
  }

  return {
    ...context,
    cli: {
      name: CLI_NAME,
      version: getPackageVersion(),
    },
    agentEnvironment: getAgentEnvironment(),
    sandboxEnvironment: getSandboxEnvironment(),
    ci: ciInfo.isCI
      ? {
          name: ciInfo.name ?? null,
          isPr: ciInfo.isPR ?? null,
        }
      : undefined,
    device: {
      arch: process.arch,
      platform: process.platform,
    },
    node: {
      version: process.versions.node,
    },
    packageManager: resolvePackageManager(projectRoot),
    project: getProjectMetadata(projectRoot),
  };
}

function getAgentEnvironment(): CliFeedbackTelemetryMetadata['agentEnvironment'] {
  const result = detectAgent();

  return result.detected && result.agent
    ? {
        detected: true,
        agent: result.agent,
      }
    : { detected: false };
}

function getSandboxEnvironment(): CliFeedbackTelemetryMetadata['sandboxEnvironment'] {
  const result = detectSandbox();

  return result.detected && result.sandbox
    ? {
        detected: true,
        sandbox: result.sandbox,
      }
    : { detected: false };
}

export function getProjectMetadata(projectRoot: string): CliFeedbackProjectMetadata {
  const pkg = getPackageJson(projectRoot);
  const paths = getConfigFilePaths(projectRoot);

  if (!hasExpoProjectConfig(paths, pkg)) {
    return {
      isExpoProject: false,
    };
  }

  try {
    const { exp, pkg: configPkg } = getConfig(projectRoot, {
      skipPlugins: true,
      skipSDKVersionRequirement: true,
    });
    const expoPackageVersion =
      getInstalledPackageVersion(projectRoot, 'expo') ?? getDependencyVersion(configPkg, 'expo');

    return {
      isExpoProject: true,
      name: exp.name,
      slug: exp.slug,
      sdkVersion: exp.sdkVersion,
      platforms: exp.platforms,
      expoPackageVersion,
      reactNativePackageVersion:
        getInstalledPackageVersion(projectRoot, 'react-native') ??
        getDependencyVersion(configPkg, 'react-native'),
      expoRouterPackageVersion:
        getInstalledPackageVersion(projectRoot, 'expo-router') ??
        getDependencyVersion(configPkg, 'expo-router'),
    };
  } catch {
    return {
      isExpoProject: true,
    };
  }
}

function hasExpoProjectConfig(paths: ConfigFilePaths, pkg: PackageJson | null): boolean {
  return (
    !!paths.staticConfigPath ||
    !!paths.dynamicConfigPath ||
    !!(pkg && getDependencyVersion(pkg, 'expo'))
  );
}

function getDependencyVersion(
  pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | null,
  name: string
): string | undefined {
  if (!pkg) {
    return undefined;
  }

  const version = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  return typeof version === 'string' ? version : undefined;
}

function getPackageJson(projectRoot: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function getInstalledPackageVersion(projectRoot: string, packageName: string): string | undefined {
  try {
    const packageJsonPath = getResolvedPackageJsonPath(projectRoot, packageName);
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function getResolvedPackageJsonPath(projectRoot: string, packageName: string): string {
  let currentPath = projectRoot;
  while (true) {
    const packageJsonPath = path.join(currentPath, 'node_modules', packageName, 'package.json');
    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Could not resolve ${packageName}/package.json from ${projectRoot}`);
    }
    currentPath = parentPath;
  }
}

export async function sendFeedbackAsync({
  feedback,
  metadata,
  session,
}: CliFeedbackRequest & {
  session?: UserSession | null;
}): Promise<boolean> {
  validateFeedback(feedback);
  if (isTelemetryDisabled()) {
    console.error(TELEMETRY_DISABLED_MESSAGE);
    return false;
  }

  const request: CliFeedbackRequest = { feedback, metadata };
  let response: Response;
  try {
    response = await fetch(new URL('/v2/feedback/cli-send', getExpoApiBaseUrl()).toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(session),
        'User-Agent': `${CLI_NAME}/${getPackageVersion()}`,
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw new FeedbackError(
      `Failed to send feedback: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    const message = await getErrorMessageAsync(response);
    throw new FeedbackError(message);
  }
  return true;
}

export function getAuthHeaders(session = getSession()): Record<string, string> {
  if (process.env.EXPO_TOKEN) {
    return {
      authorization: `Bearer ${process.env.EXPO_TOKEN}`,
    };
  }

  const sessionSecret = session?.sessionSecret;
  if (sessionSecret) {
    return {
      'expo-session': sessionSecret,
    };
  }

  return {};
}

async function getErrorMessageAsync(response: Response): Promise<string> {
  const fallback = `Failed to send feedback (${response.status} ${response.statusText})`;

  try {
    const json: any = await response.json();
    const message = json?.errors?.[0]?.message;
    return typeof message === 'string' ? message : fallback;
  } catch {
    return fallback;
  }
}

export function getSession(): UserSession | null {
  const statePath = path.join(getExpoHomeDirectory(), 'state.json');
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const contents = JSON.parse(readFileSync(statePath, 'utf8')) as {
      auth?: UserSession | null;
    };
    return contents.auth ?? null;
  } catch {
    return null;
  }
}

export function getExpoHomeDirectory(): string {
  // The command reads its session before evaluating project config.
  const unsafeHome = process.env.__UNSAFE_EXPO_HOME_DIRECTORY;
  if (unsafeHome) {
    return unsafeHome;
  } else if (boolish('EXPO_STAGING', false)) {
    return path.join(homedir(), '.expo-staging');
  } else if (boolish('EXPO_LOCAL', false)) {
    return path.join(homedir(), '.expo-local');
  }
  return path.join(homedir(), '.expo');
}

function getExpoApiBaseUrl(): string {
  if (boolish('EXPO_LOCAL', false) && process.env.EXPO_FEEDBACK_API_BASE_URL) {
    return process.env.EXPO_FEEDBACK_API_BASE_URL;
  } else if (boolish('EXPO_STAGING', false)) {
    return 'https://staging-api.expo.dev';
  } else if (boolish('EXPO_LOCAL', false)) {
    return 'http://127.0.0.1:3000';
  }
  return 'https://api.expo.dev';
}

function resolveFeedbackCategory(value?: string): CliFeedbackCategory {
  const category = value?.trim().toLowerCase() || 'unknown';
  if (CLI_FEEDBACK_CATEGORIES.includes(category as CliFeedbackCategory)) {
    return category as CliFeedbackCategory;
  }
  throw new FeedbackError(
    `Invalid feedback category "${value}". Expected one of: ${CLI_FEEDBACK_CATEGORIES.join(', ')}.`
  );
}

function normalizeSubject(value?: string): string | undefined {
  const subject = value?.trim();
  return subject || undefined;
}

function validateFeedback(feedback: string): void {
  const error = getFeedbackValidationError(feedback);
  if (error) {
    throw new FeedbackError(error);
  }
}

function getFeedbackValidationError(feedback: string): string | null {
  const trimmedFeedback = feedback.trim();
  if (!trimmedFeedback) {
    return 'Feedback cannot be empty.';
  }
  if (trimmedFeedback.length < CLI_FEEDBACK_MIN_LENGTH) {
    return `Feedback must be at least ${CLI_FEEDBACK_MIN_LENGTH.toLocaleString('en-US')} characters.`;
  }
  if (feedback.length > CLI_FEEDBACK_MAX_LENGTH) {
    return `Feedback cannot exceed ${CLI_FEEDBACK_MAX_LENGTH.toLocaleString('en-US')} characters.`;
  }
  return null;
}

export function isTelemetryDisabled(): boolean {
  return boolish('DO_NOT_TRACK', false) || boolish('EXPO_NO_TELEMETRY', false);
}

export function resolveFeedbackId(value?: string): string {
  if (
    value === undefined ||
    value.length < MIN_FEEDBACK_ID_LENGTH ||
    value.length > MAX_FEEDBACK_ID_LENGTH ||
    !FEEDBACK_ID_PATTERN.test(value)
  ) {
    return randomBytes(GENERATED_FEEDBACK_ID_BYTES).toString('hex');
  }

  return value;
}

function getPackageVersion(): string {
  try {
    return require('../../package.json')?.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

class FeedbackError extends CommandError {
  constructor(message: string) {
    super('FEEDBACK_ERROR', message);
    this.suggestedCommand = `${PROGRAM_PREFIX} feedback --help`;
  }
}
