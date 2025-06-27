#!/usr/bin/env node

// Simple test to verify dotenv loading works
import { config } from 'dotenv';

console.log('Testing .env loading...');

// Load .env file
config();

console.log('✅ dotenv loaded successfully');

// Test environment variables
const testVars = [
  'GITHUB_TOKEN',
  'OPENAI_API_KEY', 
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'PANGLOSS_DEFAULT_AGENTS'
];

console.log('\n🔍 Environment variable status:');
testVars.forEach(varName => {
  const value = process.env[varName];
  const status = value ? '✅' : '❌';
  const display = value ? (value.length > 10 ? `${value.substring(0, 10)}...` : value) : 'not set';
  console.log(`${status} ${varName}: ${display}`);
});

console.log('\n✨ .env functionality working correctly!');