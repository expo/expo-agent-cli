import { stripVTControlCharacters } from 'util';
import { wrapUntrustedAppOutput } from './untrusted';
import type { BundleCheckError } from './bundleCheck';

// Codes specific to Expo config and config-plugin resolution. A proxy can also send {error, code}.
const MANIFEST_CODES = new Set([
  'PLUGIN_NOT_FOUND',
  'INVALID_PLUGIN_TYPE',
  'INVALID_PLUGIN_IMPORT',
  'CONFLICTING_PROVIDER',
  'INVALID_MOD_ORDER',
  'MISSING_PROVIDER',
  'INVALID_PLUGIN',
  'INVALID_CONFIG',
  'NO_APP_JSON',
  'NO_EXPO',
  'ENTRY_NOT_FOUND',
  'MANIFEST_MIDDLEWARE',
  'MANIFEST_ASSET',
  'EJSONEMPTY',
]);

const MANIFEST_ERROR_CLASSES = new Set([
  'PluginError',
  'ConfigError',
  'JsonFileError',
  'EmptyJsonFileError',
  'CommandError',
]);

export async function readManifestFailureAsync(
  response: Response
): Promise<BundleCheckError | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 64 * 1024) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return parseManifestFailure(Buffer.concat(chunks).toString('utf8'));
}

function parseManifestFailure(text: string): BundleCheckError | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('error' in payload) ||
    typeof payload.error !== 'string'
  ) {
    return null;
  }
  const diagnostic = stripVTControlCharacters(payload.error).trim();
  const prefix = /^([A-Z]\w*Error|Error)(?: \[[A-Z0-9_]+\])?:/.exec(diagnostic);
  const detail = diagnostic.slice(prefix?.[0].length ?? 0).trim();
  if (!detail) return null;

  const code = 'code' in payload && typeof payload.code === 'string' ? payload.code.trim() : '';
  const errorClass = prefix?.[1] ?? '';
  const configReadFailure = errorClass !== '' && detail.startsWith('Error reading Expo config at ');
  // @expo/config-plugins normalizeStaticPlugin uses a Node assertion for this config error.
  const invalidPluginEntry =
    errorClass === 'AssertionError' &&
    detail.startsWith('Wrong number of arguments provided for static config plugin,');
  if (
    !MANIFEST_CODES.has(code) &&
    !MANIFEST_ERROR_CLASSES.has(errorClass) &&
    !configReadFailure &&
    !invalidPluginEntry
  ) {
    return null;
  }

  const summary =
    errorClass === 'JsonFileError' && detail.includes('Error parsing JSON:')
      ? summarizeJsonParseError(detail)
      : diagnostic;
  const [message, ...lines] = summary.split('\n');
  return {
    source: 'manifest',
    type: code || errorClass,
    message: message!.trim(),
    snippet: lines.join('\n').trim() || null,
    filename: null,
    lineNumber: null,
    column: null,
  };
}

// @expo/json-file includes the entire input before its File/Cause footer and can repeat it in
// a code frame after the cause. Native JSON.parse messages can quote the input as well.
function summarizeJsonParseError(detail: string): string {
  const causeMarker = '\n└─ Cause: SyntaxError: ';
  const causeIndex = detail.lastIndexOf(causeMarker);
  if (causeIndex < 0) return 'Invalid JSON';

  const file = /\n├─ File: ([^\r\n]+)$/.exec(detail.slice(0, causeIndex))?.[1];
  const message = file ? `Invalid JSON in ${file}` : 'Invalid JSON';
  const cause = detail.slice(causeIndex + causeMarker.length).split('\n', 1)[0];
  return cause?.startsWith('JSON5:') ? `${message}\n${cause}` : message;
}

export function manifestRepairAdvice(error: BundleCheckError): string {
  return isMissingPluginError(error)
    ? 'Check the plugin entry in the app config. For a package, make sure it is installed. For a local file, check that its path exists.'
    : 'Fix the error reported by the dev server while generating the manifest.';
}

export function describeManifestFailure(error: BundleCheckError): string {
  const diagnostic = [error.message, error.snippet].filter(Boolean).join('\n');
  return `${wrapUntrustedAppOutput(diagnostic)}\n${manifestRepairAdvice(error)}`;
}

/**
 * Whether a manifest error says that a config plugin's package does not resolve.
 *
 * `PluginError` also covers a plugin of the wrong shape and a local plugin that does not parse, so
 * without a `code` only the wording of `@expo/config-plugins`' `PLUGIN_NOT_FOUND` counts
 * [observed — `plugin-resolver.ts` `resolvePluginForModule`].
 */
export function isMissingPluginError(error: BundleCheckError | null): boolean {
  return (
    error?.type === 'PLUGIN_NOT_FOUND' ||
    (error?.type === 'PluginError' &&
      error.message.startsWith('PluginError: Failed to resolve plugin for module'))
  );
}
