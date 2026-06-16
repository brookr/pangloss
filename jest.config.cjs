/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Never scan runtime artifacts (kept worktrees live under .pangloss/) or build output.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/\\.pangloss/'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.json'
      }
    ]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
};
