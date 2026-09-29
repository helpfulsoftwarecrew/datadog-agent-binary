// What Harper hands a component that this repo does not import, declared so `tsc --noEmit` checks the files
// that use them rather than skipping them.

/** Harper's compartment logger, present only inside a compartment; runtime/ normalises whatever arrives. */
// `var`, not `const`: a global `var` is a property of globalThis, which is how a compartment hands it over.
declare var logger: undefined | Record<string, (message: string) => void>;

/** Harper's Resource base class, present only inside a compartment. */
declare var Resource: undefined | (new () => object);

// The guard ships plain ESM with JSDoc and is read through `maxNodeModuleJsDepth` in tsconfig.json; a
// hand-written .d.ts would be a second, drifting copy of a module this repo does not own.
