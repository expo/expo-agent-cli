// Copied from expo/expo `packages/@expo/cli/src/start/platforms/android/adbDeviceList.ts` at 33b9e01b218 (MIT).
// Keep it the same as the Expo CLI parser, so both tools read `adb devices -l` alike.

export interface AdbDeviceRecord {
  serial: string;
  state: string;
  metadata: string[];
  transportId: string | undefined;
}

export function isAdbDeviceStateUsable(state: string): boolean {
  return state === 'device';
}

const DEVICE_LIST_HEADER = 'List of devices attached';

export function parseAdbDeviceList(output: string): AdbDeviceRecord[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== DEVICE_LIST_HEADER && !/\.cpp:[0-9]+/.test(line))
    .map(parseDeviceLine)
    .filter((record): record is AdbDeviceRecord => record != null);
}

function parseDeviceLine(line: string): AdbDeviceRecord | null {
  const match =
    line.match(
      /^(.+?)\s+((?:offline|bootloader|device|host|recovery|rescue|sideload|unauthorized|authorizing|connecting|detached|any|no permissions)(?:\s+.*)?)$/
    ) ?? line.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }

  const [, serial, remainder] = match;
  const fields = remainder!.split(/\s+/);
  const state = fields[0] === 'no' && fields[1] === 'permissions' ? 'no permissions' : fields[0]!;
  const metadata = fields.slice(state === 'no permissions' ? 2 : 1);
  const transportId = metadata
    .find((field) => field.startsWith('transport_id:'))
    ?.slice('transport_id:'.length);

  return {
    serial: serial!,
    state,
    metadata,
    transportId,
  };
}
