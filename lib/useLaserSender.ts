'use client';

/**
 * Sender side of the chat: owns the outgoing queue and the two ways of
 * reaching the Uno.
 *
 *   usb   browser -> Web Serial -> Uno            (works on https and localhost)
 *   wifi  browser -> HTTP -> NodeMCU -> Uno       (http pages only, see below)
 *
 * The laser is a half duplex, one message at a time medium, and a short
 * message occupies it for roughly 18 seconds. So messages are queued here and
 * released one by one rather than fired at the Uno, whose 64 byte serial
 * buffer would otherwise overflow.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SerialLink, serialSupported } from './serial';
import { buildFrame, frameDurationMs } from './protocol';

export type Transport = 'usb' | 'wifi';

export type Outgoing = {
  id: number;
  at: number;
  text: string;
  state: 'queued' | 'sending' | 'sent' | 'failed';
  airtimeMs: number;
  startedAt?: number;
  error?: string;
};

export type LogLine = { t: number; kind: 'tx' | 'rx' | 'sys' | 'err'; text: string };

/** Gap after a frame before the next one goes out, so the idle period is clear. */
const INTER_MESSAGE_MS = 700;

export function useLaserSender(bitMs: number) {
  const linkRef = useRef<SerialLink | null>(null);
  const queueRef = useRef<Outgoing[]>([]);
  const busyRef = useRef(false);
  const idRef = useRef(1);
  const timerRef = useRef<number | null>(null);

  const [transport, setTransport] = useState<Transport>('usb');
  const [nodeIp, setNodeIp] = useState('192.168.4.1');
  const [connected, setConnected] = useState(false);
  const [supported, setSupported] = useState(true);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [busyUntil, setBusyUntil] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => setSupported(serialSupported()), []);

  const log = useCallback((kind: LogLine['kind'], text: string) => {
    setLines((prev) => [...prev.slice(-250), { t: Date.now(), kind, text }]);
  }, []);

  // One timer drives every countdown on screen.
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const sync = useCallback(() => setOutgoing([...queueRef.current]), []);

  const patch = useCallback(
    (id: number, next: Partial<Outgoing>) => {
      const item = queueRef.current.find((q) => q.id === id);
      if (item) Object.assign(item, next);
      sync();
    },
    [sync],
  );

  // ------------------------------------------------------------- transports
  const connectUsb = useCallback(async () => {
    try {
      const link = new SerialLink();
      link.onLine = (l) => {
        const trimmed = l.trim();
        if (trimmed) log('rx', trimmed);
      };
      link.onStatus = (ok, detail) => {
        setConnected(ok);
        log(ok ? 'sys' : 'err', ok ? 'Port open (' + detail + ')' : 'Port closed: ' + detail);
      };
      await link.connect(9600);
      linkRef.current = link;
    } catch (err) {
      log('err', String(err instanceof Error ? err.message : err));
    }
  }, [log]);

  const disconnectUsb = useCallback(async () => {
    await linkRef.current?.disconnect();
    linkRef.current = null;
    setConnected(false);
  }, []);

  /** Raw write of one line, by whichever transport is selected. */
  const writeLine = useCallback(
    async (text: string) => {
      if (transport === 'usb') {
        const link = linkRef.current;
        if (!link?.connected) throw new Error('USB not connected');
        await link.sendLine(text);
        return;
      }
      const url = 'http://' + nodeIp + '/api/send?msg=' + encodeURIComponent(text);
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('NodeMCU replied ' + res.status);
    },
    [transport, nodeIp],
  );

  /** Fire a command that does not occupy the beam (#ON, #OFF, #BIT=n). */
  const sendCommand = useCallback(
    async (text: string) => {
      try {
        await writeLine(text);
        log('tx', text);
      } catch (err) {
        log('err', String(err instanceof Error ? err.message : err));
      }
    },
    [log, writeLine],
  );

  // ----------------------------------------------------------------- queue
  const pump = useCallback(() => {
    if (busyRef.current) return;
    const next = queueRef.current.find((q) => q.state === 'queued');
    if (!next) return;

    busyRef.current = true;
    patch(next.id, { state: 'sending', startedAt: Date.now() });
    setBusyUntil(Date.now() + next.airtimeMs);

    writeLine(next.text)
      .then(() => {
        log('tx', next.text);
        timerRef.current = window.setTimeout(() => {
          patch(next.id, { state: 'sent' });
          busyRef.current = false;
          setBusyUntil(0);
          pump();
        }, next.airtimeMs + INTER_MESSAGE_MS);
      })
      .catch((err) => {
        const msg = String(err instanceof Error ? err.message : err);
        patch(next.id, { state: 'failed', error: msg });
        log('err', msg);
        busyRef.current = false;
        setBusyUntil(0);
        pump();
      });
  }, [log, patch, writeLine]);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim().toUpperCase().slice(0, 60);
      if (!text) return;
      const item: Outgoing = {
        id: idRef.current++,
        at: Date.now(),
        text,
        state: 'queued',
        airtimeMs: frameDurationMs(buildFrame(text), bitMs),
      };
      queueRef.current = [...queueRef.current, item].slice(-60);
      sync();
      pump();
    },
    [bitMs, pump, sync],
  );

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const clear = useCallback(() => {
    queueRef.current = queueRef.current.filter((q) => q.state === 'sending');
    sync();
  }, [sync]);

  const sending = busyUntil > tick;
  const remainingMs = Math.max(0, busyUntil - tick);
  const pending = outgoing.filter((o) => o.state === 'queued').length;

  /**
   * An https page cannot reach a plain http NodeMCU - the browser blocks it as
   * mixed content. Only the localhost dev server can use the Wi-Fi transport.
   */
  const wifiBlocked =
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    transport === 'wifi';

  const ready = transport === 'usb' ? connected : !wifiBlocked;

  return {
    transport,
    setTransport,
    nodeIp,
    setNodeIp,
    connected,
    supported,
    ready,
    wifiBlocked,
    outgoing,
    lines,
    sending,
    remainingMs,
    pending,
    connectUsb,
    disconnectUsb,
    send,
    sendCommand,
    clear,
  };
}
