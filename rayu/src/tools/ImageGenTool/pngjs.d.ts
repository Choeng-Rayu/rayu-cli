declare module 'pngjs' {
  export class PNG {
    width: number
    height: number
    data: Buffer
    static sync: { read(buffer: Buffer): PNG }
  }
}
