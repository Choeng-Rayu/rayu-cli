/*
 * Stub for CSS/SCSS imports under Jest.
 *
 * Next compiles `import styles from './X.module.scss'` into a class-name map;
 * Jest has no CSS pipeline and fails to parse the file at all. Tests that touch a
 * styled component only need the import to resolve, not real class names.
 *
 * A Proxy returning the requested key means `styles.MarkdownContent` evaluates to
 * the string "MarkdownContent". That keeps class names meaningful if a test ever
 * asserts on rendered output, instead of collapsing them all to undefined.
 */
module.exports = new Proxy(
  {},
  {
    get: (_target, prop) => (prop === '__esModule' ? false : String(prop)),
  },
);
