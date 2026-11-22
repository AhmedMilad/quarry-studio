import { Client } from 'ssh2'
import net from 'net'
import { readFileSync } from 'fs'
import type { SshConfig } from '@shared/types'

export interface Tunnel {
  localPort: number
  close(): void
}

export function openTunnel(ssh: SshConfig, dstHost: string, dstPort: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let server: net.Server | null = null
    const fail = (e: Error): void => {
      server?.close()
      client.end()
      reject(new Error(`SSH tunnel failed: ${e.message}`))
    }
    client.once('error', fail)
    client.once('ready', () => {
      client.removeListener('error', fail)
      client.on('error', () => undefined)
      server = net.createServer((sock) => {
        client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
          if (err) {
            sock.destroy()
            return
          }
          sock.pipe(stream).pipe(sock)
          stream.on('error', () => sock.destroy())
          sock.on('error', () => stream.destroy())
        })
      })
      server.on('error', fail)
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as net.AddressInfo
        resolve({
          localPort: addr.port,
          close: () => {
            server?.close()
            client.end()
          }
        })
      })
    })
    const opts: Parameters<Client['connect']>[0] = {
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user,
      readyTimeout: 20000,
      keepaliveInterval: 15000
    }
    try {
      if (ssh.authMethod === 'password') opts.password = ssh.password
      else if (ssh.authMethod === 'key') {
        opts.privateKey = readFileSync(ssh.privateKeyPath!.replace(/^~/, process.env.HOME ?? '~'))
        if (ssh.passphrase) opts.passphrase = ssh.passphrase
      } else opts.agent = process.env.SSH_AUTH_SOCK
      client.connect(opts)
    } catch (e) {
      fail(e as Error)
    }
  })
}
