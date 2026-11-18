import { appLoadedFromAnswer } from '../appLoaded';

describe(appLoadedFromAnswer, () => {
  it.each([
    ['bundle:ran', true],
    ['bundle:none', false],
    [undefined, null],
    [1, null],
    [{ value: 'bundle:none' }, null],
    ['function', null],
  ])('reads %j as %j', (answer, loaded) => {
    expect(appLoadedFromAnswer(answer)).toBe(loaded);
  });
});
