// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// The contract between the installed-app check and the fingerprint responder in expo-dev-launcher
// (`EXDevLauncherFingerprintCheck.swift`, expo/expo #49494). The CLI launches the app with a URL
// carrying the reserved marker below; the app posts the embedded fingerprint back to the callback
// URL. Every literal of that exchange lives here, and the Swift side pins the same ones.

/**
 * Query parameter that marks a URL as a fingerprint-check trigger, with the value `1`.
 *
 * The channel is selected by this parameter and never by a URL host. A host reads as a
 * destination and would take a name out of the app's own route namespace; a reserved `__expo_*`
 * parameter says what it is and composes with any link the app already handles.
 */
export const MARKER_PARAM = '__expo_fingerprint_check';

/** The only accepted value of {@link MARKER_PARAM}. */
export const MARKER_VALUE = '1';

/** Query parameter carrying the one-time nonce that ties a response to this run. */
export const NONCE_PARAM = '__expo_fingerprint_nonce';

/** Query parameter carrying the URL the app posts its response to. */
export const CALLBACK_PARAM = '__expo_fingerprint_callback';

/** JSON key of the nonce in the response body. */
export const NONCE_BODY_KEY = 'nonce';

/** JSON key of the embedded fingerprint in the response body; null when none is embedded. */
export const FINGERPRINT_BODY_KEY = 'fingerprint';

/** Path of the callback endpoint the CLI listens on. */
export const CALLBACK_PATH = '/fingerprint-callback';

/** How long the CLI waits for the app. A timeout is "cannot determine", never "up to date". */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Scheme used when the project declares none. `launch --payload-url` targets a bundle id, so it
 * needs no registered scheme to deliver the URL.
 */
const FALLBACK_SCHEME = 'expo-fingerprint-check';

/**
 * The trigger URL `devicectl` hands the app.
 *
 * Host-free: the responder matches the marker parameter, so the URL claims no route of the app's.
 */
export function buildFingerprintCheckUrl(
  scheme: string | null,
  nonce: string,
  callbackUrl: string
): string {
  const params = new URLSearchParams({
    [MARKER_PARAM]: MARKER_VALUE,
    [NONCE_PARAM]: nonce,
    [CALLBACK_PARAM]: callbackUrl,
  });
  return `${scheme ?? FALLBACK_SCHEME}://?${params}`;
}
