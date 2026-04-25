#!/usr/bin/env node
import { main } from './run-b.js';

main().catch((err) => {
  console.error('System B failed:', err);
  process.exit(1);
});
