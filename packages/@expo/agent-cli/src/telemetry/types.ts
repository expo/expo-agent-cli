/** The only command data passed to the detached telemetry process. */
export type CommandTelemetry = {
  command: string;
  version: string;
  timestamp: string;
};
