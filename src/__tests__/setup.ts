/**
 * Jest setup file
 * Runs before each test file
 */

import { jest, beforeAll, afterAll } from '@jest/globals';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.API_BASE_URL = 'https://test-api.example.com/api/v4';
process.env.LOG_LEVEL = 'error'; // Suppress logs during tests

// Increase timeout for async tests
jest.setTimeout(10000);

// Mock console.error to reduce noise in tests
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn() as typeof console.error;
});

afterAll(() => {
  console.error = originalConsoleError;
});
