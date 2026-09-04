import { vi } from 'vitest';

export const execSync = vi.fn();
export const spawn = vi.fn();
export const execFileSync = vi.fn();

const mocked = { execSync, spawn, execFileSync };
export default mocked;
