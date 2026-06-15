// Empty shim for Node.js built-in modules not available in the browser.
// Used by next.config.ts turbopack.resolveAlias to prevent "Can't resolve 'fs'"
// errors when @claucondor/sdk dynamically imports 'fs' inside async helpers
// that only run server-side. These code paths are never executed in the browser.
module.exports = {};
