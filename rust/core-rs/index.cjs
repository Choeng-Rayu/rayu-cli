// Loads the native module built by `rust-anything build`.
const native = require('./core_rs.node')

// Structured values cross as JSON text. JSON has no `undefined`, NaN or -0, and Rust strings no
// lone surrogates: those travel as `{"$undefined": true}`, `{"$num": "NaN"}` and
// `{"$utf16": [...]}` (see `js.rs`), so `{ a: undefined }`, `null` and half an emoji survive.
const replacer = (_, v) => v === undefined ? { $undefined: true }
  : typeof v === 'number' ? (Number.isFinite(v) && !Object.is(v, -0) ? v : { $num: Object.is(v, -0) ? '-0' : String(v) })
  : typeof v === 'string' && !v.isWellFormed() ? { $utf16: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)) }
  : v
const encode = v => JSON.stringify(v, replacer)
const single = (v, key) => Object.keys(v).length === 1 && key in v
const revive = v => Array.isArray(v) ? v.map(revive)
  : v !== null && typeof v === 'object'
    ? (single(v, '$undefined') ? undefined
      : single(v, '$utf16') ? String.fromCharCode(...v.$utf16)
      : single(v, '$num') ? Number(v.$num)
      : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])))
    : v
// Most results carry no marker: skip the walk unless the text has one.
const decode = text => {
  const value = JSON.parse(text)
  return text.includes('"$') ? revive(value) : value
}
const fromUnits = (units) => {
  let out = ''
  for (let i = 0; i < units.length; i += 8192)
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(units, i, i + 8192))
  return out
}

module.exports = { ...native }
const specs = {
  resolveBuildConfig: [[1, 0], 'json', false],
  isEnvTruthy: [[1], 'raw', false],
  resolveEndpoints: [[1, 1], 'json', false],
  getBakedBuildConfig: [[], 'json', false],
  buildFeatureTable: [[0, 1], 'json', false],
  installFeatureTable: [[1], 'raw', false],
}
const classes = {

}
const convert = result => result === 'json' ? decode : result === 'units' ? fromUnits : x => x
// An omitted structured argument is `undefined`, not a missing value.
const prepare = (a, structured) => Array.from({ length: Math.max(a.length, structured.length) }, (_, i) => structured[i] ? encode(a[i]) : a[i])
// Functions: [structured arguments, result kind, async].
for (const [name, [structured, result, isAsync]] of Object.entries(specs)) {
  const call = native[name]
  const out = convert(result)
  module.exports[name] = isAsync
    ? async (...a) => out(await call(...prepare(a, structured)))
    : (...a) => out(call(...prepare(a, structured)))
}
// Classes: a JS class around the native one, converting arguments and results.
const INNER = Symbol('native')
for (const [name, [ctor, methods]] of Object.entries(classes)) {
  const Native = native[name]
  const Wrapped = { [name]: class { constructor(...a) { this[INNER] = new Native(...prepare(a, ctor)) } } }[name]
  for (const [method, [structured, result]] of Object.entries(methods)) {
    const out = convert(result)
    Wrapped.prototype[method] = function (...a) { return out(this[INNER][method](...prepare(a, structured))) }
  }
  module.exports[name] = Wrapped
}

// The binary wire (see rust-anything's `wire.rs`): arguments are written into `wIn`, results read
// from `wOut`; both are registered with the native module once.
let wIn = new Uint8Array(1 << 16), wOut = new Uint8Array(1 << 16)
let iv = new DataView(wIn.buffer), ov = new DataView(wOut.buffer), at = 0, p = 0
native.rustAnythingWireInit(wIn, wOut)
const regrow = () => native.rustAnythingWireInit(wIn, wOut)
// Runs a wire function; a result larger than `wOut` is fetched once `wOut` has grown.
const wireCall = fn => {
  const n = fn(at)
  if (Number.isNaN(n)) return false
  if (n < 0) {
    wOut = new Uint8Array(Math.max(wOut.length * 2, -n))
    ov = new DataView(wOut.buffer)
    native.rustAnythingWireInit(wIn, wOut)
    native.rustAnythingWireFlush()
  }
  p = 0
  return true
}

const need = n => {
  if (at + n <= wIn.length) return
  const grown = new Uint8Array(Math.max(wIn.length * 2, at + n))
  grown.set(wIn)
  wIn = grown
  iv = new DataView(wIn.buffer)
  regrow()
}
const wU8 = v => { need(1); iv.setUint8(at++, v) }
const wU32 = v => { need(4); iv.setUint32(at, v, true); at += 4 }
const wF64 = v => { need(8); iv.setFloat64(at, v, true); at += 8 }
const wUnits = s => {
  need(4 + 2 * s.length)
  iv.setUint32(at, s.length, true)
  at += 4
  for (let i = 0; i < s.length; i++) { iv.setUint16(at, s.charCodeAt(i), true); at += 2 }
}
const wStr = s => { wU8(4); wUnits(s) }
const wDyn = v => {
  switch (typeof v) {
    case 'undefined': wU8(0); return true
    case 'boolean': wU8(v ? 3 : 2); return true
    case 'number': wU8(4); wF64(v); return true
    case 'string': wU8(5); wUnits(v); return true
    case 'object':
      if (v === null) { wU8(1); return true }
      if (Array.isArray(v)) {
        wU8(6); wU32(v.length)
        for (let i = 0; i < v.length; i++) if (!wDyn(v[i])) return false
        return true
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false
      {
        const keys = Object.keys(v)
        wU8(7); wU32(keys.length)
        for (const k of keys) { wUnits(k); if (!wDyn(v[k])) return false }
        return true
      }
  }
  return false
}
const rU8 = () => ov.getUint8(p++)
const rU32 = () => { const v = ov.getUint32(p, true); p += 4; return v }
const rF64 = () => { const v = ov.getFloat64(p, true); p += 8; return v }
// ignoreBOM: a leading U+FEFF is part of the string, not a byte-order mark.
const utf16 = new TextDecoder('utf-16le', { ignoreBOM: true })
const rUnits = (wellFormed) => {
  const n = rU32()
  let s
  if (n > 24 && wellFormed) s = utf16.decode(wOut.subarray(p, p + 2 * n))
  else {
    s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(ov.getUint16(p + 2 * i, true))
  }
  p += 2 * n
  return s
}
// Tag 1: a string from Rust (well-formed); 4: raw code units, lone surrogates included.
const rStr = () => rUnits(rU8() === 1)
const rDyn = () => {
  switch (rU8()) {
    case 0: return undefined
    case 1: return null
    case 2: return false
    case 3: return true
    case 4: return rF64()
    case 5: return rUnits(false)
    case 6: { const n = rU32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = rDyn(); return a }
    case 7: { const n = rU32(); const o = {}; for (let i = 0; i < n; i++) { const k = rUnits(false); o[k] = rDyn() } return o }
  }
}

// `resolveBuildConfig`: binary wire; the JSON version handles inputs of other shapes.
{
const json = module.exports.resolveBuildConfig
const call = native.resolveBuildConfigWire
const encode = (a0, a1) => {
at = 0
if (!wDyn(a0)) return false
if (typeof a1 !== 'string') return false
wStr(a1)
return true
}
const decode = () => {
let t
{
const o0 = {}
const n0 = rU8()
for (let j0 = 0; j0 < n0; j0++) {
switch (rU8()) {
case 0: {
let v0
v0 = rStr()
o0["VERSION"] = v0
break
}
case 1: {
let v0
v0 = rStr()
o0["BUILD_TIME"] = v0
break
}
case 2: {
let v0
v0 = rStr()
o0["PACKAGE_URL"] = v0
break
}
case 3: {
let v0
v0 = rStr()
o0["NATIVE_PACKAGE_URL"] = v0
break
}
case 4: {
let v0
v0 = rStr()
o0["FEEDBACK_CHANNEL"] = v0
break
}
case 5: {
let v0
v0 = rStr()
o0["ISSUES_EXPLAINER"] = v0
break
}
case 6: {
let v0
v0 = rStr()
o0["VERSION_CHANGELOG"] = v0
break
}
case 7: {
let v0
v0 = rStr()
o0["RAYU_OAUTH_DEFAULT"] = v0
break
}
case 8: {
let v0
v0 = rStr()
o0["RAYU_API_URL"] = v0
break
}
case 9: {
let v0
v0 = rStr()
o0["RAYU_WEB_URL"] = v0
break
}
case 10: {
let v0
v0 = rStr()
o0["RAYU_GATEWAY_URL"] = v0
break
}
default: {
const k0 = rStr()
o0[k0] = rDyn()
}
}
}
t = o0
}
return t
}
module.exports.resolveBuildConfig = function resolveBuildConfig (...a) {
  if (a.length <= 2 && encode(a[0], a[1]) && wireCall(call)) {
    return decode()
  }
  return json(...a)
}
}

// `isEnvTruthy`: binary wire; the JSON version handles inputs of other shapes.
{
const json = module.exports.isEnvTruthy
const call = native.isEnvTruthyWire
const encode = (a0) => {
at = 0
if (!wDyn(a0)) return false
return true
}
const decode = () => {
let t
t = rU8() === 1
return t
}
module.exports.isEnvTruthy = function isEnvTruthy (...a) {
  if (a.length <= 1 && encode(a[0]) && wireCall(call)) {
    return decode()
  }
  return json(...a)
}
}

// `resolveEndpoints`: binary wire; the JSON version handles inputs of other shapes.
{
const json = module.exports.resolveEndpoints
const call = native.resolveEndpointsWire
const encode = (a0, a1) => {
at = 0
if (!wDyn(a0)) return false
if (a1 === undefined) {
wU8(0)
} else if (a1 === null) {
return false
wU8(2)
} else {
wU8(1)
if (a1 === null || typeof a1 !== 'object' || Array.isArray(a1)) return false
{
const at0 = at
wU8(0)
let n0 = 0, r0 = 0
for (const k0 in a1) {
switch (k0) {
case "VERSION": {
wU8(0)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "BUILD_TIME": {
wU8(1)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "PACKAGE_URL": {
wU8(2)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "NATIVE_PACKAGE_URL": {
wU8(3)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "FEEDBACK_CHANNEL": {
wU8(4)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "ISSUES_EXPLAINER": {
wU8(5)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "VERSION_CHANGELOG": {
wU8(6)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "RAYU_OAUTH_DEFAULT": {
wU8(7)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "RAYU_API_URL": {
wU8(8)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "RAYU_WEB_URL": {
wU8(9)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
case "RAYU_GATEWAY_URL": {
wU8(10)
const f0 = a1[k0]
if (f0 === undefined) {
wU8(0)
} else if (f0 === null) {
return false
wU8(2)
} else {
wU8(1)
if (typeof f0 !== 'string') return false
wStr(f0)
}
break
}
default: return false
}
if (++n0 > 255) return false
}
if (r0 !== 0) return false
iv.setUint8(at0, n0)
}
}
return true
}
const decode = () => {
let t
{
const o0 = {}
const n0 = rU8()
for (let j0 = 0; j0 < n0; j0++) {
switch (rU8()) {
case 0: {
let v0
v0 = rStr()
o0["apiBaseUrl"] = v0
break
}
case 1: {
let v0
v0 = rStr()
o0["webBaseUrl"] = v0
break
}
case 2: {
let v0
v0 = rStr()
o0["gatewayBaseUrl"] = v0
break
}
default: {
const k0 = rStr()
o0[k0] = rDyn()
}
}
}
t = o0
}
return t
}
module.exports.resolveEndpoints = function resolveEndpoints (...a) {
  if (a.length <= 2 && encode(a[0], a[1]) && wireCall(call)) {
    return decode()
  }
  return json(...a)
}
}

// `getBakedBuildConfig`: binary wire; the JSON version handles inputs of other shapes.
{
const json = module.exports.getBakedBuildConfig
const call = native.getBakedBuildConfigWire
const encode = () => {
at = 0
return true
}
const decode = () => {
let t
{
const g0 = rU8()
if (g0 === 0) t = undefined
else if (g0 === 2) t = null
else {
{
const o1 = {}
const n1 = rU8()
for (let j1 = 0; j1 < n1; j1++) {
switch (rU8()) {
case 0: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["VERSION"] = v1
break
}
case 1: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["BUILD_TIME"] = v1
break
}
case 2: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["PACKAGE_URL"] = v1
break
}
case 3: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["NATIVE_PACKAGE_URL"] = v1
break
}
case 4: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["FEEDBACK_CHANNEL"] = v1
break
}
case 5: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["ISSUES_EXPLAINER"] = v1
break
}
case 6: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["VERSION_CHANGELOG"] = v1
break
}
case 7: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["RAYU_OAUTH_DEFAULT"] = v1
break
}
case 8: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["RAYU_API_URL"] = v1
break
}
case 9: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["RAYU_WEB_URL"] = v1
break
}
case 10: {
let v1
{
const g2 = rU8()
if (g2 === 0) v1 = undefined
else if (g2 === 2) v1 = null
else {
v1 = rStr()
}
}
o1["RAYU_GATEWAY_URL"] = v1
break
}
default: {
const k1 = rStr()
o1[k1] = rDyn()
}
}
}
t = o1
}
}
}
return t
}
module.exports.getBakedBuildConfig = function getBakedBuildConfig (...a) {
  if (a.length <= 0 && encode() && wireCall(call)) {
    return decode()
  }
  return json(...a)
}
}

// `buildFeatureTable`: binary wire; the JSON version handles inputs of other shapes.
{
const json = module.exports.buildFeatureTable
const call = native.buildFeatureTableWire
const encode = (a0, a1) => {
at = 0
if (!Array.isArray(a0)) return false
wU8(1)
wU32(a0.length)
for (let i0 = 0; i0 < a0.length; i0++) {
const v0 = a0[i0]
if (typeof v0 !== 'string') return false
wStr(v0)
}
if (a1 === undefined) {
wU8(0)
} else if (a1 === null) {
return false
wU8(2)
} else {
wU8(1)
if (!Array.isArray(a1)) return false
wU8(1)
wU32(a1.length)
for (let i0 = 0; i0 < a1.length; i0++) {
const v0 = a1[i0]
if (typeof v0 !== 'string') return false
wStr(v0)
}
}
return true
}
const decode = () => {
let t
if (rU8() === 0) t = null
else {
const n0 = rU32()
const o0 = {}
for (let i0 = 0; i0 < n0; i0++) {
const k0 = rStr()
let v0
v0 = rU8() === 1
o0[k0] = v0
}
t = o0
}
return t
}
module.exports.buildFeatureTable = function buildFeatureTable (...a) {
  if (a.length <= 2 && encode(a[0], a[1]) && wireCall(call)) {
    return decode()
  }
  return json(...a)
}
}

// `installFeatureTable`: binary wire; the JSON version handles inputs of other shapes.
{
const json = module.exports.installFeatureTable
const call = native.installFeatureTableWire
const encode = (a0) => {
at = 0
if (!wDyn(a0)) return false
return true
}
const decode = () => {
let t
return t
}
module.exports.installFeatureTable = function installFeatureTable (...a) {
  if (a.length <= 1 && encode(a[0]) && wireCall(call)) {
    return decode()
  }
  return json(...a)
}
}
