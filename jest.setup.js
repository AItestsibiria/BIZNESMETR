// Minimum env required by src/config.ts so that importing modules under test
// doesn't throw at parse time. Tests can override via process.env before import.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-key'
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://biznesmetr:biznesmetr@localhost:5432/biznesmetr_test?schema=public'
