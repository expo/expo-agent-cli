import { extractAdviceAction } from '../doctor';
import { needsHumanScenarios } from '../../needsHuman/registry';
import { cloudSessionStartCommand } from '../../device/cloudSimulator';

function advice(command: string) {
  return extractAdviceAction({
    name: 'Fix the project',
    status: 'failed',
    issues: [],
    advice: [`Run "${command}".`],
  });
}

describe('hints prefer supported agent-cli commands', () => {
  it.each([
    ['npx expo install expo-camera', 'install expo-camera'],
    ['bunx expo install --fix', 'install --fix'],
    ['expo prebuild --clean --platform ios', 'prebuild --clean --platform ios'],
    ['npx expo config --type introspect --json', 'config --type introspect --json'],
    ['npx expo run:android', 'run:android'],
    ['npx eas-cli@latest login', 'login'],
  ])('maps %s without losing arguments', (input, expected) => {
    expect(advice(input)).toBe(`npx @expo/agent-cli ${expected}`);
  });

  it.each([
    'npx eas build --profile production',
    'npx eas update --auto',
    'npx expo unknown',
    'npx expo@56 install --fix',
    'npx eas login --sso',
  ])('preserves advice without an equivalent: %s', (command) => {
    expect(advice(command)).toBe(command);
  });

  it('uses the shared account login for both Expo and EAS failures', () => {
    for (const id of ['expo-login', 'eas-login']) {
      expect(needsHumanScenarios.find((scenario) => scenario.id === id)?.command).toBe(
        'npx @expo/agent-cli login'
      );
    }
  });

  it('starts a usable cloud app through dev', () => {
    expect(cloudSessionStartCommand()).toBe('npx @expo/agent-cli dev --ios --eas');
  });
});
