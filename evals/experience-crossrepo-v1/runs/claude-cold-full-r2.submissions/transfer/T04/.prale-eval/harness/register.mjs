// Registers the resolution hook used by the demo:
//   node --import ./.prale-eval/harness/register.mjs .prale-eval/demo-normalize-exec.mjs
import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
