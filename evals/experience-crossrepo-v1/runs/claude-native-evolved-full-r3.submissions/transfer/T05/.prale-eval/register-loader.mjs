import { register } from 'node:module';

register('./deps-loader.mjs', import.meta.url);
