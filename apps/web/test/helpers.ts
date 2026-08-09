export class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  public get length(): number {
    return this.values.size
  }

  public clear(): void {
    this.values.clear()
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  public removeItem(key: string): void {
    this.values.delete(key)
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

export class FakeBrowserSocket extends EventTarget {
  public static readonly instances: FakeBrowserSocket[] = []
  public readonly sent: string[] = []
  public readonly closes: { readonly code: number; readonly reason: string }[] = []
  public readyState = 0

  public constructor(public readonly url: string) {
    super()
    FakeBrowserSocket.instances.push(this)
  }

  public open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  public send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('Socket is not open')
    }

    this.sent.push(data)
  }

  public message(input: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(input) }))
  }

  public binaryMessage(input: ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data: input }))
  }

  public error(): void {
    this.dispatchEvent(new Event('error'))
  }

  public close(code = 1000, reason = ''): void {
    if (this.readyState === 3) {
      return
    }

    this.readyState = 3
    this.closes.push({ code, reason })
    this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: code === 1000 }))
  }

  public jsonMessages(): Record<string, unknown>[] {
    return this.sent.map((message) => JSON.parse(message) as Record<string, unknown>)
  }

  public static reset(): void {
    this.instances.length = 0
  }
}

export function asWebSocket(socket: FakeBrowserSocket): WebSocket {
  return socket as unknown as WebSocket
}
