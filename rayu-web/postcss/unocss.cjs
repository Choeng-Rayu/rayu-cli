/*
 * CommonJS adapter for @unocss/postcss.
 *
 * WHY THIS FILE EXISTS
 *
 * Next resolves PostCSS plugins named in postcss.config.js with
 *   require(pluginPath)(options)
 * (next/dist/build/webpack/config/blocks/css/plugins.js). It does not unwrap an
 * ES-module default export.
 *
 * @unocss/postcss's CommonJS build exports `{ default: fn }`, so requiring it
 * yields an object and calling it fails the build with the distinctly unhelpful
 *   TypeError: require(...) is not a function
 * pointing into Next's own source rather than at the configuration.
 *
 * Referencing this file instead of the package name gives Next the callable it
 * expects. Delete it if @unocss/postcss ever ships a callable CJS export.
 */
const mod = require('@unocss/postcss')

module.exports = mod.default ?? mod
