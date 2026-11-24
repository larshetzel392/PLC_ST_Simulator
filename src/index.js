// Node-Einstieg: lädt die Engine in globalThis.ST
require('./lexer.js');
require('./parser.js');
require('./types.js');
require('./compiler.js');
require('./infer.js');
require('./codegen.js');
require('./runtime.js');
require('./sfc.js');
module.exports = globalThis.ST;
