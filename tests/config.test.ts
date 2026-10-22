import { describe, expect, it } from 'vitest';
import { PUBLIC_SERVER_URL, resolveServerUrl, statusUrl } from '../src/client/net/config';

const at = (href: string) => new URL(href) as unknown as Location;

describe('server address', () => {
  it('the Vercel site plays on the public server', () => {
    expect(resolveServerUrl(at('https://nebula-iota-rust.vercel.app/'), {})).toBe(PUBLIC_SERVER_URL);
    expect(resolveServerUrl(at('https://nebula-git-v02-multiplayer-vody22.vercel.app/'), {})).toBe(PUBLIC_SERVER_URL);
  });

  it('the server that serves the client is used directly', () => {
    expect(resolveServerUrl(at('https://nebula-frontier-server.onrender.com/'), {})).toBe('wss://nebula-frontier-server.onrender.com/ws');
    expect(resolveServerUrl(at('http://localhost:8080/'), {})).toBe('ws://localhost:8080/ws');
  });

  it('?server= and VITE_SERVER_URL take priority', () => {
    expect(resolveServerUrl(at('https://nebula-iota-rust.vercel.app/?server=wss://other.example'), {})).toBe('wss://other.example/ws');
    expect(resolveServerUrl(at('https://nebula-iota-rust.vercel.app/'), { VITE_SERVER_URL: 'wss://env.example/ws' })).toBe('wss://env.example/ws');
  });

  it('local development uses port 8080', () => {
    expect(resolveServerUrl(at('http://localhost:5173/'), {})).toBe('ws://localhost:8080/ws');
  });

  it('status endpoint sits next to the socket', () => {
    expect(statusUrl(PUBLIC_SERVER_URL)).toBe('https://nebula-frontier-server.onrender.com/status');
  });
});
