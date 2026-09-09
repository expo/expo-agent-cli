import type { EvalOutput } from './cli';

/** Parse real successful CLI output; a prose-only answer contributes no report. */
export function jsonReports(output: EvalOutput): Record<string, unknown>[] {
  return output.commands
    .filter((call) => call.exitCode === 0)
    .flatMap((call) => {
      try {
        const report = JSON.parse(call.stdout);
        return report && typeof report === 'object' && !Array.isArray(report) ? [report] : [];
      } catch {
        return [];
      }
    });
}

export function projectFiles(files: Record<string, string>) {
  return Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('.expo/')));
}
