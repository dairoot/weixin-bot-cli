#!/usr/bin/env node
import { access } from 'node:fs/promises';

let entry = new URL('../runtime/src/cli.js', import.meta.url);
try { await access(entry); }
catch { entry = new URL('../../../src/cli.js', import.meta.url); }
const { main } = await import(entry.href);
await main();
