export type DebugLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'none';


type LoggerFunction = (...messages: any[]) => void;

interface Logger {
  trace: LoggerFunction;
  debug: LoggerFunction;
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
  setLevel: (level: DebugLevel) => void;
}

/*
 * VITE_LOG_LEVEL arrives from the environment as a free-form string, so it is
 * narrowed here rather than trusted. An unrecognised value falls back to the
 * environment default instead of silently disabling logging.
 */
const DEBUG_LEVELS: readonly DebugLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'none'];
const configuredLevel = import.meta.env.VITE_LOG_LEVEL;
let currentLevel: DebugLevel = DEBUG_LEVELS.includes(configuredLevel as DebugLevel)
  ? (configuredLevel as DebugLevel)
  : import.meta.env.DEV
    ? 'debug'
    : 'info';

export const logger: Logger = {
  trace: (...messages: any[]) => logWithDebugCapture('trace', undefined, messages),
  debug: (...messages: any[]) => logWithDebugCapture('debug', undefined, messages),
  info: (...messages: any[]) => logWithDebugCapture('info', undefined, messages),
  warn: (...messages: any[]) => logWithDebugCapture('warn', undefined, messages),
  error: (...messages: any[]) => logWithDebugCapture('error', undefined, messages),
  setLevel,
};

export function createScopedLogger(scope: string): Logger {
  return {
    trace: (...messages: any[]) => logWithDebugCapture('trace', scope, messages),
    debug: (...messages: any[]) => logWithDebugCapture('debug', scope, messages),
    info: (...messages: any[]) => logWithDebugCapture('info', scope, messages),
    warn: (...messages: any[]) => logWithDebugCapture('warn', scope, messages),
    error: (...messages: any[]) => logWithDebugCapture('error', scope, messages),
    setLevel,
  };
}

function setLevel(level: DebugLevel) {
  if ((level === 'trace' || level === 'debug') && import.meta.env.PROD) {
    return;
  }

  currentLevel = level;
}

function log(level: DebugLevel, scope: string | undefined, messages: any[]) {
  const levelOrder: DebugLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'none'];

  if (levelOrder.indexOf(level) < levelOrder.indexOf(currentLevel)) {
    return;
  }

  // If current level is 'none', don't log anything
  if (currentLevel === 'none') {
    return;
  }

  const allMessages = messages.reduce((acc, current) => {
    if (acc.endsWith('\n')) {
      return acc + current;
    }

    if (!acc) {
      return current;
    }

    return `${acc} ${current}`;
  }, '');

  const labelBackgroundColor = getColorForLevel(level);
  const labelTextColor = level === 'warn' ? '#000000' : '#FFFFFF';

  const labelStyles = getLabelStyles(labelBackgroundColor, labelTextColor);
  const scopeStyles = getLabelStyles('#77828D', 'white');

  const styles = [labelStyles];

  if (typeof scope === 'string') {
    styles.push('', scopeStyles);
  }

  let labelText = formatText(` ${level.toUpperCase()} `, labelTextColor, labelBackgroundColor);

  if (scope) {
    labelText = `${labelText} ${formatText(` ${scope} `, '#FFFFFF', '77828D')}`;
  }

  if (typeof window !== 'undefined') {
    console.log(`%c${level.toUpperCase()}${scope ? `%c %c${scope}` : ''}`, ...styles, allMessages);
  } else {
    console.log(`${labelText}`, allMessages);
  }
}

function formatText(text: string, color: string, bg: string) {
  /*
   * bolt.diy used chalk here to colourise the NON-browser branch of the logger
   * above. Rayu Studio only ever runs in the browser, where that branch is
   * unreachable and the `%c` CSS styles are used instead — so chalk (a Node
   * package) is deliberately not a dependency.
   *
   * ANSI is emitted directly for the residual server-render case, keeping the
   * output readable in a terminal without pulling in a dependency for dead code.
   */
  const toAnsi = (hex: string, background: boolean): string => {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;

    return `\u001B[${background ? 48 : 38};2;${r};${g};${b}m`;
  };

  return `${toAnsi(bg, true)}${toAnsi(color, false)}${text}\u001B[0m`;
}

function getLabelStyles(color: string, textColor: string) {
  return `background-color: ${color}; color: white; border: 4px solid ${color}; color: ${textColor};`;
}

function getColorForLevel(level: DebugLevel): string {
  switch (level) {
    case 'trace':
    case 'debug': {
      return '#77828D';
    }
    case 'info': {
      return '#1389FD';
    }
    case 'warn': {
      return '#FFDB6C';
    }
    case 'error': {
      return '#EE4744';
    }
    default: {
      return '#000000';
    }
  }
}

export const renderLogger = createScopedLogger('Render');

// Debug logging integration
let debugLogger: any = null;

// Lazy load debug logger to avoid circular dependencies
const getDebugLogger = () => {
  if (!debugLogger && typeof window !== 'undefined') {
    try {
      // Use dynamic import asynchronously but don't block the function
      import('./debugLogger')
        .then(({ debugLogger: loggerInstance }) => {
          debugLogger = loggerInstance;
        })
        .catch(() => {
          // Debug logger not available, skip integration
        });
    } catch {
      // Debug logger not available, skip integration
    }
  }

  return debugLogger;
};

// Override the log function to also capture to debug logger

function logWithDebugCapture(level: DebugLevel, scope: string | undefined, messages: any[]) {
  // Call original log function (the one that does the actual console logging)
  log(level, scope, messages);

  // Also capture to debug logger if available
  const debug = getDebugLogger();

  if (debug) {
    debug.captureLog(level, scope, messages);
  }
}
