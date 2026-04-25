#!/usr/bin/env node
import { main } from './run-report.js';

main().catch((err) => {
  console.error('Report failed:', err);
  process.exit(1);
});
