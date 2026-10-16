#!/usr/bin/env node
import { ManagementAuth } from '../src/auth.mjs';
const auth = new ManagementAuth(process.env.ASTRA_CONFIG || './data/config.json');
await auth.resetPassword();
console.log(`Administrator password reset. Read ${auth.initialPasswordPath} and restart Astra to invalidate previous logins.`);
