import { fs } from 'memfs';

const mocked = {
  ...fs,
  default: fs,
  promises: fs.promises,
};

export default mocked;
export const promises = fs.promises;
export const constants = fs.constants;
