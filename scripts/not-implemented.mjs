#!/usr/bin/env node
const operation = process.argv[2] ?? "requested operation";
console.error(`NotImplemented: ${operation} is reserved for a later LightPhysics phase.`);
process.exitCode = 2;
