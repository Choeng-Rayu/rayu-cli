/**
 * Local inter-session IPC for RAYU.
 *
 * A Unix domain socket (Linux/macOS) or named pipe (Windows) per session, so the
 * Telegram bridge leader can route a prompt to whichever session the user has
 * attached, and address a specific session for lifecycle operations regardless
 * of which one currently owns the terminal.
 *
 * See protocol.ts for the security model — every frame is authenticated with a
 * per-session token, because Windows named pipes have no restrictive ACL.
 */

export {
  connectIpc,
  withIpcConnection,
  type IpcClientOptions,
} from './client.js'
export {
  IpcConnection,
  type IpcConnectionOptions,
  type NotifyHandler,
  type RequestHandler,
} from './connection.js'
export {
  ipcAddressForPid,
  ipcSocketDir,
  isUnlinkableAddress,
  isWindowsIpc,
} from './paths.js'
export {
  encodeFrame,
  FrameSplitter,
  generateIpcToken,
  IPC_PROTOCOL_VERSION,
  ipcTokensMatch,
  MAX_AUTH_FAILURES,
  MAX_FRAME_BYTES,
  parseFrame,
  type FrameRejection,
  type IpcFrame,
  type IpcNotifyFrame,
  type IpcRequestFrame,
  type IpcResponseFrame,
  type ParseResult,
} from './protocol.js'
export {
  startIpcServer,
  type IpcServerHandle,
  type IpcServerOptions,
} from './server.js'
