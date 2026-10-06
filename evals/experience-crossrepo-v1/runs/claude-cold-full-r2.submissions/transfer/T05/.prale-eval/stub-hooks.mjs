// Module-resolution hook: satisfies the two bare specifiers that the real
// MemoryPanel config modules import (dotenv, zod) with in-memory stubs, so the
// precedence demo can execute the REAL source without node_modules installed.
// Only module-load-time surface is stubbed; the precedence logic under test is
// the repository's own code.
const DOTENV = `
export const config = () => ({ parsed: {} });
export default { config };
`;

const ZOD = `
const chain = () => {
  const o = {};
  for (const m of ['min', 'max', 'url', 'optional', 'trim', 'email', 'regex'])
    o[m] = () => o;
  return o;
};
const schema = () => chain();
export const z = {
  string: () => chain(),
  number: () => chain(),
  boolean: () => chain(),
  object: () => ({ safeParse: (v) => ({ success: true, data: v }) }),
  array: () => ({ min: () => schema() }),
};
export default { z };
`;

const STUBS = {
  dotenv: DOTENV,
  zod: ZOD,
};

export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
    const url =
      'data:text/javascript;base64,' +
      Buffer.from(STUBS[specifier], 'utf8').toString('base64');
    return { url, shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}
