// Loads the native module built by `rust-anything build`.
const native = require('./portable_rs.node')
module.exports = native
