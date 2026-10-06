/**
 * Registers the `dotenv`-redirecting loader (Node >= 20 module hooks API).
 * Usage: node --import ./.prale-eval/harness/register.mjs <script.mjs>
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
