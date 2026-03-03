export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|mjs)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid)/)', // uuid is an ESM module that needs to be transformed
  ],
  globals: {
    'jest': {
      useESM: true
    }
  },
  moduleNameMapper: {
    '^\\.\\./\\.\\./auth/oauth-handlers(?:\\.js)?$': '<rootDir>/tests/mocks/oauth-handlers.js',
    '^\\.\\./\\.\\./services/service-manager(?:\\.js)?$': '<rootDir>/tests/mocks/service-manager.js',
    '^open$': '<rootDir>/tests/mocks/open.js',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: [
    '**/tests/**/*.test.js'
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000 // Add a global test timeout
};
