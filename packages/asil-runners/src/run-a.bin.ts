#!/usr/bin/env node
import { main } from './run-a.js';

main().catch((err) => {
  console.error('System A failed:', err);
  process.exit(1);
});
